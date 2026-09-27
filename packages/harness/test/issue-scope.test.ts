import { describe, expect, it } from "vitest";
import { classifyIssueScope, outOfScopeProblem } from "../src/issue-scope.js";

// All three bodies below are the real issues used against a live repo today.
const featureRequest = {
  title: "Add a green Cancel button next to Save",
  body: [
    "Could we add a second button to `index.html`?",
    "",
    "It should say **Cancel** and be green (`#16a34a`), sitting next to the existing",
    "blue **Save** button.",
    "",
    "Nothing is broken right now, I would just like the extra button."
  ].join("\n")
};

const crashReport = {
  title: "Tokenizer crashes on a trailing escape character",
  body: [
    "The tokenizer throws a `TypeError` when a pattern ends with a single backslash.",
    "",
    "## Actual",
    "```",
    "TypeError: Cannot read properties of undefined (reading 'toLowerCase')",
    "```"
  ].join("\n")
};

const wrongOutputReport = {
  title: "matchPattern fails when a literal follows a wildcard",
  body: [
    "`matchPattern` returns `false` for any pattern that has a literal character after a `*` wildcard.",
    "",
    'matchPattern("a*b", "axxb");   // expected true,  actual false'
  ].join("\n")
};

const positiveResult = { kind: "byter.result", status: "patch-ready" };

describe("issue scope classification", () => {
  it("treats a feature request with no failure artifact as out of scope", () => {
    const verdict = classifyIssueScope(featureRequest.title, featureRequest.body);

    expect(verdict.requestsFeature).toBe(true);
    expect(verdict.reportsFailure).toBe(false);
    expect(verdict.outOfScope).toBe(true);
  });

  it("does not read 'nothing is broken' as evidence of a break", () => {
    // Without negation stripping, /broken/ matches and the request looks like a defect.
    expect(classifyIssueScope("", "Nothing is broken right now.").reportsFailure).toBe(false);
    expect(classifyIssueScope("", "It is not broken, just slow to read.").reportsFailure).toBe(false);
    expect(classifyIssueScope("", "There is no error in the console.").reportsFailure).toBe(false);
  });

  it("keeps a crash report in scope", () => {
    const verdict = classifyIssueScope(crashReport.title, crashReport.body);

    expect(verdict.reportsFailure).toBe(true);
    expect(verdict.outOfScope).toBe(false);
  });

  it("keeps a wrong-output report in scope", () => {
    const verdict = classifyIssueScope(wrongOutputReport.title, wrongOutputReport.body);

    expect(verdict.reportsFailure).toBe(true);
    expect(verdict.outOfScope).toBe(false);
  });

  it("keeps a politely worded defect in scope", () => {
    // Feature-request phrasing plus a real artifact must not be blocked: the cost of a
    // false block is a real fix never reaching a maintainer.
    const verdict = classifyIssueScope(
      "Could you please add a guard for this crash?",
      "Calling parse('') throws a TypeError. It would be great if this were handled."
    );

    expect(verdict.requestsFeature).toBe(true);
    expect(verdict.reportsFailure).toBe(true);
    expect(verdict.outOfScope).toBe(false);
  });

  it("does not block a terse bug report with no feature wording", () => {
    const verdict = classifyIssueScope("Login broken", "Clicking submit does nothing.");

    expect(verdict.outOfScope).toBe(false);
  });
});

describe("out of scope proof rejection", () => {
  it("rejects patch-ready for a feature request and names the required status", () => {
    const problem = outOfScopeProblem(positiveResult, featureRequest);

    expect(problem).toBeDefined();
    expect(problem).toContain("not-reproduced");
    expect(problem).toContain("reports no observable failure");
  });

  it("rejects verified for a feature request too", () => {
    expect(outOfScopeProblem({ status: "verified" }, featureRequest)).toBeDefined();
  });

  it("allows not-reproduced and blocked for a feature request", () => {
    expect(outOfScopeProblem({ status: "not-reproduced" }, featureRequest)).toBeUndefined();
    expect(outOfScopeProblem({ status: "blocked" }, featureRequest)).toBeUndefined();
  });

  it("allows patch-ready for a genuine defect", () => {
    expect(outOfScopeProblem(positiveResult, crashReport)).toBeUndefined();
    expect(outOfScopeProblem(positiveResult, wrongOutputReport)).toBeUndefined();
  });

  it("stays inactive when the issue text could not be read", () => {
    // Fails open by design, and harness-runtime warns loudly when this happens.
    expect(outOfScopeProblem(positiveResult, { title: "", body: "" })).toBeUndefined();
  });
});
