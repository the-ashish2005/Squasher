import { approvalPayloadHash, type GitHubMcpWriteToolName, type GitHubRestClientLike } from "@byter/github-mcp";
import {
  defaultIterationLimit,
  recordDeniedToolCall,
  resumeApprovedToolCall,
  runAgentTurn
} from "./agent-loop.js";
import { LlmClient } from "./llm-client.js";
import { E2bSandboxClient, type SandboxClientLike } from "./sandbox-client.js";
import {
  SessionStore,
  type HarnessEventEnvelope,
  type HarnessIssueText,
  type HarnessSessionSpec
} from "./session-store.js";
import { createToolDispatcher } from "./tool-dispatcher.js";

export interface ByterHarnessOptions {
  client: GitHubRestClientLike;
  llm: LlmClient;
  sandbox: SandboxClientLike;
  store?: SessionStore;
  dataDir?: string;
  commandTimeoutMs?: number;
}

/**
 * Self-contained replacement for the TrueForge SDK client.
 *
 * Satisfies the `TrueForgeClientLike` interface in packages/agent/src/types.ts, so
 * `ByterTrueForgeRuntime` can take it by dependency injection unchanged. The event
 * stream it produces is shaped for the parsers in apps/server/src/server.ts.
 */
export class ByterHarness {
  readonly sessions: {
    create(request: unknown): Promise<unknown>;
    createTurn(sessionId: string, request: unknown): Promise<unknown>;
    delete(sessionId: string): Promise<unknown>;
    listEvents(sessionId: string, request?: unknown): Promise<unknown>;
    subscribeToTurn(sessionId: string, turnId: string, request?: unknown): Promise<AsyncIterable<unknown>>;
  };

  private readonly store: SessionStore;
  private readonly options: ByterHarnessOptions;

  constructor(options: ByterHarnessOptions) {
    this.options = options;
    this.store = options.store ?? new SessionStore(options.dataDir ? { dataDir: options.dataDir } : {});

    this.sessions = {
      create: (request) => this.createSession(request),
      createTurn: (sessionId, request) => this.createTurn(sessionId, request),
      delete: (sessionId) => this.deleteSession(sessionId),
      listEvents: (sessionId) => this.listEvents(sessionId),
      subscribeToTurn: (sessionId, turnId) => this.subscribeToTurn(sessionId, turnId)
    };
  }

  static fromEnv(client: GitHubRestClientLike): ByterHarness {
    return new ByterHarness({
      client,
      llm: LlmClient.fromEnv(),
      sandbox: E2bSandboxClient.fromEnv()
    });
  }

  private async createSession(request: unknown): Promise<unknown> {
    const spec = parseSpec(request);
    const session = this.store.createSession(spec);
    return { data: { id: session.id, title: session.title } };
  }

  private async createTurn(sessionId: string, request: unknown): Promise<unknown> {
    // Reloads the session when this process did not run the original turn, so an
    // approval that arrives after a restart still resumes the paused write.
    if (!(await this.store.ensureSession(sessionId))) {
      throw new Error(`Unknown harness session: ${sessionId}`);
    }

    const input = firstInput(request);
    const previousTurnId = isRecord(request) && typeof request.previousTurnId === "string" ? request.previousTurnId : undefined;

    if (input.type === "user.tool_approval") {
      return this.startApprovalTurn(sessionId, input, previousTurnId);
    }

    if (input.type !== "user.message") {
      throw new Error(`Unsupported harness turn input: ${String(input.type)}`);
    }

    const content = typeof input.content === "string" ? input.content : "";
    const spec = this.store.spec(sessionId);
    const isFirstTurn = this.store.messages(sessionId).length === 0;

    this.store.appendMessages(sessionId, [
      ...(isFirstTurn ? [{ role: "system" as const, content: spec.instructions }] : []),
      { role: "user" as const, content }
    ]);

    if (isFirstTurn) {
      const issue = parseIssueText(content);
      if (issue) {
        this.store.setIssue(sessionId, issue);
      } else {
        // The scope check needs the report verbatim; without it a feature request could
        // be accepted as a proven defect, so make the gap loud rather than silent.
        console.warn(
          `Byter harness could not read the issue text from the initial message for session ${sessionId}; ` +
            "the out-of-scope proof check is inactive for this run"
        );
      }
    }

    const turn = this.store.createTurn(sessionId, previousTurnId);
    this.store.appendEvent(sessionId, turn.id, { type: "turn.created" });

    // Fire and forget: the webhook response must not wait for the agent.
    void this.runTurn(sessionId, turn.id, spec, () =>
      runAgentTurn({
        store: this.store,
        sessionId,
        turnId: turn.id,
        llm: this.options.llm,
        dispatcher: this.dispatcherFor(sessionId, turn.id),
        iterationLimit: spec.iterationLimit,
        approvalRequiredTools: spec.approvalRequiredTools
      })
    );

    return { data: { id: turn.id, sessionId, state: { status: "running" } } };
  }

  private async startApprovalTurn(
    sessionId: string,
    input: Record<string, unknown>,
    previousTurnId: string | undefined
  ): Promise<unknown> {
    const pending = this.store.pending(sessionId);
    if (!pending) {
      throw new Error("No harness tool call is awaiting approval for this session");
    }

    const toolCallId = typeof input.toolCallId === "string" ? input.toolCallId : undefined;
    if (toolCallId && toolCallId !== pending.toolCallId) {
      throw new Error("Approval does not reference the paused harness tool call");
    }

    const approval = isRecord(input.approval) ? input.approval : {};
    const allowed = approval.status === "allow";
    const reason = typeof approval.reason === "string" ? approval.reason : "Maintainer denied the candidate patch";

    // Replicates assertApproved in apps/github-mcp/src/tools.ts: the stored arguments
    // must still hash to the value recorded when the call was paused.
    const actualHash = approvalPayloadHash(pending.name as GitHubMcpWriteToolName, pending.arguments);
    if (allowed && actualHash !== pending.payloadHash) {
      throw new Error("GitHub write blocked: approval payload hash mismatch");
    }

    const spec = this.store.spec(sessionId);
    const turn = this.store.createTurn(sessionId, previousTurnId ?? pending.turnId);
    this.store.clearPending(sessionId);

    if (!allowed) {
      recordDeniedToolCall(this.store, sessionId, turn.id, pending.toolCallId, reason);
      await this.closeSandbox(sessionId);
      return { data: { id: turn.id, sessionId, state: { status: "completed" } } };
    }

    void this.runTurn(sessionId, turn.id, spec, () =>
      resumeApprovedToolCall({
        store: this.store,
        sessionId,
        turnId: turn.id,
        llm: this.options.llm,
        dispatcher: this.dispatcherFor(sessionId, turn.id),
        iterationLimit: spec.iterationLimit,
        approvalRequiredTools: [],
        toolCallId: pending.toolCallId,
        toolName: pending.name,
        arguments: pending.arguments,
        payloadHash: pending.payloadHash
      })
    );

    return { data: { id: turn.id, sessionId, state: { status: "running" } } };
  }

  /**
   * Runs one turn and tears the sandbox down afterwards unless the turn paused for
   * approval. A later continuation turn provisions a fresh sandbox, so no sandbox
   * outlives the work that needed it even if the loop throws.
   */
  private async runTurn(
    sessionId: string,
    turnId: string,
    _spec: HarnessSessionSpec,
    run: () => Promise<void>
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Harness turn failed";
      this.store.appendEvent(sessionId, turnId, {
        type: "turn.done",
        state: { status: "error", message: `Harness turn failed: ${message}` }
      });
      this.store.setTurnStatus(sessionId, turnId, "error");
    } finally {
      if (!this.store.pending(sessionId)) {
        await this.closeSandbox(sessionId);
      }
    }
  }

  private dispatcherFor(sessionId: string, turnId: string) {
    return createToolDispatcher({
      client: this.options.client,
      sandbox: this.options.sandbox,
      enabledTools: this.store.spec(sessionId).enabledTools,
      ...(this.options.commandTimeoutMs !== undefined ? { commandTimeoutMs: this.options.commandTimeoutMs } : {}),
      resolveSandboxId: async () => {
        const existing = this.store.sandboxId(sessionId);
        if (existing) return existing;
        const sandboxId = await this.options.sandbox.createSandbox();
        this.store.setSandboxId(sessionId, sandboxId);
        // Surfaces in the dashboard trace as sandbox provisioning.
        this.store.appendEvent(sessionId, turnId, { type: "sandbox.created", sandbox_id: sandboxId });
        return sandboxId;
      }
    });
  }

  private async closeSandbox(sessionId: string): Promise<void> {
    const sandboxId = this.store.sandboxId(sessionId);
    if (!sandboxId) return;
    this.store.setSandboxId(sessionId, undefined);
    await this.options.sandbox.closeSandbox(sandboxId);
  }

  private async listEvents(sessionId: string): Promise<{ data: HarnessEventEnvelope[] }> {
    return { data: this.store.listEvents(sessionId) };
  }

  private async subscribeToTurn(sessionId: string, turnId: string): Promise<AsyncIterable<unknown>> {
    await this.store.ensureSession(sessionId);
    return this.store.subscribeToTurn(sessionId, turnId);
  }

  private async deleteSession(sessionId: string): Promise<unknown> {
    await this.store.ensureSession(sessionId);
    await this.closeSandbox(sessionId);
    this.store.deleteSession(sessionId);
    return { data: { id: sessionId, deleted: true } };
  }
}

function parseSpec(request: unknown): HarnessSessionSpec {
  const spec = isRecord(request) && isRecord(request.agent) && isRecord(request.agent.spec) ? request.agent.spec : {};
  const config = isRecord(spec.config) ? spec.config : {};
  const mcpServer = Array.isArray(spec.mcpServers) && isRecord(spec.mcpServers[0]) ? spec.mcpServers[0] : {};

  return {
    instructions: typeof spec.instructions === "string" ? spec.instructions : "",
    iterationLimit: typeof config.iterationLimit === "number" ? config.iterationLimit : defaultIterationLimit,
    enabledTools: stringArray(mcpServer.enableTools) ?? [
      "read_issue",
      "read_file",
      "submit_byter_result",
      "create_fix_pull_request"
    ],
    approvalRequiredTools: stringArray(mcpServer.requireApprovalForTools) ?? ["create_fix_pull_request"]
  };
}

/**
 * Recovers the reported title and body from the message `buildInitialUserMessage`
 * renders in packages/agent. Returns undefined rather than guessing if the expected
 * markers are missing, so a format change disables the scope check loudly instead of
 * silently feeding it prompt scaffolding.
 */
function parseIssueText(content: string): HarnessIssueText | undefined {
  const title = /^Title:[ \t]*(.+)$/m.exec(content)?.[1]?.trim();
  const body = /^Issue body:\n([\s\S]*?)(?:\n\nRequired proof path:|$)/m.exec(content)?.[1]?.trim();
  if (!title || body === undefined) return undefined;
  return { title, body };
}

function firstInput(request: unknown): Record<string, unknown> {
  const input = isRecord(request) && Array.isArray(request.input) ? request.input[0] : undefined;
  if (!isRecord(input)) {
    throw new Error("Harness turn request did not include an input entry");
  }
  return input;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length > 0 ? entries : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
