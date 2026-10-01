import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "@squasher/github";
import { SquasherTrueForgeRuntime } from "@squasher/agent";
import { SquasherHarness } from "@squasher/harness";
import type { LlmClient, LlmResponse } from "@squasher/harness";
import { ContributionRegistry, createSquasherServer } from "../src/server.js";

/**
 * End-to-end cover for contributing to a repository the token cannot push to: the fix branch
 * must land in a fork, the pull request must cross the fork boundary, and no label or comment
 * may be attempted against the upstream repository.
 */

const issueNumber = 42;
const upstream = { owner: "upstream", repo: "project", fullName: "upstream/project" };
const patchFiles = [{ path: "src/paths.ts", content: "export const fixed = true;\n" }];

const provenResult = {
  kind: "squasher.result",
  status: "patch-ready",
  summary: "The trailing slash failure was reproduced 3/3 times and the patch fixes it.",
  proof: {
    before: "3/3 runs failed with the reported error",
    after: "3/3 runs passed after the patch",
    regressions: "The focused regression suite passed",
    attempts: "3/3"
  },
  candidatePatch: {
    title: "Fix trailing slash handling",
    body: "Guards lastSegment against a trailing slash.",
    files: patchFiles
  }
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
    createSandbox: vi.fn().mockResolvedValue("sbx_fork"),
    runCommand: vi.fn().mockResolvedValue({
      stdout: "the focused reproducer ran 3/3 matching attempts",
      stderr: "",
      exitCode: 0
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

/** A GitHub where the token can read the upstream repository but cannot push to it. */
function foreignRepoGitHub(options: { contributing?: string } = {}) {
  const writes: string[] = [];
  const client = {
    getRepository: vi.fn(async (owner: string, repo: string) => ({
      full_name: `${owner}/${repo}`,
      default_branch: "main",
      private: false,
      fork: owner === "contributor",
      archived: false,
      disabled: false,
      html_url: `https://github.test/${owner}/${repo}`,
      owner: { login: owner },
      permissions: { push: owner === "contributor" }
    })),
    getAuthenticatedUser: vi.fn().mockResolvedValue({ login: "contributor" }),
    forkRepository: vi.fn(async () => {
      writes.push("fork");
      return {
        full_name: "contributor/project",
        owner: { login: "contributor" },
        html_url: "https://github.test/contributor/project"
      };
    }),
    listPullRequests: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({
      number: issueNumber,
      title: "lastSegment throws on a trailing slash",
      body: "It throws a TypeError for a path ending in a slash.",
      html_url: `https://github.test/${upstream.fullName}/issues/${issueNumber}`,
      state: "open"
    }),
    getFile: vi.fn(async (_owner: string, _repo: string, path: string) => {
      if (path === "CONTRIBUTING.md" && options.contributing) {
        return {
          path,
          sha: "sha",
          encoding: "base64",
          content: Buffer.from(options.contributing, "utf8").toString("base64")
        };
      }
      if (path === "src/paths.ts") {
        return { path, sha: "sha", encoding: "utf8", content: "export const fixed = false;\n" };
      }
      throw Object.assign(new Error("GitHub API 404 Not Found"), { status: 404 });
    }),
    getBranch: vi.fn(async (owner: string) => {
      writes.push(`getBranch:${owner}`);
      return { commit: { sha: "a".repeat(40) } };
    }),
    getCommit: vi.fn().mockResolvedValue({ tree: { sha: "b".repeat(40) } }),
    createTree: vi.fn(async (owner: string) => {
      writes.push(`createTree:${owner}`);
      return { sha: "c".repeat(40) };
    }),
    createCommit: vi.fn(async (owner: string) => {
      writes.push(`createCommit:${owner}`);
      return { sha: "d".repeat(40) };
    }),
    createBranch: vi.fn(async (owner: string) => {
      writes.push(`createBranch:${owner}`);
    }),
    deleteBranch: vi.fn(async (owner: string) => {
      writes.push(`deleteBranch:${owner}`);
    }),
    createPullRequest: vi.fn(async (owner: string, _repo: string, input: { head: string }) => {
      writes.push(`createPullRequest:${owner}:${input.head}`);
      return { number: 7, html_url: "https://github.test/pull/7" };
    }),
    addLabels: vi.fn(async (owner: string) => {
      writes.push(`addLabels:${owner}`);
    }),
    removeLabel: vi.fn(async (owner: string) => {
      writes.push(`removeLabel:${owner}`);
    }),
    createLabel: vi.fn().mockResolvedValue(undefined),
    updateLabel: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn(async (owner: string) => {
      writes.push(`createIssueComment:${owner}`);
      return { id: 1, html_url: "https://github.test/c/1" };
    }),
    updateIssueComment: vi.fn(async (_o: string, _r: string, id: number) => ({ id, html_url: "https://github.test/c/1" })),
    createOrUpdateFile: vi.fn().mockResolvedValue(undefined)
  };

  return { client, writes };
}

function payloadFor(delivery: string) {
  return JSON.stringify({
    action: "opened",
    issue: {
      number: issueNumber,
      title: "lastSegment throws on a trailing slash",
      body: `It throws a TypeError for a path ending in a slash. (${delivery})`,
      html_url: `https://github.test/${upstream.fullName}/issues/${issueNumber}`
    },
    repository: {
      name: upstream.repo,
      full_name: upstream.fullName,
      default_branch: "main",
      owner: { login: upstream.owner }
    }
  });
}

describe("fork-based contribution", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.SQUASHER_REQUIRE_TRIGGER_LABEL;
    staticDir = await mkdtemp(join(tmpdir(), "squasher-fork-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
    delete process.env.SQUASHER_CONTRIBUTION_MODE;
    delete process.env.SQUASHER_UPSTREAM_ALLOWLIST;
  });

  async function runIssue(
    github: ReturnType<typeof foreignRepoGitHub>,
    delivery: string,
    options: { withoutResolver?: boolean } = {}
  ) {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-fork-data-"));
    const branchName = `squasher/fix-${issueNumber}-${createHash("sha256").update(delivery).digest("hex").slice(0, 10)}`;
    const llm = scriptedLlm([
      toolCallResponse([
        { id: "c1", name: "run_command", arguments: { command: "node --experimental-strip-types repro.ts" } }
      ]),
      toolCallResponse([{ id: "c2", name: "submit_squasher_result", arguments: provenResult }]),
      toolCallResponse([
        {
          id: "c3",
          name: "create_fix_pull_request",
          arguments: {
            owner: upstream.owner,
            repo: upstream.repo,
            baseBranch: "main",
            branchName,
            title: provenResult.candidatePatch.title,
            body: provenResult.candidatePatch.body,
            files: patchFiles
          }
        }
      ]),
      textResponse(JSON.stringify(provenResult))
    ]);

    // Mirrors how trueForgeRuntimeFromEnv wires the harness in production: the server's
    // contribution decision is what the harness consults before pausing a write.
    const contributions = new ContributionRegistry();
    const harness = new SquasherHarness({
      client: github.client as never,
      llm,
      sandbox: fakeSandbox(),
      ...(options.withoutResolver
        ? {}
        : { resolveWriteTarget: ({ owner, repo }) => contributions.decide(owner, repo) })
    });
    const server = createSquasherServer({
      staticDir,
      dataDir,
      contributions,
      trueForgeRuntime: new SquasherTrueForgeRuntime({ modelName: "deepseek-flash" }, harness),
      githubClient: github.client as never
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const body = payloadFor(delivery);
    const baseUrl = `http://127.0.0.1:${port}`;

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

      let latest: Record<string, never> | undefined;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        latest = await fetch(`${baseUrl}/api/runs/latest`).then((r) => r.json());
        const status = (latest as { trueForge?: { status?: string } })?.trueForge?.status;
        if (status && ["paused", "completed", "failed"].includes(status)) break;
        await new Promise((wait) => setTimeout(wait, 20));
      }

      return { latest: latest as never, baseUrl, server, branchName };
    } catch (error) {
      await new Promise<void>((closed) => server.close(() => closed()));
      throw error;
    }
  }

  async function approve(baseUrl: string, run: { id: string }, patchHash: string) {
    const response = await fetch(`${baseUrl}/api/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
      body: JSON.stringify({ actionId: "approve-pr", runId: run.id, patchHash })
    });
    return { status: response.status, body: await response.json() };
  }

  it("pauses a fork-bound write and opens the pull request from the fork on approval", async () => {
    process.env.SQUASHER_CONTRIBUTION_MODE = "fork";
    process.env.SQUASHER_UPSTREAM_ALLOWLIST = upstream.fullName;
    const github = foreignRepoGitHub();

    const { latest, baseUrl, server, branchName } = await runIssue(github, "fork-run-1");
    try {
      const record = latest as unknown as {
        run: { id: string; status: string };
        contribution: { mode: string; headOwner: string; upstreamPushAccess: boolean; forkUrl?: string };
        trueForge: { status: string; result: { candidatePatch: { hash: string } } };
      };

      expect(record.contribution.mode).toBe("fork");
      expect(record.contribution.headOwner).toBe("contributor");
      expect(record.contribution.upstreamPushAccess).toBe(false);
      expect(record.contribution.forkUrl).toBe("https://github.test/contributor/project");
      expect(record.run.status).toBe("awaiting-approval");

      // Nothing was written anywhere before approval, and nothing at all upstream.
      expect(github.writes.filter((entry) => entry.startsWith("createBranch"))).toEqual([]);
      expect(github.writes.some((entry) => entry.startsWith("addLabels"))).toBe(false);
      expect(github.writes.some((entry) => entry.startsWith("createIssueComment"))).toBe(false);

      const approval = await approve(baseUrl, record.run, record.trueForge.result.candidatePatch.hash);
      expect(approval.status).toBe(200);

      // The base is read upstream; every ref write lands in the fork.
      expect(github.client.createTree).toHaveBeenCalledWith("contributor", upstream.repo, expect.anything());
      expect(github.client.createBranch).toHaveBeenCalledWith("contributor", upstream.repo, branchName, "d".repeat(40));
      expect(github.client.getBranch).toHaveBeenCalledWith(upstream.owner, upstream.repo, "main");
      expect(github.writes).toContain(`createPullRequest:${upstream.owner}:contributor:${branchName}`);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("discloses the automated contribution in the pull request body", async () => {
    process.env.SQUASHER_CONTRIBUTION_MODE = "fork";
    process.env.SQUASHER_UPSTREAM_ALLOWLIST = upstream.fullName;
    const github = foreignRepoGitHub();

    const { latest, baseUrl, server } = await runIssue(github, "fork-run-2");
    try {
      const record = latest as unknown as {
        run: { id: string };
        trueForge: { result: { candidatePatch: { hash: string } } };
      };
      await approve(baseUrl, record.run, record.trueForge.result.candidatePatch.hash);

      const body = github.client.createPullRequest.mock.calls[0]?.[2] as unknown as { body: string };
      expect(body.body).toContain("Guards lastSegment against a trailing slash.");
      expect(body.body).toContain("Automated contribution");
      expect(body.body).toContain("No maintainer requested this change");
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  type OutcomeRecord = {
    run: { id: string; status: string };
    contribution: { mode: string; writable: boolean; reason: string; policyFindings?: Array<{ path: string; excerpt: string }> };
    statuses: { implementation: { status: string }; contribution: { status: string; reason: string; action?: string } };
    outcome: { kind: string; headline: string; gate: { title: string } };
    trueForge: { status: string; error?: string; result: { status: string; candidatePatch: { hash: string; files: Array<{ path: string }> } } };
  };

  it("verifies and keeps the patch for a repository that is not allowlisted, and writes nothing", async () => {
    // CASE B: the allowlist authorises the GitHub write only. It must not stop the work,
    // and it must not turn the verified work into a failed run.
    process.env.SQUASHER_CONTRIBUTION_MODE = "fork";
    delete process.env.SQUASHER_UPSTREAM_ALLOWLIST;
    const github = foreignRepoGitHub();

    const { latest, baseUrl, server } = await runIssue(github, "fork-run-3");
    try {
      const record = latest as unknown as OutcomeRecord;

      expect(record.contribution.mode).toBe("fork");
      expect(record.contribution.writable).toBe(false);
      expect(record.contribution.reason).toContain("SQUASHER_UPSTREAM_ALLOWLIST");

      // Engineering: complete and verified, not failed.
      expect(record.run.status).toBe("patch-ready");
      expect(record.trueForge.error).toBeUndefined();
      expect(record.statuses.implementation.status).toBe("verified");
      expect(record.trueForge.result.candidatePatch.files[0]?.path).toBe("src/paths.ts");

      // Contribution: blocked, with the exact reason and what to do about it.
      expect(record.statuses.contribution.status).toBe("blocked");
      expect(record.statuses.contribution.reason).toContain("SQUASHER_UPSTREAM_ALLOWLIST");
      expect(record.statuses.contribution.action).toContain("Add upstream/project to SQUASHER_UPSTREAM_ALLOWLIST");
      expect(record.outcome.headline).toBe("Implementation verified. Pull request was not created.");
      expect(record.outcome.gate.title).toBe("Pull request not created");

      // Nothing written, nothing forked, and no approval can force a write.
      expect(github.client.forkRepository).not.toHaveBeenCalled();
      expect(github.client.createBranch).not.toHaveBeenCalled();
      const approval = await approve(baseUrl, record.run, record.trueForge.result.candidatePatch.hash);
      expect(approval.status).toBe(409);
      expect(github.client.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("refuses the write when the project's contributing guide rejects automated patches", async () => {
    process.env.SQUASHER_CONTRIBUTION_MODE = "fork";
    process.env.SQUASHER_UPSTREAM_ALLOWLIST = upstream.fullName;
    const github = foreignRepoGitHub({
      contributing: "# Contributing\n\nAI-generated pull requests are not accepted.\n"
    });

    const { latest, server } = await runIssue(github, "fork-run-4");
    try {
      const record = latest as unknown as OutcomeRecord;

      // CASE D: the project's refusal is respected -- nothing forked, nothing written --
      // and the verified work is still reported as verified.
      expect(record.contribution.writable).toBe(false);
      expect(record.contribution.policyFindings?.[0]?.path).toBe("CONTRIBUTING.md");
      expect(github.client.forkRepository).not.toHaveBeenCalled();
      expect(record.run.status).toBe("patch-ready");
      expect(record.statuses.implementation.status).toBe("verified");
      expect(record.statuses.contribution.status).toBe("blocked");
      expect(record.statuses.contribution.reason).toContain("refuse automated contributions");
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("refuses the approval when the harness never received the write-target policy", async () => {
    process.env.SQUASHER_CONTRIBUTION_MODE = "fork";
    process.env.SQUASHER_UPSTREAM_ALLOWLIST = upstream.fullName;
    const github = foreignRepoGitHub();

    // A runtime injected without the resolver stamps no destination, so the paused write
    // points at the upstream repository. That must be refused, not written.
    const { latest, baseUrl, server } = await runIssue(github, "fork-run-6", { withoutResolver: true });
    try {
      const record = latest as unknown as {
        run: { id: string; status: string };
        contribution: { mode: string; headOwner: string };
        trueForge: { pendingApproval?: { headOwner?: string }; result: { candidatePatch: { hash: string } } };
      };

      expect(record.contribution.mode).toBe("fork");
      expect(record.trueForge.pendingApproval?.headOwner).toBeUndefined();

      const approval = await approve(baseUrl, record.run, record.trueForge.result.candidatePatch.hash);

      expect(approval.status).toBe(409);
      // An unstamped write defaults to upstream, which is the destination with no push access.
      expect(String((approval.body as { error?: string }).error)).toContain(
        "paused write targets upstream but this run resolved to contributor"
      );
      expect(github.client.createBranch).not.toHaveBeenCalled();
      expect(github.client.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("contributes through a fork by default when no mode is configured", async () => {
    delete process.env.SQUASHER_CONTRIBUTION_MODE;
    process.env.SQUASHER_UPSTREAM_ALLOWLIST = upstream.fullName;
    const github = foreignRepoGitHub();

    const { latest, server } = await runIssue(github, "fork-run-5");
    try {
      const record = latest as unknown as OutcomeRecord;

      expect(record.contribution.mode).toBe("fork");
      expect(record.contribution.writable).toBe(true);
      expect(record.run.status).toBe("awaiting-approval");
      expect(record.statuses.contribution.status).toBe("awaiting_approval");
      // The fork exists in the user's account; nothing is written upstream before approval.
      expect(github.client.forkRepository).toHaveBeenCalled();
      expect(github.client.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });

  it("verifies the patch in an explicitly selected triage mode and submits nothing", async () => {
    // CASE C: triage means "do not submit", not "do not work".
    process.env.SQUASHER_CONTRIBUTION_MODE = "triage";
    process.env.SQUASHER_UPSTREAM_ALLOWLIST = upstream.fullName;
    const github = foreignRepoGitHub();

    const { latest, server } = await runIssue(github, "fork-run-7");
    try {
      const record = latest as unknown as OutcomeRecord;

      expect(record.contribution.mode).toBe("triage");
      expect(record.run.status).toBe("patch-ready");
      expect(record.statuses.implementation.status).toBe("verified");
      expect(record.statuses.contribution.status).toBe("blocked");
      expect(record.statuses.contribution.reason).toContain("triage");
      expect(record.trueForge.result.candidatePatch.files).toHaveLength(1);
      expect(github.client.forkRepository).not.toHaveBeenCalled();
      expect(github.client.createBranch).not.toHaveBeenCalled();
      expect(github.client.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});
