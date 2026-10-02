import type { ChangeRequestView, DashboardRun, PolicySummaryView, RevisionView, RunStatusView, WorkspaceJobView, WorkspaceRequirement } from "./data";
import { diffFile, type FileDiff } from "./diff";

/**
 * Everything the Contribution Workspace shows, derived from the run's public data. Nothing
 * here is invented: where the run does not carry a fact -- a base file, a requirement-to-file
 * mapping, a structured test count -- the model says it is unavailable and the page says so.
 */

/**
 * Where the human review stands. A frontend view of the server's contribution status plus
 * the workspace's own facts; it does not replace either.
 *
 * - not-applicable:        no verified patch to review.
 * - squasher-working:      Squasher is applying a change, re-verifying, or running tests.
 * - awaiting-human-review: a version is ready and can be approved.
 * - changes-requested:     a requested change is recorded but not applied.
 * - blocked-by-policy:     the repository's policy or this deployment's settings forbid the write.
 * - review-only:           verified, but nothing can be approved from this run.
 * - submitted:             the current version is on GitHub.
 */
export type ReviewState =
  | "not-applicable"
  | "squasher-working"
  | "awaiting-human-review"
  | "changes-requested"
  | "blocked-by-policy"
  | "review-only"
  | "submitted";

export interface WorkspaceFile {
  path: string;
  /** "unknown" when the base content could not be read: the change is shown without a diff. */
  change: "added" | "modified" | "unknown";
  before?: string;
  after: string;
  diff?: FileDiff;
  /** Against the original Squasher patch, when the current version is a later revision. */
  sinceOriginal?: FileDiff;
  /** In the current version, but not in the original patch. */
  newInRevision?: boolean;
  explanation?: { summary: string; requirements: string[] };
}

/** One version of the patch: the original is 0, revisions follow. */
export interface PatchVersion {
  number: number;
  label: string;
  source: "squasher" | "requested-change" | "verification";
  files: number;
  changeRequest?: string;
  createdAt?: string;
  submitted: boolean;
}

export interface WorkspaceModel {
  available: boolean;
  unavailableReason?: string;
  implementation?: RunStatusView;
  contribution?: RunStatusView;
  /** The version under review: the latest revision, or the original patch. */
  current: { number: number; hash?: string; title?: string };
  versions: PatchVersion[];
  /** Files of the original patch the current version no longer contains. */
  droppedFiles: string[];
  requirements: { items: WorkspaceRequirement[]; counted: number; satisfied: number };
  tests: { passed?: number; failed?: number; source?: string };
  proof?: { before?: string; after?: string; regressions?: string; attempts?: string };
  testCommands?: Array<{ command: string; purpose?: string }>;
  files: WorkspaceFile[];
  /** Requirement → files, only where the agent declared it in fileChanges. */
  mapping: Array<{ requirement: string; files: string[] }> | undefined;
  policy?: PolicySummaryView;
  changeRequests: ChangeRequestView[];
  activeJob?: WorkspaceJobView;
  jobs: WorkspaceJobView[];
  /** The latest test run of the current version, if one ran. */
  latestTestRun?: WorkspaceJobView;
  review: { state: ReviewState; label: string; detail: string };
  approval: { possible: boolean; kind: "original" | "revision"; label: string; reason: string };
  runTests: { possible: boolean; mode: "recorded-commands" | "agent-verification"; reason: string };
}

const satisfiedVerdicts = new Set(["pass", "already-implemented"]);

export function buildWorkspace(run: DashboardRun): WorkspaceModel {
  const patch = run.candidatePatch;
  const implementation = run.statuses?.implementation;
  const contribution = run.statuses?.contribution;
  const revisions = run.revisions ?? [];
  const latest: RevisionView | undefined = revisions.at(-1);
  const changeRequests = run.changeRequests ?? [];
  const jobs = run.workspaceJobs ?? [];
  const activeJob = jobs.find((job) => job.status === "running");

  // Without the server's status, only run states that imply verified evidence count.
  const verified = implementation
    ? implementation.status === "verified"
    : Boolean(patch) && ["patch-ready", "awaiting-approval", "approved", "pr-created"].includes(run.status);

  const originalFiles = patch?.fileContents ?? [];
  const currentFiles = latest?.files ?? originalFiles;
  const fileChanges = latest ? latest.fileChanges : run.fileChanges;
  const requirementsAll = (latest?.requirements ?? run.requirements) ?? [];
  const counted = requirementsAll.filter((requirement) => requirement.verdict !== "out-of-scope" && !requirement.ownership);
  const proof = latest ? latest.proof : run.proof;

  const files: WorkspaceFile[] = currentFiles.map((file) => {
    const base = run.patchDiff?.find((diff) => diff.path === file.path);
    const original = originalFiles.find((entry) => entry.path === file.path);
    const explanation = fileChanges?.find((change) => change.path === file.path);
    const change: WorkspaceFile["change"] = base ? (base.change === "added" ? "added" : "modified") : "unknown";
    return {
      path: file.path,
      change,
      after: file.content,
      ...(base ? { before: base.before, diff: diffFile(base.before, file.content) } : {}),
      ...(latest && original ? { sinceOriginal: diffFile(original.content, file.content) } : {}),
      ...(latest && !original ? { newInRevision: true } : {}),
      ...(explanation ? { explanation: { summary: explanation.summary, requirements: explanation.requirements ?? [] } } : {})
    };
  });
  const droppedFiles = latest ? originalFiles.filter((file) => !currentFiles.some((entry) => entry.path === file.path)).map((file) => file.path) : [];

  const mapping = fileChanges?.length
    ? requirementsAll
        .map((requirement) => ({
          requirement: requirement.requirement,
          files: fileChanges.filter((change) => change.requirements?.includes(requirement.requirement)).map((change) => change.path)
        }))
        .filter((entry) => entry.files.length > 0)
    : undefined;

  const currentNumber = latest?.number ?? 0;
  const submittedNumber = run.pullRequest ? (run.submittedRevision ?? 0) : undefined;
  const versions: PatchVersion[] = [
    { number: 0, label: "Original Squasher patch", source: "squasher", files: originalFiles.length, submitted: submittedNumber === 0 },
    ...revisions.map((revision) => ({
      number: revision.number,
      label: `Revision ${revision.number}`,
      source: revision.source,
      files: revision.files.length,
      ...(revision.changeRequestText ? { changeRequest: revision.changeRequestText } : {}),
      createdAt: revision.createdAt,
      submitted: submittedNumber === revision.number
    }))
  ];
  const latestTestRun = [...jobs].reverse().find((job) => job.kind === "test-run" && job.revision === currentNumber && job.status !== "running");
  const testCommands = latest ? latest.testCommands : run.testCommands;

  const policy = run.policy;
  const base: Omit<WorkspaceModel, "review" | "approval" | "runTests"> = {
    available: Boolean(patch) && verified,
    ...(patch
      ? verified
        ? {}
        : { unavailableReason: "The change was not verified, so there is nothing to review for contribution." }
      : { unavailableReason: "This run produced no patch, so there is nothing to review." }),
    ...(implementation ? { implementation } : {}),
    ...(contribution ? { contribution } : {}),
    current: { number: currentNumber, ...(latest ? { hash: latest.hash, title: latest.title } : patch ? { hash: patch.hash, title: patch.title } : {}) },
    versions,
    droppedFiles,
    requirements: {
      items: requirementsAll,
      counted: counted.length,
      satisfied: counted.filter((requirement) => satisfiedVerdicts.has(requirement.verdict)).length
    },
    tests: reportedTestCounts(proof?.regressions),
    ...(proof ? { proof } : {}),
    ...(testCommands ? { testCommands } : {}),
    files,
    mapping,
    ...(policy ? { policy } : {}),
    changeRequests,
    ...(activeJob ? { activeJob } : {}),
    jobs,
    ...(latestTestRun ? { latestTestRun } : {})
  };

  return {
    ...base,
    review: reviewState(run, base, submittedNumber),
    approval: approvalState(run, base, submittedNumber),
    runTests: runTestsState(base)
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

type ModelBase = Omit<WorkspaceModel, "review" | "approval" | "runTests">;

function reviewState(run: DashboardRun, model: ModelBase, submittedNumber: number | undefined): WorkspaceModel["review"] {
  if (!run.candidatePatch) return { state: "not-applicable", label: "Nothing to review", detail: "This run produced no patch." };
  if (model.activeJob) return { state: "squasher-working", label: "Squasher is working", detail: model.activeJob.stage };
  if (submittedNumber !== undefined && submittedNumber === model.current.number) {
    return { state: "submitted", label: "Submitted", detail: model.contribution?.reason ?? "This version is on GitHub." };
  }
  const pending = model.changeRequests.filter((request) => request.status === "recorded" || request.status === "failed").length;
  if (pending > 0) {
    return {
      state: "changes-requested",
      label: "Changes requested",
      detail: `${pending} requested change${pending === 1 ? " is" : "s are"} not applied. The patch below does not include ${pending === 1 ? "it" : "them"}.`
    };
  }
  if (model.policy && !model.policy.automaticContributionAllowed) {
    return { state: "blocked-by-policy", label: "Blocked by repository policy", detail: model.policy.detail };
  }
  if (run.contribution && !run.contribution.writable) {
    return { state: "blocked-by-policy", label: "Contribution not possible", detail: run.contribution.reason || "This run may not write to GitHub." };
  }
  const approvable = model.current.number > 0 || model.contribution?.status === "awaiting_approval";
  if (approvable) {
    return {
      state: "awaiting-human-review",
      label: "Awaiting human review",
      detail: submittedNumber !== undefined ? "A newer version than the pull request is ready for review." : "The current version is ready for review."
    };
  }
  return { state: "review-only", label: "Review only", detail: model.contribution?.reason ?? "No pull request can be approved from this run." };
}

/**
 * Whether "Approve contribution" can do anything, and what. A revision is submitted by the
 * server's revision approval; the original patch only through the existing paused write.
 * Nothing creates a pull request any other way, and a policy prohibition disables both.
 */
function approvalState(run: DashboardRun, model: ModelBase, submittedNumber: number | undefined): WorkspaceModel["approval"] {
  const kind: "original" | "revision" = model.current.number > 0 ? "revision" : "original";
  const label = kind === "revision"
    ? run.pullRequest
      ? `Update pull request #${run.pullRequest.number} with revision ${model.current.number}`
      : `Approve revision ${model.current.number}`
    : "Approve contribution";
  const refuse = (reason: string) => ({ possible: false, kind, label, reason });

  if (model.activeJob) return refuse(`Squasher is still working (${model.activeJob.stage}).`);
  if (model.policy && !model.policy.automaticContributionAllowed) {
    return refuse(`Repository policy: ${model.policy.label}. Squasher will not create a pull request.`);
  }
  if (run.contribution && !run.contribution.writable) return refuse(`This run may not write to GitHub: ${run.contribution.reason}`);
  if (submittedNumber !== undefined && submittedNumber === model.current.number) {
    return refuse(`This version is already in pull request #${run.pullRequest!.number}.`);
  }
  if (model.latestTestRun?.testRun && !model.latestTestRun.testRun.passed) {
    return refuse("The latest test run of this version failed. Request a fix or re-run the tests first.");
  }

  if (kind === "revision") {
    return {
      possible: true,
      kind,
      label,
      reason: run.pullRequest
        ? `Approving pushes revision ${model.current.number} to the open pull request's branch as one new commit.`
        : `Approving opens the pull request with revision ${model.current.number}.`
    };
  }
  if (run.status !== "awaiting-approval" || model.contribution?.status !== "awaiting_approval") {
    return refuse(
      model.contribution?.reason ? `No write is waiting for approval: ${model.contribution.reason}` : "No write is waiting for approval in this run."
    );
  }
  return { possible: true, kind, label, reason: "Approving resumes the paused pull request write through the existing approval checkpoint." };
}

function runTestsState(model: ModelBase): WorkspaceModel["runTests"] {
  const mode = model.testCommands?.length ? "recorded-commands" : "agent-verification";
  if (model.activeJob) return { possible: false, mode, reason: `Squasher is still working (${model.activeJob.stage}).` };
  return mode === "recorded-commands"
    ? { possible: true, mode, reason: `Re-runs ${model.testCommands!.length} recorded test command${model.testCommands!.length === 1 ? "" : "s"} against this version in a fresh sandbox.` }
    : { possible: true, mode, reason: "No test commands were recorded for this version, so Squasher re-verifies it with an agent session and records them." };
}
