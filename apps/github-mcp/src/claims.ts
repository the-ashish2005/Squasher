/**
 * Claim → evidence → verdict.
 *
 * An issue's discussion is context: it says what the maintainers intend, what work is claimed
 * or reserved, and what they believe the code already does. It is not proof of what the code
 * does. A live run on drkrillo/good-first-issues#164 repeated the owner's "sorting by any
 * column, including Repo" as fact; the repository's Repo column was not sortable.
 *
 * So a requirement reported as already implemented, and a discussion claim reported as
 * confirmed, must cite evidence from the repository itself: an excerpt that occurs in a file
 * on the base branch, or a command that actually ran in this session's sandbox. Both are
 * checked mechanically before the result is accepted. What cannot be checked mechanically --
 * whether a cited excerpt is the right one, or whether a broad claim was broken into its
 * concrete capabilities -- stays with the agent's instructions.
 */

export const requirementVerdicts = ["pass", "fail", "already-implemented", "missing", "out-of-scope"] as const;
export type RequirementVerdict = (typeof requirementVerdicts)[number];

export const claimVerdicts = ["confirmed", "partly-confirmed", "contradicted", "unverified"] as const;
export type ClaimVerdict = (typeof claimVerdicts)[number];

/** Who the work behind a requirement belongs to, per the discussion. */
export const ownershipStatuses = ["reserved", "offered", "claimed"] as const;

export interface CodeEvidence {
  path: string;
  excerpt: string;
}

export interface EvidenceBearing {
  codeEvidence?: CodeEvidence[];
  /** A command run in this session's sandbox whose output establishes the verdict. */
  executedCommand?: string;
}

/** The shortest excerpt accepted as evidence: shorter than this matches almost anything. */
export const minimumExcerptLength = 12;
const maxEvidenceFiles = 12;

/** Whitespace-insensitive, so indentation and line wrapping in a quote do not matter. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function items(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function codeEvidenceOf(entry: Record<string, unknown>): CodeEvidence[] {
  return items(entry.codeEvidence).flatMap((evidence) =>
    typeof evidence.path === "string" && typeof evidence.excerpt === "string" ? [{ path: evidence.path, excerpt: evidence.excerpt }] : []
  );
}

/** Whether an entry carries evidence of either kind; checked for existence, not truth. */
export function hasRepositoryEvidence(entry: Record<string, unknown>): boolean {
  const code = codeEvidenceOf(entry).some((evidence) => evidence.path.trim().length > 0 && normalise(evidence.excerpt).length >= minimumExcerptLength);
  const command = typeof entry.executedCommand === "string" && entry.executedCommand.trim().length >= 4;
  return code || command;
}

/** Verdicts that assert the repository already does something, and so need its evidence. */
export function assertsExistingBehaviour(kind: "requirement" | "claim", verdict: unknown): boolean {
  return kind === "requirement" ? verdict === "already-implemented" : verdict === "confirmed" || verdict === "partly-confirmed";
}

/**
 * Checks every cited excerpt against the repository and every cited command against what
 * ran in the sandbox. Returns the first discrepancy as a message the agent can act on, or
 * undefined when every citation holds.
 *
 * `readFile` returns the file's text at the base ref, or undefined when it does not exist.
 * `executedCommands` are the sandbox commands this session actually ran.
 */
export async function repositoryEvidenceProblem(
  result: Record<string, unknown>,
  readFile: (path: string) => Promise<string | undefined>,
  executedCommands: string[]
): Promise<string | undefined> {
  const cited: Array<{ label: string; asserts: boolean; entry: Record<string, unknown> }> = [
    ...items(result.requirements).map((entry) => ({
      label: `requirement "${String(entry.requirement ?? "")}"`,
      asserts: assertsExistingBehaviour("requirement", entry.verdict),
      entry
    })),
    ...items(result.discussionClaims).map((entry) => ({
      label: `discussion claim "${String(entry.claim ?? "")}"`,
      asserts: assertsExistingBehaviour("claim", entry.verdict),
      entry
    }))
  ];

  const files = new Map<string, string | undefined>();
  const read = async (path: string) => {
    if (!files.has(path)) {
      if (files.size >= maxEvidenceFiles) return undefined;
      files.set(path, await readFile(path).catch(() => undefined));
    }
    return files.get(path);
  };
  const ran = executedCommands.map(normalise);

  for (const { label, asserts, entry } of cited) {
    let verifiedCitations = 0;

    for (const evidence of codeEvidenceOf(entry)) {
      const excerpt = normalise(evidence.excerpt);
      if (excerpt.length < minimumExcerptLength) {
        return `The excerpt cited for ${label} is too short to be evidence (${minimumExcerptLength} characters at least): quote the code that establishes it.`;
      }
      const text = await read(evidence.path);
      if (text === undefined) {
        return `The evidence for ${label} cites ${evidence.path}, which does not exist on the base branch (or could not be read). Cite a file that does.`;
      }
      if (!normalise(text).includes(excerpt)) {
        return (
          `The excerpt cited for ${label} does not occur in ${evidence.path} on the base branch: "${evidence.excerpt.slice(0, 160)}". ` +
          "A statement in the issue or its discussion is a claim, not repository evidence. Quote the code that actually implements it; " +
          "if the repository does not implement it, mark the requirement missing, record the discussion claim as contradicted or partly-confirmed, " +
          "and say what the code does instead."
        );
      }
      verifiedCitations += 1;
    }

    if (typeof entry.executedCommand === "string" && entry.executedCommand.trim()) {
      const command = normalise(entry.executedCommand);
      if (!ran.some((executed) => executed.includes(command) || command.includes(executed))) {
        return `The command cited for ${label} was not run in this session's sandbox: "${entry.executedCommand.slice(0, 160)}". Cite a command you actually ran, or quote the code.`;
      }
      verifiedCitations += 1;
    }

    if (asserts && verifiedCitations === 0) {
      return `${label[0]!.toUpperCase()}${label.slice(1)} asserts existing behaviour without repository evidence. Cite codeEvidence (a file path and an excerpt that occurs in it) or an executedCommand you ran; the discussion alone does not establish it.`;
    }
  }

  return undefined;
}
