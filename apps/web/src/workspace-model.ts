import type { ChangeRequestView, DashboardRun, PolicySummaryView, RunStatusView, WorkspaceRequirement } from "./data";
import { diffFile, type FileDiff } from "./diff";

/**
 * Everything the Contribution Workspace shows, derived from the run's public data. Nothing
 * here is invented: where the run does not carry a fact -- a base file, a requirement-to-file
 * mapping, a structured test count -- the model says it is unavailable and the page says so.
 */

/**
 * Where the human review stands. A frontend view of the server's contribution status plus
 * the workspace's own facts (change requests); it does not replace either.
 *
 * - not-applicable:        no verified patch to review.
 * - awaiting-human-review: a paused write waits for a maintainer.
 * - changes-requested:     a human asked for changes Squasher has not made yet.
 * - blocked-by-policy:     the repository's policy or this deployment's settings forbid the write.
 * - review-only:           verified, but no write can be approved from this run (no paused write).
 * - submitted:             a pull request exists.
 */
export type ReviewState = "not-applicable" | "awaiting-human-review" | "changes-requested" | "blocked-by-policy" | "review-only" | "submitted";

export interface WorkspaceFile {
  path: string;
  /** "unknown" when the base content could not be read: the change is shown without a diff. */
  change: "added" | "modified" | "unknown";
  before?: string;
  after: string;
  diff?: FileDiff;
  explanation?: { summary: string; requirements: string[] };
}

/**
 * The original patch, human or requested changes, and the patch now proposed. Only the
 * original exists today: requested changes are recorded but not applied, so the proposed
 * patch is the original one.
 */
export interface PatchRevisions {
  original: { source: "squasher"; files: number; hash?: string };
  applied: Array<{ source: "human" | "requested-change"; files: number }>;
  proposed: { files: number; sameAsOriginal: boolean };
  pendingRequests: number;
}

export interface WorkspaceModel {
  available: boolean;
  unavailableReason?: string;
  implementation?: RunStatusView;
  contribution?: RunStatusView;
  requirements: { items: WorkspaceRequirement[]; counted: number; satisfied: number };
  tests: { passed?: number; failed?: number; source?: string };
  files: WorkspaceFile[];
  /** Requirement → files, only where the agent declared it in fileChanges. */
  mapping: Array<{ requirement: string; files: string[] }> | undefined;
  policy?: PolicySummaryView;
  changeRequests: ChangeRequestView[];
  revisions: PatchRevisions;
  review: { state: ReviewState; label: string; detail: string };
  approval: { possible: boolean; reason: string };
}

const satisfiedVerdicts = new Set(["pass", "already-implemented"]);

export function buildWorkspace(run: DashboardRun): WorkspaceModel {
  const patch = run.candidatePatch;
  const implementation = run.statuses?.implementation;
  const contribution = run.statuses?.contribution;
  const changeRequests = run.changeRequests ?? [];
  const requirementsAll = run.requirements ?? [];
  const counted = requirementsAll.filter((requirement) => requirement.verdict !== "out-of-scope" && !requirement.ownership);
  // Without the server's status, only run states that imply verified evidence count.
  const verified = implementation
    ? implementation.status === "verified"
    : Boolean(patch) && ["patch-ready", "awaiting-approval", "approved", "pr-created"].includes(run.status);

  const files: WorkspaceFile[] = (patch?.fileContents ?? []).map((file) => {
    const base = run.patchDiff?.find((diff) => diff.path === file.path);
    const explanation = run.fileChanges?.find((change) => change.path === file.path);
    const change: WorkspaceFile["change"] = base ? (base.change === "added" ? "added" : "modified") : "unknown";
    return {
      path: file.path,
      change,
      after: file.content,
      ...(base ? { before: base.before, diff: diffFile(base.before, file.content) } : {}),
      ...(explanation ? { explanation: { summary: explanation.summary, requirements: explanation.requirements ?? [] } } : {})
    };
  });

  const mapping = run.fileChanges?.length
    ? requirementsAll
        .map((requirement) => ({
          requirement: requirement.requirement,
          files: run.fileChanges!.filter((change) => change.requirements?.includes(requirement.requirement)).map((change) => change.path)
        }))
        .filter((entry) => entry.files.length > 0)
    : undefined;

  const pendingRequests = changeRequests.filter((request) => request.status === "recorded").length;
  const review = reviewState(run, contribution, pendingRequests);
  const policy = run.policy;
  const approval = approvalState(run, contribution, policy);

  return {
    available: Boolean(patch) && verified,
    ...(patch
      ? verified
        ? {}
        : { unavailableReason: "The change was not verified, so there is nothing to review for contribution." }
      : { unavailableReason: "This run produced no patch, so there is nothing to review." }),
    ...(implementation ? { implementation } : {}),
    ...(contribution ? { contribution } : {}),
    requirements: {
      items: requirementsAll,
      counted: counted.length,
      satisfied: counted.filter((requirement) => satisfiedVerdicts.has(requirement.verdict)).length
    },
    tests: reportedTestCounts(run.proof?.regressions),
    files,
    mapping,
    ...(policy ? { policy } : {}),
    changeRequests,
    revisions: {
      original: { source: "squasher", files: files.length, ...(patch?.hash ? { hash: patch.hash } : {}) },
      applied: [],
      proposed: { files: files.length, sameAsOriginal: true },
      pendingRequests
    },
    review,
    approval
  };
}

/**
 * Pass and fail counts, only when the agent's regression text states them ("83 passed",
 * "2 failed"). These are the agent's report, not a separate measurement, and the page
 * labels them so. Absent counts stay absent.
 */
export function reportedTestCounts(text: string | undefined): WorkspaceModel["tests"] {
  if (!text) return {};
  const passed = /(\d+)\s+passed\b/i.exec(text)?.[1];
  const failed = /(\d+)\s+failed\b/i.exec(text)?.[1];
  return {
    ...(passed ? { passed: Number(passed) } : {}),
    ...(failed ? { failed: Number(failed) } : {}),
    source: text
  };
}

function reviewState(run: DashboardRun, contribution: RunStatusView | undefined, pendingRequests: number): WorkspaceModel["review"] {
  const status = contribution?.status;
  if (run.pullRequest || ["submitted", "approved", "changes_requested", "merged", "closed"].includes(status ?? "")) {
    return { state: "submitted", label: "Submitted", detail: contribution?.reason ?? "A pull request exists for this patch." };
  }
  if (!run.candidatePatch) {
    return { state: "not-applicable", label: "Nothing to review", detail: "This run produced no patch." };
  }
  if (pendingRequests > 0) {
    return {
      state: "changes-requested",
      label: "Changes requested",
      detail: `${pendingRequests} requested change${pendingRequests === 1 ? " is" : "s are"} recorded. Squasher does not apply requested changes yet, so the patch below is unchanged.`
    };
  }
  if (run.policy && !run.policy.automaticContributionAllowed) {
    return { state: "blocked-by-policy", label: "Blocked by repository policy", detail: run.policy.detail };
  }
  if (status === "blocked" || status === "unavailable") {
    return { state: "blocked-by-policy", label: "Contribution not possible", detail: contribution?.reason ?? "This run may not write to GitHub." };
  }
  if (status === "awaiting_approval") {
    return { state: "awaiting-human-review", label: "Awaiting human review", detail: "The pull request is paused until a maintainer approves it." };
  }
  return { state: "review-only", label: "Review only", detail: contribution?.reason ?? "No pull request can be approved from this run." };
}

/**
 * Whether "Approve contribution" can do anything. It uses the existing approval flow, which
 * only resumes a write that is actually paused; nothing here creates a pull request any
 * other way, and a policy prohibition disables it outright.
 */
function approvalState(run: DashboardRun, contribution: RunStatusView | undefined, policy: PolicySummaryView | undefined): WorkspaceModel["approval"] {
  if (run.pullRequest) return { possible: false, reason: "A pull request already exists for this patch." };
  if (policy && !policy.automaticContributionAllowed) {
    return { possible: false, reason: `Repository policy: ${policy.label}. Squasher will not create a pull request.` };
  }
  if (run.status !== "awaiting-approval" || contribution?.status !== "awaiting_approval") {
    return {
      possible: false,
      reason: contribution?.reason
        ? `No write is waiting for approval: ${contribution.reason}`
        : "No write is waiting for approval in this run."
    };
  }
  return { possible: true, reason: "Approving resumes the paused pull request write through the existing approval checkpoint." };
}
