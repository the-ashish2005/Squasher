import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessPanel, OverviewView } from "./App";
import { RunStatusPills } from "./Outcome";
import { toDashboardRunFromWebhook, type RunOutcome } from "./data";

/**
 * The overview used to label every run "Verified finding / Why this run matters" and every
 * run without a patch "Mutation gate / Awaiting proof", with the last event's full text as
 * the only explanation. These render the overview from outcomes shaped as the server
 * derives them and check that each kind of run explains itself, and that the page adds no
 * explanation of its own.
 */

type WebhookRecord = Parameters<typeof toDashboardRunFromWebhook>[0];

const at = "2026-09-29T10:00:00.000Z";

function outcome(overrides: Partial<RunOutcome>): RunOutcome {
  return {
    kind: "not-reproduced",
    tone: "warning",
    gate: { eyebrow: "Run outcome", title: "No mutation required" },
    headline: "The reported failure was not reproduced",
    statement: { text: "The reported error does not occur on the default branch.", source: "agent" },
    change: {
      created: false,
      title: "Why no pull request?",
      reasons: ["The agent did not reproduce the reported failure, so there was nothing to fix."],
      files: [],
      verification: []
    },
    checks: [
      { id: "security", label: "Issue safety scan", state: "done", detail: "The issue text passed the safety scan.", source: "server" },
      { id: "files", label: "Repository files inspected", state: "done", detail: "2 files: src/a.py, README.md.", source: "trace" },
      { id: "reproduction", label: "Reproduction", state: "info", detail: "Not reproduced: 3/3 runs completed without the error.", source: "agent" }
    ],
    trace: { retained: 12, truncated: false },
    findings: [],
    rootCause: { established: false, text: "Root cause not established" },
    nextStep: { text: "No further action is required based on the available evidence.", source: "server" },
    ...overrides
  };
}

function record(options: {
  status: string;
  harnessStatus?: string;
  harnessError?: string;
  outcome: RunOutcome;
  result?: Record<string, unknown>;
  contribution?: Record<string, unknown>;
  lastMessage?: string;
  statuses?: Record<string, unknown>;
}): WebhookRecord {
  return {
    receivedAt: at,
    deliveryId: "outcome-ui",
    repository: "o/r",
    baseBranch: "main",
    issueTitle: "Analyzer crashes on headings",
    issueBody: "It throws.",
    run: {
      id: "github-o-r-7-outcome-ui",
      issue: { owner: "o", repo: "r", issueNumber: 7, url: "https://github.test/o/r/issues/7" },
      status: options.status,
      createdAt: at,
      updatedAt: at,
      events: [
        { id: "e1", runId: "github-o-r-7-outcome-ui", at, status: "received", message: "GitHub issue webhook verified and scanned" },
        { id: "e2", runId: "github-o-r-7-outcome-ui", at, status: options.status, message: options.lastMessage ?? "A long final message from the model that used to fill the gate panel." }
      ]
    },
    scan: { safeToExecute: true, findings: [] },
    ...(options.contribution ? { contribution: options.contribution } : {}),
    outcome: options.outcome,
    ...(options.statuses ? { statuses: options.statuses } : {}),
    trueForge: {
      status: options.harnessStatus ?? "completed",
      ...(options.harnessError ? { error: options.harnessError } : {}),
      events: [],
      ...(options.result ? { result: options.result } : {})
    }
  } as unknown as WebhookRecord;
}

const patch = {
  title: "Fix the tokenizer escape",
  body: "Adds a bounds check.",
  baseBranch: "main",
  branchName: "squasher/fix-7-abc",
  files: [{ path: "src/tokenizer.ts", content: "export {};\n" }],
  hash: "a".repeat(64),
  verifiedAt: at
};

const proof = {
  before: "The reproducer failed 3/3.",
  after: "The reproducer passed 3/3.",
  regressions: "The existing suite passed.",
  attempts: "3/3 matching executions"
};

function gatePanel(html: string): string {
  const start = html.indexOf('<section class="panel approval-panel">');
  return html.slice(start, html.indexOf("</section>", start));
}

function renderOverview(webhookRecord: WebhookRecord) {
  const run = toDashboardRunFromWebhook(webhookRecord);
  const pullRequest = run.pullRequest;
  return renderToStaticMarkup(
    <OverviewView run={run} currentStatus={run.status} pullRequest={pullRequest} onApproval={async () => undefined} onOpenView={() => undefined} />
  );
}

describe("run outcome overview", () => {
  it("explains a not-reproduced run without a pending gate", () => {
    const html = renderOverview(
      record({
        status: "not-reproduced",
        outcome: outcome({}),
        result: { status: "not-reproduced", summary: "## Verdict\n\nThe reported error does not occur on the default branch. A long explanation follows." }
      })
    );

    expect(html).toContain("Why this run stopped");
    expect(html).toContain("The reported failure was not reproduced");
    expect(html).toContain("No mutation required");
    expect(html).toContain("Why no pull request?");
    expect(html).toContain("Root cause not established");
    expect(html).toContain("No further action is required based on the available evidence.");
    expect(html).toContain("What Squasher checked");
    expect(html).toContain("Repository files inspected");
    expect(html).toContain("Reported by the agent");
    expect(html).toContain("Recorded by Squasher");
    // The fixed labels that made a finished run look unfinished are gone.
    expect(html).not.toContain("Awaiting proof");
    expect(html).not.toContain("Why this run matters");
    expect(html).not.toContain("Verified finding");
    // The last event stays in the timeline but is no longer dumped into the gate; the full
    // report sits in a collapsed section instead.
    expect(gatePanel(html)).not.toContain("used to fill the gate panel");
    expect(html).toMatch(/<details class="raw-evidence"><summary>.*Agent&#x27;s full report<\/summary>/);
  });

  it("shows the agent's root cause and next step with their source", () => {
    const html = renderOverview(
      record({
        status: "not-reproduced",
        outcome: outcome({
          rootCause: { established: true, text: "The reporter ran release 4.0.0, which predates the fix.", source: "agent" },
          nextStep: { text: "Ask the reporter to upgrade.", source: "agent" },
          findings: ["analyze() calls the helper on main."]
        })
      })
    );

    expect(html).toContain("The reporter ran release 4.0.0, which predates the fix.");
    expect(html).not.toContain("Root cause not established");
    expect(html).toContain("Ask the reporter to upgrade.");
    expect(html).toContain("Findings reported by the agent");
  });

  it("reports an implemented change that became a pull request", () => {
    const html = renderOverview(
      record({
        status: "pr-created",
        contribution: { mode: "fork", headOwner: "me", reason: "No push access to o/r; contributing from fork me/r" },
        result: { status: "implemented-feature", summary: "Added the requested button.", proof, candidatePatch: patch, pullRequest: { number: 49, url: "https://github.test/o/r/pull/49" } },
        outcome: outcome({
          kind: "contribution-created",
          tone: "success",
          gate: { eyebrow: "Contribution", title: "Draft pull request opened" },
          headline: "A draft pull request was opened",
          change: {
            created: true,
            title: "Contribution created",
            reasons: ["Draft pull request #49 was opened after a maintainer approved the patch."],
            pullRequest: { number: 49, url: "https://github.test/o/r/pull/49" },
            branch: "squasher/fix-7-abc",
            target: "me/r",
            files: ["src/tokenizer.ts"],
            verification: [{ label: "Attempts", text: "3/3 matching executions" }]
          },
          nextStep: { text: "Review draft pull request #49 on GitHub.", source: "server" }
        })
      })
    );

    expect(html).toContain("Draft pull request opened");
    expect(html).toContain("Contribution created");
    expect(html).toContain("Open draft PR #49");
    expect(html).toContain("squasher/fix-7-abc");
    expect(html).toContain("Verification reported by the agent");
    expect(html).not.toContain("Why no pull request");
  });

  it("keeps the approval controls for a patch awaiting approval", () => {
    const html = renderOverview(
      record({
        status: "awaiting-approval",
        harnessStatus: "paused",
        result: { status: "patch-ready", summary: "The tokenizer crashes on a trailing escape.", proof, candidatePatch: patch },
        outcome: outcome({
          kind: "awaiting-approval",
          gate: { eyebrow: "Mutation gate", title: "Awaiting human approval" },
          headline: "A verified fix is waiting for approval",
          change: { created: false, title: "Why no pull request yet?", reasons: ["Nothing has been written yet."], files: ["src/tokenizer.ts"], verification: [] },
          nextStep: { text: "Review the evidence and the exact diff, then approve or reject the pull request.", source: "server" }
        })
      })
    );

    expect(html).toContain("Awaiting human approval");
    expect(html).toContain("Review decision");
    expect(html).toContain("Nothing has been written");
    expect(html).toContain("src/tokenizer.ts");
  });

  it("explains a failed run and keeps the raw error under technical details", () => {
    const html = renderOverview(
      record({
        status: "failed",
        harnessError: "TrueForge turn failed: Model request failed: Request timed out.",
        outcome: outcome({
          kind: "failed",
          tone: "danger",
          gate: { eyebrow: "Run outcome", title: "Run failed" },
          headline: "The run stopped before it could finish",
          statement: { text: "TrueForge turn failed: Model request failed: Request timed out.", source: "server" },
          change: { created: false, title: "Why no pull request?", reasons: ["The run failed before a verified patch was produced."], files: [], verification: [] },
          checks: [{ id: "result", label: "Structured result", state: "failed", detail: "No valid result was submitted.", source: "server" }],
          nextStep: { text: "Re-run the issue. If it fails the same way, inspect the technical details below.", source: "server" }
        })
      })
    );

    expect(html).toContain("Run failed");
    expect(html).toContain("The run failed before a verified patch was produced.");
    expect(html).toContain("check-row check-failed");
    expect(html).toContain("Harness error");
    expect(html).not.toContain("Awaiting proof");
  });

  it("explains a patch that policy blocked without offering to approve it", () => {
    const html = renderOverview(
      record({
        status: "failed",
        contribution: { mode: "fork", writable: false, headOwner: "o", reason: "o/r is not in SQUASHER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted" },
        result: { status: "patch-ready", summary: "A missing dependency aborts configure.", proof, candidatePatch: patch },
        outcome: outcome({
          kind: "contribution-blocked",
          gate: { eyebrow: "Contribution gate", title: "Contribution blocked" },
          headline: "A change was prepared, but policy does not allow it to be written",
          statement: { text: "o/r is not in SQUASHER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted", source: "server" },
          change: {
            created: false,
            title: "Why no pull request?",
            reasons: ["A patch was prepared, but this run's contribution policy does not permit a GitHub write."],
            files: ["src/tokenizer.ts"],
            verification: []
          }
        })
      })
    );

    expect(html).toContain("Contribution blocked");
    expect(html).toContain("contribution policy does not permit a GitHub write");
    expect(html).toContain("1 file prepared, not written");
    expect(html).not.toContain("Review decision");
    expect(html).not.toContain("Maintainer decision required");
  });

  const verifiedButBlocked = {
    implementation: { status: "verified", label: "Verified", reason: "The change was verified with executed evidence" },
    contribution: {
      status: "blocked",
      label: "Blocked",
      reason: "o/r is not in SQUASHER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted",
      action: "Add o/r to SQUASHER_UPSTREAM_ALLOWLIST after reading its contribution guidelines, then re-run the issue"
    }
  };

  it("shows a verified implementation with a blocked contribution as verified, not failed", () => {
    const blockedOutcome = outcome({
      kind: "contribution-blocked",
      tone: "warning",
      gate: { eyebrow: "Contribution gate", title: "Pull request not created" },
      headline: "Implementation verified. Pull request was not created.",
      statement: { text: verifiedButBlocked.contribution.reason, source: "server" },
      change: {
        created: false,
        title: "Why no pull request?",
        reasons: ["The change was verified. It was not submitted to GitHub, and the verified patch is kept on this page."],
        files: ["src/tokenizer.ts"],
        verification: []
      },
      nextStep: { text: verifiedButBlocked.contribution.action, source: "server" },
      implementation: verifiedButBlocked.implementation,
      contribution: verifiedButBlocked.contribution,
      requirements: [{ requirement: "Configure succeeds without Fontconfig", verdict: "pass", evidence: "cmake configured 3/3." }]
    });
    const html = renderOverview(
      record({
        status: "patch-ready",
        contribution: { mode: "fork", writable: false, headOwner: "o", reason: verifiedButBlocked.contribution.reason },
        result: { status: "patch-ready", summary: "Configure no longer aborts.", proof, candidatePatch: patch },
        statuses: verifiedButBlocked,
        outcome: blockedOutcome
      })
    );
    const pills = renderToStaticMarkup(<RunStatusPills statuses={verifiedButBlocked} />);

    expect(pills).toContain("Implementation: Verified");
    expect(pills).toContain("Contribution: Blocked");
    expect(pills).toContain("status-success");
    expect(pills).not.toContain("status-danger");
    expect(html).toContain("Implementation verified. Pull request was not created.");
    expect(html).toContain("Pull request not created");
    expect(html).toContain("SQUASHER_UPSTREAM_ALLOWLIST");
    expect(html).toContain("Add o/r to SQUASHER_UPSTREAM_ALLOWLIST");
    expect(html).toContain("Requirement verification");
    expect(html).toContain("Configure succeeds without Fontconfig");
    expect(html).not.toContain("Run failed");
    expect(html).not.toContain("Review decision");
  });

  it("shows a genuine engineering failure as a failed implementation", () => {
    const failed = {
      implementation: { status: "failed", label: "Failed", reason: "TrueForge turn failed: iteration limit" },
      contribution: { status: "not_applicable", label: "Not applicable", reason: "The run produced no change to submit" }
    };
    const pills = renderToStaticMarkup(<RunStatusPills statuses={failed} />);

    expect(pills).toContain("Implementation: Failed");
    expect(pills).toContain("status-danger");
    expect(pills).toContain("Contribution: Not applicable");
  });

  it("reads an old record's triage mode as not writable, so no write target is offered", () => {
    const run = toDashboardRunFromWebhook(
      record({ status: "failed", contribution: { mode: "triage", headOwner: "o", reason: "not allowlisted" }, outcome: outcome({}) })
    );

    expect(run.contribution).toMatchObject({ mode: "triage", writable: false });
    expect(run.contribution?.writeTarget).toBeUndefined();
  });

  it("marks trace-derived numbers as lower bounds when the trace was truncated", () => {
    const run = toDashboardRunFromWebhook(
      record({
        status: "not-reproduced",
        outcome: outcome({ trace: { retained: 120, truncated: true } })
      })
    );
    const overview = renderOverview(record({ status: "not-reproduced", outcome: outcome({ trace: { retained: 120, truncated: true } }) }));

    expect(overview).toContain("Only the last 120 trace events are kept for this run");
    expect(run.harness.traceTruncated).toBe(true);
    expect(run.harness.currentTask).toBe("The reported failure was not reproduced");
    expect(renderToStaticMarkup(<HarnessPanel harness={run.harness} />)).toContain("most recent trace events");
  });
});
