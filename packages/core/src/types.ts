export type RunStatus =
  | "received"
  | "security-review"
  | "rejected"
  | "triaging"
  | "needs-info"
  | "failed"
  | "environment-building"
  | "environment-failed"
  | "reproducing"
  | "not-reproduced"
  /**
   * Understood, but deliberately not built: impossible here, ambiguous, unrelated to the
   * project, or out of scope. Distinct from not-reproduced, which means a claimed defect
   * could not be demonstrated — reporting a declined change request as "not reproduced"
   * describes work that was never attempted as a failed reproduction.
   */
  | "not-actionable"
  | "flaky"
  | "verified"
  | "minimizing"
  | "fixing"
  | "validating"
  | "fix-failed"
  | "patch-ready"
  | "awaiting-approval"
  | "approved"
  | "pr-created";

/**
 * Whether the engineering work succeeded, independent of whether it reached GitHub.
 *
 * - running:     still investigating.
 * - implemented: a change exists but its verification did not hold.
 * - verified:    a change exists and its evidence held.
 * - reproduced:  a defect was demonstrated, with no fix attached.
 * - no_change:   investigation concluded no change belongs here (not reproduced, not actionable).
 * - blocked:     engineering could not proceed (environment, security hold, harness unavailable).
 * - failed:      engineering genuinely failed (no valid result, iteration limit, model error).
 */
export type ImplementationStatus = "running" | "implemented" | "verified" | "reproduced" | "no_change" | "blocked" | "failed";

/**
 * Where the change stands on GitHub, independent of whether the engineering succeeded. A
 * blocked or unavailable contribution never makes a verified implementation a failure.
 *
 * - not_started:       nothing to submit yet, or no write has been requested.
 * - not_applicable:    the run produced no change to submit.
 * - available:         a write is permitted but has not been requested.
 * - awaiting_approval: a write is paused for a maintainer.
 * - submitted:         a pull request is open.
 * - approved / changes_requested: the latest review on that pull request.
 * - merged / closed:   the pull request finished.
 * - rejected:          a maintainer declined the write in Squasher.
 * - blocked:           configuration or policy forbids the write (triage, allowlist, repo policy, duplicate).
 * - unavailable:       the write is not technically possible (no access, archived, fork failed).
 */
export type ContributionStatus =
  | "not_started"
  | "not_applicable"
  | "available"
  | "awaiting_approval"
  | "submitted"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed"
  | "rejected"
  | "blocked"
  | "unavailable";

export interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
  url: string;
  baseSha?: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  status: RunStatus;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface ReproRun {
  id: string;
  issue: GitHubIssueRef;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: RunEvent[];
}

export interface SecurityFinding {
  ruleId: string;
  severity: "low" | "medium" | "high" | "critical";
  reason: string;
  matchedText: string;
}

export interface SecurityScanResult {
  safeToExecute: boolean;
  findings: SecurityFinding[];
}
