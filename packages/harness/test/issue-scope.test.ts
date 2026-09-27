import { describe, expect, it } from "vitest";
import { classifyIssueScope, resultContractProblem } from "../src/issue-scope.js";

// Every body below is a real issue used against a live repository.
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

// talkasab/peruse#45. Asks for cache-validation headers that do not exist yet: written in
// bug-report form, with a reproduction command and root-cause reasoning, but the server
// answers every request correctly. Byter classified this not-reproduced, which is the
// report this change exists to fix.
const improvementRequest = {
  title: "Serve app.js and index.html with cache validation headers",
  body: [
    "## What we know",
    "",
    "`curl -I /app.js` on the dev build returns only `content-length`: no `ETag`,",
    "`Last-Modified`, or `Cache-Control`. Browsers apply heuristic caching to such responses.",
    "",
    "## Fix direction",
    "",
    "- Emit `ETag` and `Cache-Control: no-cache` on the HTML and bundle so browsers revalidate.",
    "- Integration test: two requests, second with `If-None-Match`, expect 304."
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

const bugProofResult = { kind: "byter.result", status: "patch-ready" };
const implementedResult = { kind: "byter.result", status: "implemented-feature" };

describe("issue scope classification", () => {
  it("treats a feature request with no failure artifact as a change request", () => {
    const verdict = classifyIssueScope(featureRequest.title, featureRequest.body);

    expect(verdict.requestsFeature).toBe(true);
    expect(verdict.reportsFailure).toBe(false);
    expect(verdict.kind).toBe("change-request");
    expect(verdict.outOfScope).toBe(true);
  });

  it("treats a hardening request written as a bug report as a change request", () => {
    const verdict = classifyIssueScope(improvementRequest.title, improvementRequest.body);

    expect(verdict.kind).toBe("change-request");
  });

  it("does not read 'nothing is broken' as evidence of a break", () => {
    // Without negation stripping, /broken/ matches and the request looks like a defect.
    expect(classifyIssueScope("", "Nothing is broken right now.").reportsFailure).toBe(false);
    expect(classifyIssueScope("", "It is not broken, just slow to read.").reportsFailure).toBe(false);
    expect(classifyIssueScope("", "There is no error in the console.").reportsFailure).toBe(false);
  });

  it("keeps a crash report a defect", () => {
    const verdict = classifyIssueScope(crashReport.title, crashReport.body);

    expect(verdict.reportsFailure).toBe(true);
    expect(verdict.kind).toBe("defect");
    expect(verdict.outOfScope).toBe(false);
  });

  it("keeps a wrong-output report a defect", () => {
    expect(classifyIssueScope(wrongOutputReport.title, wrongOutputReport.body).kind).toBe("defect");
  });

  it("leaves a politely worded defect unclear so neither path is refused", () => {
    // Feature phrasing plus a real artifact: blocking either direction here would cost a
    // real fix, so the classifier declines to decide.
    const verdict = classifyIssueScope(
      "Could you please add a guard for this crash?",
      "Calling parse('') throws a TypeError. It would be great if this were handled."
    );

    expect(verdict.requestsFeature).toBe(true);
    expect(verdict.reportsFailure).toBe(true);
    expect(verdict.kind).toBe("unclear");
    expect(verdict.outOfScope).toBe(false);
  });

  it("leaves a terse bug report with no feature wording a defect", () => {
    expect(classifyIssueScope("Login broken", "Clicking submit does nothing.").kind).toBe("defect");
  });
});

describe("defect claims for change requests", () => {
  it("rejects patch-ready for a feature request and points at the implementation path", () => {
    const problem = resultContractProblem(bugProofResult, featureRequest);

    expect(problem).toBeDefined();
    expect(problem).toContain("reports no observable failure");
    // The fix this change makes: the request is actionable, so the correction must not
    // send the model to not-reproduced.
    expect(problem).toContain("implemented-feature");
    expect(problem).toContain("implemented-improvement");
    expect(problem).not.toContain('resubmit with status "not-reproduced"');
  });

  it("rejects verified for a feature request too", () => {
    expect(resultContractProblem({ status: "verified" }, featureRequest)).toBeDefined();
  });

  it("rejects a defect claim for a hardening request", () => {
    expect(resultContractProblem(bugProofResult, improvementRequest)).toBeDefined();
  });

  it("allows patch-ready for a genuine defect", () => {
    expect(resultContractProblem(bugProofResult, crashReport)).toBeUndefined();
    expect(resultContractProblem(bugProofResult, wrongOutputReport)).toBeUndefined();
  });
});

describe("implementation claims for defects", () => {
  it("refuses an implementation status for an issue that reported a failure", () => {
    // The inversion the new path could otherwise open: relabel a defect a feature and the
    // reproduction requirement becomes optional.
    const problem = resultContractProblem(implementedResult, crashReport);

    expect(problem).toBeDefined();
    expect(problem).toContain("reports an observable failure");
    expect(problem).toContain("Reproduce the reported failure first");
  });

  it("refuses implemented-improvement for a defect as well", () => {
    expect(resultContractProblem({ status: "implemented-improvement" }, wrongOutputReport)).toBeDefined();
  });

  it("allows an implementation status for a change request", () => {
    expect(resultContractProblem(implementedResult, featureRequest)).toBeUndefined();
    expect(resultContractProblem(implementedResult, improvementRequest)).toBeUndefined();
    expect(resultContractProblem({ status: "implemented-improvement" }, improvementRequest)).toBeUndefined();
  });

  it("allows an implementation status for an ambiguous issue", () => {
    expect(
      resultContractProblem(implementedResult, {
        title: "Could you please add a guard for this crash?",
        body: "Calling parse('') throws a TypeError. It would be great if this were handled."
      })
    ).toBeUndefined();
  });
});

describe("statuses that assert nothing", () => {
  it("allows not-reproduced, not-actionable and blocked for any issue", () => {
    for (const issue of [featureRequest, improvementRequest, crashReport]) {
      expect(resultContractProblem({ status: "not-reproduced" }, issue)).toBeUndefined();
      expect(resultContractProblem({ status: "not-actionable" }, issue)).toBeUndefined();
      expect(resultContractProblem({ status: "blocked" }, issue)).toBeUndefined();
      expect(resultContractProblem({ status: "failed" }, issue)).toBeUndefined();
    }
  });

  it("stays inactive when the issue text could not be read", () => {
    // Fails open by design, and harness-runtime warns loudly when this happens.
    expect(resultContractProblem(bugProofResult, { title: "", body: "" })).toBeUndefined();
    expect(resultContractProblem(implementedResult, { title: "", body: "" })).toBeUndefined();
  });

  it("ignores a result with no status rather than throwing", () => {
    expect(resultContractProblem({}, crashReport)).toBeUndefined();
  });
});
