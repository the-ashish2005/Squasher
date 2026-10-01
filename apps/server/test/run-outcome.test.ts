import { mkdtemp, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunOutcome, type RunOutcomeInput } from "../src/run-outcome.js";
import { createSquasherServer } from "../src/server.js";

/**
 * The run page used to title every finished run "Verified finding / Why this run matters"
 * and every run without a patch "Mutation gate / Awaiting proof", then print the last
 * event's full text as the explanation. A not-reproduced run on python-seo-analyzer#118
 * therefore looked like it was still waiting for proof. These pin the derived outcome that
 * replaced those fixed labels, and the provenance each statement carries.
 */

function input(overrides: Partial<RunOutcomeInput> = {}): RunOutcomeInput {
  return {
    runStatus: "not-reproduced",
    runEvents: [
      { status: "received", message: "GitHub issue webhook verified and scanned" },
      { status: "environment-building", message: "TrueForge session started" }
    ],
    harness: { status: "completed" },
    pendingApproval: false,
    scan: { safeToExecute: true, findingCount: 0 },
    repository: { owner: "o", repo: "r", issueNumber: 7 },
    trace: [
      { type: "turn.created", category: "session" },
      { type: "model.message", category: "mcp", toolName: "read_issue", target: "issue #7" },
      { type: "model.message", category: "mcp", toolName: "read_file", target: "src/a.py" },
      { type: "model.message", category: "mcp", toolName: "read_file", target: "src/a.py" },
      { type: "model.message", category: "mcp", toolName: "read_file", target: "README.md" },
      { type: "model.message", category: "sandbox", toolName: "run_command" },
      { type: "tool.response", category: "sandbox", exitCode: 1, status: "failed" },
      { type: "model.message", category: "sandbox", toolName: "run_command" },
      { type: "tool.response", category: "sandbox", exitCode: 0, status: "passed" }
    ],
    traceCapacity: 120,
    ...overrides
  };
}

const provenProof = {
  before: "The reproducer failed 3/3 with the reported TypeError.",
  after: "The same reproducer passed 3/3 after the change.",
  regressions: "The existing suite passed: 42 tests.",
  attempts: "3/3 matching executions before and after"
};

const patch = { title: "Fix the tokenizer escape", branchName: "squasher/fix-7-abc", files: ["src/tokenizer.ts"] };

describe("run outcome", () => {
  it("explains a not-reproduced run without claiming a root cause or a pending gate", () => {
    const outcome = buildRunOutcome(
      input({
        result: {
          status: "not-reproduced",
          summary: "## Verdict\n\nThe reported error does not occur on the default branch. The function it names is called from analyze().",
          proof: { before: "n/a", after: "n/a", regressions: "No regression check was run because nothing changed.", attempts: "3/3 runs completed without the error" }
        }
      })
    );

    expect(outcome.kind).toBe("not-reproduced");
    expect(outcome.gate).toEqual({ eyebrow: "Run outcome", title: "No mutation required" });
    expect(outcome.headline).toBe("The reported failure was not reproduced");
    // The heading line is dropped so a collapsed statement cannot render as one big heading.
    expect(outcome.statement).toEqual({
      text: "The reported error does not occur on the default branch. The function it names is called from analyze().",
      source: "agent"
    });
    expect(outcome.rootCause).toEqual({ established: false, text: "Root cause not established" });
    expect(outcome.nextStep).toEqual({ text: "No further action is required based on the available evidence.", source: "server" });
    expect(outcome.change.created).toBe(false);
    expect(outcome.change.title).toBe("Why no pull request?");
    expect(outcome.change.reasons.join(" ")).toContain("No candidate patch was submitted");
    // No change exists, so there is no destination or verification to show for one.
    expect(outcome.change.target).toBeUndefined();
    expect(outcome.change.verification).toEqual([]);

    const checks = Object.fromEntries(outcome.checks.map((check) => [check.id, check]));
    expect(checks.reproduction).toMatchObject({ state: "info", source: "agent" });
    expect(checks.reproduction?.detail).toContain("3/3 runs completed without the error");
    // Free text saying nothing ran is shown, never scored as a passed check.
    expect(checks.tests).toMatchObject({ state: "info", source: "agent" });
    expect(checks.files).toMatchObject({ state: "done", source: "trace", detail: "2 paths requested through GitHub: `src/a.py`, `README.md`." });
    expect(checks.sandbox).toMatchObject({ state: "done", detail: "2 commands run; 1 exited non-zero." });
    expect(checks.issue).toMatchObject({ state: "done", source: "trace" });
  });

  it("uses the agent's own root cause, next step and findings when it supplied them", () => {
    const outcome = buildRunOutcome(
      input({
        result: {
          status: "not-reproduced",
          summary: "The error does not occur on main.",
          rootCause: "The reporter ran release 4.0.0, which predates the change that added the missing call.",
          nextStep: "Ask the reporter to upgrade and confirm.",
          findings: ["analyze() calls analyze_headings() on main.", "  "]
        }
      })
    );

    expect(outcome.rootCause).toEqual({
      established: true,
      text: "The reporter ran release 4.0.0, which predates the change that added the missing call.",
      source: "agent"
    });
    expect(outcome.nextStep).toEqual({ text: "Ask the reporter to upgrade and confirm.", source: "agent" });
    expect(outcome.findings).toEqual(["analyze() calls analyze_headings() on main."]);
  });

  it("puts a verified patch behind the approval gate and says nothing was written", () => {
    const outcome = buildRunOutcome(
      input({
        runStatus: "awaiting-approval",
        harness: { status: "paused" },
        pendingApproval: true,
        contribution: { mode: "fork", headOwner: "me", reason: "No push access to o/r; contributing from fork me/r" },
        result: { status: "patch-ready", summary: "The tokenizer crashes on a trailing escape.", proof: provenProof, candidatePatch: patch }
      })
    );

    expect(outcome.kind).toBe("awaiting-approval");
    expect(outcome.gate).toEqual({ eyebrow: "Mutation gate", title: "Awaiting human approval" });
    expect(outcome.change.title).toBe("Why no pull request yet?");
    expect(outcome.change.reasons[0]).toContain("Nothing has been written yet");
    expect(outcome.change.target).toBe("me/r");
    expect(outcome.nextStep.source).toBe("server");
    // The server itself checked the 3/3 count and the executed reproducer for this status.
    expect(outcome.checks.find((check) => check.id === "reproduction")).toMatchObject({ state: "done", source: "server" });
    expect(outcome.checks.find((check) => check.id === "tests")).toMatchObject({ state: "done", source: "agent" });
    expect(outcome.checks.find((check) => check.id === "contribution")?.detail).toBe("Fork contribution to me/r permitted after approval.");
  });

  it("reports the created pull request with its branch, target and verification", () => {
    const outcome = buildRunOutcome(
      input({
        runStatus: "pr-created",
        contribution: { mode: "fork", headOwner: "me" },
        result: {
          status: "implemented-feature",
          summary: "Added the requested Cancel button.",
          proof: provenProof,
          candidatePatch: patch,
          pullRequest: { number: 49, url: "https://github.test/o/r/pull/49" }
        }
      })
    );

    expect(outcome.kind).toBe("contribution-created");
    expect(outcome.gate).toEqual({ eyebrow: "Contribution", title: "Draft pull request opened" });
    expect(outcome.change).toMatchObject({
      created: true,
      title: "Contribution created",
      pullRequest: { number: 49, url: "https://github.test/o/r/pull/49" },
      branch: "squasher/fix-7-abc",
      target: "me/r",
      files: ["src/tokenizer.ts"]
    });
    expect(outcome.change.verification.map((line) => line.label)).toEqual(["Attempts", "Before", "After", "Regression checks"]);
    expect(outcome.nextStep).toEqual({ text: "Review draft pull request #49 on GitHub.", source: "server" });
    // A change request has nothing to reproduce, and the page must not say otherwise.
    expect(outcome.checks.find((check) => check.id === "reproduction")?.detail).toContain("Not applicable");
  });

  it("explains a failed run from the recorded failure, not from a model summary", () => {
    const outcome = buildRunOutcome(
      input({
        runStatus: "failed",
        runEvents: [
          { status: "environment-building", message: "TrueForge session started" },
          { status: "failed", message: "TrueForge turn failed: The agent loop reached its iteration limit of 64 without producing a final result" }
        ],
        harness: { status: "completed", error: "TrueForge turn failed: iteration limit" }
      })
    );

    expect(outcome.kind).toBe("failed");
    expect(outcome.gate).toEqual({ eyebrow: "Run outcome", title: "Run failed" });
    expect(outcome.statement).toEqual({
      text: "TrueForge turn failed: The agent loop reached its iteration limit of 64 without producing a final result",
      source: "server"
    });
    expect(outcome.change.reasons[0]).toBe("The run failed before a verified patch was produced.");
    expect(outcome.checks.find((check) => check.id === "result")).toMatchObject({ state: "failed" });
    expect(outcome.checks.find((check) => check.id === "reproduction")).toMatchObject({ state: "not-observed" });
    expect(outcome.checks.some((check) => check.id === "tests")).toBe(false);
  });

  it("says a prepared patch was lost when a run fails after preparing it", () => {
    const outcome = buildRunOutcome(
      input({
        runStatus: "failed",
        runEvents: [{ status: "failed", message: "The approved write cannot be resumed: the harness no longer holds the paused tool call." }],
        harness: { status: "paused" },
        result: { status: "implemented-improvement", summary: "Added cache headers.", proof: provenProof, candidatePatch: patch }
      })
    );

    expect(outcome.kind).toBe("failed");
    expect(outcome.change.reasons[0]).toBe("A patch was prepared, but the run failed before it was written.");
  });

  it("blocks a proven patch that the contribution policy will not let out", () => {
    const outcome = buildRunOutcome(
      input({
        runStatus: "failed",
        runEvents: [{ status: "failed", message: "TrueForge returned a patch without a matching native approval checkpoint" }],
        contribution: {
          mode: "triage",
          reason: "o/r is not in SQUASHER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted",
          policyFindings: [{ path: "CONTRIBUTING.md", excerpt: "no AI-generated pull requests" }]
        },
        result: { status: "patch-ready", summary: "A missing dependency aborts configure.", proof: provenProof, candidatePatch: patch }
      })
    );

    expect(outcome.kind).toBe("contribution-blocked");
    expect(outcome.gate).toEqual({ eyebrow: "Contribution gate", title: "Pull request not created" });
    expect(outcome.headline).toBe("Implementation verified. Pull request was not created.");
    expect(outcome.statement).toEqual({
      text: "o/r is not in SQUASHER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted",
      source: "server"
    });
    expect(outcome.change.reasons).toContain("CONTRIBUTING.md: “no AI-generated pull requests”");
    expect(outcome.change.target).toBeUndefined();
    expect(outcome.checks.find((check) => check.id === "contribution")).toMatchObject({ state: "failed", source: "server" });
    // Not validated by the server for this status, so the reproduction stays the agent's claim.
    expect(outcome.checks.find((check) => check.id === "reproduction")).toMatchObject({ state: "done", source: "agent" });
  });

  it("holds an unsafe issue before the agent runs", () => {
    const outcome = buildRunOutcome(
      input({ runStatus: "rejected", harness: { status: "skipped", reason: "Issue was rejected by security policy" }, scan: { safeToExecute: false, findingCount: 2 }, trace: [] })
    );

    expect(outcome.kind).toBe("security-hold");
    expect(outcome.gate).toEqual({ eyebrow: "Input policy", title: "Execution held" });
    expect(outcome.checks.map((check) => check.id)).toEqual(["security"]);
    expect(outcome.checks[0]).toMatchObject({ state: "failed", detail: "Execution was held: 2 findings recorded." });
  });

  it("covers not-actionable and blocked results", () => {
    const notActionable = buildRunOutcome(
      input({ runStatus: "not-actionable", result: { status: "not-actionable", summary: "The build step it names does not exist here." } })
    );
    expect(notActionable.gate).toEqual({ eyebrow: "Run outcome", title: "No change made" });
    expect(notActionable.change.reasons[0]).toContain("not actionable");
    expect(notActionable.checks.find((check) => check.id === "reproduction")?.detail).toContain("Not attempted");

    // Reproduced, then judged unbuildable here: the page must not deny the reproduction the
    // same run reported. Seen on microsoft/pylance-release#8238.
    const reproducedButUnbuildable = buildRunOutcome(
      input({
        runStatus: "not-actionable",
        result: {
          status: "not-actionable",
          summary: "The false positive is real but the fix belongs in another repository.",
          proof: { ...provenProof, attempts: "3/3 before-failures, byte-identical, on the finalized reproducer" }
        }
      })
    );
    const reproduction = reproducedButUnbuildable.checks.find((check) => check.id === "reproduction");
    expect(reproduction?.detail).toBe("3/3 before-failures, byte-identical, on the finalized reproducer");
    expect(reproduction?.detail).not.toContain("Not attempted");

    // A blocked result is recorded as run status failed; it must still read as a block.
    const blocked = buildRunOutcome(input({ runStatus: "failed", result: { status: "blocked", summary: "The sandbox refused the network." } }));
    expect(blocked.kind).toBe("blocked");
    expect(blocked.statement).toEqual({ text: "The sandbox refused the network.", source: "agent" });
    expect(blocked.gate).toEqual({ eyebrow: "Run outcome", title: "Run blocked" });
    expect(blocked.nextStep.text).toBe("Resolve the blocker described above, then re-run the issue.");
  });

  it("shows 'Awaiting proof' only while the run is still in progress", () => {
    const running = buildRunOutcome(input({ runStatus: "environment-building", harness: { status: "started" } }));
    expect(running.kind).toBe("in-progress");
    expect(running.gate.title).toBe("Awaiting proof");

    const finished: RunOutcomeInput[] = [
      input({ result: { status: "not-reproduced", summary: "Not reproduced." } }),
      input({ runStatus: "verified", result: { status: "verified", summary: "Reproduced.", proof: provenProof } }),
      input({ runStatus: "failed", harness: { status: "failed", error: "monitoring failed" } }),
      input({ runStatus: "patch-ready", result: { status: "patch-ready", summary: "Fixed.", proof: provenProof, candidatePatch: patch } })
    ];
    for (const finishedInput of finished) {
      expect(buildRunOutcome(finishedInput).gate.title).not.toBe("Awaiting proof");
    }
  });

  it("treats a full trace without its opening event as truncated and counts only lower bounds", () => {
    const tail = Array.from({ length: 120 }, (_, index) =>
      index % 2 === 0
        ? { type: "model.message", category: "sandbox", toolName: "run_command" }
        : { type: "tool.response", category: "sandbox", exitCode: 0, status: "passed" }
    );
    const outcome = buildRunOutcome(input({ trace: tail, result: { status: "not-reproduced", summary: "Not reproduced." } }));

    expect(outcome.trace).toEqual({ retained: 120, truncated: true });
    // No read_file in the retained tail says nothing about whether files were read.
    expect(outcome.checks.find((check) => check.id === "files")).toMatchObject({ state: "not-observed" });
    expect(outcome.checks.find((check) => check.id === "sandbox")?.detail).toBe("At least 60 commands run; 0 exited non-zero.");

    const complete = buildRunOutcome(input({ result: { status: "not-reproduced", summary: "Not reproduced." } }));
    expect(complete.trace.truncated).toBe(false);
  });
});

describe("run outcome in the public run payload", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    staticDir = await mkdtemp(join(tmpdir(), "squasher-outcome-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  async function latestFor(record: unknown) {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-outcome-data-"));
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    const server = createSquasherServer({ staticDir, dataDir });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    try {
      return await fetch(`http://127.0.0.1:${port}/api/runs/latest`).then((response) => response.json());
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }

  function record(result: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      receivedAt: "2026-09-29T00:00:00.000Z",
      deliveryId: "outcome-1",
      repository: "o/r",
      baseBranch: "main",
      issueTitle: "Tokenizer crashes on a trailing escape",
      issueBody: "It throws a TypeError.",
      run: {
        id: "github-o-r-7-outcome-1",
        issue: { owner: "o", repo: "r", issueNumber: 7, url: "https://github.test/o/r/issues/7" },
        status: "not-reproduced",
        createdAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
        events: [{ id: "e1", runId: "github-o-r-7-outcome-1", at: "2026-09-29T00:00:00.000Z", status: "not-reproduced", message: "Not reproduced." }]
      },
      scan: { safeToExecute: true, findings: [] },
      trueForge: { status: "completed", events: [{ id: "t1", at: "2026-09-29T00:00:00.000Z", type: "turn.created", category: "session", source: "trueforge", status: "info", summary: "TrueForge turn created" }], result },
      ...extra
    };
  }

  it("treats a record from before the provenance flag by content", async () => {
    // Extraction used to fill a missing rootCauseSummary with sentences lifted from the
    // summary -- here from mid-summary, because the sentence splitter skips `a.b` -- and
    // records written then carry no flag saying so.
    const summary = "Calling `tokenizer.ts` with a trailing escape no longer crashes on main. The escape branch now checks the index. Nothing to fix.";
    const latest = await latestFor(
      record({
        kind: "squasher.result",
        status: "not-reproduced",
        summary,
        rootCauseSummary: "ts` with a trailing escape no longer crashes on main. The escape branch now checks the index.",
        proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "3/3 clean runs" }
      })
    );

    expect(latest.outcome.kind).toBe("not-reproduced");
    expect(latest.outcome.rootCause).toEqual({ established: false, text: "Root cause not established" });
  });

  it("derives the approval gate from the private checkpoint without exposing it", async () => {
    const result = {
      kind: "squasher.result",
      status: "patch-ready",
      summary: "The tokenizer crashes on a trailing escape; a bounds check fixes it.",
      rootCauseSummary: "The escape branch reads one character past the end of the pattern.",
      rootCauseReported: true,
      proof: provenProof,
      candidatePatch: {
        title: "Fix the tokenizer escape",
        body: "Adds a bounds check.",
        baseBranch: "main",
        branchName: "squasher/fix-7-abc",
        files: [{ path: "src/tokenizer.ts", content: "export {};\n" }],
        hash: "a".repeat(64),
        verifiedAt: "2026-09-29T00:00:00.000Z"
      }
    };
    const paused = record(result, {
      run: {
        id: "github-o-r-7-outcome-1",
        issue: { owner: "o", repo: "r", issueNumber: 7, url: "https://github.test/o/r/issues/7" },
        status: "awaiting-approval",
        createdAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
        events: []
      },
      trueForge: {
        status: "paused",
        events: [],
        result,
        pendingApproval: { turnId: "turn-1", threadId: "thread-1", toolCallId: "call-1", toolName: "create_fix_pull_request", payloadHash: "b".repeat(64) }
      }
    });

    const latest = await latestFor(paused);

    expect(latest.outcome.kind).toBe("awaiting-approval");
    expect(latest.outcome.gate).toEqual({ eyebrow: "Mutation gate", title: "Awaiting human approval" });
    expect(latest.outcome.rootCause).toEqual({
      established: true,
      text: "The escape branch reads one character past the end of the pattern.",
      source: "agent"
    });
    // The checkpoint informs the outcome but never leaves the server.
    expect(latest.trueForge.pendingApproval).toBeUndefined();
    expect(JSON.stringify(latest)).not.toContain("call-1");
  });
});
