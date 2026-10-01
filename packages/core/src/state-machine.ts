import type { GitHubIssueRef, ReproRun, RunEvent, RunStatus } from "./types.js";

const allowedTransitions: Record<RunStatus, RunStatus[]> = {
  received: ["security-review", "failed"],
  "security-review": ["triaging", "rejected", "failed"],
  rejected: [],
  triaging: ["needs-info", "environment-building", "not-actionable", "failed"],
  "needs-info": [],
  failed: [],
  "environment-building": ["reproducing", "environment-failed", "not-actionable", "failed"],
  "environment-failed": [],
  reproducing: ["verified", "flaky", "not-reproduced", "not-actionable", "failed"],
  "not-reproduced": [],
  // Terminal: a declined change request is a decision, not a step toward one.
  "not-actionable": [],
  flaky: [],
  verified: ["minimizing", "failed"],
  minimizing: ["fixing", "failed"],
  fixing: ["validating", "fix-failed", "failed"],
  validating: ["patch-ready", "fix-failed", "failed"],
  "fix-failed": [],
  "patch-ready": ["awaiting-approval", "failed"],
  // Back to patch-ready when the paused write can no longer be resumed: the approval step
  // is lost, but the verified patch is not, so the run must not read as an engineering failure.
  "awaiting-approval": ["approved", "rejected", "patch-ready", "failed"],
  approved: ["pr-created", "failed"],
  "pr-created": []
};

export function createRun(id: string, issue: GitHubIssueRef, now = new Date()): ReproRun {
  const timestamp = now.toISOString();
  return {
    id,
    issue,
    status: "received",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [
      {
        id: `${id}:received`,
        runId: id,
        at: timestamp,
        status: "received",
        message: "GitHub issue received"
      }
    ]
  };
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionRun(
  run: ReproRun,
  nextStatus: RunStatus,
  message: string,
  options: { now?: Date; evidence?: Record<string, unknown> } = {}
): ReproRun {
  if (!canTransition(run.status, nextStatus)) {
    throw new Error(`Invalid Squasher transition: ${run.status} -> ${nextStatus}`);
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const event: RunEvent = {
    id: `${run.id}:${run.events.length + 1}:${nextStatus}`,
    runId: run.id,
    at: timestamp,
    status: nextStatus,
    message,
    ...(options.evidence ? { evidence: options.evidence } : {})
  };

  return {
    ...run,
    status: nextStatus,
    updatedAt: timestamp,
    events: [...run.events, event]
  };
}
