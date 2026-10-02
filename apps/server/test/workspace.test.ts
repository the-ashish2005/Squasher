import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "@squasher/github";
import { SquasherTrueForgeRuntime } from "@squasher/agent";
import { SquasherHarness } from "@squasher/harness";
import type { LlmClient, LlmResponse } from "@squasher/harness";
import { classifyPolicyLine, readContributionPolicy, resolveContributionTarget } from "../src/contribution.js";
import { summarizePolicy } from "../src/policy-summary.js";
import { buildAskContext } from "../src/workspace.js";
import { ContributionRegistry, createSquasherServer } from "../src/server.js";

/**
 * The Contribution Workspace's server side: questions answered from the run's public data
 * only, change requests recorded (never silently applied), repository policy classified
 * without mistaking a mention of AI for a prohibition, and new files shown as added.
 */

const verifiedRecord = {
  receivedAt: "2026-09-30T00:00:00.000Z",
  deliveryId: "workspace-1",
  repository: "drkrillo/good-first-issues",
  baseBranch: "main",
  issueTitle: "Add Dependabot for pip and GitHub Actions",
  issueBody: "Add a .github/dependabot.yml with pip and github-actions entries, weekly.",
  issueDiscussion: "--- @drkrillo (OWNER, maintainer) at 2026-09-29T00:00:00Z\nComment here to claim it.",
  contribution: {
    mode: "fork",
    writable: false,
    headOwner: "drkrillo",
    upstreamPushAccess: false,
    archived: false,
    reason: "drkrillo/good-first-issues is not in SQUASHER_UPSTREAM_ALLOWLIST",
    blockers: [{ kind: "configuration", reason: "drkrillo/good-first-issues is not in SQUASHER_UPSTREAM_ALLOWLIST", action: "Add it" }],
    preflight: { policyReviewed: true },
    policySignals: [
      { kind: "human-assignment-required", path: "CONTRIBUTING.md", excerpt: "Comment on the issue before you start so I can assign it to you." }
    ]
  },
  run: {
    id: "github-drkrillo-good-first-issues-174-workspace",
    issue: { owner: "drkrillo", repo: "good-first-issues", issueNumber: 174, url: "https://github.test/drkrillo/good-first-issues/issues/174" },
    status: "patch-ready",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    events: []
  },
  scan: { safeToExecute: true, findings: [] },
  trueForge: {
    status: "completed",
    session: { id: "sess-private-123", title: null },
    turn: { id: "turn-private-456", status: "done" },
    pendingApproval: { turnId: "turn-private-456", threadId: "main", toolCallId: "call-private-789", toolName: "create_fix_pull_request", payloadHash: "f".repeat(64) },
    events: [],
    result: {
      status: "implemented-feature",
      summary: "Adds the requested Dependabot configuration.",
      proofVerified: true,
      requirements: [{ requirement: "A pip entry with weekly schedule", verdict: "pass", evidence: "validator OK 3/3" }],
      fileChanges: [{ path: ".github/dependabot.yml", summary: "New Dependabot config.", requirements: ["A pip entry with weekly schedule"] }],
      proof: { before: "missing 3/3", after: "valid 3/3", regressions: "83 passed", attempts: "3/3" },
      candidatePatch: {
        title: "Add Dependabot",
        body: "Adds dependabot.yml.",
        baseBranch: "main",
        branchName: "squasher/fix-174-abc",
        files: [{ path: ".github/dependabot.yml", content: "version: 2\nupdates:\n  - package-ecosystem: \"pip\"\n" }],
        hash: "a".repeat(64),
        verifiedAt: "2026-09-30T00:00:00.000Z"
      },
      patchDiff: [{ path: ".github/dependabot.yml", before: "", after: "version: 2\n", change: "added" }]
    }
  }
};

describe("contribution workspace endpoints", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    staticDir = await mkdtemp(join(tmpdir(), "squasher-ws-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  async function serve(askModel?: { complete: ReturnType<typeof vi.fn> }) {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-ws-data-"));
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(verifiedRecord)}\n`, "utf8");
    const server = createSquasherServer({ staticDir, dataDir, ...(askModel ? { askModel: askModel as never } : {}) });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const runPath = `/api/runs/${encodeURIComponent(verifiedRecord.run.id)}`;
    const post = (path: string, body: unknown, token: string | null = "approval-token") =>
      fetch(`${base}${runPath}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body)
      });
    return {
      post,
      read: () => fetch(`${base}${runPath}`).then((response) => response.json()),
      close: () => new Promise<void>((closed) => server.close(() => closed()))
    };
  }

  it("records a change request against the run, and says why it was not applied when no agent is configured", async () => {
    const api = await serve();
    try {
      expect((await api.post("/change-requests", { text: "Don't modify CHANGELOG.md." }, null)).status).toBe(401);
      expect((await api.post("/change-requests", { text: "x" })).status).toBe(400);

      const created = await api.post("/change-requests", { text: "Don't modify CHANGELOG.md." });
      expect(created.status).toBe(201);
      const body = await created.json();
      expect(body.changeRequest).toMatchObject({ text: "Don't modify CHANGELOG.md.", status: "recorded", patchHash: "a".repeat(64) });
      // This server has no agent configured, so the request is recorded and says why it was not applied.
      expect(body.job).toBeUndefined();
      expect(body.jobError).toContain("not configured");

      const run = await api.read();
      expect(run.changeRequests).toEqual([expect.objectContaining({ text: "Don't modify CHANGELOG.md.", status: "recorded" })]);
      // Recorded, not applied: the patch is exactly what it was.
      expect(run.trueForge.result.candidatePatch.files).toEqual(verifiedRecord.trueForge.result.candidatePatch.files.map((file) => expect.objectContaining(file)));
    } finally {
      await api.close();
    }
  });

  it("answers questions from the run's public data, and never sees private approval details", async () => {
    const complete = vi.fn().mockResolvedValue({ text: "The pip entry satisfies the weekly-schedule requirement." });
    const api = await serve({ complete });
    try {
      expect((await api.post("/ask", { question: "Which requirement does this satisfy?" }, "wrong")).status).toBe(401);

      const response = await api.post("/ask", { question: "Which requirement does this satisfy?" });
      expect(response.status).toBe(200);
      const answer = await response.json();
      expect(answer.answer).toBe("The pip entry satisfies the weekly-schedule requirement.");
      expect(answer.contextSections).toEqual(expect.arrayContaining(["Issue", "Issue discussion", "Requirements", "Patch", "Contribution policy"]));

      const prompt = JSON.stringify(complete.mock.calls[0]?.[0]);
      // The real run is in the prompt...
      expect(prompt).toContain(".github/dependabot.yml (added)");
      expect(prompt).toContain("A pip entry with weekly schedule");
      expect(prompt).toContain("Comment here to claim it");
      expect(prompt).toContain("Human action required");
      // ...and nothing private is.
      for (const secret of ["sess-private-123", "turn-private-456", "call-private-789", "approval-token", "f".repeat(64)]) {
        expect(prompt).not.toContain(secret);
      }
    } finally {
      await api.close();
    }
  });

  it("says Ask Squasher is not configured instead of pretending to answer", async () => {
    const api = await serve();
    try {
      const response = await api.post("/ask", { question: "What tests prove this works?" });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("not configured");
    } finally {
      await api.close();
    }
  });

  it("gives the page the policy summary and the discussion, and keeps approval details private", async () => {
    const api = await serve();
    try {
      const run = await api.read();
      expect(run.policy).toMatchObject({ verdict: "human-action-required", automaticContributionAllowed: true });
      expect(run.issueDiscussion).toContain("Comment here to claim it");
      const payload = JSON.stringify(run);
      expect(payload).not.toContain("call-private-789");
      expect(payload).not.toContain("sess-private-123");
      expect(run.trueForge.pendingApproval).toBeUndefined();
    } finally {
      await api.close();
    }
  });
});

describe("ask context", () => {
  it("reports missing sections rather than filling them in", () => {
    const context = buildAskContext({ issueTitle: "Only a title", trueForge: { result: { status: "not-actionable" } } });

    expect(context.sections).toContain("Issue");
    expect(context.missing).toEqual(expect.arrayContaining(["Issue discussion", "Requirements", "Patch", "Tests and proof"]));
    expect(context.text).not.toContain("## Patch");
  });
});

describe("repository contribution policy", () => {
  it("classifies what a line actually says, not whether it mentions AI", () => {
    expect(classifyPolicyLine("We do not accept AI-generated patches of any kind.")).toBe("ai-prohibited");
    expect(classifyPolicyLine("Automated pull requests will be closed without review.")).toBe("bots-prohibited");
    expect(classifyPolicyLine("Please disclose any use of AI tools in your pull request description.")).toBe("ai-disclosure-required");
    expect(classifyPolicyLine("AI-assisted contributions are welcome if you test them.")).toBe("ai-assistance-allowed");
    expect(classifyPolicyLine("Comment on the issue before you start so I can assign it to you.")).toBe("human-assignment-required");
    // Mentions are not policies.
    expect(classifyPolicyLine("An AI-powered search library.")).toBeUndefined();
    expect(classifyPolicyLine("We use AI-generated embeddings internally.")).toBeUndefined();
  });

  it("reads each document's statements and blocks only on a prohibition", async () => {
    const files: Record<string, string> = {
      "CONTRIBUTING.md": "# Contributing\nComment on the issue before you start so I can assign it to you.\nPlease disclose AI assistance in the PR.",
      "README.md": "An AI-powered tool."
    };
    const client = {
      getRepository: vi.fn().mockResolvedValue({ full_name: "o/r", default_branch: "main", private: false, fork: false, html_url: "u", owner: { login: "o" }, permissions: { push: true } }),
      getAuthenticatedUser: vi.fn().mockResolvedValue({ login: "o" }),
      listPullRequests: vi.fn().mockResolvedValue([]),
      getFile: vi.fn().mockImplementation(async (_o: string, _r: string, path: string) => {
        if (files[path] === undefined) throw Object.assign(new Error("404"), { status: 404 });
        return { path, sha: "s", encoding: "utf8", content: files[path] };
      })
    };

    const signals = await readContributionPolicy(client as never, "o", "r");
    expect(signals.map((signal) => signal.kind)).toEqual(["human-assignment-required", "ai-disclosure-required"]);

    // Neither statement forbids the write, so the contribution stays possible and is described.
    const target = await resolveContributionTarget({ client: client as never, owner: "o", repo: "r", issueNumber: 1, mode: "fork" });
    expect(target.writable).toBe(true);
    expect(target.policySignals).toHaveLength(2);
    expect(summarizePolicy(target).verdict).toBe("human-action-required");
  });

  it("summarises a prohibition as not allowing an automatic contribution", () => {
    const summary = summarizePolicy({
      mode: "fork",
      policySignals: [{ kind: "ai-prohibited", path: "CONTRIBUTING.md", excerpt: "No AI-generated pull requests." }]
    });
    expect(summary).toMatchObject({ verdict: "prohibited", automaticContributionAllowed: false });
    expect(summarizePolicy({ mode: "fork", preflight: { policyReviewed: true } as never }).verdict).toBe("no-policy-found");
    expect(summarizePolicy(undefined).verdict).toBe("not-scanned");
    // A record from before classification: its refusal is still a prohibition.
    expect(summarizePolicy({ mode: "triage", policyFindings: [{ path: "CONTRIBUTING.md", excerpt: "No AI-generated code." }] }).verdict).toBe("prohibited");
  });

  it("asks for disclosure on a same-repository write when the policy requires it", () => {
    const registry = new ContributionRegistry();
    registry.set("o", "r", {
      mode: "own",
      writable: true,
      headOwner: "o",
      upstreamPushAccess: true,
      archived: false,
      reason: "push access",
      policySignals: [{ kind: "ai-disclosure-required", path: "CONTRIBUTING.md", excerpt: "Please disclose AI assistance." }]
    });

    expect(registry.decide("o", "r")).toEqual({ allowed: true, headOwner: "o", disclose: true });
  });
});

describe("added files in the patch diff", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.SQUASHER_REQUIRE_TRIGGER_LABEL;
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  it("records a file absent on the base branch as added, instead of dropping it from the diff", async () => {
    // A live run's new .github/dependabot.yml had no diff at all: its base read 404'd and was skipped.
    const issue = { number: 174, title: "Add Dependabot", body: "Please add a dependabot.yml; nothing is broken.", html_url: "https://github.test/o/r/issues/174" };
    const newFile = { path: ".github/dependabot.yml", content: "version: 2\n" };
    const delivery = "added-file-1";
    const result = {
      kind: "squasher.result",
      status: "implemented-feature",
      summary: "Adds the requested Dependabot configuration file.",
      requirements: [{ requirement: "A dependabot.yml exists", verdict: "pass", evidence: "The validator found it 3/3." }],
      proof: { before: "File absent 3/3.", after: "File valid 3/3.", regressions: "83 passed.", attempts: "3/3 matching executions" },
      candidatePatch: { title: "Add Dependabot config", body: "Adds dependabot.yml.", files: [newFile] }
    };
    const github = {
      getIssue: vi.fn().mockResolvedValue({ ...issue, state: "open" }),
      getFile: vi.fn().mockRejectedValue(Object.assign(new Error("GitHub API 404 Not Found"), { status: 404 })),
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "base-sha" } }),
      addLabels: vi.fn().mockResolvedValue(undefined),
      createIssueComment: vi.fn().mockResolvedValue({ id: 1, html_url: "u" }),
      createPullRequest: vi.fn()
    };
    const responses: LlmResponse[] = [
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "node --experimental-strip-types repro.ts" }) }] },
      { text: "", finishReason: "tool_calls", toolCalls: [{ id: "c2", name: "submit_squasher_result", arguments: JSON.stringify(result) }] },
      {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "c3",
          name: "create_fix_pull_request",
          arguments: JSON.stringify({
            owner: "o", repo: "r", baseBranch: "main",
            branchName: `squasher/fix-174-${createHash("sha256").update(delivery).digest("hex").slice(0, 10)}`,
            title: "Add Dependabot config", body: "Adds dependabot.yml.", files: [newFile]
          })
        }]
      },
      { text: JSON.stringify(result), finishReason: "stop", toolCalls: [] }
    ];
    const llm = { complete: vi.fn(async () => responses.shift()!) } as unknown as LlmClient;
    const harness = new SquasherHarness({
      client: github as never,
      llm,
      sandbox: {
        createSandbox: vi.fn().mockResolvedValue("sbx"),
        runCommand: vi.fn().mockResolvedValue({ stdout: "3/3 passed", stderr: "", exitCode: 0 }),
        writeFile: vi.fn(),
        closeSandbox: vi.fn()
      }
    });
    const staticDir = await mkdtemp(join(tmpdir(), "squasher-added-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-added-data-"));
    const server = createSquasherServer({
      staticDir,
      dataDir,
      trueForgeRuntime: new SquasherTrueForgeRuntime({ modelName: "m" }, harness),
      githubClient: github as never
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ action: "opened", issue, repository: { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } } });

    try {
      await fetch(`http://127.0.0.1:${port}/api/github/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GitHub-Event": "issues", "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": signWebhookPayload(body, "webhook-secret") },
        body
      });
      let latest: Record<string, any> = {};
      for (let attempt = 0; attempt < 200; attempt += 1) {
        latest = await fetch(`http://127.0.0.1:${port}/api/runs/latest`).then((response) => response.json());
        if (["paused", "completed", "failed"].includes(latest?.trueForge?.status)) break;
        await new Promise((wait) => setTimeout(wait, 5));
      }

      expect(latest.trueForge.result.patchDiff).toEqual([{ path: ".github/dependabot.yml", before: "", after: "version: 2\n", change: "added" }]);
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});
