const placeholderPattern = /^(?:\.{3}|…|todo|tbd|n\/?a|placeholder|full file content)$/i;
const resultStatuses = ["patch-ready", "verified", "not-reproduced", "blocked", "failed"] as const;

/**
 * Must stay >= the `proof.attempts` clamp in `extractLiveProofResult`
 * (apps/server/src/server.ts), because `hasGenuineProof` re-checks the count on the
 * clamped copy. If the server truncates below this, a contract the guard accepted is
 * rejected downstream and the run fails after a correct reproduction.
 */
const serverAttemptsClampBytes = 2_000;

export interface GuardSchema {
  name: string;
  /** Exact expected shape, quoted verbatim back to the model on a corrective retry. */
  describe(): string;
  /** Returns one message per violation; empty means valid. */
  validate(value: Record<string, unknown>): string[];
}

export type GuardResult =
  | { valid: true; value: Record<string, unknown>; cleanedJson: string }
  | { valid: false; rawText: string; error: string };

export class GuardValidationError extends Error {
  readonly toolName: string;
  readonly rawText: string;
  readonly problem: string;

  constructor(toolName: string, rawText: string, problem: string) {
    super(`Malformed ${toolName} arguments: ${problem}`);
    this.name = "GuardValidationError";
    this.toolName = toolName;
    this.rawText = rawText;
    this.problem = problem;
  }
}

/**
 * Parses tool-call arguments that may arrive fenced or wrapped in prose, then checks
 * them against `schema`. Never throws and never coerces: a malformed or
 * schema-violating payload comes back as `{ valid: false }` for the caller to retry.
 */
export function validateAndParse(rawArgs: string, schema: GuardSchema): GuardResult {
  const rawText = typeof rawArgs === "string" ? rawArgs : String(rawArgs);
  const unfenced = stripFences(rawText).trim();

  // When the payload is itself a JSON object, it is the intended arguments. A parse
  // failure there means malformed or truncated output, so report that rather than
  // falling through to a nested fragment that happens to parse — validating an inner
  // object against the outer schema produces a misleading "missing fields" message and
  // sends the model off correcting the wrong thing.
  if (unfenced.startsWith("{")) {
    const outermost = balancedJsonObjects(unfenced)[0];
    if (!outermost) {
      return {
        valid: false,
        rawText,
        error:
          "The tool arguments are not a complete JSON object: the opening brace is never closed, " +
          "so the output was cut off. Return the whole object, keeping long text fields short enough to finish."
      };
    }
    return validateCandidate(outermost, schema, rawText);
  }

  const candidates = jsonCandidates(rawText);
  if (candidates.length === 0) {
    return { valid: false, rawText, error: "No JSON object was found in the tool arguments." };
  }

  let firstSchemaError: string | undefined;
  let lastParseError = "The tool arguments were not valid JSON.";

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      lastParseError = error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON.";
      continue;
    }

    if (!isRecord(parsed)) {
      lastParseError = "The tool arguments parsed to a non-object JSON value.";
      continue;
    }

    const violations = schema.validate(parsed);
    if (violations.length === 0) {
      return { valid: true, value: parsed, cleanedJson: JSON.stringify(parsed) };
    }
    // Keep the first schema error: later candidates are usually nested fragments.
    firstSchemaError ??= violations.join(" ");
  }

  return { valid: false, rawText, error: firstSchemaError ?? lastParseError };
}

function validateCandidate(candidate: string, schema: GuardSchema, rawText: string): GuardResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown syntax error";
    return {
      valid: false,
      rawText,
      error: `The tool arguments were not valid JSON (${detail}). Return one complete, raw JSON object.`
    };
  }

  if (!isRecord(parsed)) {
    return { valid: false, rawText, error: "The tool arguments parsed to a non-object JSON value." };
  }

  const violations = schema.validate(parsed);
  return violations.length === 0
    ? { valid: true, value: parsed, cleanedJson: JSON.stringify(parsed) }
    : { valid: false, rawText, error: violations.join(" ") };
}

function stripFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9_-]*\s*\n?/g, "").replace(/```/g, "");
}

/** Builds the single corrective follow-up message sent before the one allowed retry. */
export function buildCorrectionMessage(schema: GuardSchema, problem: string): string {
  return [
    `Your ${schema.name} tool call was rejected before it ran.`,
    "",
    `Problem found: ${problem}`,
    "",
    "Return the arguments as one raw JSON object matching exactly this schema, with no markdown fence, no prose, and no trailing commentary:",
    schema.describe(),
    "",
    "Resend the COMPLETE object, not just the field named above. Every top-level field must be",
    "present again with the same values as before, changing only what the problem describes —",
    "a retry that silently drops a field, or that is cut off before the closing brace, is rejected.",
    "Keep long text fields brief so the object finishes.",
    "",
    "Call the tool again now with corrected arguments. Use only concrete values you actually observed in this run."
  ].join("\n");
}

/**
 * Strips markdown fences and surrounding prose by returning every balanced top-level
 * JSON object in the text, outermost first.
 */
function jsonCandidates(text: string): string[] {
  const unfenced = stripFences(text);
  const sources = unfenced === text ? [text] : [unfenced, text];
  const candidates: string[] = [];

  for (const source of sources) {
    const trimmed = source.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}") && !candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
    for (const object of balancedJsonObjects(source)) {
      if (!candidates.includes(object)) candidates.push(object);
    }
  }

  return candidates;
}

function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  // Outermost objects start earliest, so source order already prefers the full payload.
  return objects;
}

/**
 * Mirrors `expectByterResult` in apps/github-mcp/src/tools.ts. Kept in step with it
 * deliberately: the guard must reject exactly what the tool would throw on, so a
 * recoverable formatting mistake becomes a retry instead of a failed run.
 */
export const byterResultSchema: GuardSchema = {
  name: "submit_byter_result",

  describe() {
    return [
      "{",
      '  "kind": "byter.result",',
      '  "status": "patch-ready" | "verified" | "not-reproduced" | "blocked" | "failed",',
      '  "summary": string,',
      '  "proof": {',
      '    "before": string,',
      '    "after": string,',
      '    "regressions": string,',
      '    "attempts": string',
      "  },",
      '  "candidatePatch": null | {',
      '    "title": string,',
      '    "body": string,',
      '    "files": [{ "path": string, "content": string }]',
      "  }",
      "}",
      "",
      "Rules for status \"patch-ready\" and \"verified\":",
      "- summary must be at least 20 characters of concrete description.",
      "- proof.before, proof.after and proof.regressions must each be at least 6 characters.",
      '- proof.attempts must report matching counts of at least three, for example "3/3". Put the count',
      "  near the start of the field so it survives truncation, then add detail after it.",
      "- candidatePatch.title must be at least 8 characters and candidatePatch.body at least 12.",
      "- candidatePatch.files must be non-empty, each with the exact final path and full file content.",
      "- Placeholder values such as \"...\", \"TODO\", \"TBD\", \"N/A\" or \"full file content\" are rejected.",
      "For every other status, set candidatePatch to null."
    ].join("\n");
  },

  validate(value) {
    const errors: string[] = [];

    if (value.kind !== "byter.result") {
      errors.push('Field "kind" must be exactly "byter.result".');
    }

    const status = value.status;
    if (typeof status !== "string" || !(resultStatuses as readonly string[]).includes(status)) {
      errors.push(`Field "status" must be one of ${resultStatuses.map((entry) => `"${entry}"`).join(", ")}.`);
    }

    const positiveProof = status === "patch-ready" || status === "verified";
    errors.push(...(positiveProof ? meaningful(value.summary, "summary", 20) : nonEmpty(value.summary, "summary")));

    if (!isRecord(value.proof)) {
      errors.push('Field "proof" must be an object with before, after, regressions and attempts.');
    } else {
      const proof = value.proof;
      if (positiveProof) {
        errors.push(...meaningful(proof.before, "proof.before", 6));
        errors.push(...meaningful(proof.after, "proof.after", 6));
        errors.push(...meaningful(proof.regressions, "proof.regressions", 6));
        const attemptErrors = meaningful(proof.attempts, "proof.attempts", 3);
        errors.push(...attemptErrors);
        if (attemptErrors.length === 0 && !hasThreeMatchingAttempts(proof.attempts as string)) {
          errors.push(
            `Field "proof.attempts" must report at least 3 of 3 matching executions, for example "3/3", ` +
              `within its first ${serverAttemptsClampBytes} characters. Start the field with the count, ` +
              `such as "3/3 before-fix failures, 3/3 after-fix passes", then add any detail afterwards.`
          );
        }
      } else {
        errors.push(...nonEmpty(proof.before, "proof.before"));
        errors.push(...nonEmpty(proof.after, "proof.after"));
        errors.push(...nonEmpty(proof.regressions, "proof.regressions"));
        errors.push(...nonEmpty(proof.attempts, "proof.attempts"));
      }
    }

    if (!("candidatePatch" in value)) {
      errors.push('Field "candidatePatch" is required; use null when no verified fix exists.');
    } else if (value.candidatePatch !== null) {
      if (!isRecord(value.candidatePatch)) {
        errors.push('Field "candidatePatch" must be an object or null.');
      } else {
        const patch = value.candidatePatch;
        errors.push(...meaningful(patch.title, "candidatePatch.title", 8));
        errors.push(...meaningful(patch.body, "candidatePatch.body", 12));
        errors.push(...patchFileErrors(patch.files, "candidatePatch.files"));
      }
    }

    return errors;
  }
};

/** Mirrors `parseCreatePullRequestArgs` in apps/github-mcp/src/tools.ts. */
export const createFixPullRequestSchema: GuardSchema = {
  name: "create_fix_pull_request",

  describe() {
    return [
      "{",
      '  "owner": string,',
      '  "repo": string,',
      '  "baseBranch": string,',
      '  "branchName": string,',
      '  "title": string,',
      '  "body": string,',
      '  "files": [{ "path": string, "content": string }]',
      "}",
      "",
      "Every field is required and must be a non-empty string. files must be non-empty and",
      "must match candidatePatch.files exactly, each with the exact final path and full content."
    ].join("\n");
  },

  validate(value) {
    const errors: string[] = [];
    for (const field of ["owner", "repo", "baseBranch", "branchName", "title", "body"]) {
      errors.push(...nonEmpty(value[field], field));
    }
    errors.push(...patchFileErrors(value.files, "files"));
    return errors;
  }
};

function patchFileErrors(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [`Field "${field}" must be a non-empty array of { path, content } objects.`];
  }

  const errors: string[] = [];
  value.forEach((file, index) => {
    if (!isRecord(file)) {
      errors.push(`Field "${field}[${index}]" must be an object with path and content.`);
      return;
    }
    errors.push(...meaningful(file.path, `${field}[${index}].path`, 3));
    errors.push(...meaningful(file.content, `${field}[${index}].content`, 4));
  });
  return errors;
}

function nonEmpty(value: unknown, field: string): string[] {
  return typeof value === "string" && value.length > 0 ? [] : [`Field "${field}" must be a non-empty string.`];
}

function meaningful(value: unknown, field: string, minimumLength: number): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [`Field "${field}" must be a non-empty string.`];
  }
  const text = value.trim();
  if (text.length < minimumLength || placeholderPattern.test(text)) {
    return [`Field "${field}" must be concrete text of at least ${minimumLength} characters, not a placeholder.`];
  }
  return [];
}

function hasThreeMatchingAttempts(value: string): boolean {
  // Only the leading window survives to the server's own check.
  const window = Buffer.from(value, "utf8").subarray(0, serverAttemptsClampBytes).toString("utf8");
  const match = window.match(/(?:^|\D)(\d+)\s*\/\s*(\d+)(?:\D|$)/);
  return Boolean(match && Number(match[1]) >= 3 && match[1] === match[2]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
