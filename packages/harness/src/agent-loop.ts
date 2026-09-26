import { randomUUID } from "node:crypto";
import { approvalPayloadHash, type GitHubMcpWriteToolName } from "@byter/github-mcp";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LlmRateLimitError, type LlmClient } from "./llm-client.js";
import {
  buildCorrectionMessage,
  byterResultSchema,
  createFixPullRequestSchema,
  GuardValidationError,
  type GuardSchema
} from "./structured-output-guard.js";
import type { HarnessAgentMessage, SessionStore } from "./session-store.js";
import type { ToolDispatcher } from "./tool-dispatcher.js";

export const defaultIterationLimit = 64;
export const mainThreadId = "main";

const guardedSchemas: Record<string, GuardSchema> = {
  submit_byter_result: byterResultSchema,
  create_fix_pull_request: createFixPullRequestSchema
};

export interface AgentLoopOptions {
  store: SessionStore;
  sessionId: string;
  turnId: string;
  llm: LlmClient;
  dispatcher: ToolDispatcher;
  iterationLimit?: number;
  approvalRequiredTools?: string[];
}

/**
 * Drives the tool-calling loop until the model produces a final message, pauses for
 * approval, or the turn fails. Every LLM call and tool call is wrapped so a failure
 * becomes a `turn.done` error event that the server's existing handling recognises.
 *
 * Emits the event shapes consumed by `projectTrueForgeEvent`,
 * `extractSubmittedByterResult`, `extractTrueForgePendingApproval` and
 * `trueForgeTurnError` in apps/server/src/server.ts.
 */
export async function runAgentTurn(options: AgentLoopOptions): Promise<void> {
  const { store, sessionId, turnId, llm, dispatcher } = options;
  const iterationLimit = options.iterationLimit ?? defaultIterationLimit;
  const approvalRequired = new Set(options.approvalRequiredTools ?? ["create_fix_pull_request"]);
  const tools = dispatcher.tools();

  // Tracks the one allowed corrective retry per guarded tool.
  const guardRetries = new Map<string, number>();

  for (let iteration = 0; iteration < iterationLimit; iteration += 1) {
    let response;
    try {
      response = await llm.complete(toChatMessages(store.messages(sessionId)), tools);
    } catch (error) {
      failTurn(store, sessionId, turnId, llmErrorMessage(error));
      return;
    }

    if (response.toolCalls.length === 0) {
      store.appendMessages(sessionId, [{ role: "assistant", content: response.text }]);
      store.appendEvent(sessionId, turnId, { type: "model.message", content: response.text });
      settleTurn(store, sessionId, turnId, response.text);
      return;
    }

    const sourceEventId = `evt_${randomUUID()}`;
    store.appendEvent(sessionId, turnId, {
      id: sourceEventId,
      type: "model.message",
      ...(response.text ? { content: response.text } : {}),
      toolCalls: response.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.name, arguments: toolCall.arguments }
      }))
    });
    store.appendMessages(sessionId, [
      {
        role: "assistant",
        content: response.text || null,
        toolCalls: response.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments
        }))
      }
    ]);

    for (const toolCall of response.toolCalls) {
      const schema = guardedSchemas[toolCall.name];
      let args: Record<string, unknown>;
      try {
        args = parseArguments(toolCall.arguments);
      } catch {
        args = {};
      }

      if (approvalRequired.has(toolCall.name)) {
        const validated = schema ? validateForPause(store, sessionId, turnId, toolCall.name, schema, args, guardRetries) : { ok: true as const, value: args };
        if (!validated.ok) {
          if (validated.exhausted) {
            failTurn(store, sessionId, turnId, `Malformed structured output after retry for ${toolCall.name}: ${validated.problem}`);
            return;
          }
          store.appendMessages(sessionId, [
            { role: "tool", toolCallId: toolCall.id, content: `Rejected before execution: ${validated.problem}` },
            { role: "user", content: buildCorrectionMessage(schema!, validated.problem) }
          ]);
          break;
        }

        pauseForApproval(store, sessionId, turnId, {
          toolCallId: toolCall.id,
          sourceEventId,
          name: toolCall.name,
          arguments: validated.value
        });
        return;
      }

      try {
        const result = await dispatcher.callTool(toolCall.name, args);
        const text = result.content.map((part) => part.text).join("\n");
        store.appendEvent(sessionId, turnId, {
          type: "tool.response",
          toolCallId: toolCall.id,
          content: text
        });
        store.appendMessages(sessionId, [{ role: "tool", toolCallId: toolCall.id, content: text }]);
      } catch (error) {
        if (error instanceof GuardValidationError && schema) {
          const attempts = (guardRetries.get(toolCall.name) ?? 0) + 1;
          guardRetries.set(toolCall.name, attempts);
          store.appendGuardEvent(sessionId, turnId, {
            toolName: toolCall.name,
            attempt: attempts,
            outcome: attempts > 1 ? "failed" : "retrying",
            problem: error.problem,
            rawText: error.rawText
          });

          if (attempts > 1) {
            failTurn(store, sessionId, turnId, `Malformed structured output after retry for ${toolCall.name}: ${error.problem}`);
            return;
          }

          store.appendMessages(sessionId, [
            { role: "tool", toolCallId: toolCall.id, content: `Rejected before execution: ${error.problem}` },
            { role: "user", content: buildCorrectionMessage(schema, error.problem) }
          ]);
          break;
        }

        const message = error instanceof Error ? error.message : `Tool ${toolCall.name} failed`;
        store.appendEvent(sessionId, turnId, {
          type: "tool.response",
          toolCallId: toolCall.id,
          content: JSON.stringify({ error: message })
        });
        store.appendMessages(sessionId, [
          { role: "tool", toolCallId: toolCall.id, content: `Tool call failed: ${message}` }
        ]);
      }
    }
  }

  failTurn(
    store,
    sessionId,
    turnId,
    `The agent loop reached its iteration limit of ${iterationLimit} without producing a final result`
  );
}

/**
 * Executes the approved write on a fresh turn, then lets the model finish the workflow.
 * Called after `harness-runtime` has verified the approval payload hash.
 */
export async function resumeApprovedToolCall(
  options: AgentLoopOptions & {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    payloadHash: string;
  }
): Promise<void> {
  const { store, sessionId, turnId, dispatcher } = options;

  try {
    const result = await dispatcher.callTool(options.toolName, options.arguments, {
      approved: true,
      expectedPayloadHash: options.payloadHash
    });
    const text = result.content.map((part) => part.text).join("\n");
    store.appendEvent(sessionId, turnId, {
      type: "tool.response",
      threadId: mainThreadId,
      toolCallId: options.toolCallId,
      content: text
    });
    store.appendMessages(sessionId, [{ role: "tool", toolCallId: options.toolCallId, content: text }]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Approved tool call failed";
    store.appendEvent(sessionId, turnId, {
      type: "tool.response",
      threadId: mainThreadId,
      toolCallId: options.toolCallId,
      content: JSON.stringify({ error: message })
    });
    failTurn(store, sessionId, turnId, `Approved GitHub write failed: ${message}`);
    return;
  }

  // Let the model emit its closing byter.result message on this same turn.
  await runAgentTurn(options);
}

/** Denies the paused call and closes the turn without touching GitHub. */
export function recordDeniedToolCall(
  store: SessionStore,
  sessionId: string,
  turnId: string,
  toolCallId: string,
  reason: string
): void {
  store.appendEvent(sessionId, turnId, {
    type: "tool.response",
    threadId: mainThreadId,
    toolCallId,
    content: JSON.stringify({ denied: true, reason })
  });
  store.appendMessages(sessionId, [
    { role: "tool", toolCallId, content: `Maintainer denied this write: ${reason}` }
  ]);
  settleTurn(store, sessionId, turnId, `Maintainer denied the GitHub write: ${reason}`);
}

function validateForPause(
  store: SessionStore,
  sessionId: string,
  turnId: string,
  toolName: string,
  schema: GuardSchema,
  args: Record<string, unknown>,
  guardRetries: Map<string, number>
): { ok: true; value: Record<string, unknown> } | { ok: false; problem: string; exhausted: boolean } {
  const violations = schema.validate(args);
  if (violations.length === 0) {
    if ((guardRetries.get(toolName) ?? 0) > 0) {
      store.appendGuardEvent(sessionId, turnId, {
        toolName,
        attempt: guardRetries.get(toolName) ?? 0,
        outcome: "recovered",
        problem: "Corrected after one retry",
        rawText: JSON.stringify(args).slice(0, 2048)
      });
    }
    return { ok: true, value: args };
  }

  const attempts = (guardRetries.get(toolName) ?? 0) + 1;
  guardRetries.set(toolName, attempts);
  const problem = violations.join(" ");
  store.appendGuardEvent(sessionId, turnId, {
    toolName,
    attempt: attempts,
    outcome: attempts > 1 ? "failed" : "retrying",
    problem,
    rawText: JSON.stringify(args).slice(0, 8 * 1024)
  });
  return { ok: false, problem, exhausted: attempts > 1 };
}

function pauseForApproval(
  store: SessionStore,
  sessionId: string,
  turnId: string,
  call: { toolCallId: string; sourceEventId: string; name: string; arguments: Record<string, unknown> }
): void {
  // Hash the model's own arguments, matching how the MCP HTTP handler bound approvals.
  const payloadHash = approvalPayloadHash(call.name as GitHubMcpWriteToolName, call.arguments);

  store.setPending(sessionId, {
    toolCallId: call.toolCallId,
    sourceEventId: call.sourceEventId,
    threadId: mainThreadId,
    turnId,
    name: call.name,
    arguments: call.arguments,
    payloadHash
  });

  // No turn.done here: the turn is paused, and emitting both would make the server
  // treat it as completed and request a redundant proof-contract continuation.
  store.appendEvent(sessionId, turnId, {
    type: "tool.approval_required",
    threadId: mainThreadId,
    toolCalls: [{ id: call.toolCallId, sourceEventId: call.sourceEventId }]
  });
  store.setTurnStatus(sessionId, turnId, "paused");
}

function settleTurn(store: SessionStore, sessionId: string, turnId: string, output: string): void {
  store.appendEvent(sessionId, turnId, {
    type: "turn.done",
    state: { status: "completed", output }
  });
  store.setTurnStatus(sessionId, turnId, "completed");
}

function failTurn(store: SessionStore, sessionId: string, turnId: string, message: string): void {
  store.appendEvent(sessionId, turnId, {
    type: "turn.done",
    state: { status: "error", message }
  });
  store.setTurnStatus(sessionId, turnId, "error");
}

/**
 * Rate limits and context overflows are phrased so
 * `isRecoverableTrueForgeTurnError` matches and the server retries via a
 * proof-contract continuation turn rather than failing the run outright.
 */
function llmErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown model error";
  if (error instanceof LlmRateLimitError) {
    return `Model token budget breached by rate limiting: ${detail}`;
  }
  if (/context length|too many tokens|maximum context|token limit/i.test(detail)) {
    return `Model max tokens breached: ${detail}`;
  }
  return `Model request failed: ${detail}`;
}

function parseArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments were not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function toChatMessages(messages: HarnessAgentMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content ?? ""
      };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: { name: toolCall.name, arguments: toolCall.arguments }
              }))
            }
          : {})
      };
    }
    return { role: message.role, content: message.content ?? "" };
  });
}
