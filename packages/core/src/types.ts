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
