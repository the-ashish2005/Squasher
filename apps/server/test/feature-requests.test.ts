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
 * Byter used to act only on reproducible defects, so a request for behaviour that did not
 * exist yet could only ever come back not-reproduced -- observed on talkasab/peruse#45,
 * a cache-header request written in bug-report form. These cover the implementation path
 * added for those, and the guard that keeps a defect from taking it.
 */

const patchFiles = [{ path: "index.html", content: "<button id=\"cancel\">Cancel</button>\n" }];

const featureIssue = {
  number: 7,
  title: "Add a green Cancel button next to Save",
  body: "Could we add a second button to `index.html`? Nothing is broken, I would just like the extra button.",
  html_url: "https://github.test/o/r/issues/7"
};

const defectIssue = {
  number: 8,
  title: "Tokenizer crashes on a trailing escape",
  body: "The tokenizer throws a `TypeError` when a pattern ends with a single backslash.",
  html_url: "https://github.test/o/r/issues/8"
};

function implementedResult(status: string) {
  return {
    kind: "byter.result",
    status,
    summary: "Added the requested Cancel button beside Save and verified it renders.",
    proof: {
      before: "The new acceptance test failed 3/3 against the unchanged page: no Cancel button present.",
      after: "The same test passed 3/3 after the change.",
      regressions: "The existing checks passed 3/3 alongside it.",
      attempts: "3/3 matching executions before and after the change"
    },
    candidatePatch: {
      title: "Add a Cancel button beside Save",
      body: "Adds the requested green Cancel button to index.html.",
      files: patchFiles
    }
  };
}

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
    createSandbox: vi.fn().mockResolvedValue("sbx_feature"),
    runCommand: vi.fn().mockResolvedValue({
      stdout: "the focused test ran 3/3 matching attempts",
      stderr: "",
      exitCode: 0
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

function labelTrackingGitHub(issue: { number: number; title: string; body: string; html_url: string }) {
  const labels = new Set<string>();
  const comments: string[] = [];
  return {
    labels,
    comments,
    client: {
      getIssue: vi.fn().mockResolvedValue({ ...issue, state: "open" }),
      getFile: vi.fn().mockResolvedValue({
        path: "index.html",
        sha: "sha",
        encoding: "utf8",
        content: "<button id=\"save\">Save</button>\n"
      }),
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "base-sha" } }),
      getCommit: vi.fn().mockResolvedValue({ tree: { sha: "base-tree" } }),
      createTree: vi.fn().mockResolvedValue({ sha: "tree" }),
      createCommit: vi.fn().mockResolvedValue({ sha: "commit" }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({ number: 11, html_url: "https://github.test/pull/11" }),
      addLabels: vi.fn(async (_o: string, _r: string, _n: number, names: string[]) => {
        for (const name of names) labels.add(name);
      }),
      removeLabel: vi.fn(async (_o: string, _r: string, _n: number, name: string) => {
        labels.delete(name);
      }),
      createLabel: vi.fn().mockResolvedValue(undefined),
      updateLabel: vi.fn().mockResolvedValue(undefined),
      createIssueComment: vi.fn(async (_o: string, _r: string, _n: number, body: string) => {
        comments.push(body);
        return { id: 1, html_url: "https://github.test/c/1" };
      }),
      updateIssueComment: vi.fn(async (_o: string, _r: string, id: number, body: string) => {
        comments.push(body);
        return { id, html_url: "https://github.test/c/1" };
      }),
      createOrUpdateFile: vi.fn().mockResolvedValue(undefined)
    }
  };
}

describe("feature and improvement requests", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.BYTER_REQUIRE_TRIGGER_LABEL;
    staticDir = await mkdtemp(join(tmpdir(), "byter-feature-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Byter</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  async function runIssue(
    github: ReturnType<typeof labelTrackingGitHub>,
    issue: typeof featureIssue,
    delivery: string,
    responses: LlmResponse[]
  ) {
    const dataDir = await mkdtemp(join(tmpdir(), "byter-feature-data-"));
    const harness = new ByterHarness({
      client: github.client as never,
      llm: scriptedLlm(responses),
      sandbox: fakeSandbox()
    });
    const server = createByterServer({
      staticDir,
      dataDir,
      trueForgeRuntime: new ByterTrueForgeRuntime({ modelName: "deepseek-flash" }, harness),
      githubClient: github.client as never
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({
      action: "opened",
      issue,
      repository: { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } }
    });

    try {
      await fetch(`${baseUrl}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256": signWebhookPayload(body, "webhook-secret")
        },
        body
      });

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const latest = await fetch(`${baseUrl}/api/runs/latest`).then((r) => r.json());
        if (["paused", "completed", "failed"].includes(latest?.trueForge?.status)) {
          return { latest, baseUrl, server };
        }
        await new Promise((wait) => setTimeout(wait, 5));
      }
      throw new Error("run did not settle");
    } catch (error) {
      await new Promise<void>((closed) => server.close(() => closed()));
      throw error;
    }
  }

  function writeArgumentsFor(delivery: string, issueNumber: number) {
    return {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: `byter/fix-${issueNumber}-${createHash("sha256").update(delivery).digest("hex").slice(0, 10)}`,
      title: "Add a Cancel button beside Save",
      body: "Adds the requested green Cancel button to index.html.",
      files: patchFiles
    };
  }

  it("carries an implemented feature through to an approval checkpoint", async () => {
    const github = labelTrackingGitHub(featureIssue);
    const delivery = "feature-run-1";
    const { latest, baseUrl, server } = await runIssue(github, featureIssue, delivery, [
      toolCallResponse([{ id: "c1", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }]),
      toolCallResponse([{ id: "c2", name: "submit_byter_result", arguments: implementedResult("implemented-feature") }]),
      toolCallResponse([
        { id: "c3", name: "create_fix_pull_request", arguments: writeArgumentsFor(delivery, featureIssue.number) }
      ]),
      textResponse(JSON.stringify(implementedResult("implemented-feature")))
    ]);

    try {
      // The whole point: a request with nothing broken reaches the approval gate.
      expect(latest.run.status).toBe("awaiting-approval");
      expect(latest.trueForge.result.status).toBe("implemented-feature");
      expect(latest.trueForge.result.candidatePatch.files[0].path).toBe("index.html");

      // Labelled as implemented, never as a reproduced defect.
      expect(github.labels.has("byter:implemented")).toBe(true);
      expect(github.labels.has("byter:verified")).toBe(false);
      expect(github.labels.has("byter:not-reproduced")).toBe(false);
      expect(github.labels.has("byter:awaiting-approval")).toBe(true);

      // The public comment must not describe a reproduction that never happened.
      const comment = github.comments.at(-1) ?? "";
      expect(comment).toContain("Before change");
      expect(comment).toContain("Requested change");
      expect(comment).not.toContain("**Reproduction:**");

      // The approval gate is untouched: approving still opens the pull request.
      const approval = await fetch(`${baseUrl}/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
        body: JSON.stringify({
          actionId: "approve-pr",
          runId: latest.run.id,
          patchHash: latest.trueForge.result.candidatePatch.hash
        })
      }).then((r) => r.json());

      expect(approval.resultStatus).toBe("pr-created");
      expect(approval.pullRequest.url).toBe("https://github.test/pull/11");
      expect(github.client.createPullRequest).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("carries an implemented improvement through the same path", async () => {
    const github = labelTrackingGitHub(featureIssue);
    const delivery = "feature-run-2";
    const { latest, server } = await runIssue(github, featureIssue, delivery, [
      toolCallResponse([{ id: "c1", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }]),
      toolCallResponse([{ id: "c2", name: "submit_byter_result", arguments: implementedResult("implemented-improvement") }]),
      toolCallResponse([
        { id: "c3", name: "create_fix_pull_request", arguments: writeArgumentsFor(delivery, featureIssue.number) }
      ]),
      textResponse(JSON.stringify(implementedResult("implemented-improvement")))
    ]);

    try {
      expect(latest.run.status).toBe("awaiting-approval");
      expect(latest.trueForge.result.status).toBe("implemented-improvement");
      expect(github.labels.has("byter:implemented")).toBe(true);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("records a declined request as not-actionable rather than not-reproduced", async () => {
    const github = labelTrackingGitHub(featureIssue);
    const notActionable = {
      kind: "byter.result",
      status: "not-actionable",
      summary: "The request names a build step this repository does not contain, so there is nowhere to add it.",
      proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "0/0" },
      candidatePatch: null
    };
    const { latest, server } = await runIssue(github, featureIssue, "feature-run-3", [
      toolCallResponse([{ id: "c1", name: "submit_byter_result", arguments: notActionable }]),
      textResponse(JSON.stringify(notActionable))
    ]);

    try {
      // Distinct from not-reproduced: nothing was attempted, so nothing failed to reproduce.
      expect(latest.run.status).toBe("not-actionable");
      expect(latest.trueForge.result.status).toBe("not-actionable");
      expect(github.labels.has("byter:not-actionable")).toBe(true);
      expect(github.labels.has("byter:not-reproduced")).toBe(false);
      expect(github.labels.has("byter:implemented")).toBe(false);
      expect(github.client.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("still requires a reproduction for an issue that reports a failure", async () => {
    const github = labelTrackingGitHub(defectIssue);
    // Claiming an implementation for a defect skips the reproduction, so it is refused and
    // the model has to come back with a defect status.
    const backDown = {
      kind: "byter.result",
      status: "not-reproduced",
      summary: "The reported TypeError could not be observed against the current source.",
      proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "0/3" },
      candidatePatch: null
    };
    const { latest, server } = await runIssue(github, defectIssue, "defect-run-1", [
      toolCallResponse([{ id: "c1", name: "submit_byter_result", arguments: implementedResult("implemented-feature") }]),
      toolCallResponse([{ id: "c2", name: "submit_byter_result", arguments: backDown }]),
      textResponse(JSON.stringify(backDown))
    ]);

    try {
      expect(latest.run.status).toBe("not-reproduced");
      expect(github.labels.has("byter:implemented")).toBe(false);
      expect(github.labels.has("byter:not-reproduced")).toBe(true);
      expect(github.client.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("still labels a reproduced defect verified, not implemented", async () => {
    const github = labelTrackingGitHub(defectIssue);
    const delivery = "defect-run-2";
    const provenDefect = {
      kind: "byter.result",
      status: "patch-ready",
      summary: "The trailing escape crash reproduced 3/3 and the patch fixes it.",
      proof: {
        before: "3/3 runs threw the reported TypeError",
        after: "3/3 runs passed after the patch",
        regressions: "The focused suite passed",
        attempts: "3/3"
      },
      candidatePatch: {
        title: "Guard the trailing escape",
        body: "Handles a pattern ending in a single backslash.",
        files: patchFiles
      }
    };
    const { latest, server } = await runIssue(github, defectIssue, delivery, [
      toolCallResponse([{ id: "c1", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }]),
      toolCallResponse([{ id: "c2", name: "submit_byter_result", arguments: provenDefect }]),
      toolCallResponse([
        { id: "c3", name: "create_fix_pull_request", arguments: writeArgumentsFor(delivery, defectIssue.number) }
      ]),
      textResponse(JSON.stringify(provenDefect))
    ]);

    try {
      // The existing defect path is unchanged, including which label it earns.
      expect(latest.run.status).toBe("awaiting-approval");
      expect(latest.trueForge.result.status).toBe("patch-ready");
      expect(github.labels.has("byter:verified")).toBe(true);
      expect(github.labels.has("byter:implemented")).toBe(false);
      expect(github.comments.at(-1) ?? "").toContain("**Reproduction:**");
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});
