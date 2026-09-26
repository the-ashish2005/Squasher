import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const guardEventType = "byter.structured_output.guard";

export interface HarnessEventEnvelope {
  sequenceNumber: number;
  event: Record<string, unknown>;
}

export interface HarnessTurnRecord {
  id: string;
  sessionId: string;
  status: string;
  previousTurnId?: string;
}

export interface PendingToolCall {
  toolCallId: string;
  sourceEventId: string;
  threadId: string;
  turnId: string;
  name: string;
  arguments: Record<string, unknown>;
  payloadHash: string;
}

export interface HarnessAgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface HarnessSessionSpec {
  instructions: string;
  iterationLimit: number;
  enabledTools: string[];
  approvalRequiredTools: string[];
}

interface StoredEvent {
  sequenceNumber: number;
  turnId: string;
  event: Record<string, unknown>;
}

interface SessionState {
  id: string;
  title: string | null;
  spec: HarnessSessionSpec;
  createdAt: string;
  turns: HarnessTurnRecord[];
  events: StoredEvent[];
  messages: HarnessAgentMessage[];
  pending?: PendingToolCall;
  sandboxId?: string;
  nextSequenceNumber: number;
  waiters: Array<() => void>;
}

export interface SessionStoreOptions {
  /** Mirrors every raw event to `<dataDir>/harness-events.jsonl` for later inspection. */
  dataDir?: string;
}

/**
 * Authoritative in-memory session state, mirrored to an append-only JSONL file so
 * guard failures stay inspectable after the process exits.
 *
 * Reads return copies: the webhook handler polls `listEvents` while the agent loop
 * is still appending, and callers must never observe a mutating array.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly dataDir?: string;
  private mirrorChain: Promise<void> = Promise.resolve();

  constructor(options: SessionStoreOptions = {}) {
    const dataDir = options.dataDir ?? process.env.DATA_DIR;
    if (dataDir) {
      this.dataDir = resolve(dataDir);
    }
  }

  createSession(spec: HarnessSessionSpec, title: string | null = null): { id: string; title: string | null } {
    const id = `sess_${randomUUID()}`;
    this.sessions.set(id, {
      id,
      title,
      spec,
      createdAt: new Date().toISOString(),
      turns: [],
      events: [],
      messages: [],
      nextSequenceNumber: 1,
      waiters: []
    });
    return { id, title };
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  spec(sessionId: string): HarnessSessionSpec {
    return this.expect(sessionId).spec;
  }

  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Release anything blocked on subscribeToTurn before dropping the state.
    for (const waiter of session.waiters.splice(0)) waiter();
    this.sessions.delete(sessionId);
  }

  createTurn(sessionId: string, previousTurnId?: string): HarnessTurnRecord {
    const session = this.expect(sessionId);
    const turn: HarnessTurnRecord = {
      id: `turn_${randomUUID()}`,
      sessionId,
      status: "running",
      ...(previousTurnId ? { previousTurnId } : {})
    };
    session.turns.push(turn);
    return { ...turn };
  }

  setTurnStatus(sessionId: string, turnId: string, status: string): void {
    const turn = this.expect(sessionId).turns.find((candidate) => candidate.id === turnId);
    if (turn) turn.status = status;
  }

  /**
   * Appends one raw event. `type` is required; `id` and `created_at` are filled in
   * when absent so `runtimeEventKey` in the server can dedupe across stream and poll.
   */
  appendEvent(sessionId: string, turnId: string, event: Record<string, unknown>): HarnessEventEnvelope {
    const session = this.expect(sessionId);
    const sequenceNumber = session.nextSequenceNumber;
    session.nextSequenceNumber += 1;
    const stored: StoredEvent = {
      sequenceNumber,
      turnId,
      event: {
        id: typeof event.id === "string" ? event.id : `evt_${randomUUID()}`,
        created_at: typeof event.created_at === "string" ? event.created_at : new Date().toISOString(),
        ...event
      }
    };
    session.events.push(stored);
    for (const waiter of session.waiters.splice(0)) waiter();
    this.mirror(sessionId, stored);
    return { sequenceNumber, event: { ...stored.event } };
  }

  /** Records a structured-output guard failure or retry, tagged for later grepping. */
  appendGuardEvent(
    sessionId: string,
    turnId: string,
    detail: { toolName: string; attempt: number; outcome: "retrying" | "recovered" | "failed"; problem: string; rawText: string }
  ): HarnessEventEnvelope {
    return this.appendEvent(sessionId, turnId, {
      type: guardEventType,
      toolName: detail.toolName,
      attempt: detail.attempt,
      outcome: detail.outcome,
      problem: detail.problem,
      rawText: detail.rawText.slice(0, 8 * 1024)
    });
  }

  listEvents(sessionId: string): HarnessEventEnvelope[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.events.map((stored) => ({ sequenceNumber: stored.sequenceNumber, event: { ...stored.event } }));
  }

  /**
   * Yields this turn's events in order and completes once the turn reaches a terminal
   * event. `tool.approval_required` is terminal: the turn is paused, not finished.
   */
  async *subscribeToTurn(sessionId: string, turnId: string): AsyncGenerator<HarnessEventEnvelope> {
    let cursor = 0;
    for (;;) {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      const pending = session.events.slice(cursor);
      if (pending.length === 0) {
        // Only block once nothing is left to drain. Registering the waiter here, with no
        // await since the emptiness check, means an append cannot slip past it.
        await new Promise<void>((resolveWaiter) => {
          session.waiters.push(resolveWaiter);
        });
        continue;
      }
      cursor += pending.length;

      let terminal = false;
      for (const stored of pending) {
        if (stored.turnId !== turnId) continue;
        yield { sequenceNumber: stored.sequenceNumber, event: { ...stored.event } };
        if (stored.event.type === "turn.done" || stored.event.type === "tool.approval_required") {
          terminal = true;
        }
      }
      if (terminal) return;
    }
  }

  messages(sessionId: string): HarnessAgentMessage[] {
    return this.expect(sessionId).messages.map((message) => ({ ...message }));
  }

  appendMessages(sessionId: string, messages: HarnessAgentMessage[]): void {
    this.expect(sessionId).messages.push(...messages);
  }

  pending(sessionId: string): PendingToolCall | undefined {
    const pendingCall = this.sessions.get(sessionId)?.pending;
    return pendingCall ? { ...pendingCall } : undefined;
  }

  setPending(sessionId: string, pendingCall: PendingToolCall): void {
    this.expect(sessionId).pending = { ...pendingCall };
  }

  clearPending(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.pending = undefined;
  }

  sandboxId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.sandboxId;
  }

  setSandboxId(sessionId: string, sandboxId: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (session) session.sandboxId = sandboxId;
  }

  private expect(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown harness session: ${sessionId}`);
    }
    return session;
  }

  private mirror(sessionId: string, stored: StoredEvent): void {
    if (!this.dataDir) return;
    const line = `${JSON.stringify({ sessionId, ...stored })}\n`;
    const target = join(this.dataDir, "harness-events.jsonl");
    // Serialize appends so concurrent events cannot interleave partial lines.
    this.mirrorChain = this.mirrorChain
      .then(async () => {
        await mkdir(dirname(target), { recursive: true });
        await appendFile(target, line, "utf8");
      })
      .catch((error) => {
        console.warn("Harness event mirror write failed", error);
      });
  }
}
