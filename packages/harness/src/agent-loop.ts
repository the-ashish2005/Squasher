import { randomUUID } from "node:crypto";
import { approvalPayloadHash, type GitHubMcpWriteToolName } from "@squasher/github-mcp";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { LlmRateLimitError, type LlmClient } from "./llm-client.js";
import {
  buildCorrectionMessage,
  squasherResultSchema,
  createFixPullRequestSchema,
  GuardValidationError,
  type GuardSchema
} from "./structured-output-guard.js";
import { resultContractProblem } from "./issue-scope.js";
import type { HarnessAgentMessage, SessionStore } from "./session-store.js";
import type { ToolDispatcher } from "./tool-dispatcher.js";

export const defaultIterationLimit = 64;
export const mainThreadId = "main";

const guardedSchemas: Record<string, GuardSchema> = {
  submit_squasher_result: squasherResultSchema,
  create_fix_pull_request: createFixPullRequestSchema
};

/**
 * Where an approved GitHub write is allowed to land. Resolved by the caller (the server,
 * from its contribution policy) rather than by the model, so the write destination is never
 * something the model chose. The decision is stamped into the tool arguments before the
 * approval pause, which puts it inside the approval payload hash.
 */
export interface WriteTargetDecision {
  allowed: boolean;
  /** Account that will hold the fix branch. Omit for a same-repository write. */
  headOwner?: string;
  reason?: string;
}

export type WriteTargetResolver = (input: {
  owner: string;
  repo: string;
}) => Promise<WriteTargetDecision> | WriteTargetDecision;

export interface AgentLoopOptions {
  store: SessionStore;
  sessionId: string;
  turnId: string;
  llm: LlmClient;
  dispatcher: ToolDispatcher;
  iterationLimit?: number;
  approvalRequiredTools?: string[];
  resolveWriteTarget?: WriteTargetResolver;
}

/**
 * Drives the tool-calling loop until the model produces a final message, pauses for
 * approval, or the turn fails. Every LLM call and tool call is wrapped so a failure
 * becomes a `turn.done` error event that the server's existing handling recognises.
 *
 * Emits the event shapes consumed by `projectTrueForgeEvent`,
 * `extractSubmittedSquasherResult`, `extractTrueForgePendingApproval` and
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

        // Decide the write destination before pausing, so the approver sees it and the
        // approval hash covers it. A refusal is reported back to the model rather than
        // failing the turn: the proof is already submitted and still worth keeping.
        const target = await resolveWriteTargetFor(options, toolCall.name, validated.value);
        if (!target.allowed) {
          const refusal = `GitHub write refused by contribution policy: ${target.reason ?? "not permitted"}`;
          store.appendEvent(sessionId, turnId, {
            type: "tool.response",
            toolCallId: toolCall.id,
            content: refusal
          });
          store.appendMessages(sessionId, [
            { role: "tool", toolCallId: toolCall.id, content: refusal },
            {
              role: "user",
              content:
                "The gated GitHub write was refused by policy, not by a maintainer. Do not retry it. " +
                "Return the same squasher.result object as your final response so the evidence is preserved."
            }
          ]);
          continue;
        }

        pauseForApproval(store, sessionId, turnId, {
          toolCallId: toolCall.id,
          sourceEventId,
          name: toolCall.name,
          arguments: target.arguments
        });
        return;
      }

      try {
        // Refuses a result whose evidence is the wrong kind for the issue it answers, in
        // either direction: a defect claim for an issue that reported no failure, or an
        // implementation claim for one that did. Runs before the result is accepted, and so
        // before the issue can be labelled.
        if (toolCall.name === "submit_squasher_result") {
          const problem = resultContractProblem(args, issueTextFor(store, sessionId));
          if (problem) {
            throw new GuardValidationError(toolCall.name, JSON.stringify(args).slice(0, 8 * 1024), problem);
          }
        }

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
/**
 * Runs the approved write, then lets the model close out the turn.
 *
 * Returns whether the write itself landed. The caller needs that to decide whether the
 * approval checkpoint is resolved: a write that failed leaves the patch unwritten, and
 * discarding the checkpoint for it strands the run with a verified patch it can never
 * write and no way to try again. Anything after the write — the model's closing message —
 * cannot un-resolve it, so this reports success as soon as the tool call returns.
 */
export async function resumeApprovedToolCall(
  options: AgentLoopOptions & {
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    payloadHash: string;
  }
): Promise<boolean> {
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
    return false;
  }

  // Let the model emit its closing squasher.result message on this same turn.
  await runAgentTurn(options);
  return true;
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

/**
 * Applies the caller's write-target policy to a gated tool call. Tools other than the
 * pull request write are unaffected, and an absent resolver preserves same-repository
 * behaviour exactly.
 */
async function resolveWriteTargetFor(
  options: AgentLoopOptions,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ allowed: true; arguments: Record<string, unknown> } | { allowed: false; reason?: string }> {
  if (toolName !== "create_fix_pull_request" || !options.resolveWriteTarget) {
    return { allowed: true, arguments: args };
  }

  const owner = typeof args.owner === "string" ? args.owner : "";
  const repo = typeof args.repo === "string" ? args.repo : "";
  if (owner.length === 0 || repo.length === 0) {
    // Let the write tool's own argument validation produce the error message.
    return { allowed: true, arguments: args };
  }

  let decision: WriteTargetDecision;
  try {
    decision = await options.resolveWriteTarget({ owner, repo });
  } catch (error) {
    return {
      allowed: false,
      reason: `contribution policy could not be resolved: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!decision.allowed) {
    return { allowed: false, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) };
  }

  if (!decision.headOwner || decision.headOwner === owner) {
    return { allowed: true, arguments: args };
  }

  // Crossing into someone else's repository, so disclosure is not left to the model.
  // Added before the pause, which means the approver reads the exact body that will ship.
  const body = typeof args.body === "string" ? args.body : "";
  return {
    allowed: true,
    arguments: { ...args, headOwner: decision.headOwner, body: withContributionDisclosure(body) }
  };
}

export const contributionDisclosureMarker = "<!-- squasher:disclosure -->";

/** Marker used before the rename. Recognised so an existing body is not stamped twice. */
export const legacyContributionDisclosureMarker = "<!-- byter:disclosure -->";

/**
 * Appends an automated-contribution disclosure. Idempotent, so a resubmitted body is not
 * stamped twice.
 */
export function withContributionDisclosure(body: string): string {
  if (body.includes(contributionDisclosureMarker) || body.includes(legacyContributionDisclosureMarker)) {
    return body;
  }

  return [
    body.trimEnd(),
    "",
    "---",
    contributionDisclosureMarker,
    "**Automated contribution.** This pull request was prepared by [Squasher](https://github.com/the-ashish2005/Squasher), " +
      "an automated agent that reproduces a reported defect in a sandbox before proposing a fix. " +
      "A human reviewed and approved this patch before it was opened.",
    "",
    "No maintainer requested this change. Please close it without hesitation if it is unwanted, " +
      "out of scope, or does not meet the project's standards."
  ].join("\n");
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
  // headOwner travels on the event so the server can verify the paused destination against
  // its own contribution decision without reaching into harness internals.
  store.appendEvent(sessionId, turnId, {
    type: "tool.approval_required",
    threadId: mainThreadId,
    ...(typeof call.arguments.headOwner === "string" ? { headOwner: call.arguments.headOwner } : {}),
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

/** Empty text when the issue could not be read, which makes the scope check a no-op. */
function issueTextFor(store: SessionStore, sessionId: string): { title: string; body: string } {
  return store.issue(sessionId) ?? { title: "", body: "" };
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
