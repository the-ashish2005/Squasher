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

  it("preserves a fenced code block inside a string value byte for byte", () => {
    // The approval payload hash is computed over these arguments twice: once when the
    // call is paused and once when it is executed. Rewriting a ```ts block inside
    // candidatePatch.body between those two points makes the hashes disagree and the
    // GitHub write is refused. Observed on a real run whose PR body contained a fence.
    const withFence = {
      ...validResult,
      candidatePatch: {
        ...validResult.candidatePatch,
        body: "## Problem\n\n```ts\ntokenizePattern(\"\\\\\");\n```\n\nThrows a TypeError."
      }
    };
    const raw = JSON.stringify(withFence);

    const result = validateAndParse(raw, byterResultSchema);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual(withFence);
      // Stable enough to hash: identical to a plain parse of the same text.
      expect(JSON.stringify(result.value)).toBe(JSON.stringify(JSON.parse(raw)));
      expect((result.value.candidatePatch as { body: string }).body).toContain("```ts");
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

  // The cases below were produced by real deepseek-flash runs against a live issue.
  it("accepts a narrative attempts field with the count past 200 characters", () => {
    // Real run 7 wrote 877 characters here with "3/3" late. The server used to clamp this
    // field to 200 bytes and re-check the count, failing a genuinely proven run.
    const buried =
      "1. Read `src/tokenizer.ts` and `README.md` from the base branch with the GitHub MCP read tool; " +
      "`package.json`, `src/index.ts`, and `tests/tokenizer.test.ts` were fetched to establish the " +
      "surrounding structure before any sandbox work began. Then the reproducer ran 3/3 times.";
    expect(buried.length).toBeGreaterThan(200);

    const result = validateAndParse(
      JSON.stringify({ ...validResult, proof: { ...validResult.proof, attempts: buried } }),
      byterResultSchema
    );

    expect(result.valid).toBe(true);
  });

  it("still rejects a count that falls outside the server's clamp window", () => {
    const tooLate = `${"Narrative detail. ".repeat(140)}3/3 attempts matched.`;
    expect(tooLate.length).toBeGreaterThan(2_000);

    const result = validateAndParse(
      JSON.stringify({ ...validResult, proof: { ...validResult.proof, attempts: tooLate } }),
      byterResultSchema
    );

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("proof.attempts");
  });

  it("rejects a retry that drops a required top-level field", () => {
    // Real run 13: the retry fixed proof.attempts but omitted status while regenerating
    // a 7.5 KB object, so the correction message must demand the complete object.
    const { status: _dropped, ...withoutStatus } = validResult;

    const result = validateAndParse(JSON.stringify(withoutStatus), byterResultSchema);

    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Field "status"');
    expect(buildCorrectionMessage(byterResultSchema, "x")).toContain("COMPLETE object");
  });

  it("reports truncated JSON as truncation, not as missing schema fields", () => {
    // A large candidatePatch.body cut off mid-string: the outer object never closes,
    // but the nested patch object would parse on its own and mislead the correction.
    const truncated = '{"kind":"byter.result","candidatePatch":{"title":"Fix it","body":"## Problem\\n\\nlong text';

    const result = validateAndParse(truncated, byterResultSchema);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/not a complete JSON object|cut off/);
      expect(result.error).not.toContain('Field "kind"');
    }
  });

  it("still reports a genuine schema violation when the outer object parses", () => {
    const result = validateAndParse(
      JSON.stringify({ kind: "not.byter", status: "patch-ready" }),
      byterResultSchema
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Field "kind"');
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
