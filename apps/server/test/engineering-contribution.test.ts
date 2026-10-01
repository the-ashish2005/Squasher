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
 * Engineering and contribution are separate answers. These cover the parts of that split not
 * exercised by the fork and label suites: the issue discussion reaching the agent before it
 * works, requirement verification carried to the page, records from before the split, and a
 * pull request followed after it is opened.
 */

const issue = {
  number: 164,
  title: "UI/UX improvements for issue discovery",
  body: "Replace the dense table with cards, add language badges, sorting and filtering.",
  html_url: "https://github.test/o/r/issues/164"
};

const maintainerComment = {
  id: 1,
  body: "Two of the points are already in there though: sorting by any column, including Created, Updated and Repo, and the search box plus the language filter. The rest I am going to split into separate issues myself.",
  created_at: "2026-09-20T14:12:23Z",
  user: { login: "owner-login" },
  author_association: "OWNER"
};

function scriptedLlm(responses: LlmResponse[]) {
  const complete = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Scripted model ran out of responses");
    return next;
  });
  return { llm: { complete } as unknown as LlmClient, complete };
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

function fakeSandbox() {
  return {
    createSandbox: vi.fn().mockResolvedValue("sbx_contract"),
    runCommand: vi.fn().mockResolvedValue({ stdout: "3/3 passed", stderr: "", exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

function githubWithDiscussion() {
  return {
    getIssue: vi.fn().mockResolvedValue({ ...issue, state: "open" }),
    listIssueComments: vi.fn().mockResolvedValue([maintainerComment]),
    getFile: vi.fn().mockImplementation(async (_owner: string, _repo: string, path: string) => {
      if (path !== "index.html") throw Object.assign(new Error("GitHub API 404 Not Found"), { status: 404 });
      return { path, sha: "sha", encoding: "utf8", content: indexHtml };
    }),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    createLabel: vi.fn().mockResolvedValue(undefined),
    updateLabel: vi.fn().mockResolvedValue(undefined),
    createIssueComment: vi.fn().mockResolvedValue({ id: 1, html_url: "https://github.test/c/1" }),
    updateIssueComment: vi.fn().mockResolvedValue({ id: 1, html_url: "https://github.test/c/1" }),
    createPullRequest: vi.fn()
  };
}

/** The page as it was: Comments, Created and Updated are sortable; Repo is not. */
const indexHtml = [
  "const COLUMNS = [",
  '  { key: "repo",       label: "Repo" },',
  '  { key: "comments",   label: "Comments", sortable: true, numeric: true, align: "center" },',
  '  { key: "created_at", label: "Created",  sortable: true },',
  '  { key: "updated_at", label: "Updated",  sortable: true },',
  "];",
  'languageFilter.addEventListener("change", updateTable);'
].join("\n");

const created = { path: "index.html", excerpt: '{ key: "created_at", label: "Created",  sortable: true }' };

function notActionableWith(requirements: unknown[], discussionClaims: unknown[]) {
  return {
    kind: "squasher.result",
    status: "not-actionable",
    summary: "Most of the proposal exists or is reserved by the owner, and the responsive layout was offered to the reporter.",
    rootCauseSummary: "Nothing on this issue is left for this run: what is not already present is owned by someone else.",
    requirements,
    discussionClaims,
    proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "0/0" },
    candidatePatch: null
  };
}

/** What the live run submitted: the owner's claim repeated as repository fact. */
const repeatedClaim = notActionableWith(
  [
    {
      requirement: "Sort by repository name",
      verdict: "already-implemented",
      evidence: "The owner says sorting works on any column, including Repo.",
      codeEvidence: [{ path: "index.html", excerpt: '{ key: "repo",       label: "Repo", sortable: true }' }]
    }
  ],
  []
);

const notActionable = notActionableWith(
  [
    { requirement: "Sort by created date", verdict: "already-implemented", evidence: "COLUMNS marks created_at sortable.", codeEvidence: [created] },
    {
      requirement: "Filter by language",
      verdict: "already-implemented",
      evidence: "index.html wires #languageFilter to the render.",
      codeEvidence: [{ path: "index.html", excerpt: 'languageFilter.addEventListener("change", updateTable)' }]
    },
    {
      requirement: "Sort by repository name",
      verdict: "missing",
      evidence: 'COLUMNS declares { key: "repo", label: "Repo" } with no sortable flag.',
      ownership: { status: "reserved", by: "@drkrillo", basis: "The rest I am going to split into separate issues myself" }
    },
    {
      requirement: "Improve the mobile/responsive layout",
      verdict: "missing",
      evidence: "There is a single width @media rule in the page.",
      ownership: { status: "offered", by: "@tiruveedhula-charuhasini", basis: "Feel free to open an issue for that one and I will assign it to you" }
    },
    { requirement: "Card layout, badges, empty state", verdict: "out-of-scope" }
  ],
  [
    {
      claim: "@drkrillo (OWNER): sorting by any column, including Created, Updated and Repo, is already in the page",
      verdict: "partly-confirmed",
      evidence: "Comments, Created and Updated are sortable; the Repo column is not.",
      codeEvidence: [created]
    }
  ]
);

describe("engineering and contribution, end to end", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.SQUASHER_REQUIRE_TRIGGER_LABEL;
    staticDir = await mkdtemp(join(tmpdir(), "squasher-contract-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  it("puts the maintainers' current direction in front of the agent, and follows it", async () => {
    // CASE F: the body asks for sorting; the owner says it already exists. The agent must
    // see that before it reads any code, and the result is recorded against it.
    const github = githubWithDiscussion();
    // An agent that first repeats the owner's claim as fact, as on the live run, and corrects
    // itself only if told the claim does not hold. Without the repository check nobody tells
    // it, and the claim reaches the page as fact.
    const complete = vi.fn(async (messages: Array<{ role: string; content: string | null }>) => {
      const last = messages.at(-1);
      const submitted = messages.filter((message) => message.role === "assistant").length;
      if (submitted === 0) return toolCallResponse([{ id: "c1", name: "submit_squasher_result", arguments: repeatedClaim }]);
      if (last?.role === "tool" && String(last.content).includes("does not occur in index.html")) {
        return toolCallResponse([{ id: "c2", name: "submit_squasher_result", arguments: notActionable }]);
      }
      const final = messages.some((message) => message.role === "tool" && String(message.content).includes("does not occur")) ? notActionable : repeatedClaim;
      return textResponse(JSON.stringify(final));
    });
    const llm = { complete } as unknown as LlmClient;
    const harness = new SquasherHarness({ client: github as never, llm, sandbox: fakeSandbox() });
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-contract-data-"));
    const server = createSquasherServer({
      staticDir,
      dataDir,
      trueForgeRuntime: new SquasherTrueForgeRuntime({ modelName: "deepseek-flash" }, harness),
      githubClient: github as never
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
          "X-GitHub-Delivery": "discussion-run-1",
          "X-Hub-Signature-256": signWebhookPayload(body, "webhook-secret")
        },
        body
      });
      let latest: Record<string, any> = {};
      for (let attempt = 0; attempt < 200; attempt += 1) {
        latest = await fetch(`${baseUrl}/api/runs/latest`).then((r) => r.json());
        if (["paused", "completed", "failed"].includes(latest?.trueForge?.status)) break;
        await new Promise((wait) => setTimeout(wait, 5));
      }

      // Read before the agent started, and handed to it in the opening message.
      expect(github.listIssueComments).toHaveBeenCalledWith("o", "r", 164, { limit: 200 });
      const opening = (complete.mock.calls[0]?.[0] as Array<{ role: string; content: string }>)[1]?.content ?? "";
      expect(opening).toContain("Issue discussion:");
      expect(opening).toContain("@owner-login (OWNER, maintainer)");
      expect(opening).toContain("already in there");
      expect(opening).toContain("call read_repository_instructions");

      // Still not actionable, and still no patch: the discrepancy does not become work.
      expect(latest.run.status).toBe("not-actionable");
      expect(latest.statuses.implementation.status).toBe("no_change");
      expect(latest.statuses.contribution.status).toBe("not_applicable");
      expect(latest.trueForge.result.candidatePatch).toBeUndefined();
      expect(github.createPullRequest).not.toHaveBeenCalled();

      // The refused submission is not the result; Repo sorting is reported missing, not implemented.
      const repo = latest.outcome.requirements.find((entry: { requirement: string }) => entry.requirement === "Sort by repository name");
      expect(repo).toMatchObject({ verdict: "missing", ownership: { status: "reserved", by: "@drkrillo" } });
      expect(latest.outcome.checks.find((check: { id: string }) => check.id === "requirements")?.detail).toContain(
        "2 already implemented, 2 missing"
      );

      // Both facts kept: what the owner said, and what the repository shows.
      expect(latest.outcome.claims).toEqual([expect.objectContaining({ verdict: "partly-confirmed" })]);
      const claims = latest.outcome.checks.find((check: { id: string }) => check.id === "claims");
      expect(claims).toMatchObject({ state: "discrepancy" });
      expect(claims.detail).toContain("The discussion says: @drkrillo (OWNER): sorting by any column, including Created, Updated and Repo");
      expect(claims.detail).toContain("The repository shows: Comments, Created and Updated are sortable; the Repo column is not.");
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});

describe("records from before the engineering and contribution split", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    staticDir = await mkdtemp(join(tmpdir(), "squasher-legacy-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  async function latestFor(record: unknown, githubClient?: unknown) {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-legacy-data-"));
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    const server = createSquasherServer({ staticDir, dataDir, ...(githubClient ? { githubClient: githubClient as never } : {}) });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    try {
      return await fetch(`http://127.0.0.1:${port}/api/runs/latest`).then((response) => response.json());
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }

  const verifiedPatchResult = {
    kind: "squasher.result",
    status: "patch-ready",
    summary: "A REQUIRED find_package aborted configure whenever Fontconfig was missing; the fix makes it optional.",
    proof: {
      before: "cmake configure failed 3/3: Could NOT find Fontconfig.",
      after: "cmake configure succeeded 3/3 with the patch.",
      regressions: "Fontconfig is still linked when it is discoverable.",
      attempts: "3/3 before and 3/3 after"
    },
    candidatePatch: {
      title: "Make Fontconfig optional",
      body: "Stops configure aborting when Fontconfig is absent.",
      baseBranch: "main",
      branchName: "squasher/fix-33029-abc",
      files: [{ path: "src/Mod/Sketcher/Gui/CMakeLists.txt", content: "find_package(Fontconfig)\n" }],
      hash: "c".repeat(64),
      verifiedAt: "2026-09-27T00:00:00.000Z"
    }
  };

  function legacyRecord(overrides: Record<string, unknown> = {}) {
    return {
      receivedAt: "2026-09-27T00:00:00.000Z",
      deliveryId: "live-freecad33029-legacy",
      repository: "FreeCAD/FreeCAD",
      baseBranch: "main",
      issueTitle: "cmake: configure error due to recent fontconfig changes",
      issueBody: "Configure fails without Fontconfig.",
      // The old encoding: every refusal rewritten to triage, no writable flag.
      contribution: {
        mode: "triage",
        headOwner: "FreeCAD",
        upstreamPushAccess: false,
        archived: false,
        reason: "FreeCAD/FreeCAD is not in SQUASHER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted"
      },
      run: {
        id: "github-FreeCAD-FreeCAD-33029-legacy",
        issue: { owner: "FreeCAD", repo: "FreeCAD", issueNumber: 33029, url: "https://github.test/FreeCAD/FreeCAD/issues/33029" },
        status: "failed",
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
        events: [
          { id: "e1", runId: "x", at: "2026-09-27T00:00:00.000Z", status: "environment-building", message: "TrueForge session started" },
          { id: "e2", runId: "x", at: "2026-09-27T00:05:00.000Z", status: "failed", message: "TrueForge returned a patch without a matching native approval checkpoint" }
        ]
      },
      scan: { safeToExecute: true, findings: [] },
      trueForge: {
        status: "completed",
        error: "TrueForge patch did not match a native approval checkpoint",
        events: [],
        result: verifiedPatchResult
      },
      ...overrides
    };
  }

  it("reads an old failed run with a verified patch as verified, with its contribution blocked", async () => {
    const latest = await latestFor(legacyRecord());

    // The raw history is untouched...
    expect(latest.run.status).toBe("failed");
    // ...but the answer to "did the engineering succeed" is no longer that failure.
    expect(latest.statuses.implementation).toMatchObject({ status: "verified", label: "Verified" });
    expect(latest.statuses.contribution).toMatchObject({ status: "blocked", label: "Blocked" });
    expect(latest.statuses.contribution.reason).toContain("SQUASHER_UPSTREAM_ALLOWLIST");
    expect(latest.outcome.kind).toBe("contribution-blocked");
    expect(latest.outcome.headline).toBe("Implementation verified. Pull request was not created.");
    expect(latest.trueForge.result.candidatePatch.files[0].path).toBe("src/Mod/Sketcher/Gui/CMakeLists.txt");
    // No pull request exists, so the next step is Squasher's own, never agent text that might
    // assume one does.
    expect(latest.outcome.nextStep).toMatchObject({ source: "server" });
    expect(latest.outcome.nextStep.text).toContain("re-run the issue to submit the verified patch");
  });

  it("still reads an old genuine failure as a failure", async () => {
    const latest = await latestFor(
      legacyRecord({
        trueForge: { status: "completed", error: "TrueForge turn failed: Model request failed: Request timed out.", events: [] },
        run: {
          id: "github-o-r-1-timeout",
          issue: { owner: "o", repo: "r", issueNumber: 1, url: "https://github.test/o/r/issues/1" },
          status: "failed",
          createdAt: "2026-09-27T00:00:00.000Z",
          updatedAt: "2026-09-27T00:00:00.000Z",
          events: [{ id: "e1", runId: "x", at: "2026-09-27T00:00:00.000Z", status: "failed", message: "TrueForge turn failed: Model request failed: Request timed out." }]
        }
      })
    );

    expect(latest.statuses.implementation.status).toBe("failed");
    expect(latest.statuses.implementation.reason).toContain("Request timed out");
    expect(latest.statuses.contribution.status).toBe("not_applicable");
    expect(latest.outcome.kind).toBe("failed");
  });

  it("follows a submitted pull request to merged, and to changes requested", async () => {
    const submitted = legacyRecord({
      contribution: { mode: "fork", writable: true, headOwner: "me", upstreamPushAccess: false, archived: false, reason: "fork" },
      run: {
        id: "github-FreeCAD-FreeCAD-33029-pr",
        issue: { owner: "FreeCAD", repo: "FreeCAD", issueNumber: 33029, url: "https://github.test/FreeCAD/FreeCAD/issues/33029" },
        status: "pr-created",
        createdAt: "2026-09-27T00:00:00.000Z",
        updatedAt: "2026-09-27T00:00:00.000Z",
        events: []
      },
      trueForge: {
        status: "completed",
        events: [],
        result: { ...verifiedPatchResult, pullRequest: { number: 77, url: "https://github.test/FreeCAD/FreeCAD/pull/77" } }
      }
    });

    // Creating a pull request is not merging it: without a read of GitHub it is only submitted.
    expect((await latestFor(submitted)).statuses.contribution.status).toBe("submitted");

    const merged = await latestFor(submitted, {
      getPullRequest: vi.fn().mockResolvedValue({ number: 77, html_url: "u", state: "closed", merged: true })
    });
    expect(merged.statuses.contribution).toMatchObject({ status: "merged", reason: "Pull request #77 was merged" });

    const reviewed = await latestFor(submitted, {
      getPullRequest: vi.fn().mockResolvedValue({ number: 77, html_url: "u", state: "open", merged: false }),
      listPullRequestReviews: vi.fn().mockResolvedValue([
        { id: 1, state: "APPROVED", user: { login: "a" } },
        { id: 2, state: "COMMENTED", user: { login: "b" } },
        { id: 3, state: "CHANGES_REQUESTED", user: { login: "c" } }
      ])
    });
    expect(reviewed.statuses.contribution.status).toBe("changes_requested");
    expect(reviewed.outcome.nextStep.text).toContain("update the branch");

    const closed = await latestFor(submitted, {
      getPullRequest: vi.fn().mockResolvedValue({ number: 77, html_url: "u", state: "closed", merged: false })
    });
    expect(closed.statuses.contribution.status).toBe("closed");
  });
});

describe("contribution decisions per run", () => {
  it("keeps each issue's decision when two issues in one repository run at once", () => {
    const registry = new ContributionRegistry();
    registry.set("o", "r", { mode: "fork", writable: true, headOwner: "me", upstreamPushAccess: false, archived: false, reason: "ok" }, "squasher/fix-43-a");
    registry.set(
      "o",
      "r",
      { mode: "fork", writable: false, headOwner: "me", upstreamPushAccess: false, archived: false, reason: "A Squasher pull request for issue #42 is already open" },
      "squasher/fix-42-b"
    );

    // #42's duplicate block, written last, must not leak onto #43.
    expect(registry.decide("o", "r", "squasher/fix-43-a")).toEqual({ allowed: true, headOwner: "me" });
    expect(registry.decide("o", "r", "squasher/fix-42-b")).toMatchObject({ allowed: false });
    // Unknown repositories still fail closed.
    expect(registry.decide("x", "y", "squasher/fix-1-c")).toMatchObject({ allowed: false });
  });
});
