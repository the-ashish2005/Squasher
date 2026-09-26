import { TrueForge } from "@truefoundry/trueforge-sdk";
import {
  buildInitialUserMessage,
  buildProofContractRecoveryMessage,
  buildByterAgentSpec
} from "./byter-agent.js";
import type {
  StartByterSessionInput,
  StartByterSessionResult,
  ResolveToolApprovalInput,
  TrueForgeClientLike,
  TrueForgePartialSessionFailureDetails,
  TrueForgeRuntimeConfig,
  TrueForgeRuntimeEvent,
  TrueForgeRuntimeEventListener,
  TrueForgeSession,
  TrueForgeTurn
} from "./types.js";

export class TrueForgeInitialTurnError extends Error {
  readonly details: TrueForgePartialSessionFailureDetails;

  constructor(details: TrueForgePartialSessionFailureDetails) {
    super(`TrueForge initial turn failed for created session ${details.session.id}`);
    this.name = "TrueForgeInitialTurnError";
    this.details = details;
  }
}

export class ByterTrueForgeRuntime {
  private readonly client: TrueForgeClientLike;
  private readonly config: TrueForgeRuntimeConfig;

  constructor(config: TrueForgeRuntimeConfig, client?: TrueForgeClientLike) {
    this.config = config;
    this.client =
      client ??
      (new TrueForge({
        baseUrl: config.baseUrl,
        ...(config.token ? { token: config.token } : {}),
        headers: {
          "User-Agent": "CLINE"
        }
      }) as unknown as TrueForgeClientLike);
  }

  async startSession(input: StartByterSessionInput): Promise<StartByterSessionResult> {
    const session = normalizeSession(
      await this.client.sessions.create({
        agent: {
          spec: buildByterAgentSpec(this.config)
        }
      })
    );

    let turn: TrueForgeTurn;
    try {
      turn = normalizeTurn(
        await this.client.sessions.createTurn(session.id, {
          input: [
            {
              type: "user.message",
              content: buildInitialUserMessage(input)
            }
          ]
        })
      );
    } catch (cause) {
      throw await this.handleInitialTurnFailure(session, cause);
    }

    return { session, turn };
  }

  async listSessionEvents(sessionId: string): Promise<TrueForgeRuntimeEvent[]> {
    const response = await this.client.sessions.listEvents(sessionId);
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    return data.map(normalizeEvent);
  }

  async requestProofContract(sessionId: string): Promise<TrueForgeTurn> {
    return normalizeTurn(
      await this.client.sessions.createTurn(sessionId, {
        input: [
          {
            type: "user.message",
            content: buildProofContractRecoveryMessage()
          }
        ]
      })
    );
  }

  async resolveToolApproval(input: ResolveToolApprovalInput): Promise<TrueForgeTurn> {
    return normalizeTurn(
      await this.client.sessions.createTurn(input.sessionId, {
        previousTurnId: input.previousTurnId,
        input: [
          {
            type: "user.tool_approval",
            threadId: input.threadId,
            toolCallId: input.toolCallId,
            approval: input.decision === "allow"
              ? { status: "allow" }
              : { status: "deny", ...(input.reason ? { reason: input.reason } : {}) }
          }
        ]
      })
    );
  }

  async subscribeToTurn(
    sessionId: string,
    turnId: string,
    onEvent?: TrueForgeRuntimeEventListener
  ): Promise<TrueForgeRuntimeEvent[]> {
    if (!this.client.sessions.subscribeToTurn) {
      throw new Error("TrueForge SDK does not expose turn subscription");
    }

    const stream = await this.client.sessions.subscribeToTurn(sessionId, turnId);
    const events: TrueForgeRuntimeEvent[] = [];
    for await (const event of stream) {
      const normalized = normalizeEvent(event);
      events.push(normalized);
      await onEvent?.(normalized);
    }

    return events;
  }

  private async handleInitialTurnFailure(session: TrueForgeSession, cause: unknown): Promise<TrueForgeInitialTurnError> {
    if (!this.client.sessions.delete) {
      return new TrueForgeInitialTurnError({
        session,
        cause,
        cleanupAttempted: false,
        cleanupSucceeded: false
      });
    }

    try {
      await this.client.sessions.delete(session.id);
      return new TrueForgeInitialTurnError({
        session,
        cause,
        cleanupAttempted: true,
        cleanupSucceeded: true
      });
    } catch (cleanupError) {
      return new TrueForgeInitialTurnError({
        session,
        cause,
        cleanupAttempted: true,
        cleanupSucceeded: false,
        cleanupError
      });
    }
  }
}

function normalizeSession(value: unknown): TrueForgeSession {
  const session = unwrapData(value);
  if (!isRecord(session) || typeof session.id !== "string") {
    throw new Error("TrueForge session response did not include an id");
  }

  return {
    id: session.id,
    title: typeof session.title === "string" ? session.title : null
  };
}

function normalizeTurn(value: unknown): TrueForgeTurn {
  const turn = unwrapData(value);
  if (!isRecord(turn) || typeof turn.id !== "string" || typeof turn.sessionId !== "string") {
    throw new Error("TrueForge turn response did not include ids");
  }

  return {
    id: turn.id,
    sessionId: turn.sessionId,
    status: turnStatus(turn.state)
  };
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

function normalizeEvent(value: unknown): TrueForgeRuntimeEvent {
  const event = isRecord(value) && isRecord(value.event) ? value.event : value;
  const sequenceNumber =
    isRecord(value) && typeof value.sequenceNumber === "number" ? value.sequenceNumber : undefined;
  const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";

  return {
    ...(sequenceNumber !== undefined ? { sequenceNumber } : {}),
    type,
    raw: compactEventPayload(value)
  };
}

function compactEventPayload(value: unknown): unknown {
  const budget = { remaining: 512 * 1024 };
  return compactValue(value, budget, 0);
}

function compactValue(value: unknown, budget: { remaining: number }, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const limit = Math.min(value.length, Math.max(0, budget.remaining));
    const compacted = value.slice(0, limit);
    budget.remaining -= compacted.length;
    return compacted;
  }
  if (depth >= 8 || budget.remaining <= 0) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const compacted: unknown[] = [];
    for (const item of value.slice(0, 256)) {
      const next = compactValue(item, budget, depth + 1);
      if (next !== undefined) compacted.push(next);
      if (budget.remaining <= 0) break;
    }
    return compacted;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 128)) {
    const next = compactValue(item, budget, depth + 1);
    if (next !== undefined) compacted[key] = next;
    if (budget.remaining <= 0) break;
  }
  return compacted;
}

function turnStatus(state: unknown): string {
  return isRecord(state) && typeof state.status === "string" ? state.status : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
