import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "@squasher/github";
import { SquasherTrueForgeRuntime } from "@squasher/agent";
import { SquasherHarness } from "@squasher/harness";
import type { LlmClient, LlmResponse } from "@squasher/harness";
import { createSquasherServer } from "../src/server.js";

/**
 * End-to-end dry run: a real GitHub webhook drives the real SquasherHarness through the
 * real server, with only the model and the sandbox mocked. This is the proof that the
 * harness's event stream satisfies the existing server parsers unchanged.
 */

const deliveryId = "delivery-harness-e2e-31";
const issueNumber = 31;
const branchName = `squasher/fix-${issueNumber}-${createHash("sha256").update(deliveryId).digest("hex").slice(0, 10)}`;

const patchFiles = [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }];

const proofContract = {
  kind: "squasher.result",
  status: "patch-ready",
  summary: "The trailing escape crash was reproduced 3/3 times and the patch fixes it.",
  proof: {
    before: "3/3 runs of `node --experimental-strip-types repro.ts` failed with the trailing escape error",
    after: "3/3 runs passed after applying the tokenizer guard",
    regressions: "The focused tokenizer regression suite passed 3/3",
    attempts: "3/3"
  },
  candidatePatch: {
    title: "Fix trailing escape crash in tokenizer",
    body: "Guards the tokenizer against a trailing backslash so it no longer throws.",
    files: patchFiles
  }
};

const writeArguments = {
  owner: "o",
  repo: "r",
  baseBranch: "main",
  branchName,
  title: proofContract.candidatePatch.title,
  body: proofContract.candidatePatch.body,
  files: patchFiles
};

/** Reads the newest persisted webhook run, which keeps the private approval fields. */
async function readLatestPersistedRecord(dataDir: string): Promise<any> {
  const contents = await readFile(join(dataDir, "webhook-runs.jsonl"), "utf8");
  const lines = contents.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!);
}

function toolCalls(calls: Array<{ id: string; name: string; arguments: unknown }>): LlmResponse {
  return {
    text: "",
    finishReason: "tool_calls",
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    }))
  };
}

/** Scripts the full evidence-first workflow the system prompt asks for. */
function scriptedModel() {
  const responses: LlmResponse[] = [
    toolCalls([{ id: "call_issue", name: "read_issue", arguments: { owner: "o", repo: "r", issueNumber } }]),
    toolCalls([{ id: "call_read", name: "read_file", arguments: { owner: "o", repo: "r", path: "src/tokenizer.ts" } }]),
    // Must mention a runner and a reproducer for the server's hasExecutableProof check.
    toolCalls([
      {
        id: "call_repro",
        name: "run_command",
        arguments: {
          command: "node --experimental-strip-types repro.ts && node --experimental-strip-types repro.ts",
          files: [{ path: "repro.ts", content: "throw new Error('trailing escape')" }]
        }
      }
    ]),
    toolCalls([{ id: "call_verify", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }]),
    toolCalls([{ id: "call_submit", name: "submit_squasher_result", arguments: proofContract }]),
    toolCalls([{ id: "call_write", name: "create_fix_pull_request", arguments: writeArguments }])
  ];

  const complete = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Scripted model ran out of responses");
    return next;
  });

  return { llm: { complete } as unknown as LlmClient, complete };
}

function fakeSandbox() {
  return {
    createSandbox: vi.fn().mockResolvedValue("sbx_e2e"),
    // Exit code 0 so the trace carries a passed sandbox command.
    runCommand: vi.fn().mockResolvedValue({
      stdout: "reproducer executed 3/3 matching runs",
      stderr: "",
      exitCode: 0
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

function fakeGitHubClient() {
  return {
    getIssue: vi.fn().mockResolvedValue({
      number: issueNumber,
      title: "Parser crash with trailing escape",
      body: "Trailing escape crashes the parser.",
      html_url: `https://github.test/o/r/issues/${issueNumber}`,
      state: "open"
    }),
    getFile: vi.fn().mockResolvedValue({
      path: "src/tokenizer.ts",
      sha: "base-file-sha",
      encoding: "utf8",
      content: "export const fixed = false;\n"
    }),
    getBranch: vi.fn().mockResolvedValue({ commit: { sha: "base-sha" } }),
    getCommit: vi.fn().mockResolvedValue({ tree: { sha: "base-tree" } }),
    createTree: vi.fn().mockResolvedValue({ sha: "new-tree" }),
    createCommit: vi.fn().mockResolvedValue({ sha: "new-commit" }),
    createBranch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({ number: 77, html_url: "https://github.test/o/r/pull/77" }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    createLabel: vi.fn().mockResolvedValue(undefined),
    updateLabel: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ id: 900, html_url: "https://github.test/c/900" }),
    updateIssueComment: vi
      .fn()
      .mockImplementation(async (_o: string, _r: string, id: number) => ({ id, html_url: "https://github.test/c/900" })),
    createOrUpdateFile: vi.fn().mockResolvedValue(undefined)
  };
}

const issuePayload = JSON.stringify({
  action: "opened",
  issue: {
    number: issueNumber,
    title: "Parser crash with trailing escape",
    body: "Trailing escape crashes the parser.",
    html_url: `https://github.test/o/r/issues/${issueNumber}`
  },
  repository: {
    name: "r",
    full_name: "o/r",
    default_branch: "main",
    owner: { login: "o" }
  }
});

describe("Squasher harness end to end", () => {
  let dataDir: string;
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.SQUASHER_REQUIRE_TRIGGER_LABEL;
    delete process.env.MCP_AUTH_TOKEN;
    // Keep an injected harness authoritative even if real keys are in the shell.
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    staticDir = await mkdtemp(join(tmpdir(), "squasher-static-"));
    dataDir = await mkdtemp(join(tmpdir(), "squasher-data-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  it("reaches awaiting-approval from a webhook without calling DeepSeek or E2B", async () => {
    const { llm, complete } = scriptedModel();
    const sandbox = fakeSandbox();
    const githubClient = fakeGitHubClient();
    const harness = new SquasherHarness({ client: githubClient as never, llm, sandbox, dataDir });
    const trueForgeRuntime = new SquasherTrueForgeRuntime(
      { modelName: "deepseek-v4-pro", modelProvider: "deepseek" },
      harness
    );

    const server = createSquasherServer({
      staticDir,
      dataDir,
      trueForgeRuntime,
      githubClient: githubClient as never
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const response = await fetch(`${baseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": deliveryId,
          "X-Hub-Signature-256": signWebhookPayload(issuePayload, "webhook-secret")
        },
        body: issuePayload
      });

      expect(response.status).toBe(202);

      let latest: any;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        latest = await fetch(`${baseUrl}/api/runs/latest`).then((result) => result.json());
        if (latest.trueForge?.status === "paused" || latest.run?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // The run must be parked at the approval gate, not completed or failed.
      expect(latest.trueForge.error).toBeUndefined();
      expect(latest.trueForge.status).toBe("paused");
      expect(latest.run.status).toBe("awaiting-approval");

      // The server extracted the proof contract from the harness's tool-call event.
      expect(latest.trueForge.result.status).toBe("patch-ready");
      expect(latest.trueForge.result.proof.attempts).toBe("3/3");
      expect(latest.trueForge.result.candidatePatch.files).toEqual(patchFiles);
      expect(latest.trueForge.result.candidatePatch.branchName).toBe(branchName);

      // pendingApproval is stripped from the public payload, so assert it on the
      // persisted record the approval endpoint actually reads.
      const persisted = await readLatestPersistedRecord(dataDir);
      expect(persisted.trueForge.pendingApproval.toolName).toBe("create_fix_pull_request");
      expect(persisted.trueForge.pendingApproval.toolCallId).toBe("call_write");
      expect(persisted.trueForge.pendingApproval.threadId).toBe("main");
      expect(persisted.trueForge.pendingApproval.payloadHash).toBe(persisted.trueForge.result.candidatePatch.hash);

      // The trace was projected into dashboard events, including sandbox activity.
      const categories = latest.trueForge.events.map((event: { category: string }) => event.category);
      expect(categories).toContain("sandbox");
      expect(categories).toContain("mcp");
      expect(categories).toContain("approval");

      // Nothing was written to GitHub before approval.
      expect(githubClient.createPullRequest).not.toHaveBeenCalled();
      expect(githubClient.createBranch).not.toHaveBeenCalled();

      // No real provider was contacted.
      expect(complete).toHaveBeenCalledTimes(6);
      expect(sandbox.createSandbox).toHaveBeenCalledTimes(1);

      // Approving resumes the paused call and opens the draft pull request.
      const approval = await fetch(`${baseUrl}/api/approvals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer approval-token"
        },
        body: JSON.stringify({
          actionId: "approve-pr",
          runId: latest.run.id,
          patchHash: latest.trueForge.result.candidatePatch.hash
        })
      });
      const receipt = await approval.json();

      expect(approval.status).toBe(200);
      expect(receipt.resultStatus).toBe("pr-created");
      expect(receipt.pullRequest).toEqual({ number: 77, url: "https://github.test/o/r/pull/77" });
      expect(githubClient.createPullRequest).toHaveBeenCalledTimes(1);
      expect(githubClient.createPullRequest.mock.calls[0]?.[2]).toMatchObject({
        head: branchName,
        base: "main",
        draft: true
      });

      // The sandbox was torn down; nothing is left running.
      expect(sandbox.closeSandbox).toHaveBeenCalledWith("sbx_e2e");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }, 30_000);
});
