import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const guardEventType = "squasher.structured_output.guard";

/**
 * Pre-rename event type. Event logs written before the rename carry it, so anything that
 * reads history back -- the dashboard trace, the live-run summary -- must still match it.
 */
export const legacyGuardEventType = "byter.structured_output.guard";

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

/** The reported issue, kept so scope checks do not re-parse the rendered prompt. */
export interface HarnessIssueText {
  title: string;
  body: string;
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

/** The durable subset of a session: everything needed to resume an approved write. */
interface SessionSnapshot {
  id: string;
  title: string | null;
  spec: HarnessSessionSpec;
  createdAt: string;
  turns: HarnessTurnRecord[];
  messages: HarnessAgentMessage[];
  pending?: PendingToolCall;
  issue?: HarnessIssueText;
  nextSequenceNumber: number;
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
  issue?: HarnessIssueText;
  sandboxId?: string;
  nextSequenceNumber: number;
  waiters: Array<() => void>;
}

export interface SessionStoreOptions {
  /** Mirrors every raw event to `<dataDir>/harness-events.jsonl` for later inspection. */
  dataDir?: string;
}

/**
 * In-memory session state backed by a per-session JSON snapshot on disk.
 *
 * The snapshot exists because a paused tool call waits on a human, so the gap between
 * `tool.approval_required` and the approval is hours or days — far longer than one
 * process lives. Without it a restart in that window strands the run: the persisted
 * record still reads `awaiting-approval` but the session is gone and the approval can
 * never be resumed. Events are deliberately not snapshotted; the server already
 * projects them into its own store, and only the conversation, the spec and the pending
 * call are needed to finish an approved write.
 *
 * Reads return copies: the webhook handler polls `listEvents` while the agent loop
 * is still appending, and callers must never observe a mutating array.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly dataDir?: string;
  private mirrorChain: Promise<void> = Promise.resolve();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SessionStoreOptions = {}) {
    const dataDir = options.dataDir ?? process.env.DATA_DIR;
    if (dataDir) {
      this.dataDir = resolve(dataDir);
    }
  }

  /**
   * Makes a session available, reloading its snapshot when this process has never seen
   * it. Returns false when no such session exists anywhere.
   */
  async ensureSession(sessionId: string): Promise<boolean> {
    if (this.sessions.has(sessionId)) return true;
    if (!this.dataDir) return false;

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(await readFile(this.snapshotPath(sessionId), "utf8"));
    } catch {
      return false;
    }
    if (typeof snapshot !== "object" || snapshot === null) return false;

    const stored = snapshot as Partial<SessionSnapshot>;
    if (!stored.spec || stored.id !== sessionId) return false;

    this.sessions.set(sessionId, {
      id: sessionId,
      title: stored.title ?? null,
      spec: stored.spec,
      createdAt: stored.createdAt ?? new Date().toISOString(),
      turns: stored.turns ?? [],
      messages: stored.messages ?? [],
      ...(stored.pending ? { pending: stored.pending } : {}),
      ...(stored.issue ? { issue: stored.issue } : {}),
      // Events are not snapshotted, but sequence numbers continue from where they
      // stopped so replayed events cannot collide with ones already on the dashboard.
      events: [],
      nextSequenceNumber: stored.nextSequenceNumber ?? 1,
      // The old sandbox died with the previous process; a later command provisions a
      // fresh one rather than addressing a handle this process does not hold.
      sandboxId: undefined,
      waiters: []
    });
    return true;
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
    this.persist(id);
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
    if (this.dataDir) {
      const target = this.snapshotPath(sessionId);
      this.writeChain = this.writeChain.then(() => unlink(target)).catch(() => {});
    }
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
    this.persist(sessionId);
    return { ...turn };
  }

  setTurnStatus(sessionId: string, turnId: string, status: string): void {
    const turn = this.expect(sessionId).turns.find((candidate) => candidate.id === turnId);
    if (turn) {
      turn.status = status;
      this.persist(sessionId);
    }
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
    // Keeps nextSequenceNumber durable so a reloaded session cannot reuse numbers.
    this.persist(sessionId);
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
    this.persist(sessionId);
  }

  issue(sessionId: string): HarnessIssueText | undefined {
    const issue = this.sessions.get(sessionId)?.issue;
    return issue ? { ...issue } : undefined;
  }

  setIssue(sessionId: string, issue: HarnessIssueText): void {
    this.expect(sessionId).issue = { ...issue };
    this.persist(sessionId);
  }

  pending(sessionId: string): PendingToolCall | undefined {
    const pendingCall = this.sessions.get(sessionId)?.pending;
    return pendingCall ? { ...pendingCall } : undefined;
  }

  setPending(sessionId: string, pendingCall: PendingToolCall): void {
    this.expect(sessionId).pending = { ...pendingCall };
    this.persist(sessionId);
  }

  clearPending(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pending = undefined;
      this.persist(sessionId);
    }
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

  private snapshotPath(sessionId: string): string {
    // sessionId is generated as `sess_<uuid>` by this class, never caller-supplied text.
    return join(this.dataDir ?? "", "harness-sessions", `${sessionId}.json`);
  }

  /** Writes the session's durable subset. Serialized, and atomic via write-then-rename. */
  private persist(sessionId: string): void {
    if (!this.dataDir) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const snapshot: SessionSnapshot = {
      id: session.id,
      title: session.title,
      spec: session.spec,
      createdAt: session.createdAt,
      turns: session.turns,
      messages: session.messages,
      ...(session.pending ? { pending: session.pending } : {}),
      ...(session.issue ? { issue: session.issue } : {}),
      nextSequenceNumber: session.nextSequenceNumber
    };
    const body = JSON.stringify(snapshot);
    const target = this.snapshotPath(sessionId);

    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, body, "utf8");
        await rename(temporary, target);
      })
      .catch((error) => {
        console.warn(`Harness session snapshot failed for ${sessionId}`, error);
      });
  }

  /** Resolves once every queued snapshot write has landed. */
  async flush(): Promise<void> {
    await this.writeChain;
    await this.mirrorChain;
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
