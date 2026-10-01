import { describe, expect, it, vi } from "vitest";
import { approvalPayloadHash, type GitHubRestClientLike } from "@squasher/github-mcp";
import { buildSquasherAgentSpec } from "@squasher/agent";
import { contributionDisclosureMarker, withContributionDisclosure } from "../src/agent-loop.js";
import { SquasherHarness } from "../src/harness-runtime.js";
import { SessionStore } from "../src/session-store.js";
import type { LlmClient, LlmResponse } from "../src/llm-client.js";
import type { SandboxClientLike } from "../src/sandbox-client.js";

const writeArguments = {
  owner: "upstream",
  repo: "project",
  baseBranch: "main",
  branchName: "squasher/fix-42-abc1234567",
  title: "Fix trailing slash handling",
  body: "Guards lastSegment against a trailing slash.",
  files: [{ path: "src/paths.ts", content: "export const fixed = true;\n" }]
};

const proofContract = {
  kind: "squasher.result",
  status: "patch-ready",
  summary: "The reported failure was reproduced three times and then fixed.",
  proof: {
    before: "3/3 runs failed with the reported error",
    after: "3/3 runs passed after the patch",
    regressions: "The focused regression suite passed",
    attempts: "3/3"
  },
  candidatePatch: {
    title: writeArguments.title,
    body: writeArguments.body,
    files: writeArguments.files
  }
};

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

function fakeGitHub(): GitHubRestClientLike {
  return {
    getIssue: vi.fn().mockResolvedValue({
      number: 42,
      title: "Crash",
      body: "It crashes",
      html_url: "https://github.test/upstream/project/issues/42",
      state: "open"
    }),
    getFile: vi.fn().mockResolvedValue({ path: "src/paths.ts", sha: "abc", encoding: "utf8", content: "code" }),
    getBranch: vi.fn().mockResolvedValue({ commit: { sha: "base-sha" } }),
    getCommit: vi.fn().mockResolvedValue({ tree: { sha: "tree-sha" } }),
    createTree: vi.fn().mockResolvedValue({ sha: "new-tree" }),
    createCommit: vi.fn().mockResolvedValue({ sha: "new-commit" }),
    createBranch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({ number: 7, html_url: "https://github.test/pull/7" }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ html_url: "https://github.test/c/1" }),
    createOrUpdateFile: vi.fn().mockResolvedValue(undefined)
  } as unknown as GitHubRestClientLike;
}

/** Runs one turn where the model submits proof and then requests the gated write. */
async function runWriteTurn(harness: SquasherHarness) {
  const spec = buildSquasherAgentSpec({ modelName: "deepseek-flash", modelProvider: "deepseek" });
  const created = (await harness.sessions.create({ agent: { spec } })) as { data: { id: string } };
  const turn = (await harness.sessions.createTurn(created.data.id, {
    input: [{ type: "user.message", content: "Analyze issue 42." }]
  })) as { data: { id: string } };

  const stream = await harness.sessions.subscribeToTurn(created.data.id, turn.data.id);
  const events: Array<Record<string, unknown>> = [];
  for await (const envelope of stream) {
    events.push((envelope as { event: Record<string, unknown> }).event);
  }

  return { sessionId: created.data.id, turnId: turn.data.id, events };
}

function writeScript() {
  return scriptedLlm([
    toolCallResponse([{ id: "call_1", name: "submit_squasher_result", arguments: proofContract }]),
    toolCallResponse([{ id: "call_2", name: "create_fix_pull_request", arguments: writeArguments }]),
    textResponse(JSON.stringify(proofContract))
  ]);
}

describe("write target policy", () => {
  it("leaves arguments untouched when no resolver is supplied", async () => {
    const store = new SessionStore({});
    const { llm } = writeScript();
    const harness = new SquasherHarness({ client: fakeGitHub(), llm, sandbox: fakeSandbox(), store });

    const { sessionId } = await runWriteTurn(harness);

    const pending = store.pending(sessionId);
    expect(pending?.name).toBe("create_fix_pull_request");
    expect(pending?.arguments.headOwner).toBeUndefined();
    expect(pending?.arguments.body).toBe(writeArguments.body);
  });

  it("stamps the fork owner into the paused arguments and the approval hash", async () => {
    const store = new SessionStore({});
    const { llm } = writeScript();
    const harness = new SquasherHarness({
      client: fakeGitHub(),
      llm,
      sandbox: fakeSandbox(),
      store,
      resolveWriteTarget: () => ({ allowed: true, headOwner: "contributor" })
    });

    const { sessionId } = await runWriteTurn(harness);

    const pending = store.pending(sessionId);
    expect(pending?.arguments.headOwner).toBe("contributor");
    // The recorded hash must be the hash of the stamped arguments, or the approved write
    // would be rejected later by assertApproved.
    expect(pending?.payloadHash).toBe(approvalPayloadHash("create_fix_pull_request", pending!.arguments));
  });

  it("discloses the automated contribution in the body the approver sees", async () => {
    const store = new SessionStore({});
    const { llm } = writeScript();
    const harness = new SquasherHarness({
      client: fakeGitHub(),
      llm,
      sandbox: fakeSandbox(),
      store,
      resolveWriteTarget: () => ({ allowed: true, headOwner: "contributor" })
    });

    const { sessionId } = await runWriteTurn(harness);

    const body = String(store.pending(sessionId)?.arguments.body);
    expect(body).toContain(writeArguments.body);
    expect(body).toContain("Automated contribution");
    expect(body).toContain("Please close it without hesitation");
  });

  it("discloses on a same-repository write when the repository's policy requires it", async () => {
    const store = new SessionStore({});
    const { llm } = writeScript();
    const harness = new SquasherHarness({
      client: fakeGitHub(),
      llm,
      sandbox: fakeSandbox(),
      store,
      resolveWriteTarget: () => ({ allowed: true, headOwner: "upstream", disclose: true })
    });

    const { sessionId } = await runWriteTurn(harness);
    const pending = store.pending(sessionId);

    expect(String(pending?.arguments.body)).toContain("Automated contribution");
    // Still a same-repository write: no fork owner is stamped.
    expect(pending?.arguments.headOwner).toBeUndefined();
  });

  it("does not disclose on a same-repository write", async () => {
    const store = new SessionStore({});
    const { llm } = writeScript();
    const harness = new SquasherHarness({
      client: fakeGitHub(),
      llm,
      sandbox: fakeSandbox(),
      store,
      resolveWriteTarget: () => ({ allowed: true, headOwner: "upstream" })
    });

    const { sessionId } = await runWriteTurn(harness);

    expect(store.pending(sessionId)?.arguments.body).toBe(writeArguments.body);
  });

  it("refuses the write without pausing, and keeps the submitted proof", async () => {
    const store = new SessionStore({});
    const { llm } = writeScript();
    const harness = new SquasherHarness({
      client: fakeGitHub(),
      llm,
      sandbox: fakeSandbox(),
      store,
      resolveWriteTarget: () => ({ allowed: false, reason: "upstream/project is not in SQUASHER_UPSTREAM_ALLOWLIST" })
    });

    const { sessionId, events } = await runWriteTurn(harness);

    // No approval checkpoint exists, so nothing can later be approved into that repository.
    expect(store.pending(sessionId)).toBeUndefined();
    expect(events.some((event) => event.type === "tool.approval_required")).toBe(false);

    const refusal = events.find(
      (event) => event.type === "tool.response" && String(event.content).includes("refused by contribution policy")
    );
    expect(refusal).toBeDefined();
    expect(String(refusal?.content)).toContain("SQUASHER_UPSTREAM_ALLOWLIST");

    // The turn still finishes with the proof intact rather than failing.
    expect(events.at(-1)).toMatchObject({ type: "turn.done", state: { status: "completed" } });
  });

  it("refuses the write when the policy lookup itself throws", async () => {
    const store = new SessionStore({});
    const { llm } = writeScript();
    const harness = new SquasherHarness({
      client: fakeGitHub(),
      llm,
      sandbox: fakeSandbox(),
      store,
      resolveWriteTarget: () => {
        throw new Error("probe exploded");
      }
    });

    const { sessionId, events } = await runWriteTurn(harness);

    expect(store.pending(sessionId)).toBeUndefined();
    expect(
      events.some((event) => event.type === "tool.response" && String(event.content).includes("probe exploded"))
    ).toBe(true);
  });
});

describe("contribution disclosure", () => {
  it("keeps the original body and appends the notice once", () => {
    const once = withContributionDisclosure("Fixes the crash.");
    const twice = withContributionDisclosure(once);

    expect(once).toContain("Fixes the crash.");
    expect(once).toContain(contributionDisclosureMarker);
    expect(twice).toBe(once);
    expect(twice.split(contributionDisclosureMarker)).toHaveLength(2);
  });

  it("states that a human approved the patch and that the PR is unsolicited", () => {
    const body = withContributionDisclosure("Body");

    expect(body).toContain("A human reviewed and approved this patch");
    expect(body).toContain("No maintainer requested this change");
  });
});

describe("approval checkpoint lifetime", () => {
  /** Drives one run to a paused write, then resolves that approval. */
  async function pauseThenApprove(options: { createPullRequest: ReturnType<typeof vi.fn> }) {
    const store = new SessionStore({});
    const github = fakeGitHub();
    github.createPullRequest = options.createPullRequest as never;
    const harness = new SquasherHarness({ client: github, llm: writeScript().llm, sandbox: fakeSandbox(), store });

    const { sessionId } = await runWriteTurn(harness);
    expect(store.pending(sessionId)).toBeDefined();

    const pending = store.pending(sessionId)!;
    await harness.sessions.createTurn(sessionId, {
      previousTurnId: pending.turnId,
      input: [
        {
          type: "user.tool_approval",
          toolCallId: pending.toolCallId,
          approval: { status: "allow" }
        }
      ]
    });

    // The write runs detached from the approval response, so let it settle.
    for (let attempt = 0; attempt < 200 && store.pending(sessionId) !== undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (options.createPullRequest.mock.calls.length > 0) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    return { store, sessionId, github };
  }

  it("keeps the approval pending when the write fails, so it can be retried", async () => {
    // The real failure: the dashboard held a token with no access to the fork, GitHub
    // answered 403, and the checkpoint was discarded anyway. Every later approval then
    // reported no pending call and the verified patch could never be written.
    const createPullRequest = vi.fn().mockRejectedValue(
      new Error('GitHub API 403 Forbidden: {"message":"Resource not accessible by personal access token"}')
    );
    const { store, sessionId } = await pauseThenApprove({ createPullRequest });

    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(store.pending(sessionId)).toBeDefined();
    expect(store.pending(sessionId)?.name).toBe("create_fix_pull_request");
  });

  it("releases the sandbox when the write fails, even though the approval stays open", async () => {
    // Keeping the checkpoint open skips runTurn's teardown, which only fires when nothing
    // is pending. A retry replays the GitHub write and needs no sandbox, so holding one
    // for a pause that may last hours would be a leak.
    const store = new SessionStore({});
    const sandbox = fakeSandbox();
    const github = fakeGitHub();
    github.createPullRequest = vi.fn().mockRejectedValue(new Error("GitHub API 403 Forbidden")) as never;
    // Runs a sandbox command first, so there is a live sandbox for the pause to hold.
    const { llm } = scriptedLlm([
      toolCallResponse([{ id: "call_0", name: "run_command", arguments: { command: "node repro.ts" } }]),
      toolCallResponse([{ id: "call_1", name: "submit_squasher_result", arguments: proofContract }]),
      toolCallResponse([{ id: "call_2", name: "create_fix_pull_request", arguments: writeArguments }]),
      textResponse(JSON.stringify(proofContract))
    ]);
    const harness = new SquasherHarness({ client: github, llm, sandbox, store });

    const { sessionId } = await runWriteTurn(harness);
    expect(sandbox.createSandbox).toHaveBeenCalled();
    const pending = store.pending(sessionId)!;
    await harness.sessions.createTurn(sessionId, {
      previousTurnId: pending.turnId,
      input: [{ type: "user.tool_approval", toolCallId: pending.toolCallId, approval: { status: "allow" } }]
    });
    for (let attempt = 0; attempt < 200 && (sandbox.closeSandbox as ReturnType<typeof vi.fn>).mock.calls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(store.pending(sessionId)).toBeDefined();
    expect(sandbox.closeSandbox).toHaveBeenCalled();
  });

  it("clears the approval once the write lands", async () => {
    const createPullRequest = vi.fn().mockResolvedValue({ number: 3, html_url: "https://github.test/pull/3" });
    const { store, sessionId } = await pauseThenApprove({ createPullRequest });

    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(store.pending(sessionId)).toBeUndefined();
  });

  it("clears the approval when the maintainer denies it", async () => {
    const store = new SessionStore({});
    const harness = new SquasherHarness({
      client: fakeGitHub(),
      llm: writeScript().llm,
      sandbox: fakeSandbox(),
      store
    });
    const { sessionId } = await runWriteTurn(harness);
    const pending = store.pending(sessionId)!;

    await harness.sessions.createTurn(sessionId, {
      previousTurnId: pending.turnId,
      input: [
        {
          type: "user.tool_approval",
          toolCallId: pending.toolCallId,
          approval: { status: "deny", reason: "Not wanted" }
        }
      ]
    });

    // A denial genuinely resolves the checkpoint: there is nothing left to write.
    expect(store.pending(sessionId)).toBeUndefined();
  });
});
