/**
 * Byter triages reported defects. Its proof contract asks for a failure that reproduces
 * 3/3 before a patch and passes 3/3 after — but that shape is equally satisfiable by
 * writing an acceptance test for functionality the issue merely *requests*, running it
 * against the current code, and calling the failure a reproduction.
 *
 * Observed live on a real feature request ("add a green Cancel button"): the agent said
 * plainly that it was "a feature addition, not a defect", authored its own reproducer,
 * recorded a genuine 3/3 before/after, and returned patch-ready. Every command really
 * ran, so nothing downstream could tell the difference, and the issue was labelled
 * byter:verified.
 *
 * This check closes that gap from the input side rather than trusting the model to
 * police its own scope.
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
  /\bdoes\s?n[o']?t\s+work\b/i
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
  /\b(?:add|support)\s+(?:a|an|the)\s+new\b/i
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

export interface IssueScopeVerdict {
  /** True when the issue reports something observably broken. */
  reportsFailure: boolean;
  /** True when the issue explicitly asks for new or changed behaviour. */
  requestsFeature: boolean;
  /** True when a positive proof status must be refused. */
  outOfScope: boolean;
}

/**
 * Deliberately conservative: a positive status is refused only when the issue reads as a
 * feature request AND carries no failure artifact at all. A real bug report phrased
 * politely ("could you fix the TypeError below") still keeps its artifact and passes, so
 * the common case is never blocked. The cost of the remaining false negatives is a
 * maintainer re-reading an issue; the cost of a false `verified` is a fabricated proof
 * carrying Byter's own trust label.
 */
export function classifyIssueScope(title: string, body: string): IssueScopeVerdict {
  const raw = `${title}\n${body}`;
  const scrubbed = stripNegatedFailureClaims(raw);

  const reportsFailure = failureArtifactPatterns.some((pattern) => pattern.test(scrubbed));
  const requestsFeature = featureIntentPatterns.some((pattern) => pattern.test(raw));

  return { reportsFailure, requestsFeature, outOfScope: requestsFeature && !reportsFailure };
}

/** Statuses that assert a defect was proven. */
const positiveStatuses = new Set(["patch-ready", "verified"]);

/**
 * Returns the problem to send back when a submitted result claims proof for an issue
 * that never reported a failure, or undefined when the result is in scope.
 */
export function outOfScopeProblem(
  result: Record<string, unknown>,
  issueText: { title: string; body: string }
): string | undefined {
  if (typeof result.status !== "string" || !positiveStatuses.has(result.status)) {
    return undefined;
  }

  const verdict = classifyIssueScope(issueText.title, issueText.body);
  if (!verdict.outOfScope) return undefined;

  return (
    `This issue requests new or changed behaviour and reports no observable failure — no error, ` +
    `exception, stack trace, wrong output, or failing command. A test you wrote yourself that ` +
    `asserts the requested behaviour is not a reproduction of a defect, so status ` +
    `"${result.status}" is not available for it. Byter triages reported defects only. ` +
    `Resubmit with status "not-reproduced" and candidatePatch set to null, and say in the summary ` +
    `that the report is a feature request rather than a defect.`
  );
}
