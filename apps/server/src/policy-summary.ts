import type { ContributionPolicySignal, ContributionTarget } from "./contribution.js";

/**
 * What the repository's own documents say about contributing this change, for the human
 * reviewing it. This is about the contribution, never the engineering: a repository that
 * prohibits AI contributions leaves a verified implementation verified.
 *
 * Only statements actually found in the repository are reported. Where nothing was read,
 * the summary says so rather than guessing a policy.
 */
export type PolicyVerdict =
  | "prohibited"
  | "unclear"
  | "human-action-required"
  | "disclosure-required"
  | "allowed"
  | "no-policy-found"
  | "not-scanned";

export interface PolicySummary {
  verdict: PolicyVerdict;
  label: string;
  detail: string;
  /** What the human should do, given this policy. */
  nextStep: string;
  /** Whether an automatic pull request may be created at all under this policy. */
  automaticContributionAllowed: boolean;
  signals: ContributionPolicySignal[];
}

export function summarizePolicy(
  contribution: Pick<ContributionTarget, "policySignals" | "policyFindings" | "preflight" | "mode"> | undefined
): PolicySummary {
  const signals: ContributionPolicySignal[] =
    contribution?.policySignals ??
    // Records from before classification kept only the refusals.
    (contribution?.policyFindings ?? []).map((finding) => ({
      ...finding,
      kind: /could not be read/i.test(finding.excerpt) ? ("unreadable" as const) : ("ai-prohibited" as const)
    }));
  const has = (kind: ContributionPolicySignal["kind"]) => signals.some((signal) => signal.kind === kind);

  if (has("ai-prohibited") || has("bots-prohibited")) {
    return {
      verdict: "prohibited",
      label: has("ai-prohibited") ? "AI contributions prohibited" : "Bot contributions prohibited",
      detail: "The repository's own documents refuse contributions like this one.",
      nextStep: "Do not submit this automatically. The verified patch stays available to view and copy.",
      automaticContributionAllowed: false,
      signals
    };
  }
  if (has("unreadable")) {
    return {
      verdict: "unclear",
      label: "Policy unclear",
      detail: "A contribution document exists but could not be read, so its policy is unknown.",
      nextStep: "A human should read the repository's contribution documents before deciding.",
      automaticContributionAllowed: false,
      signals
    };
  }

  const requirements: string[] = [];
  if (has("human-assignment-required")) requirements.push("claim the issue and be assigned before contributing");
  if (has("ai-disclosure-required")) requirements.push("disclose AI assistance in the pull request");

  if (has("human-assignment-required")) {
    return {
      verdict: "human-action-required",
      label: "Human action required",
      detail: `The repository asks contributors to ${requirements.join(", and to ")}.`,
      nextStep: "Complete the repository's own steps (such as commenting to claim the issue) before approving a contribution.",
      automaticContributionAllowed: true,
      signals
    };
  }
  if (has("ai-disclosure-required")) {
    return {
      verdict: "disclosure-required",
      label: "AI disclosure required",
      detail: "The repository requires AI assistance to be disclosed.",
      nextStep: "Approve only with the disclosure in place; Squasher adds it to the pull request body.",
      automaticContributionAllowed: true,
      signals
    };
  }
  if (has("ai-assistance-allowed")) {
    return {
      verdict: "allowed",
      label: "AI assistance allowed",
      detail: "The repository's documents explicitly welcome AI-assisted contributions.",
      nextStep: "Contribution can proceed through the normal approval flow.",
      automaticContributionAllowed: true,
      signals
    };
  }

  if (contribution?.preflight?.policyReviewed) {
    return {
      verdict: "no-policy-found",
      label: "No AI policy found",
      detail: "The repository's contribution documents were read and say nothing about AI or automated contributions.",
      nextStep: "No stated policy is not permission: a human decides whether an unsolicited contribution is welcome.",
      automaticContributionAllowed: true,
      signals
    };
  }
  return {
    verdict: "not-scanned",
    label: "Policy not checked",
    detail:
      contribution?.mode === "triage"
        ? "Submission is disabled for this run (triage mode), so the repository's policy was not read."
        : "This run did not read the repository's contribution documents.",
    nextStep: "A human should read the repository's contribution documents before any contribution.",
    automaticContributionAllowed: true,
    signals
  };
}
