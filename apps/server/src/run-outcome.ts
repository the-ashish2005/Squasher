/**
 * The human-readable account of a run: why it stopped, what backs that conclusion, why no
 * change was (or was) written, and what a maintainer should do next.
 *
 * Everything here is derived from the persisted record, and every sentence says where it
 * came from. Text the agent wrote is carried as the agent's claim (`source: "agent"`); only
 * facts the server itself recorded or checked are stated as `server`, and only what is
 * visible in the retained trace is stated as `trace`. The trace keeps a bounded tail of
 * events, so a trace-derived count is a lower bound once earlier events have been dropped,
 * and an action missing from a truncated trace is reported as not observable rather than
 * as not done.
 */

export type RunOutcomeKind =
  | "in-progress"
  | "not-started"
  | "security-hold"
  | "awaiting-approval"
  | "contribution-created"
  | "contribution-blocked"
  | "patch-ready"
  | "verified"
  | "not-reproduced"
  | "not-actionable"
  | "blocked"
  | "rejected"
  | "failed";

export type OutcomeSource = "server" | "trace" | "agent";

export interface RunOutcomeCheck {
  id: string;
  label: string;
  /**
   * `done`: happened. `failed`: happened and went wrong. `not-observed`: absent from a
   * truncated trace. `discrepancy`: the discussion and the repository disagree.
   */
  state: "done" | "failed" | "info" | "not-observed" | "discrepancy";
  detail: string;
  source: OutcomeSource;
}

export interface RunOutcome {
  kind: RunOutcomeKind;
  tone: "success" | "warning" | "danger" | "active";
  /** Replaces the fixed "Mutation gate / Awaiting proof" heading. */
  gate: { eyebrow: string; title: string };
  headline: string;
  statement: { text: string; source: OutcomeSource };
  change: {
    created: boolean;
    title: string;
    reasons: string[];
    pullRequest?: { number: number; url: string };
    branch?: string;
    target?: string;
    files: string[];
    /** The agent's own verification claims, as submitted. */
    verification: Array<{ label: string; text: string }>;
  };
  checks: RunOutcomeCheck[];
  trace: { retained: number; truncated: boolean };
  findings: string[];
  rootCause: { established: boolean; text: string; source?: OutcomeSource };
  nextStep: { text: string; source: "agent" | "server" };
  /** Engineering and contribution, reported separately; see run-status.ts. */
  implementation?: OutcomeStatus;
  contribution?: OutcomeStatus & { action?: string };
  /** The agent's acceptance criteria and its verdict on each. */
  requirements: OutcomeRequirement[];
  /**
   * Claims from the issue or its discussion and what the repository showed, kept side by
   * side: a comment is context, and a contradicted claim is reported as a discrepancy
   * rather than silently repeated as fact.
   */
  claims: Array<{ claim: string; verdict: string; evidence: string }>;
}

export interface OutcomeRequirement {
  requirement: string;
  verdict: string;
  evidence?: string;
  /** Whose work it is per the discussion; separate from its technical state. */
  ownership?: { status: string; by: string };
}

export interface OutcomeStatus {
  status: string;
  label: string;
  reason: string;
}

export interface RunOutcomeInput {
  runStatus: string;
  runEvents: Array<{ status: string; message: string }>;
  harness: { status: string; error?: string; reason?: string };
  /** Whether a gated write is currently paused in the harness. */
  pendingApproval: boolean;
  scan: { safeToExecute: boolean; findingCount: number };
  repository: { owner: string; repo: string; issueNumber: number };
  contribution?: {
    mode: string;
    /** Absent on records from before it existed, where mode "triage" meant not writable. */
    writable?: boolean;
    headOwner?: string;
    reason?: string;
    policyFindings?: Array<{ path: string; excerpt: string }>;
  };
  /** The two statuses from run-status.ts, when the caller has them. They take precedence. */
  statuses?: {
    implementation: OutcomeStatus;
    contribution: OutcomeStatus & { action?: string };
  };
  result?: {
    status: string;
    summary: string;
    /** Only when the agent supplied it, never the fallback synthesized from the summary. */
    rootCause?: string;
    nextStep?: string;
    findings?: string[];
    requirements?: OutcomeRequirement[];
    discussionClaims?: Array<{ claim: string; verdict: string; evidence: string }>;
    proof?: { before?: string; after?: string; regressions?: string; attempts?: string };
    candidatePatch?: { title?: string; branchName?: string; files: string[] };
    pullRequest?: { number: number; url: string };
  };
  trace: Array<{ type?: string; category?: string; toolName?: string; target?: string; exitCode?: number | string | null; status?: string }>;
  /** How many trace events the record retains; a trace at this length may have lost its head. */
  traceCapacity: number;
}

const noActionNeeded = "No further action is required based on the available evidence.";
const rootCauseMissing = "Root cause not established";
const serverValidatedRunStatuses = new Set(["verified", "patch-ready", "awaiting-approval", "approved", "pr-created"]);
const failedRunStatuses = new Set(["failed", "environment-failed", "fix-failed"]);
const implementationResultStatuses = new Set(["implemented-feature", "implemented-improvement"]);
const provenResultStatuses = new Set(["patch-ready", "verified", ...implementationResultStatuses]);

export function buildRunOutcome(input: RunOutcomeInput): RunOutcome {
  const kind = outcomeKind(input);
  const trace = traceWindow(input);
  const change = changeSection(kind, input);
  return {
    kind,
    tone: toneFor(kind),
    gate: gateFor(kind),
    headline: headlineFor(kind, input),
    statement: statementFor(kind, input),
    change,
    checks: checksFor(kind, input, trace),
    trace,
    findings: (input.result?.findings ?? []).filter((finding) => finding.trim().length > 0),
    rootCause: input.result?.rootCause?.trim()
      ? { established: true, text: input.result.rootCause.trim(), source: "agent" }
      : { established: false, text: rootCauseMissing },
    nextStep: nextStepFor(kind, input),
    ...(input.statuses ? { implementation: input.statuses.implementation, contribution: input.statuses.contribution } : {}),
    requirements: input.result?.requirements ?? [],
    claims: input.result?.discussionClaims ?? []
  };
}

function contributionWritable(contribution: RunOutcomeInput["contribution"]): boolean {
  if (!contribution) return false;
  return contribution.writable ?? contribution.mode !== "triage";
}

const submittedContributions = new Set(["submitted", "approved", "changes_requested", "merged", "closed"]);

function outcomeKind(input: RunOutcomeInput): RunOutcomeKind {
  const { runStatus, result, harness } = input;
  if (input.statuses) {
    const implementation = input.statuses.implementation.status;
    const contribution = input.statuses.contribution.status;
    if (!input.scan.safeToExecute || runStatus === "security-review" || harness.status === "skipped") return "security-hold";
    if (submittedContributions.has(contribution)) return "contribution-created";
    if (contribution === "rejected") return "rejected";
    if (contribution === "awaiting_approval") return "awaiting-approval";
    if (implementation === "verified" && (contribution === "blocked" || contribution === "unavailable")) return "contribution-blocked";
    if (implementation === "verified") return "patch-ready";
    if (implementation === "reproduced") return "verified";
    if (implementation === "no_change") return result?.status === "not-actionable" ? "not-actionable" : "not-reproduced";
    if (implementation === "blocked") return harness.status === "not-configured" ? "not-started" : "blocked";
    if (implementation === "failed" || implementation === "implemented") return "failed";
    return "in-progress";
  }
  if (!input.scan.safeToExecute || runStatus === "security-review" || harness.status === "skipped") {
    return "security-hold";
  }
  if (result?.pullRequest || runStatus === "pr-created") return "contribution-created";
  if (runStatus === "rejected") return "rejected";
  if (runStatus === "awaiting-approval" && input.pendingApproval) return "awaiting-approval";
  // A proven patch that policy would not let out: the write was refused, not the work.
  if (result?.candidatePatch && input.contribution && !contributionWritable(input.contribution)) return "contribution-blocked";
  // The state machine has no blocked state and records an agent-reported block as failed;
  // it is still a block, with the agent's reason, unless the harness itself failed.
  if (result?.status === "blocked" && harness.status !== "failed") return "blocked";
  if (failedRunStatuses.has(runStatus) || harness.status === "failed") return "failed";
  if (harness.status === "not-configured") return "not-started";
  if (result && (harness.status === "completed" || harness.status === "paused")) {
    if (result.status === "not-reproduced") return "not-reproduced";
    if (result.status === "not-actionable") return "not-actionable";
    if (result.status === "blocked") return "blocked";
    if (result.status === "failed") return "failed";
    if (result.candidatePatch) return "patch-ready";
    if (result.status === "verified") return "verified";
  }
  return "in-progress";
}

function toneFor(kind: RunOutcomeKind): RunOutcome["tone"] {
  if (kind === "failed" || kind === "security-hold") return "danger";
  if (kind === "contribution-created" || kind === "patch-ready" || kind === "verified") return "success";
  if (kind === "in-progress") return "active";
  return "warning";
}

function gateFor(kind: RunOutcomeKind): RunOutcome["gate"] {
  switch (kind) {
    case "awaiting-approval":
      return { eyebrow: "Mutation gate", title: "Awaiting human approval" };
    case "contribution-created":
      return { eyebrow: "Contribution", title: "Draft pull request opened" };
    case "contribution-blocked":
      return { eyebrow: "Contribution gate", title: "Pull request not created" };
    case "patch-ready":
      return { eyebrow: "Mutation gate", title: "Patch ready, not written" };
    case "rejected":
      return { eyebrow: "Mutation gate", title: "Change rejected" };
    case "security-hold":
      return { eyebrow: "Input policy", title: "Execution held" };
    case "failed":
      return { eyebrow: "Run outcome", title: "Run failed" };
    case "blocked":
      return { eyebrow: "Run outcome", title: "Run blocked" };
    case "not-actionable":
      return { eyebrow: "Run outcome", title: "No change made" };
    case "not-reproduced":
      return { eyebrow: "Run outcome", title: "No mutation required" };
    case "verified":
      return { eyebrow: "Run outcome", title: "No fix proposed" };
    case "not-started":
      return { eyebrow: "Run outcome", title: "Harness not connected" };
    case "in-progress":
      return { eyebrow: "Mutation gate", title: "Awaiting proof" };
  }
}

function headlineFor(kind: RunOutcomeKind, input: RunOutcomeInput): string {
  const implemented = implementationResultStatuses.has(input.result?.status ?? "");
  switch (kind) {
    case "awaiting-approval":
      return implemented ? "The requested change is implemented and waiting for approval" : "A verified fix is waiting for approval";
    case "contribution-created":
      return "A draft pull request was opened";
    case "contribution-blocked":
      return "Implementation verified. Pull request was not created.";
    case "patch-ready":
      return implemented ? "The requested change is implemented" : "A verified fix was prepared";
    case "rejected":
      return "A maintainer rejected the proposed change";
    case "security-hold":
      return "The issue was held before anything ran";
    case "failed":
      return "The run stopped before it could finish";
    case "blocked":
      return "The agent was blocked";
    case "not-actionable":
      return "The request was judged not actionable";
    case "not-reproduced":
      return "The reported failure was not reproduced";
    case "verified":
      return "The defect was reproduced, with no fix attached";
    case "not-started":
      return "The run never started";
    case "in-progress":
      return "The run is still in progress";
  }
}

function statementFor(kind: RunOutcomeKind, input: RunOutcomeInput): RunOutcome["statement"] {
  const lastFailure = [...input.runEvents].reverse().find((event) => failedRunStatuses.has(event.status) || event.status === "rejected");

  if (kind === "security-hold") {
    return {
      text: `The issue text raised ${plural(input.scan.findingCount, "safety finding")}, so the agent was never started.`,
      source: "server"
    };
  }
  if (kind === "contribution-blocked") {
    const reason = input.statuses?.contribution.reason ?? input.contribution?.reason;
    if (reason) return { text: reason, source: "server" };
  }
  if (kind === "failed" || kind === "rejected") {
    const text = lastFailure?.message ?? input.harness.error ?? input.harness.reason;
    if (text) return { text: briefText(text, 480), source: "server" };
  }
  if (kind === "not-started" && input.harness.reason) {
    return { text: input.harness.reason, source: "server" };
  }
  if (kind === "in-progress") {
    return { text: input.runEvents.at(-1)?.message ? briefText(input.runEvents.at(-1)!.message, 280) : "The run was accepted.", source: "server" };
  }
  if (input.result?.summary) {
    return { text: briefText(leadParagraph(input.result.summary), 480), source: "agent" };
  }
  return { text: input.harness.error ?? "No explanation was recorded for this run.", source: "server" };
}

function changeSection(kind: RunOutcomeKind, input: RunOutcomeInput): RunOutcome["change"] {
  const { result, contribution } = input;
  const patch = result?.candidatePatch;
  // Triage has no destination: naming one would suggest a write that policy forbids.
  const target = contribution?.headOwner && contributionWritable(contribution) ? `${contribution.headOwner}/${input.repository.repo}` : undefined;
  const verification = verificationLines(input);
  // Where a change would go and how it was verified only mean something when there is one.
  const base = patch
    ? { files: patch.files, ...(patch.branchName ? { branch: patch.branchName } : {}), ...(target ? { target } : {}), verification }
    : { files: [], verification: [] };

  if (kind === "contribution-created" && result?.pullRequest) {
    return {
      ...base,
      created: true,
      title: "Contribution created",
      reasons: [`Draft pull request #${result.pullRequest.number} was opened after a maintainer approved the patch.`],
      pullRequest: result.pullRequest
    };
  }
  if (kind === "contribution-created") {
    return { ...base, created: true, title: "Contribution created", reasons: ["The run recorded a created pull request."] };
  }

  const reasons: string[] = [];
  const noWrite = "Squasher writes to GitHub only after a maintainer approves a verified patch.";
  switch (kind) {
    case "awaiting-approval":
      reasons.push("Nothing has been written yet: no branch, commit, or pull request exists until a maintainer approves.");
      break;
    case "patch-ready":
      reasons.push("A patch was prepared, but no approval checkpoint is paused, so it cannot be written from this run.");
      break;
    case "contribution-blocked": {
      reasons.push("The change was verified. It was not submitted to GitHub, and the verified patch is kept on this page.");
      const reason = input.statuses?.contribution.reason ?? contribution?.reason;
      if (reason) reasons.push(`Reason: ${reason}`);
      for (const finding of contribution?.policyFindings ?? []) {
        reasons.push(`${finding.path}: “${finding.excerpt}”`);
      }
      break;
    }
    case "rejected":
      reasons.push("A maintainer rejected the candidate patch, so nothing was written.");
      break;
    case "not-reproduced":
      reasons.push("The agent did not reproduce the reported failure, so there was nothing to fix.");
      reasons.push(`No candidate patch was submitted. ${noWrite}`);
      break;
    case "not-actionable":
      reasons.push("The agent judged the request not actionable, so no change was built.");
      reasons.push(`No candidate patch was submitted. ${noWrite}`);
      break;
    case "verified":
      reasons.push("The defect was reproduced, but no fix was submitted with it.");
      reasons.push(noWrite);
      break;
    case "blocked":
      reasons.push("The agent reported it was blocked before it could produce a verified change.");
      reasons.push(noWrite);
      break;
    case "failed":
      reasons.push(
        patch
          ? "A patch was prepared, but the run failed before it was written."
          : "The run failed before a verified patch was produced."
      );
      reasons.push(noWrite);
      break;
    case "security-hold":
      reasons.push("The agent never ran, so no change could be prepared.");
      break;
    case "not-started":
      reasons.push("The agent never ran, so no change could be prepared.");
      break;
    case "in-progress":
      reasons.push("The run has not finished. A pull request can only follow a verified patch and a maintainer's approval.");
      break;
  }

  if (contribution && !contributionWritable(contribution) && kind !== "contribution-blocked" && kind !== "security-hold" && kind !== "not-started") {
    reasons.push(`Even with a verified patch, this run could not have written to GitHub: ${contribution.reason ?? "contribution mode is triage"}`);
  }

  return {
    ...base,
    created: false,
    title: kind === "awaiting-approval" ? "Why no pull request yet?" : "Why no pull request?",
    reasons
  };
}

function verificationLines(input: RunOutcomeInput): RunOutcome["change"]["verification"] {
  const proof = input.result?.proof;
  if (!proof) return [];
  return [
    { label: "Attempts", text: proof.attempts },
    { label: "Before", text: proof.before },
    { label: "After", text: proof.after },
    { label: "Regression checks", text: proof.regressions }
  ].flatMap(({ label, text }) => (isMeaningful(text) ? [{ label, text: briefText(text, 320) }] : []));
}

function traceWindow(input: RunOutcomeInput): RunOutcome["trace"] {
  const retained = input.trace.length;
  // A complete trace opens with the harness's first event. At capacity with some other
  // event first, the head was dropped.
  const truncated = retained >= input.traceCapacity && input.trace[0]?.type !== "turn.created";
  return { retained, truncated };
}

function checksFor(kind: RunOutcomeKind, input: RunOutcomeInput, trace: RunOutcome["trace"]): RunOutcomeCheck[] {
  const checks: RunOutcomeCheck[] = [];
  const agentRan = kind !== "security-hold" && kind !== "not-started";

  checks.push(
    input.scan.safeToExecute
      ? {
          id: "security",
          label: "Issue safety scan",
          state: "done",
          detail: input.scan.findingCount > 0
            ? `The issue text passed the safety scan with ${plural(input.scan.findingCount, "non-blocking finding")}.`
            : "The issue text passed the safety scan.",
          source: "server"
        }
      : {
          id: "security",
          label: "Issue safety scan",
          state: "failed",
          detail: `Execution was held: ${plural(input.scan.findingCount, "finding")} recorded.`,
          source: "server"
        }
  );

  if (agentRan) {
    const readIssue = input.trace.some((event) => event.toolName === "read_issue");
    checks.push({
      id: "issue",
      label: "Issue report",
      state: "done",
      detail: readIssue
        ? `The issue text was given to the agent, which also re-read issue #${input.repository.issueNumber} through GitHub.`
        : "The issue text was given to the agent at the start of the run.",
      source: readIssue ? "trace" : "server"
    });

    const files = [...new Set(input.trace.filter((event) => event.toolName === "read_file" && event.target).map((event) => event.target!))];
    checks.push(
      files.length > 0
        ? {
            id: "files",
            label: "Repository files requested",
            state: "done",
            // Code spans keep paths such as __init__.py from rendering as Markdown emphasis.
            // "requested", not "read": a response is recorded as passed whether the file was
            // returned or did not exist, so the trace cannot prove each one was inspected.
            detail: `${trace.truncated ? "At least " : ""}${plural(files.length, "path")} requested through GitHub: ${listPreview(files.map(codeSpan))}.`,
            source: "trace"
          }
        : trace.truncated
          ? { id: "files", label: "Repository files requested", state: "not-observed", detail: "None in the retained trace; earlier events were not kept.", source: "trace" }
          : { id: "files", label: "Repository files requested", state: "info", detail: "No repository files were requested through GitHub.", source: "trace" }
    );

    const commands = input.trace.filter((event) => event.category === "sandbox" && event.toolName === "run_command").length;
    const nonZero = input.trace.filter(
      (event) => event.category === "sandbox" && event.type === "tool.response" && event.exitCode !== undefined && event.exitCode !== null && Number(event.exitCode) !== 0
    ).length;
    checks.push(
      commands > 0
        ? {
            id: "sandbox",
            label: "Sandbox commands",
            state: "done",
            detail: `${trace.truncated ? "At least " : ""}${plural(commands, "command")} run; ${nonZero} exited non-zero.`,
            source: "trace"
          }
        : trace.truncated
          ? { id: "sandbox", label: "Sandbox commands", state: "not-observed", detail: "None in the retained trace; earlier events were not kept.", source: "trace" }
          : { id: "sandbox", label: "Sandbox commands", state: "info", detail: "No commands were run in the sandbox.", source: "trace" }
    );

    checks.push(reproductionCheck(input));

    const requirements = input.result?.requirements ?? [];
    if (requirements.length > 0) {
      const count = (verdict: string) => requirements.filter((requirement) => requirement.verdict === verdict).length;
      const failed = count("fail");
      const owned = requirements.filter((requirement) => requirement.ownership).length;
      checks.push({
        id: "requirements",
        label: "Requirement verification",
        state: failed > 0 ? "failed" : "done",
        detail:
          `${count("pass")} passed, ${count("already-implemented")} already implemented, ${count("missing")} missing, ` +
          `${count("out-of-scope")} out of scope, ${failed} failed` +
          (owned ? `; ${owned} owned by someone else per the discussion.` : "."),
        source: "agent"
      });
    }

    const claims = input.result?.discussionClaims ?? [];
    if (claims.length > 0) {
      const disputed = claims.filter((claim) => claim.verdict === "contradicted" || claim.verdict === "partly-confirmed");
      const confirmed = claims.filter((claim) => claim.verdict === "confirmed").length;
      checks.push({
        id: "claims",
        label: "Discussion claims checked",
        // A discrepancy is information for the maintainer, not a failure of the run.
        state: disputed.length > 0 ? "discrepancy" : "done",
        detail: disputed.length > 0
          ? disputed.map((claim) => `The discussion says: ${claim.claim} The repository shows: ${claim.evidence}`).join(" ")
          : `${confirmed} of ${claims.length} claim${claims.length === 1 ? "" : "s"} confirmed against the repository.`,
        source: "agent"
      });
    }

    const regressions = input.result?.proof?.regressions;
    if (isMeaningful(regressions)) {
      // Only a proven result is required to report checks that ran; for any other status the
      // field is free text that often says nothing was run, so it is shown, not scored.
      const proven = provenResultStatuses.has(input.result?.status ?? "");
      checks.push({ id: "tests", label: "Tests and checks", state: proven ? "done" : "info", detail: briefText(regressions, 320), source: "agent" });
    } else if (input.result) {
      checks.push({ id: "tests", label: "Tests and checks", state: "info", detail: "No regression checks were reported.", source: "agent" });
    }

    checks.push(
      input.result
        ? { id: "result", label: "Structured result", state: "done", detail: `Submitted with status ${input.result.status}.`, source: "server" }
        : kind === "in-progress"
          ? { id: "result", label: "Structured result", state: "info", detail: "Not submitted yet.", source: "server" }
          : {
              id: "result",
              label: "Structured result",
              state: "failed",
              detail: input.harness.error ? `No valid result was submitted: ${briefText(input.harness.error, 240)}` : "No valid result was submitted.",
              source: "server"
            }
    );
  }

  if (input.contribution) {
    const target = input.contribution.headOwner ? `${input.contribution.headOwner}/${input.repository.repo}` : undefined;
    checks.push(
      !contributionWritable(input.contribution)
        ? { id: "contribution", label: "Contribution policy", state: "failed", detail: `Writes not permitted: ${input.contribution.reason ?? "triage mode"}`, source: "server" }
        : {
            id: "contribution",
            label: "Contribution policy",
            state: "done",
            detail: `${input.contribution.mode === "fork" ? "Fork" : "Direct"} contribution${target ? ` to ${target}` : ""} permitted after approval.`,
            source: "server"
          }
    );
  }

  return checks;
}

function reproductionCheck(input: RunOutcomeInput): RunOutcomeCheck {
  const label = "Reproduction";
  const result = input.result;
  const attempts = result?.proof?.attempts;
  if (!result) {
    return { id: "reproduction", label, state: "not-observed", detail: "No result was submitted, so no reproduction outcome was recorded.", source: "server" };
  }
  if (implementationResultStatuses.has(result.status)) {
    return {
      id: "reproduction",
      label,
      state: "info",
      detail: "Not applicable: the agent classified the issue as a change request, so there was no failure to reproduce.",
      source: "agent"
    };
  }
  if (result.status === "patch-ready" || result.status === "verified") {
    const count = matchingAttempts(attempts);
    if (serverValidatedRunStatuses.has(input.runStatus) || input.pendingApproval) {
      return {
        id: "reproduction",
        label,
        state: "done",
        detail: `Reproduced${count ? ` ${count}` : ""}. Squasher confirmed the reported attempt count and a reproducer command in the sandbox trace.`,
        source: "server"
      };
    }
    return {
      id: "reproduction",
      label,
      state: "done",
      detail: isMeaningful(attempts) ? `Reported as reproduced: ${briefText(attempts, 280)}` : "Reported as reproduced.",
      source: "agent"
    };
  }
  if (result.status === "not-reproduced") {
    return {
      id: "reproduction",
      label,
      state: "info",
      detail: isMeaningful(attempts) ? `Not reproduced: ${briefText(attempts, 280)}` : "The agent reported that the failure did not occur.",
      source: "agent"
    };
  }
  if (result.status === "not-actionable") {
    // A request can be understood, reproduced, and still not buildable here -- observed on
    // microsoft/pylance-release#8238, where the agent reproduced the false positive 3/3 and
    // then reported not-actionable because that repository holds no source. Asserting "not
    // attempted" there would contradict the evidence the same run submitted.
    return isMeaningful(attempts)
      ? { id: "reproduction", label, state: "info", detail: briefText(attempts, 280), source: "agent" }
      : { id: "reproduction", label, state: "info", detail: "Not attempted: the request was judged not actionable.", source: "agent" };
  }
  return {
    id: "reproduction",
    label,
    state: "info",
    detail: isMeaningful(attempts) ? briefText(attempts, 280) : `No reproduction outcome was reported (status ${result.status}).`,
    source: "agent"
  };
}

function nextStepFor(kind: RunOutcomeKind, input: RunOutcomeInput): RunOutcome["nextStep"] {
  // What is waiting on the maintainer is known exactly for these, whatever the agent wrote.
  if (kind === "awaiting-approval") {
    return { text: "Review the evidence and the exact diff, then approve or reject the pull request.", source: "server" };
  }
  if (kind === "contribution-created" && input.statuses?.contribution.action && input.statuses.contribution.status === "changes_requested") {
    return { text: input.statuses.contribution.action, source: "server" };
  }
  if (kind === "contribution-created" && input.result?.pullRequest) {
    return { text: `Review draft pull request #${input.result.pullRequest.number} on GitHub.`, source: "server" };
  }
  // How to unblock a contribution is known exactly from the preflight.
  if (kind === "contribution-blocked" && input.statuses?.contribution.action) {
    return { text: input.statuses.contribution.action, source: "server" };
  }
  if (kind === "in-progress") {
    return { text: "Wait for the run to finish; this page refreshes automatically.", source: "server" };
  }

  const agentNextStep = input.result?.nextStep?.trim();
  if (agentNextStep) return { text: agentNextStep, source: "agent" };

  switch (kind) {
    case "contribution-blocked":
      return { text: "The evidence is kept on this page. To allow a write, resolve the policy above and re-run the issue.", source: "server" };
    case "failed":
      return { text: "Re-run the issue. If it fails the same way, inspect the technical details below.", source: "server" };
    case "blocked":
      return { text: "Resolve the blocker described above, then re-run the issue.", source: "server" };
    case "verified":
      return { text: "Review the reproduction evidence, then fix the defect or re-run the issue to request a patch.", source: "server" };
    case "patch-ready":
      return { text: "Re-run the issue to produce a patch that can be approved.", source: "server" };
    case "security-hold":
      return { text: "Review the security findings. If they are false positives, edit the issue and re-run.", source: "server" };
    case "not-started":
      return { text: "Configure the harness credentials, then re-run the issue.", source: "server" };
    default:
      return { text: noActionNeeded, source: "server" };
  }
}

function matchingAttempts(value: string | undefined): string | undefined {
  const match = value?.match(/(?:^|\D)(\d+)\s*\/\s*(\d+)(?:\D|$)/);
  return match && match[1] === match[2] ? `${match[1]}/${match[2]}` : undefined;
}

function isMeaningful(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length >= 6 && !/^(?:\.{3}|…|todo|tbd|n\/?a|none|placeholder)\.?$/i.test(text);
}

/**
 * The opening prose of a Markdown text: heading lines are dropped, so collapsing the result
 * onto one line cannot turn a whole paragraph into a heading.
 */
function leadParagraph(markdown: string): string {
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").filter((line) => !/^\s{0,3}#{1,6}\s/.test(line)).join("\n").trim())
    .filter(Boolean);
  if (blocks.length === 0) return markdown.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // A one-line verdict ("**Defect, reproduced and fixed.**") says little alone; keep
  // following paragraphs until there is enough to explain it.
  const lead: string[] = [];
  for (const block of blocks) {
    lead.push(block);
    if (lead.join(" ").length >= 160) break;
  }
  return lead.join("\n\n");
}

/** Collapses whitespace and cuts at a sentence, then a word, boundary. */
export function briefText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  const window = compact.slice(0, maxLength);
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentenceEnd >= maxLength * 0.5) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(" ");
  return `${window.slice(0, wordEnd > maxLength * 0.5 ? wordEnd : maxLength).trimEnd()}…`;
}

function listPreview(items: string[], shown = 6): string {
  const visible = items.slice(0, shown).join(", ");
  return items.length > shown ? `${visible}, and ${items.length - shown} more` : visible;
}

function codeSpan(value: string): string {
  return `\`${value.replace(/`/g, "")}\``;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
