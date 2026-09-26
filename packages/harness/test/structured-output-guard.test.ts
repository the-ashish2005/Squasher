import { describe, expect, it } from "vitest";
import {
  buildCorrectionMessage,
  byterResultSchema,
  createFixPullRequestSchema,
  validateAndParse
} from "../src/structured-output-guard.js";

const validResult = {
  kind: "byter.result",
  status: "patch-ready",
  summary: "The reported tokenizer failure was reproduced three times and then fixed.",
  proof: {
    before: "3/3 runs failed with the trailing escape error",
    after: "3/3 runs passed after the patch",
    regressions: "The focused regression suite passed",
    attempts: "3/3"
  },
  candidatePatch: {
    title: "Fix trailing escape crash",
    body: "Guards the tokenizer against a trailing backslash.",
    files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
  }
};

describe("structured output guard", () => {
  it("accepts a valid raw JSON object", () => {
    const result = validateAndParse(JSON.stringify(validResult), byterResultSchema);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.kind).toBe("byter.result");
      expect(JSON.parse(result.cleanedJson).status).toBe("patch-ready");
    }
  });

  it("strips markdown code fences before parsing", () => {
    const wrapped = `\`\`\`json\n${JSON.stringify(validResult, null, 2)}\n\`\`\``;

    const result = validateAndParse(wrapped, byterResultSchema);

    expect(result.valid).toBe(true);
  });

  it("recovers a JSON object surrounded by prose", () => {
    const wrapped = `Here is the proof contract you asked for.\n\n${JSON.stringify(validResult)}\n\nLet me know if you need more.`;

    const result = validateAndParse(wrapped, byterResultSchema);

    expect(result.valid).toBe(true);
  });

  it("fails cleanly on completely malformed text", () => {
    const result = validateAndParse("I could not reproduce the bug, sorry.", byterResultSchema);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("No JSON object");
      expect(result.rawText).toContain("could not reproduce");
    }
  });

  it("fails on truncated JSON without throwing", () => {
    const result = validateAndParse('{"kind":"byter.result","status":"patch-ready"', byterResultSchema);

    expect(result.valid).toBe(false);
  });

  it("rejects valid JSON that violates the schema", () => {
    const result = validateAndParse(
      JSON.stringify({ ...validResult, proof: { ...validResult.proof, attempts: "1/3" } }),
      byterResultSchema
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("proof.attempts");
    }
  });

  it("rejects placeholder content the proof tool would also reject", () => {
    const result = validateAndParse(
      JSON.stringify({
        ...validResult,
        candidatePatch: {
          ...validResult.candidatePatch,
          files: [{ path: "src/tokenizer.ts", content: "full file content" }]
        }
      }),
      byterResultSchema
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("candidatePatch.files[0].content");
    }
  });

  it("requires candidatePatch to be present even when null", () => {
    const { candidatePatch: _omitted, ...withoutPatch } = validResult;

    const result = validateAndParse(JSON.stringify({ ...withoutPatch, status: "blocked" }), byterResultSchema);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("candidatePatch");
    }
  });

  it("accepts a non-positive status with a null candidate patch and relaxed proof", () => {
    const result = validateAndParse(
      JSON.stringify({
        kind: "byter.result",
        status: "not-reproduced",
        summary: "No failure observed.",
        proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "0/3" },
        candidatePatch: null
      }),
      byterResultSchema
    );

    expect(result.valid).toBe(true);
  });

  it("validates the pull request write arguments", () => {
    const valid = validateAndParse(
      JSON.stringify({
        owner: "o",
        repo: "r",
        baseBranch: "main",
        branchName: "byter/fix-1-abc",
        title: "Fix trailing escape crash",
        body: "Verified by Byter.",
        files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
      }),
      createFixPullRequestSchema
    );
    expect(valid.valid).toBe(true);

    const missingBranch = validateAndParse(
      JSON.stringify({ owner: "o", repo: "r", baseBranch: "main", title: "t", body: "b", files: [] }),
      createFixPullRequestSchema
    );
    expect(missingBranch.valid).toBe(false);
    if (!missingBranch.valid) {
      expect(missingBranch.error).toContain("branchName");
    }
  });

  it("quotes the expected schema and the specific problem in the correction message", () => {
    const message = buildCorrectionMessage(byterResultSchema, 'Field "proof.attempts" must report at least 3 of 3.');

    expect(message).toContain("submit_byter_result");
    expect(message).toContain('Field "proof.attempts" must report at least 3 of 3.');
    expect(message).toContain('"kind": "byter.result"');
    expect(message).toContain("no markdown fence");
  });
});
