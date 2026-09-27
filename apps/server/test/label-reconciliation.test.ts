import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "@byter/github";
import { ByterTrueForgeRuntime } from "@byter/agent";
import { ByterHarness } from "@byter/harness";
import type { LlmClient, LlmResponse } from "@byter/harness";
import { createByterServer } from "../src/server.js";

/**
 * Byter labels used to be add-only outside the reconciled lifecycle set, so running one
 * issue twice left the first run's claims behind. Observed on a public repo: an issue
 * carried byter:verified and byter:not-reproduced at the same time, publicly asserting a
 * proof that the second run had disproved.
 */

const issueNumber = 42;
const patchFiles = [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }];

const provenResult = {
  kind: "byter.result",
  status: "patch-ready",
  summary: "The trailing escape crash was reproduced 3/3 times and the patch fixes it.",
  proof: {
    before: "3/3 runs failed with the trailing escape error",
    after: "3/3 runs passed after the patch",
    regressions: "The focused regression suite passed",
    attempts: "3/3"
  },
  candidatePatch: {
    title: "Fix trailing escape crash",
    body: "Guards the tokenizer against a trailing backslash.",
    files: patchFiles
  }
};

const notReproducedResult = {
  kind: "byter.result",
  status: "not-reproduced",
  summary: "A second look found no observable failure in the reported environment.",
  proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "0/3" },
  candidatePatch: null
};

function toolCallResponse(calls: Array<{ id: string; name: string; arguments: unknown }>): LlmResponse {
  return {
    text: "",
    finishReason: "tool_calls",
    toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
  };
}

function textResponse(text: string): LlmResponse {
  return { text, finishReason: "stop", toolCalls: [] };
}

function scriptedLlm(responses: LlmResponse[]) {
  const complete = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Scripted model ran out of responses");
    return next;
  });
  return { complete } as unknown as LlmClient;
}

function fakeSandbox() {
  return {
    createSandbox: vi.fn().mockResolvedValue("sbx_label"),
    runCommand: vi.fn().mockResolvedValue({
      stdout: "the focused reproducer ran 3/3 matching attempts",
      stderr: "",
      exitCode: 0
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

/** Tracks the labels GitHub would actually hold after adds and removes. */
function labelTrackingGitHub() {
  const labels = new Set<string>();
  return {
    labels,
    client: {
      getIssue: vi.fn().mockResolvedValue({
        number: issueNumber,
        title: "Tokenizer crashes on a trailing escape",
        body: "It throws a TypeError on a trailing backslash.",
        html_url: `https://github.test/o/r/issues/${issueNumber}`,
        state: "open"
      }),
      getFile: vi.fn().mockResolvedValue({
        path: "src/tokenizer.ts",
        sha: "sha",
        encoding: "utf8",
        content: "export const fixed = false;\n"
      }),
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "base-sha" } }),
      getCommit: vi.fn().mockResolvedValue({ tree: { sha: "base-tree" } }),
      createTree: vi.fn().mockResolvedValue({ sha: "tree" }),
      createCommit: vi.fn().mockResolvedValue({ sha: "commit" }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({ number: 9, html_url: "https://github.test/pull/9" }),
      addLabels: vi.fn(async (_o: string, _r: string, _n: number, names: string[]) => {
        for (const name of names) labels.add(name);
      }),
      removeLabel: vi.fn(async (_o: string, _r: string, _n: number, name: string) => {
        labels.delete(name);
      }),
      createLabel: vi.fn().mockResolvedValue(undefined),
      updateLabel: vi.fn().mockResolvedValue(undefined),
      createIssueComment: vi.fn().mockResolvedValue({ id: 1, html_url: "https://github.test/c/1" }),
      updateIssueComment: vi.fn(async (_o: string, _r: string, id: number) => ({ id, html_url: "https://github.test/c/1" })),
      createOrUpdateFile: vi.fn().mockResolvedValue(undefined)
    }
  };
}

function payloadFor(delivery: string) {
  return JSON.stringify({
    action: "opened",
    issue: {
      number: issueNumber,
      title: "Tokenizer crashes on a trailing escape",
      body: `It throws a TypeError on a trailing backslash. (${delivery})`,
      html_url: `https://github.test/o/r/issues/${issueNumber}`
    },
    repository: { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } }
  });
}

describe("Byter label reconciliation", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.BYTER_REQUIRE_TRIGGER_LABEL;
    staticDir = await mkdtemp(join(tmpdir(), "byter-label-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  async function runOnce(
    dataDir: string,
    github: ReturnType<typeof labelTrackingGitHub>,
    result: unknown,
    delivery: string
  ) {
    const branchName = `byter/fix-${issueNumber}-${createHash("sha256").update(delivery).digest("hex").slice(0, 10)}`;
    const wantsWrite = (result as { status?: string }).status === "patch-ready";
    const llm = scriptedLlm([
      toolCallResponse([
        { id: "c1", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }
      ]),
      toolCallResponse([{ id: "c2", name: "submit_byter_result", arguments: result }]),
      ...(wantsWrite
        ? [
            toolCallResponse([
              {
                id: "c3",
                name: "create_fix_pull_request",
                arguments: {
                  owner: "o",
                  repo: "r",
                  baseBranch: "main",
                  branchName,
                  title: provenResult.candidatePatch!.title,
                  body: provenResult.candidatePatch!.body,
                  files: patchFiles
                }
              }
            ])
          ]
        : [textResponse("done")])
    ]);
    const harness = new ByterHarness({ client: github.client as never, llm, sandbox: fakeSandbox() });
    const server = createByterServer({
      staticDir,
      dataDir,
      trueForgeRuntime: new ByterTrueForgeRuntime({ modelName: "deepseek-flash" }, harness),
      githubClient: github.client as never
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const body = payloadFor(delivery);

    try {
      await fetch(`http://127.0.0.1:${port}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256": signWebhookPayload(body, "webhook-secret")
        },
        body
      });

      for (let attempt = 0; attempt < 80; attempt += 1) {
        const latest = await fetch(`http://127.0.0.1:${port}/api/runs/latest`).then((r) => r.json());
        if (["paused", "completed", "failed"].includes(latest?.trueForge?.status)) return latest;
        await new Promise((wait) => setTimeout(wait, 20));
      }
      throw new Error("run did not settle");
    } finally {
      await new Promise<void>((closed) => server.close((e) => (e ? closed() : closed())));
    }
  }

  it("retracts byter:verified when a later run no longer reproduces the bug", async () => {
    const github = labelTrackingGitHub();

    const first = await runOnce(await mkdtemp(join(tmpdir(), "byter-label-a-")), github, provenResult, "label-run-1");
    expect(first.run.status).toBe("awaiting-approval");
    expect([...github.labels].sort()).toEqual(["byter:awaiting-approval", "byter:verified"]);

    // A second run over the same issue reaches the opposite verdict.
    const second = await runOnce(
      await mkdtemp(join(tmpdir(), "byter-label-b-")),
      github,
      notReproducedResult,
      "label-run-2"
    );
    expect(second.run.status).toBe("not-reproduced");

    // The stale claims must be gone, not merely joined by a contradicting one.
    expect(github.labels.has("byter:verified")).toBe(false);
    expect(github.labels.has("byter:awaiting-approval")).toBe(false);
    expect(github.labels.has("byter:not-reproduced")).toBe(true);
  }, 30_000);

  it("keeps byter:verified once a pull request exists", async () => {
    const github = labelTrackingGitHub();
    const dataDir = await mkdtemp(join(tmpdir(), "byter-label-c-"));

    const latest = await runOnce(dataDir, github, provenResult, "label-run-3");
    expect(latest.run.status).toBe("awaiting-approval");

    const approval = await (async () => {
      const server = createByterServer({ staticDir, dataDir, githubClient: github.client as never });
      await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
      const { port } = server.address() as AddressInfo;
      try {
        return await fetch(`http://127.0.0.1:${port}/api/approvals`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
          body: JSON.stringify({
            actionId: "reject-run",
            runId: latest.run.id,
            patchHash: latest.trueForge.result.candidatePatch.hash
          })
        }).then((r) => r.json());
      } finally {
        await new Promise<void>((closed) => server.close(() => closed()));
      }
    })();

    expect(approval.resultStatus).toBeDefined();
    // Rejecting the patch does not unmake the reproduction.
    expect(github.labels.has("byter:verified")).toBe(true);
    expect(github.labels.has("byter:awaiting-approval")).toBe(false);
  }, 30_000);

  it("never labels a refused patch as verified", async () => {
    // hasGenuineProof is satisfied by the proof text alone, so the run status has to gate
    // the claim: this result is well formed but arrives with no approval checkpoint.
    const github = labelTrackingGitHub();
    const llm = scriptedLlm([
      toolCallResponse([
        { id: "c1", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }
      ]),
      toolCallResponse([{ id: "c2", name: "submit_byter_result", arguments: provenResult }]),
      // Ends without ever requesting the gated write, so no approval checkpoint exists.
      textResponse(JSON.stringify(provenResult))
    ]);
    const harness = new ByterHarness({ client: github.client as never, llm, sandbox: fakeSandbox() });
    const dataDir = await mkdtemp(join(tmpdir(), "byter-label-d-"));
    const server = createByterServer({
      staticDir,
      dataDir,
      trueForgeRuntime: new ByterTrueForgeRuntime({ modelName: "deepseek-flash" }, harness),
      githubClient: github.client as never
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const body = payloadFor("label-run-4");

    try {
      await fetch(`http://127.0.0.1:${port}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "label-run-4",
          "X-Hub-Signature-256": signWebhookPayload(body, "webhook-secret")
        },
        body
      });
      let latest: any;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        latest = await fetch(`http://127.0.0.1:${port}/api/runs/latest`).then((r) => r.json());
        if (["paused", "completed", "failed"].includes(latest?.trueForge?.status)) break;
        await new Promise((wait) => setTimeout(wait, 20));
      }
      expect(latest.run.status).toBe("failed");
      expect(github.labels.has("byter:verified")).toBe(false);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }, 30_000);
});
