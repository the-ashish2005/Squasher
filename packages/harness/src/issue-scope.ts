/**
 * Byter acts on two kinds of issue, and each has a different evidence contract:
 *
 * - A reported defect must be reproduced. Its proof is a failure observed 3/3 before a fix
 *   and a pass 3/3 after.
 * - A requested change need not be reproduced, because nothing is broken. Its proof is the
 *   new behaviour verified 3/3 and the existing suite still passing.
 *
 * Both contracts are satisfiable by the wrong kind of work, in both directions, so this
 * module guards both:
 *
 * Claiming a defect for a change request. Observed live on a real feature request ("add a
 * green Cancel button"): the agent said plainly that it was "a feature addition, not a
 * defect", authored its own acceptance test, recorded a genuine 3/3 before/after, and
 * returned patch-ready. Every command really ran, so nothing downstream could tell, and
 * the issue was labelled byter:verified — Byter's own trust label, asserting a defect that
 * never existed.
 *
 * Claiming a change for a defect. The mirror image, and the reason the first guard cannot
 * simply be relaxed: if an implementation status skipped the reproduction requirement,
 * every defect could reach a pull request by being relabelled a "feature", and the
 * verification the defect path exists to enforce would be optional in practice.
 *
 * Both checks work from the issue text rather than trusting the model to police its own
 * classification.
 */

/** A concrete failure artifact: hard to produce for behaviour that does not exist yet. */
const failureArtifactPatterns: RegExp[] = [
  /\b(?:type|reference|syntax|range|eval|uri)error\b/i,
  /\b(?:exception|traceback|stack\s?trace|segmentation fault|core dumped)\b/i,
  /\bpanic[:\s]/i,
  /\berror\s*:/i,
  /\berrno\b/i,
  /\bexit(?:s|ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]/i,
  /\bthrow(?:s|n|ing)?\b/i,
  /\bcrash(?:es|ed|ing)?\b/i,
  /\bhangs?\b|\bdeadlock/i,
  /\bregress(?:ion|ed)\b/i,
  /expected[\s\S]{0,120}?(?:actual|but\s+(?:got|returns?|received|it))/i,
  /\bactual\s*:/i,
  /\breturns?\s+[^.\n]{0,60}\binstead\b/i,
  /\b(?:wrong|incorrect|unexpected)\s+(?:output|result|value|behaviou?r)\b/i,
  /\bfail(?:s|ed|ing|ure)\b/i,
  /\bdoes\s?n[o']?t\s+work\b/i,
  // Survives only because stripNegatedFailureClaims removes "nothing is broken" and
  // "not broken" first. Without this, "Login broken / clicking submit does nothing"
  // carried no recognised artifact and fell through as unclear, which left the
  // implementation path open to a plain defect report.
  /\bbroken\b/i
];

/** Explicit request-for-new-behaviour language. */
const featureIntentPatterns: RegExp[] = [
  /\bfeature\s+request\b/i,
  /\benhancement\b/i,
  /\bnothing\s+is\s+broken\b/i,
  /\bnot\s+a\s+bug\b/i,
  /\bwould\s+(?:just\s+)?like\b/i,
  /\bnice\s+to\s+have\b/i,
  /\b(?:could|can|should)\s+(?:we|you)\s+(?:please\s+)?(?:add|have|support|include)\b/i,
  /\bplease\s+add\b/i,
  /\bit\s+would\s+be\s+(?:good|great|nice|helpful)\b/i,
  /\b(?:add|support)\s+(?:a|an|the)\s+new\b/i,
  /\bfix\s+direction\b/i,
  /\b(?:proposes?|proposal|proposed)\s+(?:to\s+)?(?:add|improve|change|support)\b/i,
  /\b(?:we|it)\s+should\s+(?:also\s+)?(?:emit|expose|return|send|include|support)\b/i
];

/**
 * Negations must be stripped before looking for failure artifacts, or "nothing is
 * broken" reads as evidence of a break.
 */
function stripNegatedFailureClaims(text: string): string {
  return text
    .replace(/\b(?:nothing|it)\s+is\s+n[o']?t?\s*broken\b/gi, " ")
    .replace(/\bnothing\s+is\s+broken\b/gi, " ")
    .replace(/\bnot\s+broken\b/gi, " ")
    .replace(/\bno\s+(?:error|errors|exception|exceptions|crash|failure|failures)\b/gi, " ")
    .replace(/\bdoes\s?n[o']?t\s+(?:error|crash|throw|fail)\b/gi, " ")
    .replace(/\bwithout\s+(?:an?\s+)?(?:error|exception|crash|failure)\b/gi, " ");
}

/**
 * What the issue text structurally looks like.
 *
 * Deliberately three values, not the five the result vocabulary has. A keyword classifier
 * can tell "something is broken" from "something is wanted", but it cannot honestly tell a
 * feature from an improvement — "add a Cancel button" and "add cache validation headers"
 * are the same shape, both requesting behaviour that does not exist. That distinction is
 * the model's to make, and it expresses it by choosing between "implemented-feature" and
 * "implemented-improvement". Nor does this decide actionability: whether a request is
 * feasible in the repository needs the repository, which only the model has read.
 */
export type IssueKind = "defect" | "change-request" | "unclear";

export interface IssueScopeVerdict {
  /** True when the issue reports something observably broken. */
  reportsFailure: boolean;
  /** True when the issue explicitly asks for new or changed behaviour. */
  requestsFeature: boolean;
  kind: IssueKind;
  /**
   * True when the issue reads as a change request with no failure artifact, so a status
   * asserting a reproduced defect must be refused.
   *
   * Retained under its original name because it means exactly what it did: a defect claim
   * is out of scope for this issue. It no longer implies Byter will not act — a change
   * request is now actionable through the implementation path.
   */
  outOfScope: boolean;
}

/**
 * Conservative in both directions. A classification only becomes decisive when the signals
 * agree: a failure artifact with no request language is a defect, request language with no
 * failure artifact is a change request, and anything mixed or silent is "unclear" and
 * blocks nothing. A politely worded real bug ("could you add a guard for this TypeError")
 * carries both signals and stays unclear, so neither path is refused for it.
 */
export function classifyIssueScope(title: string, body: string): IssueScopeVerdict {
  const raw = `${title}\n${body}`;
  const scrubbed = stripNegatedFailureClaims(raw);

  const reportsFailure = failureArtifactPatterns.some((pattern) => pattern.test(scrubbed));
  const requestsFeature = featureIntentPatterns.some((pattern) => pattern.test(raw));

  const kind: IssueKind =
    reportsFailure && !requestsFeature ? "defect" : requestsFeature && !reportsFailure ? "change-request" : "unclear";

  return { reportsFailure, requestsFeature, kind, outOfScope: kind === "change-request" };
}

/** Statuses that assert a defect was reproduced. */
const bugProofStatuses = new Set(["patch-ready", "verified"]);

/** Statuses that assert a requested change was built and verified. */
const implementationStatuses = new Set(["implemented-feature", "implemented-improvement"]);

/**
 * Returns the problem to send back when a submitted result claims the wrong kind of
 * evidence for the issue it answers, or undefined when the result fits.
 *
 * Fails open for an issue it cannot classify: an unreadable or mixed-signal report blocks
 * neither path, because a false block costs a real fix and the reproduction contract in
 * `expectByterResult` still applies to every positive status regardless.
 */
export function resultContractProblem(
  result: Record<string, unknown>,
  issueText: { title: string; body: string }
): string | undefined {
  const status = result.status;
  if (typeof status !== "string") return undefined;

  const verdict = classifyIssueScope(issueText.title, issueText.body);

  if (bugProofStatuses.has(status) && verdict.kind === "change-request") {
    return (
      `This issue requests new or changed behaviour and reports no observable failure — no error, ` +
      `exception, stack trace, wrong output, or failing command. A test you wrote yourself that ` +
      `asserts the requested behaviour is not a reproduction of a defect, so status "${status}" is ` +
      `not available for it. This report is still actionable: if the change is clear and the ` +
      `repository supports it, implement it and resubmit with status "implemented-feature" or ` +
      `"implemented-improvement", keeping the same evidence bar — the new behaviour verified 3/3 ` +
      `and the existing suite still passing. If it cannot be built as described, use ` +
      `"not-actionable" with candidatePatch null and say why.`
    );
  }

  if (implementationStatuses.has(status) && verdict.kind === "defect") {
    return (
      `This issue reports an observable failure, so it is a defect rather than a request for new ` +
      `behaviour, and status "${status}" is not available for it. Implementing around a defect ` +
      `skips the reproduction that proves the fix addresses the reported symptom. Reproduce the ` +
      `reported failure first, then resubmit with status "patch-ready" once the fix is verified, ` +
      `or "not-reproduced" if the reported failure cannot be demonstrated.`
    );
  }

  return undefined;
}
