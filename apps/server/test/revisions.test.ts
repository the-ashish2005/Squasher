import { mkdtemp, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SquasherTrueForgeRuntime } from "@squasher/agent";
import { SquasherHarness } from "@squasher/harness";
import type { LlmClient, LlmResponse } from "@squasher/harness";
import { runRecordedTests } from "../src/revisions.js";
import { createSquasherServer } from "../src/server.js";

/**
 * Requested changes applied as revisions, tests re-run on demand, and a revision submitted
 * on a human's approval. A revision exists only when its evidence holds; a submitted
 * revision goes through the same gates as the original write.
 */

const runId = "github-o-r-174-revisions";
const originalFiles = [
  { path: ".github/dependabot.yml", content: 'version: 2\nupdates:\n  - package-ecosystem: "pip"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n' },
  { path: "CHANGELOG.md", content: "# Changelog\n\n- Added Dependabot.\n" }
];

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    receivedAt: "2026-10-01T00:00:00.000Z",
    deliveryId: "revisions-1",
    repository: "o/r",
    baseBranch: "main",
    issueTitle: "Add Dependabot for pip and GitHub Actions",
    issueBody: "Please add a dependabot.yml; nothing is broken today.",
    contribution: {
      mode: "fork",
      writable: true,
      headOwner: "contributor",
      upstreamPushAccess: false,
      archived: false,
      reason: "No push access to o/r; contributing from fork contributor/r",
      preflight: { policyReviewed: true },
      policySignals: []
    },
    run: {
      id: runId,
      issue: { owner: "o", repo: "r", issueNumber: 174, url: "https://github.test/o/r/issues/174" },
      status: "patch-ready",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      events: []
    },
    scan: { safeToExecute: true, findings: [] },
    trueForge: {
      status: "completed",
      events: [],
      result: {
        status: "implemented-feature",
        summary: "Adds the requested Dependabot configuration and a changelog entry.",
        proofVerified: true,
        requirements: [{ requirement: "A pip entry, weekly", verdict: "pass", evidence: "Validator OK 3/3." }],
        proof: { before: "missing 3/3", after: "valid 3/3", regressions: "83 passed", attempts: "3/3" },
        candidatePatch: {
          title: "Add Dependabot",
          body: "Adds dependabot.yml.",
          baseBranch: "main",
          branchName: "squasher/fix-174-abc1234567",
          files: originalFiles,
          hash: "a".repeat(64),
          verifiedAt: "2026-10-01T00:00:00.000Z"
        },
        patchDiff: [
          { path: ".github/dependabot.yml", before: "", after: originalFiles[0]!.content, change: "added" },
          { path: "CHANGELOG.md", before: "# Changelog\n", after: originalFiles[1]!.content, change: "modified" }
        ]
      }
    },
    ...overrides
  };
}

/** What a revision session submits after dropping CHANGELOG.md, as a maintainer asked. */
const revisedResult = {
  kind: "squasher.result",
  status: "implemented-feature",
  summary: "Dropped the CHANGELOG.md edit as requested; the Dependabot configuration is unchanged and re-verified.",
  requirements: [{ requirement: "A pip entry, weekly", verdict: "pass", evidence: "Validator OK 3/3 after the change." }],
  testCommands: [{ command: "python3 -m pytest -q", purpose: "The repository's own suite" }],
  proof: { before: "CHANGELOG.md was modified 3/3.", after: "Only dependabot.yml changes 3/3.", regressions: "83 passed.", attempts: "3/3 matching executions" },
  candidatePatch: { title: "Add Dependabot", body: "Adds dependabot.yml only.", files: [originalFiles[0]!] }
};

function toolCall(id: string, name: string, args: unknown): LlmResponse {
  return { text: "", finishReason: "tool_calls", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

function fakeSandbox(results: Array<{ stdout?: string; stderr?: string; exitCode: number }> = []) {
  const queue = [...results];
  return {
    createSandbox: vi.fn().mockResolvedValue("sbx-revision"),
    runCommand: vi.fn(async () => {
      const next = queue.shift() ?? { exitCode: 0 };
      return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", exitCode: next.exitCode };
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

function fakeGitHub() {
  return {
    getIssue: vi.fn(),
    getFile: vi.fn().mockRejectedValue(Object.assign(new Error("404"), { status: 404 })),
    getRepository: vi.fn().mockResolvedValue({ full_name: "o/r", default_branch: "main", archived: false, disabled: false }),
    getBranch: vi.fn().mockResolvedValue({ commit: { sha: "1".repeat(40) } }),
    getCommit: vi.fn().mockResolvedValue({ tree: { sha: "2".repeat(40) } }),
    createTree: vi.fn().mockResolvedValue({ sha: "3".repeat(40) }),
    createCommit: vi.fn().mockResolvedValue({ sha: "4".repeat(40) }),
    createBranch: vi.fn().mockResolvedValue(undefined),
    updateBranch: vi.fn().mockResolvedValue(undefined),
    deleteBranch: vi.fn().mockResolvedValue(undefined),
    createPullRequest: vi.fn().mockResolvedValue({ number: 176, html_url: "https://github.test/o/r/pull/176" }),
    addLabels: vi.fn(),
    createIssueComment: vi.fn(),
    createOrUpdateFile: vi.fn()
  };
}

describe("contribution workspace revisions", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    staticDir = await mkdtemp(join(tmpdir(), "squasher-rev-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  async function serve(options: { record?: unknown; responses?: LlmResponse[]; sandbox?: ReturnType<typeof fakeSandbox>; extraLines?: unknown[] } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-rev-data-"));
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(options.record ?? baseRecord())}\n`, "utf8");
    const github = fakeGitHub();
    const responses = [...(options.responses ?? [])];
    const complete = vi.fn(async () => responses.shift() ?? { text: "done", finishReason: "stop", toolCalls: [] });
    const harness = new SquasherHarness({
      client: github as never,
      llm: { complete } as unknown as LlmClient,
      sandbox: { createSandbox: vi.fn().mockResolvedValue("sbx-agent"), runCommand: vi.fn().mockResolvedValue({ stdout: "3/3 passed", stderr: "", exitCode: 0 }), writeFile: vi.fn(), closeSandbox: vi.fn() }
    });
    const sandbox = options.sandbox ?? fakeSandbox();
    const server = createSquasherServer({
      staticDir,
      dataDir,
      trueForgeRuntime: new SquasherTrueForgeRuntime({ modelName: "m" }, harness),
      githubClient: github as never,
      sandbox
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/runs/${encodeURIComponent(runId)}`;
    const post = async (path: string, body: unknown, token: string | null = "approval-token") => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const read = () => fetch(base).then((response) => response.json() as Promise<Record<string, any>>);
    const settle = async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const run = await read();
        if ((run.workspaceJobs ?? []).every((job: { status: string }) => job.status !== "running")) return run;
        await new Promise((wait) => setTimeout(wait, 10));
      }
      throw new Error("workspace job did not settle");
    };
    return { github, sandbox, complete, post, read, settle, dataDir, close: () => new Promise<void>((closed) => server.close(() => closed())) };
  }

  it("applies a requested change as a verified revision, in a session that cannot write to GitHub", async () => {
    const api = await serve({
      responses: [
        toolCall("c1", "run_command", { command: "python3 -m pytest -q" }),
        toolCall("c2", "submit_squasher_result", revisedResult),
        { text: JSON.stringify(revisedResult), finishReason: "stop", toolCalls: [] }
      ]
    });
    try {
      const created = await api.post("/change-requests", { text: "Don't modify CHANGELOG.md." });
      expect(created.status).toBe(201);
      expect(created.body.job).toMatchObject({ kind: "apply-change", status: "running", revision: 0 });

      const run = await api.settle();
      expect(run.workspaceJobs[0]).toMatchObject({ status: "succeeded", producedRevision: 1 });
      expect(run.revisions).toHaveLength(1);
      expect(run.revisions[0]).toMatchObject({
        number: 1,
        source: "requested-change",
        basedOn: 0,
        changeRequestText: "Don't modify CHANGELOG.md.",
        files: [originalFiles[0]],
        testCommands: [{ command: "python3 -m pytest -q", purpose: "The repository's own suite" }]
      });
      expect(run.changeRequests[0]).toMatchObject({ status: "implemented", revision: 1 });

      // The session saw the patch in full and the request, and had no GitHub write tool.
      const [messages, tools] = api.complete.mock.calls[0] as unknown as [Array<{ content: string }>, Array<{ function: { name: string } }>];
      expect(messages[1]!.content).toContain("REQUESTED CHANGE: Don't modify CHANGELOG.md.");
      expect(messages[1]!.content).toContain("--- FILE CHANGELOG.md");
      expect(tools.map((tool) => tool.function.name)).not.toContain("create_fix_pull_request");
      expect(api.github.createPullRequest).not.toHaveBeenCalled();
      // No session or turn identifier reaches the page.
      expect(run.workspaceJobs[0].sessionId).toBeUndefined();
      expect(run.workspaceJobs[0].turnId).toBeUndefined();
    } finally {
      await api.close();
    }
  });

  it("keeps the patch unchanged when the revision's evidence does not hold", async () => {
    // Submitted without ever running anything: no executed proof, so no revision.
    const api = await serve({
      responses: [toolCall("c1", "submit_squasher_result", revisedResult), { text: JSON.stringify(revisedResult), finishReason: "stop", toolCalls: [] }]
    });
    try {
      await api.post("/change-requests", { text: "Don't modify CHANGELOG.md." });
      const run = await api.settle();

      expect(run.workspaceJobs[0]).toMatchObject({ status: "failed" });
      expect(run.workspaceJobs[0].error).toContain("did not pass verification");
      expect(run.revisions).toEqual([]);
      expect(run.changeRequests[0]).toMatchObject({ status: "failed" });
    } finally {
      await api.close();
    }
  });

  it("re-runs the recorded test commands exactly, in a fresh sandbox, without a model", async () => {
    const record = baseRecord();
    (record.trueForge.result as Record<string, unknown>).testCommands = [
      { command: "pip install -r requirements.txt", purpose: "setup" },
      { command: "python3 -m pytest -q", purpose: "suite" }
    ];
    const sandbox = fakeSandbox([{ exitCode: 0 }, { exitCode: 0, stdout: "installed" }, { exitCode: 1, stdout: "1 failed, 82 passed" }]);
    const api = await serve({ record, sandbox });
    try {
      const started = await api.post("/test-runs", {});
      expect(started.status).toBe(202);
      expect(started.body.job).toMatchObject({ kind: "test-run" });

      const run = await api.settle();
      const job = run.workspaceJobs[0];
      expect(job).toMatchObject({ status: "succeeded", stage: "Tests failed", revision: 0 });
      expect(job.testRun.passed).toBe(false);
      expect(job.testRun.commands.map((command: { command: string; exitCode: number }) => [command.command, command.exitCode])).toEqual([
        ["pip install -r requirements.txt", 0],
        ["python3 -m pytest -q", 1]
      ]);
      expect(job.testRun.commands[1].stdout).toBe("1 failed, 82 passed");
      // The patch was written over a fresh clone of the base branch; no model was involved.
      expect(sandbox.runCommand.mock.calls[0]![1]).toContain("git clone --quiet --depth 1 --branch main https://github.com/o/r.git");
      expect(sandbox.writeFile).toHaveBeenCalledWith("sbx-revision", "/tmp/squasher-workspace/CHANGELOG.md", originalFiles[1]!.content);
      expect(api.complete).not.toHaveBeenCalled();
      expect(sandbox.closeSandbox).toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });

  it("re-verifies with Squasher when no test commands were recorded", async () => {
    const api = await serve({ responses: [{ text: "stopped", finishReason: "stop", toolCalls: [] }] });
    try {
      const started = await api.post("/test-runs", {});
      expect(started.body.job).toMatchObject({ kind: "verify" });
      const run = await api.settle();
      expect(run.workspaceJobs[0].status).toBe("failed");
      expect(api.sandbox.createSandbox).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });

  async function withRevision(record = baseRecord(), extra: Record<string, unknown> = {}) {
    const api = await serve({ record });
    await writeFile(
      join(api.dataDir, "patch-revisions.jsonl"),
      `${JSON.stringify({
        id: "revision-1",
        runId,
        number: 1,
        source: "requested-change",
        basedOn: 0,
        changeRequestText: "Don't modify CHANGELOG.md.",
        createdAt: "2026-10-01T01:00:00.000Z",
        title: "Add Dependabot",
        body: "Adds dependabot.yml only.",
        summary: "Dropped the CHANGELOG.md edit.",
        files: [originalFiles[0]],
        hash: "r".repeat(64),
        ...extra
      })}\n`,
      "utf8"
    );
    return api;
  }

  it("opens the pull request with the approved revision, disclosed, through the same pull request tool", async () => {
    const api = await withRevision();
    try {
      expect((await api.post("/revisions/1/approve", { hash: "r".repeat(64) }, null)).status).toBe(401);
      expect((await api.post("/revisions/1/approve", { hash: "stale" })).status).toBe(409);

      const approved = await api.post("/revisions/1/approve", { hash: "r".repeat(64) });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ pullRequest: { number: 176 }, updated: false, revision: 1 });

      // The revision's files, from the fork, with the automated-contribution disclosure.
      expect(api.github.createTree).toHaveBeenCalledWith("contributor", "r", expect.objectContaining({ files: [originalFiles[0]] }));
      const pullRequest = api.github.createPullRequest.mock.calls[0]![2] as { body: string; head: string };
      expect(pullRequest.head).toBe("contributor:squasher/fix-174-abc1234567");
      expect(pullRequest.body).toContain("Adds dependabot.yml only.");
      expect(pullRequest.body).toContain("Automated contribution");

      const run = await api.read();
      expect(run.run.status).toBe("pr-created");
      expect(run.submittedRevision).toBe(1);
      expect(run.statuses.contribution.status).toBe("submitted");
    } finally {
      await api.close();
    }
  });

  it("updates an open pull request's branch, removing a file the revision dropped", async () => {
    const record = baseRecord();
    (record.trueForge.result as Record<string, unknown>).pullRequest = { number: 176, url: "https://github.test/o/r/pull/176" };
    (record.run as Record<string, unknown>).status = "pr-created";
    const api = await withRevision(record);
    try {
      const approved = await api.post("/revisions/1/approve", { hash: "r".repeat(64) });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ updated: true, revision: 1 });

      // One commit on the existing branch: CHANGELOG.md goes back to its base content.
      expect(api.github.getBranch).toHaveBeenCalledWith("contributor", "r", "squasher/fix-174-abc1234567");
      expect(api.github.createTree).toHaveBeenCalledWith("contributor", "r", {
        baseTree: "2".repeat(40),
        files: [originalFiles[0], { path: "CHANGELOG.md", content: "# Changelog\n" }]
      });
      expect(api.github.updateBranch).toHaveBeenCalledWith("contributor", "r", "squasher/fix-174-abc1234567", "4".repeat(40));
      expect(api.github.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });

  it("refuses approval when policy, permission or a failed test run says no", async () => {
    const prohibited = baseRecord();
    (prohibited.contribution as Record<string, unknown>).policySignals = [{ kind: "ai-prohibited", path: "CONTRIBUTING.md", excerpt: "No AI-generated PRs." }];
    let api = await withRevision(prohibited);
    try {
      const refused = await api.post("/revisions/1/approve", { hash: "r".repeat(64) });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("AI contributions prohibited");
    } finally {
      await api.close();
    }

    const blocked = baseRecord();
    (blocked.contribution as Record<string, unknown>).writable = false;
    api = await withRevision(blocked);
    try {
      expect((await api.post("/revisions/1/approve", { hash: "r".repeat(64) })).body.error).toContain("may not write to GitHub");
    } finally {
      await api.close();
    }

    api = await withRevision();
    try {
      await writeFile(
        join(api.dataDir, "workspace-jobs.jsonl"),
        `${JSON.stringify({ id: "job-t", runId, kind: "test-run", status: "succeeded", stage: "Tests failed", createdAt: "2026-10-01T02:00:00.000Z", updatedAt: "2026-10-01T02:00:00.000Z", revision: 1, testRun: { passed: false, source: "recorded-commands", commands: [] } })}\n`,
        "utf8"
      );
      const refused = await api.post("/revisions/1/approve", { hash: "r".repeat(64) });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("latest test run of revision 1 failed");
      expect(api.github.createPullRequest).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });
});

describe("recorded test runner", () => {
  it("stops before running anything when the repository cannot be cloned", async () => {
    const sandbox = fakeSandbox([{ exitCode: 128, stderr: "fatal: repository not found" }]);
    await expect(
      runRecordedTests(sandbox, { owner: "o", repo: "r", baseBranch: "main", files: [], commands: [{ command: "npm test" }], onStage: async () => undefined })
    ).rejects.toThrow("could not be cloned");
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.closeSandbox).toHaveBeenCalled();
  });
});
