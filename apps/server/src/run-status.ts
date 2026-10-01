import type { ContributionStatus, ImplementationStatus } from "@squasher/core";
import { isContributionWritable, type ContributionBlocker, type ContributionTarget } from "./contribution.js";

/**
 * Two independent answers about a run: did the engineering succeed, and did the change reach
 * GitHub. They used to be one run status, so a verified patch that policy would not let out
 * was reported as a failed run. Neither answer may borrow from the other: a contribution
 * blocker never makes an implementation fail, and a pull request never makes one verified.
 *
 * Both are derived from facts on the record rather than stored as the source of truth, so
 * they cannot drift from what actually happened; the server stamps the derived values onto
 * every record it writes so they are also persisted. Records written before these existed
 * are derived the same way when they are read.
 */

export interface RunStatuses {
  implementation: { status: ImplementationStatus; reason: string };
  contribution: { status: ContributionStatus; reason: string; action?: string };
}

/** A contribution problem that happened after the preflight, such as a failed write. */
export interface ContributionIssue {
  status: "blocked" | "unavailable";
  reason: string;
  action?: string;
  at: string;
}

export interface PullRequestState {
  state: "open" | "closed" | "merged";
  /** The latest decisive review, when there is one. */
  reviewDecision?: "approved" | "changes_requested";
  checkedAt: string;
}

export interface RunStatusFacts {
  runStatus: string;
  runEvents: Array<{ status: string; message: string }>;
  harness: { status: string; error?: string; reason?: string };
  scanSafe: boolean;
  pendingApproval: boolean;
  result?: {
    status: string;
    hasPatch: boolean;
    /** Whether the evidence held when it was checked. */
    proofVerified: boolean;
    pullRequest?: { number: number; url: string };
  };
  contribution?: Pick<ContributionTarget, "mode" | "writable" | "reason" | "blockers">;
  contributionIssue?: ContributionIssue;
  pullRequestState?: PullRequestState;
}

const failedRunStatuses = new Set(["failed", "environment-failed", "fix-failed"]);
const provenStatuses = new Set(["patch-ready", "verified", "implemented-feature", "implemented-improvement"]);

export function deriveRunStatuses(facts: RunStatusFacts): RunStatuses {
  const implementation = deriveImplementation(facts);
  return { implementation, contribution: deriveContribution(facts, implementation.status) };
}

function deriveImplementation(facts: RunStatusFacts): RunStatuses["implementation"] {
  const { result, harness } = facts;

  if (!facts.scanSafe || harness.status === "skipped") {
    return { status: "blocked", reason: "The issue was held by the security scan, so no work was started" };
  }
  if (harness.status === "not-configured") {
    return { status: "blocked", reason: harness.reason ?? "The harness is not configured, so no work was started" };
  }

  if (result) {
    if (provenStatuses.has(result.status)) {
      if (!result.proofVerified) {
        return result.hasPatch
          ? { status: "implemented", reason: "A change was produced, but its evidence did not pass verification" }
          : { status: "failed", reason: "The result claimed proof that did not pass verification" };
      }
      if (result.hasPatch) {
        return { status: "verified", reason: "The change was verified with executed evidence" };
      }
      return result.status === "verified"
        ? { status: "reproduced", reason: "The defect was reproduced; no fix was attached" }
        : { status: "verified", reason: "The requested change was verified, but no patch survived normalization" };
    }
    if (result.status === "not-reproduced") {
      return { status: "no_change", reason: "The reported failure was not reproduced, so no change was made" };
    }
    if (result.status === "not-actionable") {
      return { status: "no_change", reason: "The request was judged not actionable here, so no change was made" };
    }
    if (result.status === "blocked") {
      return { status: "blocked", reason: "The agent reported it was blocked before it could verify a change" };
    }
    return { status: "failed", reason: "The agent reported the work failed" };
  }

  const stopped = failedRunStatuses.has(facts.runStatus) || harness.status === "failed" || harness.status === "completed";
  if (stopped) {
    const failure = [...facts.runEvents].reverse().find((event) => failedRunStatuses.has(event.status));
    return { status: "failed", reason: failure?.message ?? harness.error ?? "The run ended without a valid result" };
  }
  return { status: "running", reason: "The investigation is still running" };
}

function deriveContribution(
  facts: RunStatusFacts,
  implementation: ImplementationStatus
): RunStatuses["contribution"] {
  const { result } = facts;

  if (result?.pullRequest || facts.runStatus === "pr-created") {
    const state = facts.pullRequestState;
    const reference = result?.pullRequest ? `Pull request #${result.pullRequest.number}` : "The pull request";
    if (state?.state === "merged") return { status: "merged", reason: `${reference} was merged` };
    if (state?.state === "closed") return { status: "closed", reason: `${reference} was closed without being merged` };
    if (state?.reviewDecision === "changes_requested") {
      return {
        status: "changes_requested",
        reason: `A reviewer requested changes on ${reference.toLowerCase()}`,
        action: "Read the review on GitHub and update the branch, or re-run the issue with the feedback"
      };
    }
    if (state?.reviewDecision === "approved") return { status: "approved", reason: `${reference} was approved by a reviewer` };
    return { status: "submitted", reason: `${reference} is open`, action: "Review the pull request on GitHub" };
  }

  if (facts.runStatus === "rejected" && facts.scanSafe && facts.harness.status !== "skipped") {
    return { status: "rejected", reason: "A maintainer rejected the patch in Squasher, so nothing was written" };
  }

  if (implementation === "running") {
    return { status: "not_started", reason: "Contribution starts only after the change is verified" };
  }
  if (implementation === "implemented") {
    return { status: "unavailable", reason: "The change was not verified, so it is not offered for submission" };
  }
  if (implementation !== "verified" || !result?.hasPatch) {
    return { status: "not_applicable", reason: "The run produced no change to submit" };
  }

  // A verified patch from here on.
  if (facts.pendingApproval && facts.runStatus === "awaiting-approval") {
    return facts.contributionIssue
      ? { status: facts.contributionIssue.status, reason: facts.contributionIssue.reason, ...(facts.contributionIssue.action ? { action: facts.contributionIssue.action } : {}) }
      : {
          status: "awaiting_approval",
          reason: "The GitHub write is paused for a maintainer's approval",
          action: "Review the evidence and the exact diff, then approve or reject"
        };
  }

  if (facts.contributionIssue) {
    return {
      status: facts.contributionIssue.status,
      reason: facts.contributionIssue.reason,
      ...(facts.contributionIssue.action ? { action: facts.contributionIssue.action } : {})
    };
  }

  if (facts.contribution && !isContributionWritable(facts.contribution)) {
    const blocker: ContributionBlocker | undefined = facts.contribution.blockers?.[0];
    return {
      status: blocker?.kind === "capability" ? "unavailable" : "blocked",
      reason: blocker?.reason ?? facts.contribution.reason,
      // Records from before blockers carried actions still get a concrete next step, so the
      // page never falls back to agent text that may assume a pull request exists.
      action: blocker?.action ?? "Resolve the reason above, then re-run the issue to submit the verified patch, or apply the patch by hand"
    };
  }

  // Writable, verified, and yet no checkpoint: the write was never requested, or a record
  // from before this model lost it. Either way the patch stands and the reason is known.
  const lost = [...facts.runEvents].reverse().find((event) => failedRunStatuses.has(event.status));
  return {
    status: "blocked",
    reason: lost?.message ?? "No approval checkpoint is held for this patch, so it cannot be submitted from this run",
    action: "Re-run the issue to produce an approvable write"
  };
}

/** Labels for the two statuses, shared by the API so the page does not invent its own. */
export const implementationStatusLabels: Record<ImplementationStatus, string> = {
  running: "Running",
  implemented: "Implemented, not verified",
  verified: "Verified",
  reproduced: "Reproduced",
  no_change: "No change needed",
  blocked: "Blocked",
  failed: "Failed"
};

export const contributionStatusLabels: Record<ContributionStatus, string> = {
  not_started: "Not started",
  not_applicable: "Not applicable",
  available: "Available",
  awaiting_approval: "Awaiting approval",
  submitted: "Submitted",
  approved: "Approved",
  changes_requested: "Changes requested",
  merged: "Merged",
  closed: "Closed",
  rejected: "Rejected",
  blocked: "Blocked",
  unavailable: "Unavailable"
};
