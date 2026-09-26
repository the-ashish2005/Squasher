import { describe, expect, it, vi } from "vitest";
import { approvalPayloadHash, type GitHubRestClientLike } from "@byter/github-mcp";
import { buildByterAgentSpec } from "@byter/agent";
import { ByterHarness } from "../src/harness-runtime.js";
import { guardEventType, SessionStore } from "../src/session-store.js";
import type { LlmClient, LlmResponse } from "../src/llm-client.js";
import type { SandboxClientLike } from "../src/sandbox-client.js";

const writeArguments = {
  owner: "o",
  repo: "r",
  baseBranch: "main",
  branchName: "byter/fix-7-abc1234567",
  title: "Fix trailing escape crash",
  body: "Guards the tokenizer against a trailing backslash.",
  files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
};

const proofContract = {
  kind: "byter.result",
  status: "patch-ready",
  summary: "The reported tokenizer failure was reproduced three times and then fixed.",
  proof: {
    before: "3/3 runs failed with the trailing escape error",
    after: "3/3 runs passed after the patch",
    regressions: "The focused regression suite passed",
    attempts: "3/3"
  },
  candidatePatch: {
    title: "Fix trailing escape crash",
    body: "Guards the tokenizer against a trailing backslash.",
    files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
  }
};

/** Returns a scripted LLM whose turns are consumed in order. */
function scriptedLlm(responses: LlmResponse[]) {
  const complete = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Scripted LLM ran out of responses");
    return next;
  });
  return { llm: { complete } as unknown as LlmClient, complete };
}

function toolCallResponse(calls: Array<{ id: string; name: string; arguments: unknown }>): LlmResponse {
  return {
    text: "",
    finishReason: "tool_calls",
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments)
    }))
  };
}

function textResponse(text: string): LlmResponse {
  return { text, finishReason: "stop", toolCalls: [] };
}

function fakeSandbox(): SandboxClientLike {
  return {
    createSandbox: vi.fn().mockResolvedValue("sbx_1"),
    runCommand: vi.fn().mockResolvedValue({ stdout: "3/3 failed", stderr: "", exitCode: 1 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

function fakeGitHub(overrides: Partial<GitHubRestClientLike> = {}): GitHubRestClientLike {
  return {
    getIssue: vi.fn().mockResolvedValue({
      number: 7,
      title: "Crash",
      body: "It crashes",
      html_url: "https://github.test/o/r/issues/7",
      state: "open"
    }),
    getFile: vi.fn().mockResolvedValue({ path: "src/tokenizer.ts", sha: "abc", encoding: "utf8", content: "code" }),
    getBranch: vi.fn().mockResolvedValue({ commit: { sha: "base-sha" } }),
    getCommit: vi.fn().mockResolvedValue({ tree: { sha: "tree-sha" } }),
    createTree: vi.fn().mockResolvedValue({ sha: "new-tree" }),
    createCommit: vi.fn().mockResolvedValue({ sha: "new-commit" }),
    createBranch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({ number: 42, html_url: "https://github.test/o/r/pull/42" }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ html_url: "https://github.test/c/1" }),
    createOrUpdateFile: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as GitHubRestClientLike;
}

async function startSession(harness: ByterHarness) {
  const spec = buildByterAgentSpec({ modelName: "deepseek-v4-pro", modelProvider: "deepseek" });
  const created = (await harness.sessions.create({ agent: { spec } })) as { data: { id: string } };
  const turn = (await harness.sessions.createTurn(created.data.id, {
    input: [{ type: "user.message", content: "Analyze issue 7." }]
  })) as { data: { id: string } };
  return { sessionId: created.data.id, turnId: turn.data.id };
}

async function drain(harness: ByterHarness, sessionId: string, turnId: string) {
  const stream = await harness.sessions.subscribeToTurn(sessionId, turnId);
  const events: Array<Record<string, unknown>> = [];
  for await (const envelope of stream) {
    events.push((envelope as { event: Record<string, unknown> }).event);
  }
  return events;
}

describe("byter harness runtime", () => {
  it("returns a session id in the shape the agent runtime normalizes", async () => {
    const { llm } = scriptedLlm([textResponse("done")]);
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox() });

    const created = (await harness.sessions.create({
      agent: { spec: buildByterAgentSpec({ modelName: "m" }) }
    })) as { data: { id: string; title: string | null } };

    expect(created.data.id).toMatch(/^sess_/);
    expect(created.data.title).toBeNull();
  });

  it("seeds the system prompt from the agent spec instructions", async () => {
    const { llm, complete } = scriptedLlm([textResponse("done")]);
    const store = new SessionStore({});
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox(), store });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);

    const messages = complete.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("You are Byter, CI for bug reports.");
    expect(messages[1]?.content).toContain("Analyze issue 7.");
    expect(store.messages(sessionId)).not.toHaveLength(0);
  });

  it("records a successful sandbox tool call as a sandbox-shaped tool response", async () => {
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_1", name: "run_command", arguments: { command: "node repro.ts" } }]),
      textResponse("observed the failure")
    ]);
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox() });

    const { sessionId, turnId } = await startSession(harness);
    const events = await drain(harness, sessionId, turnId);

    const toolResponse = events.find((event) => event.type === "tool.response");
    expect(toolResponse?.toolCallId).toBe("call_1");
    expect(JSON.parse(String(toolResponse?.content))).toMatchObject({ exitCode: 1, stdout: "3/3 failed" });
    expect(events.some((event) => event.type === "sandbox.created")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn.done", state: { status: "completed" } });
  });

  it("records a failed tool call without ending the turn", async () => {
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_1", name: "read_issue", arguments: { owner: "o", repo: "r", issueNumber: 7 } }]),
      textResponse("gave up")
    ]);
    const harness = new ByterHarness({
      client: fakeGitHub({ getIssue: vi.fn().mockRejectedValue(new Error("GitHub 404")) }),
      llm,
      sandbox: fakeSandbox()
    });

    const { sessionId, turnId } = await startSession(harness);
    const events = await drain(harness, sessionId, turnId);

    const toolResponse = events.find((event) => event.type === "tool.response");
    expect(JSON.parse(String(toolResponse?.content)).error).toContain("GitHub 404");
    expect(events.at(-1)).toMatchObject({ type: "turn.done", state: { status: "completed" } });
  });

  it("pauses the GitHub write for approval without emitting turn.done", async () => {
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_submit", name: "submit_byter_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }])
    ]);
    const github = fakeGitHub();
    const store = new SessionStore({});
    const harness = new ByterHarness({ client: github, llm, sandbox: fakeSandbox(), store });

    const { sessionId, turnId } = await startSession(harness);
    const events = await drain(harness, sessionId, turnId);

    const approval = events.find((event) => event.type === "tool.approval_required");
    expect(approval).toBeDefined();
    expect(approval?.threadId).toBe("main");
    expect(approval?.toolCalls).toEqual([
      { id: "call_write", sourceEventId: expect.stringMatching(/^evt_/) }
    ]);

    // The paused turn must not also look completed, or the server requests a
    // redundant proof-contract continuation.
    expect(events.some((event) => event.type === "turn.done")).toBe(false);
    expect(github.createPullRequest).not.toHaveBeenCalled();

    const pending = store.pending(sessionId);
    expect(pending?.name).toBe("create_fix_pull_request");
    expect(pending?.payloadHash).toBe(approvalPayloadHash("create_fix_pull_request", writeArguments));

    // The approval event must reference the model.message that carried the call.
    const sourceEventId = (approval?.toolCalls as Array<{ sourceEventId: string }>)[0]!.sourceEventId;
    const source = events.find((event) => event.id === sourceEventId);
    expect(source?.type).toBe("model.message");
  });

  it("executes the write on approval and reports the pull request receipt", async () => {
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_submit", name: "submit_byter_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }]),
      textResponse(JSON.stringify(proofContract))
    ]);
    const github = fakeGitHub();
    const harness = new ByterHarness({ client: github, llm, sandbox: fakeSandbox() });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);

    const approvalTurn = (await harness.sessions.createTurn(sessionId, {
      previousTurnId: turnId,
      input: [
        { type: "user.tool_approval", threadId: "main", toolCallId: "call_write", approval: { status: "allow" } }
      ]
    })) as { data: { id: string } };
    const events = await drain(harness, sessionId, approvalTurn.data.id);

    expect(github.createPullRequest).toHaveBeenCalledTimes(1);

    // parsePullRequestFromTrueForgeEvents matches on toolCallId then finds {number,url}.
    const receipt = events.find((event) => event.type === "tool.response" && event.toolCallId === "call_write");
    expect(receipt).toBeDefined();
    expect(JSON.parse(String(receipt?.content))).toMatchObject({
      number: 42,
      url: "https://github.test/o/r/pull/42"
    });
  });

  it("rejects an approval whose stored payload no longer hashes to the paused value", async () => {
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_submit", name: "submit_byter_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }])
    ]);
    const github = fakeGitHub();
    const store = new SessionStore({});
    const harness = new ByterHarness({ client: github, llm, sandbox: fakeSandbox(), store });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);

    // Simulate tampering between the pause and the approval.
    const pending = store.pending(sessionId)!;
    store.setPending(sessionId, {
      ...pending,
      arguments: { ...writeArguments, files: [{ path: "src/evil.ts", content: "malicious" }] }
    });

    await expect(
      harness.sessions.createTurn(sessionId, {
        input: [
          { type: "user.tool_approval", threadId: "main", toolCallId: "call_write", approval: { status: "allow" } }
        ]
      })
    ).rejects.toThrow(/approval payload hash mismatch/);

    expect(github.createPullRequest).not.toHaveBeenCalled();
  });

  it("rejects an approval that references a different tool call", async () => {
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_submit", name: "submit_byter_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }])
    ]);
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox() });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);

    await expect(
      harness.sessions.createTurn(sessionId, {
        input: [
          { type: "user.tool_approval", threadId: "main", toolCallId: "call_other", approval: { status: "allow" } }
        ]
      })
    ).rejects.toThrow(/does not reference the paused/);
  });

  it("denies the write without touching GitHub", async () => {
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_submit", name: "submit_byter_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }])
    ]);
    const github = fakeGitHub();
    const harness = new ByterHarness({ client: github, llm, sandbox: fakeSandbox() });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);

    const denialTurn = (await harness.sessions.createTurn(sessionId, {
      input: [
        {
          type: "user.tool_approval",
          threadId: "main",
          toolCallId: "call_write",
          approval: { status: "deny", reason: "Not this patch" }
        }
      ]
    })) as { data: { id: string } };
    const events = await drain(harness, sessionId, denialTurn.data.id);

    expect(github.createPullRequest).not.toHaveBeenCalled();
    expect(JSON.parse(String(events.find((event) => event.type === "tool.response")?.content))).toMatchObject({
      denied: true,
      reason: "Not this patch"
    });
    expect(events.at(-1)).toMatchObject({ type: "turn.done", state: { status: "completed" } });
  });

  it("sends one corrective retry for a malformed proof contract and logs the failure", async () => {
    const broken = { ...proofContract, proof: { ...proofContract.proof, attempts: "1/3" } };
    const { llm, complete } = scriptedLlm([
      toolCallResponse([{ id: "call_1", name: "submit_byter_result", arguments: broken }]),
      toolCallResponse([{ id: "call_2", name: "submit_byter_result", arguments: proofContract }]),
      textResponse("done")
    ]);
    const store = new SessionStore({});
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox(), store });

    const { sessionId, turnId } = await startSession(harness);
    const events = await drain(harness, sessionId, turnId);

    const guardEvents = events.filter((event) => event.type === guardEventType);
    expect(guardEvents).toHaveLength(1);
    expect(guardEvents[0]).toMatchObject({ outcome: "retrying", toolName: "submit_byter_result", attempt: 1 });
    expect(String(guardEvents[0]?.problem)).toContain("proof.attempts");

    // The correction message quoting the schema must reach the model.
    const secondCall = complete.mock.calls[1]?.[0] as Array<{ role: string; content: string }>;
    expect(secondCall.at(-1)?.role).toBe("user");
    expect(secondCall.at(-1)?.content).toContain('"kind": "byter.result"');

    expect(events.at(-1)).toMatchObject({ type: "turn.done", state: { status: "completed" } });
  });

  it("fails the turn after a second malformed structured output instead of coercing it", async () => {
    const broken = { ...proofContract, proof: { ...proofContract.proof, attempts: "1/3" } };
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_1", name: "submit_byter_result", arguments: broken }]),
      toolCallResponse([{ id: "call_2", name: "submit_byter_result", arguments: broken }])
    ]);
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox() });

    const { sessionId, turnId } = await startSession(harness);
    const events = await drain(harness, sessionId, turnId);

    const done = events.at(-1);
    expect(done).toMatchObject({ type: "turn.done", state: { status: "error" } });
    expect(String((done?.state as { message: string }).message)).toContain("Malformed structured output after retry");

    const guardEvents = events.filter((event) => event.type === guardEventType);
    expect(guardEvents.map((event) => event.outcome)).toEqual(["retrying", "failed"]);
  });

  it("fails cleanly when the iteration limit is exhausted", async () => {
    const responses = Array.from({ length: 10 }, (_unused, index) =>
      toolCallResponse([{ id: `call_${index}`, name: "run_command", arguments: { command: "echo loop" } }])
    );
    const { llm } = scriptedLlm(responses);
    const store = new SessionStore({});
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox(), store });

    const created = (await harness.sessions.create({
      agent: {
        spec: { ...buildByterAgentSpec({ modelName: "m" }), config: { iterationLimit: 3 } }
      }
    })) as { data: { id: string } };
    const turn = (await harness.sessions.createTurn(created.data.id, {
      input: [{ type: "user.message", content: "loop forever" }]
    })) as { data: { id: string } };

    const events = await drain(harness, created.data.id, turn.data.id);
    const done = events.at(-1);

    expect(done).toMatchObject({ type: "turn.done", state: { status: "error" } });
    expect(String((done?.state as { message: string }).message)).toContain("iteration limit of 3");
  });

  it("phrases a rate limit so the server treats it as recoverable", async () => {
    const complete = vi.fn().mockRejectedValue(
      Object.assign(new Error("Model rate limit exceeded after 3 attempts"), { name: "LlmRateLimitError" })
    );
    const llm = { complete } as unknown as LlmClient;
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox() });

    const { sessionId, turnId } = await startSession(harness);
    const events = await drain(harness, sessionId, turnId);

    const done = events.at(-1);
    expect(done).toMatchObject({ type: "turn.done", state: { status: "error" } });
    expect(String((done?.state as { message: string }).message)).toMatch(/Model request failed/);
  });

  it("tears down the sandbox when a turn ends but keeps it while paused", async () => {
    const sandbox = fakeSandbox();
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_1", name: "run_command", arguments: { command: "node repro.ts" } }]),
      toolCallResponse([{ id: "call_submit", name: "submit_byter_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }])
    ]);
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);

    // Paused for approval, so the sandbox is still held.
    expect(sandbox.closeSandbox).not.toHaveBeenCalled();

    const denialTurn = (await harness.sessions.createTurn(sessionId, {
      input: [
        { type: "user.tool_approval", threadId: "main", toolCallId: "call_write", approval: { status: "deny" } }
      ]
    })) as { data: { id: string } };
    await drain(harness, sessionId, denialTurn.data.id);

    expect(sandbox.closeSandbox).toHaveBeenCalledWith("sbx_1");
  });

  it("closes the sandbox and drops state on session delete", async () => {
    const sandbox = fakeSandbox();
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_1", name: "run_command", arguments: { command: "echo hi" } }]),
      toolCallResponse([{ id: "call_submit", name: "submit_byter_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }])
    ]);
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);
    await harness.sessions.delete(sessionId);

    expect(sandbox.closeSandbox).toHaveBeenCalledWith("sbx_1");
    await expect(harness.sessions.createTurn(sessionId, { input: [{ type: "user.message", content: "x" }] })).rejects.toThrow(
      /Unknown harness session/
    );
  });

  it("lists persisted events under a data wrapper for the agent runtime", async () => {
    const { llm } = scriptedLlm([textResponse("done")]);
    const harness = new ByterHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox() });

    const { sessionId, turnId } = await startSession(harness);
    await drain(harness, sessionId, turnId);

    const listed = (await harness.sessions.listEvents(sessionId)) as {
      data: Array<{ sequenceNumber: number; event: Record<string, unknown> }>;
    };

    expect(Array.isArray(listed.data)).toBe(true);
    expect(listed.data[0]?.sequenceNumber).toBe(1);
    expect(listed.data[0]?.event.type).toBe("turn.created");
  });
});
