import { createHash } from "node:crypto";

export interface GitHubRestClientLike {
  getIssue(owner: string, repo: string, issueNumber: number): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
  }>;
  getFile(owner: string, repo: string, path: string, ref?: string): Promise<{
    path: string;
    sha: string;
    encoding: string;
    content: string;
  }>;
  addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void>;
  removeLabel?(owner: string, repo: string, issueNumber: number, label: string): Promise<void>;
  createLabel?(owner: string, repo: string, name: string, color: string, description: string): Promise<void>;
  updateLabel?(owner: string, repo: string, name: string, color: string, description: string): Promise<void>;
  getCollaboratorPermission?(owner: string, repo: string, username: string): Promise<{ permission: string }>;
  createIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<{ html_url: string; id?: number }>;
  updateIssueComment?(owner: string, repo: string, commentId: number, body: string): Promise<{ html_url: string; id?: number }>;
  getBranch(owner: string, repo: string, branch: string): Promise<{ commit: { sha: string } }>;
  createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void>;
  deleteBranch(owner: string, repo: string, branch: string): Promise<void>;
  getCommit(owner: string, repo: string, sha: string): Promise<{ tree: { sha: string } }>;
  createTree(
    owner: string,
    repo: string,
    input: { baseTree: string; files: Array<{ path: string; content: string }> }
  ): Promise<{ sha: string }>;
  createCommit(
    owner: string,
    repo: string,
    input: { message: string; tree: string; parents: string[] }
  ): Promise<{ sha: string }>;
  createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    input: { branch: string; message: string; content: string; sha?: string }
  ): Promise<void>;
  createPullRequest(
    owner: string,
    repo: string,
    input: {
      title: string;
      body: string;
      head: string;
      base: string;
      draft?: boolean;
      maintainerCanModify?: boolean;
    }
  ): Promise<{ number: number; html_url: string }>;
  getRepository?(owner: string, repo: string): Promise<{
    full_name: string;
    default_branch: string;
    private: boolean;
    fork: boolean;
    archived?: boolean;
    disabled?: boolean;
    html_url: string;
    owner: { login: string };
    permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  }>;
  getAuthenticatedUser?(): Promise<{ login: string }>;
  forkRepository?(owner: string, repo: string): Promise<{ full_name: string; owner: { login: string }; html_url: string }>;
  mergeUpstream?(owner: string, repo: string, branch: string): Promise<void>;
  listPullRequests?(
    owner: string,
    repo: string,
    query?: { state?: "open" | "closed" | "all"; head?: string }
  ): Promise<Array<{ number: number; html_url: string; state: string; head: { ref: string; label: string } }>>;
}

export interface ApprovalContext {
  approved: boolean;
  expectedPayloadHash?: string;
}

/**
 * Every status a Squasher result may carry, and the single source of truth for the three
 * places that validate it: this tool's argument check, the harness's structured-output
 * guard, and the server's result parser.
 *
 * Squasher handles two kinds of actionable issue, and the status says which one was found:
 *
 * - patch-ready / verified        a reported defect was reproduced. "verified" is a
 *                                reproduction without a fix attached; "patch-ready" adds
 *                                a verified fix.
 * - implemented-feature          a requested behaviour that did not exist was built and
 *   implemented-improvement      verified. No reproduction exists, because nothing was
 *                                broken; the evidence is the new behaviour passing and
 *                                the existing suite still passing.
 * - not-reproduced               a defect was claimed but could not be demonstrated.
 * - not-actionable               understood, but not something to build: impossible,
 *                                ambiguous, unrelated to the project, or out of scope.
 * - blocked / failed             execution could not complete.
 */
/** Proof `kind` used before the project was renamed from Squasher to Squasher. */
export const legacyResultKind = "byter.result";

/** Proof-submission tool name used before the rename. */
export const legacyResultToolName = "submit_byter_result";

export const squasherResultStatuses = [
  "patch-ready",
  "verified",
  "implemented-feature",
  "implemented-improvement",
  "not-reproduced",
  "not-actionable",
  "blocked",
  "failed"
] as const;

export type SquasherResultStatus = (typeof squasherResultStatuses)[number];

/** Asserts a reported defect was reproduced. Requires failure-then-pass evidence. */
export const bugProofStatuses: ReadonlySet<string> = new Set(["patch-ready", "verified"]);

/** Asserts a requested change was implemented and verified. No reproduction required. */
export const implementationStatuses: ReadonlySet<string> = new Set([
  "implemented-feature",
  "implemented-improvement"
]);

/**
 * Statuses held to the full evidence bar: concrete summary, before/after/regression text,
 * and at least 3/3 matching executions. Both kinds clear the same bar; only the meaning of
 * "before" differs — a reproduced failure for a defect, the requested behaviour absent or
 * its new test failing for a change.
 */
export const provenResultStatuses: ReadonlySet<string> = new Set([
  ...bugProofStatuses,
  ...implementationStatuses
]);

export type GitHubMcpToolName =
  | "read_issue"
  | "read_file"
  | "submit_squasher_result"
  | "add_verified_label"
  | "comment_on_issue"
  | "create_fix_pull_request";
export type GitHubMcpWriteToolName = Extract<
  GitHubMcpToolName,
  "add_verified_label" | "comment_on_issue" | "create_fix_pull_request"
>;

export interface GitHubMcpToolCall {
  name: GitHubMcpToolName;
  arguments: Record<string, unknown>;
  approval?: ApprovalContext;
}

export interface GitHubMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
}

export interface GitHubMcpServerOptions {
  client: GitHubRestClientLike;
  /** Injectable clock and delay for the fork-readiness poll, so tests need not wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function listGitHubTools(): Array<{ name: GitHubMcpToolName; description: string; requiresApproval: boolean }> {
  return [
    { name: "read_issue", description: "Read a GitHub issue by owner, repo, and number.", requiresApproval: false },
    { name: "read_file", description: "Read a repository file at an optional ref.", requiresApproval: false },
    {
      name: "submit_squasher_result",
      description: "Submit the final Squasher proof contract without mutating GitHub.",
      requiresApproval: false
    },
    { name: "add_verified_label", description: "Add squasher:verified after proof is complete.", requiresApproval: true },
    { name: "comment_on_issue", description: "Post a Squasher evidence comment.", requiresApproval: true },
    {
      name: "create_fix_pull_request",
      description: "Create a fix branch with explicit file contents and open a draft pull request.",
      requiresApproval: true
    }
  ];
}

export function createGitHubMcpTools({ client, now, sleep }: GitHubMcpServerOptions) {
  const forkPollOptions = {
    ...(now ? { now } : {}),
    ...(sleep ? { sleep } : {})
  };

  return {
    async callTool(incoming: GitHubMcpToolCall): Promise<GitHubMcpToolResult> {
      // A session paused before the rename has submit_byter_result in its message history
      // and may call it again on resume. Accept that spelling as the tool it became.
      const call: GitHubMcpToolCall =
        (incoming.name as string) === legacyResultToolName
          ? { ...incoming, name: "submit_squasher_result" }
          : incoming;

      switch (call.name) {
        case "read_issue": {
          const { owner, repo, issueNumber } = parseRepoIssueArgs(call.arguments);
          const issue = await client.getIssue(owner, repo, issueNumber);
          return textResult(
            JSON.stringify(
              {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                url: issue.html_url
              },
              null,
              2
            )
          );
        }

        case "read_file": {
          const { owner, repo, path, ref, ...range } = parseReadFileArgs(call.arguments);
          const file = await client.getFile(owner, repo, path, ref);
          return textResult(JSON.stringify(readFileWindow(file, range), null, 2));
        }

        case "submit_squasher_result": {
          expectSquasherResult(call.arguments);
          const isPatchReady = call.arguments.status === "patch-ready";
          return textResult(
            JSON.stringify({
              accepted: true,
              ...(isPatchReady
                ? {
                    instruction:
                      "For a patch-ready result, you MUST now immediately call the create_fix_pull_request MCP tool with owner, repo, baseBranch, branchName, title, body, and files (with the exact array matching candidatePatch.files) to initiate the maintainer approval checkpoint."
                  }
                : {})
            })
          );
        }

        case "add_verified_label": {
          assertApproved(call.approval, approvalPayloadHash(call.name, call.arguments));
          const { owner, repo, issueNumber } = parseRepoIssueArgs(call.arguments);
          await client.addLabels(owner, repo, issueNumber, ["squasher:verified"]);
          return textResult("Added squasher:verified label.");
        }

        case "comment_on_issue": {
          assertApproved(call.approval, approvalPayloadHash(call.name, call.arguments));
          const { owner, repo, issueNumber } = parseRepoIssueArgs(call.arguments);
          const body = expectString(call.arguments.body, "body");
          const comment = await client.createIssueComment(owner, repo, issueNumber, body);
          return textResult(`Created comment: ${comment.html_url}`);
        }

        case "create_fix_pull_request": {
          assertApproved(call.approval, approvalPayloadHash(call.name, call.arguments));
          const request = parseCreatePullRequestArgs(call.arguments);
          const crossRepo = request.headOwner !== request.owner;

          // The base is always read from upstream, so a stale fork cannot drag unrelated
          // commits into the diff. Forks share object storage, so the upstream base commit
          // and tree are reachable when writing into the fork.
          const base = await client.getBranch(request.owner, request.repo, request.baseBranch);
          const baseCommit = await client.getCommit(request.owner, request.repo, base.commit.sha);

          if (crossRepo) {
            await ensureForkReady(client, request.headOwner, request.repo, request.baseBranch, forkPollOptions);
          }

          const tree = await client.createTree(request.headOwner, request.repo, {
            baseTree: baseCommit.tree.sha,
            files: request.files.map((file) => ({ path: file.path, content: file.content }))
          });
          const commit = await client.createCommit(request.headOwner, request.repo, {
            message: `Squasher fix: ${request.title}`,
            tree: tree.sha,
            parents: [base.commit.sha]
          });
          await client.createBranch(request.headOwner, request.repo, request.branchName, commit.sha);

          let pullRequest: { number: number; html_url: string };
          try {
            pullRequest = await client.createPullRequest(request.owner, request.repo, {
              title: request.title,
              body: request.body,
              head: crossRepo ? `${request.headOwner}:${request.branchName}` : request.branchName,
              base: request.baseBranch,
              draft: true,
              maintainerCanModify: true
            });
          } catch (error) {
            // Roll back the branch we created, in the repository we created it in. Never the fork itself.
            await client.deleteBranch(request.headOwner, request.repo, request.branchName);
            throw error;
          }

          return textResult(
            JSON.stringify(
              {
                number: pullRequest.number,
                url: pullRequest.html_url,
                branch: request.branchName,
                headOwner: request.headOwner,
                crossRepo,
                filesChanged: request.files.map((file) => file.path)
              },
              null,
              2
            )
          );
        }
      }
    }
  };
}

export function approvalPayloadHash(name: GitHubMcpWriteToolName, args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(canonicalWritePayload(name, args))).digest("hex");
}

/**
 * Hard ceiling on the decoded bytes any single read may return.
 *
 * One unbounded read is enough to end a run. Observed live on talkasab/peruse: reading a
 * 42 KB source file returned 59,793 bytes in one tool response -- base64 is a third larger
 * than the text it encodes, and JSON escaping adds more -- which pushed the conversation to
 * 215 KB and timed out the next model request. A caller may ask for less than this; it
 * cannot ask for more.
 */
export const maxReadFileBytes = 32 * 1024;

export interface ReadFileWindowOptions {
  /** First line to return, 1-based. Defaults to the start of the file. */
  startLine?: number;
  /** Last line to return, inclusive. Defaults to the end of the file. */
  endLine?: number;
  /** Byte ceiling for this window, clamped to maxReadFileBytes. */
  maxBytes?: number;
}

export interface ReadFileWindow {
  path: string;
  sha: string;
  size: number;
  encoding: string;
  content: string;
  /** Total lines in the file, so a caller can tell where a window sits. */
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  returnedBytes?: number;
  /** True when this window reaches the end of the file. */
  complete?: boolean;
  /** True when the window stops short of what was asked for. */
  truncated?: boolean;
  /** Where to continue from, present only when content remains. */
  nextStartLine?: number;
  notice?: string;
}

/**
 * Returns a bounded window of a repository file.
 *
 * Decoding matters as much as the bound: GitHub returns base64, which the model cannot read
 * without spending tokens transcribing it, so passing it through was both larger than the
 * file and less useful than it.
 *
 * Windows are line-based because source code is read in line ranges, with a byte ceiling on
 * top because a single minified line can be larger than any sensible window. A window that
 * stops short says so and names the line to continue from, so a large file is inspected in
 * pieces rather than being unreachable past its first chunk.
 */
export function readFileWindow(
  file: { path: string; sha: string; size?: number; encoding: string; content: string },
  options: ReadFileWindowOptions = {}
): ReadFileWindow {
  const raw = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
  const size = typeof file.size === "number" ? file.size : raw.byteLength;
  const base = { path: file.path, sha: file.sha, size };

  // A NUL byte means this is not source text; a decoded blob would be noise.
  if (raw.includes(0)) {
    return {
      ...base,
      encoding: "none",
      content: "",
      complete: false,
      notice: `Binary file, not returned. Fetch it in the sandbox if it is needed, and verify it against sha ${file.sha}.`
    };
  }

  const text = raw.toString("utf8");
  // Split after each newline so every piece keeps its own ending and reassembly is exact.
  const lines = text.length > 0 ? text.split(/(?<=\n)/) : [];
  const totalLines = lines.length;

  const ceiling = Math.min(options.maxBytes ?? maxReadFileBytes, maxReadFileBytes);
  const firstLine = Math.min(Math.max(options.startLine ?? 1, 1), Math.max(totalLines, 1));
  const requestedLast = Math.min(options.endLine ?? totalLines, totalLines);

  if (totalLines === 0) {
    return { ...base, encoding: "utf8", content: "", totalLines: 0, startLine: 1, endLine: 0, returnedBytes: 0, complete: true };
  }

  if (firstLine > totalLines || requestedLast < firstLine) {
    return {
      ...base,
      encoding: "utf8",
      content: "",
      totalLines,
      startLine: firstLine,
      endLine: firstLine - 1,
      returnedBytes: 0,
      complete: firstLine > totalLines,
      notice: `Requested range is empty. The file has ${totalLines} lines.`
    };
  }

  let content = "";
  let bytes = 0;
  let lastLine = firstLine - 1;
  for (let line = firstLine; line <= requestedLast; line += 1) {
    const piece = lines[line - 1] ?? "";
    const pieceBytes = Buffer.byteLength(piece, "utf8");

    if (bytes + pieceBytes > ceiling) {
      if (bytes === 0) {
        // A single line larger than the whole window: cut it on a character boundary so the
        // model is not handed a broken code point.
        const slice = new TextDecoder("utf-8").decode(Buffer.from(piece, "utf8").subarray(0, ceiling)).replace(/\uFFFD$/, "");
        content = slice;
        bytes = Buffer.byteLength(slice, "utf8");
        lastLine = line;
      }
      break;
    }

    content += piece;
    bytes += pieceBytes;
    lastLine = line;
  }

  // A line cut mid-way must be re-read, not skipped, and never counts as complete: a
  // minified bundle is one line, so a line-only test would call 32 KB of an 80 KB bundle
  // the whole file.
  const partialLine = bytes > 0 && lastLine >= firstLine && content !== lines.slice(firstLine - 1, lastLine).join("");
  const reachedRequestedEnd = lastLine >= requestedLast && !partialLine;
  const complete = reachedRequestedEnd && requestedLast >= totalLines;
  const nextStartLine = complete ? undefined : partialLine ? lastLine : lastLine + 1;

  return {
    ...base,
    encoding: "utf8",
    content,
    totalLines,
    startLine: firstLine,
    endLine: lastLine,
    returnedBytes: bytes,
    complete,
    ...(complete ? {} : { truncated: true }),
    ...(nextStartLine !== undefined && nextStartLine <= totalLines ? { nextStartLine } : {}),
    ...(complete
      ? {}
      : {
          notice:
            `Lines ${firstLine}-${lastLine} of ${totalLines}${partialLine ? " (last line cut at the byte ceiling)" : ""}. ` +
            `This is not the whole file: do not reconstruct it from what is shown, and do not treat the visible end as ` +
            `the end of the file. Continue with startLine ${nextStartLine ?? lastLine + 1}, or materialise the whole ` +
            `file in the sandbox and verify it against sha ${file.sha} before patching it.`
        })
  };
}

function textResult(text: string): GitHubMcpToolResult {
  return { content: [{ type: "text", text }] };
}

function assertApproved(approval: ApprovalContext | undefined, actualPayloadHash: string): void {
  if (!approval?.approved) {
    throw new Error("GitHub write blocked: approval is required");
  }

  if (!approval.expectedPayloadHash) {
    throw new Error("GitHub write blocked: approval payload hash is required");
  }

  if (approval.expectedPayloadHash !== actualPayloadHash) {
    throw new Error("GitHub write blocked: approval payload hash mismatch");
  }
}

function canonicalWritePayload(name: GitHubMcpWriteToolName, args: Record<string, unknown>) {
  switch (name) {
    case "add_verified_label": {
      return {
        tool: name,
        arguments: {
          ...parseRepoIssueArgs(args),
          labels: ["squasher:verified"]
        }
      };
    }

    case "comment_on_issue": {
      return {
        tool: name,
        arguments: {
          ...parseRepoIssueArgs(args),
          body: expectString(args.body, "body")
        }
      };
    }

    case "create_fix_pull_request": {
      return {
        tool: name,
        arguments: parseCreatePullRequestArgs(args)
      };
    }
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)])
    );
  }

  return value;
}

function parseRepoIssueArgs(args: Record<string, unknown>) {
  return {
    owner: expectString(args.owner, "owner"),
    repo: expectString(args.repo, "repo"),
    issueNumber: expectNumber(args.issueNumber, "issueNumber")
  };
}

function parseReadFileArgs(args: Record<string, unknown>) {
  return {
    owner: expectString(args.owner, "owner"),
    repo: expectString(args.repo, "repo"),
    path: expectString(args.path, "path"),
    ref: typeof args.ref === "string" ? args.ref : undefined,
    ...(args.startLine !== undefined ? { startLine: expectPositiveInteger(args.startLine, "startLine") } : {}),
    ...(args.endLine !== undefined ? { endLine: expectPositiveInteger(args.endLine, "endLine") } : {}),
    ...(args.maxBytes !== undefined ? { maxBytes: expectPositiveInteger(args.maxBytes, "maxBytes") } : {})
  };
}

/** Rejects a bad range outright rather than silently reading from somewhere else. */
function expectPositiveInteger(value: unknown, name: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive whole number argument: ${name}`);
  }
  return parsed;
}

function parseCreatePullRequestArgs(args: Record<string, unknown>) {
  const owner = expectString(args.owner, "owner");
  return {
    owner,
    repo: expectString(args.repo, "repo"),
    // The account holding the fix branch. Equal to owner for a same-repo write, so an
    // omitted headOwner hashes identically to an explicit one naming the upstream owner.
    // Because this is part of the canonical payload, the approval hash covers the write
    // destination: an approved payload cannot be redirected to a different account.
    headOwner: typeof args.headOwner === "string" && args.headOwner.length > 0 ? args.headOwner : owner,
    baseBranch: expectString(args.baseBranch, "baseBranch"),
    branchName: expectString(args.branchName, "branchName"),
    title: expectString(args.title, "title"),
    body: expectString(args.body, "body"),
    files: Array.isArray(args.files) ? expectPatchFiles(args.files) : []
  };
}

export const forkReadyTimeoutMs = 30_000;
const forkPollIntervalMs = 1_500;

/**
 * A fork answers 202 before it is usable, so the branch write can race it. Poll until the
 * fork resolves, then make sure its base branch exists before any ref is written.
 */
async function ensureForkReady(
  client: GitHubRestClientLike,
  headOwner: string,
  repo: string,
  baseBranch: string,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!client.getRepository) {
    // Without a probe there is no way to wait; let the branch write surface the failure.
    return;
  }

  const deadline = now() + forkReadyTimeoutMs;
  let lastError: unknown;
  while (now() < deadline) {
    try {
      await client.getRepository(headOwner, repo);
      await client.getBranch(headOwner, repo, baseBranch);
      return;
    } catch (error) {
      lastError = error;
      if (!isNotFound(error)) {
        throw error;
      }
      await sleep(forkPollIntervalMs);
    }
  }

  throw new Error(
    `Fork ${headOwner}/${repo} was not ready within ${Math.round(forkReadyTimeoutMs / 1000)}s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function isNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { status?: number }).status === 404;
}

function expectSquasherResult(args: Record<string, unknown>): void {
  // squasher.result is the current contract; squasher.result is what sessions paused before
  // the rename still carry in their message history, so both are accepted.
  if (args.kind !== "squasher.result" && args.kind !== legacyResultKind) {
    throw new Error("Expected kind=squasher.result");
  }
  if (typeof args.status !== "string" || !(squasherResultStatuses as readonly string[]).includes(args.status)) {
    throw new Error("Expected a valid Squasher result status");
  }
  // Identical rigor for a reproduced defect and an implemented change: the bar is
  // executed, repeated evidence either way.
  const positiveProof = provenResultStatuses.has(args.status);
  if (positiveProof) expectMeaningfulText(args.summary, "summary", 20);
  else expectString(args.summary, "summary");
  if (!args.proof || typeof args.proof !== "object" || Array.isArray(args.proof)) {
    throw new Error("Expected proof object");
  }
  const proof = args.proof as Record<string, unknown>;
  if (positiveProof) {
    expectMeaningfulText(proof.before, "proof.before", 6);
    expectMeaningfulText(proof.after, "proof.after", 6);
    expectMeaningfulText(proof.regressions, "proof.regressions", 6);
    if (!hasThreeMatchingAttempts(expectMeaningfulText(proof.attempts, "proof.attempts", 3))) {
      throw new Error("Expected proof.attempts to report at least 3/3 matching executions");
    }
  } else {
    expectString(proof.before, "proof.before");
    expectString(proof.after, "proof.after");
    expectString(proof.regressions, "proof.regressions");
    expectString(proof.attempts, "proof.attempts");
  }
  if (args.candidatePatch === null) return;
  if (!args.candidatePatch || typeof args.candidatePatch !== "object" || Array.isArray(args.candidatePatch)) {
    throw new Error("Expected candidatePatch object or null");
  }
  const patch = args.candidatePatch as Record<string, unknown>;
  expectMeaningfulText(patch.title, "candidatePatch.title", 8);
  expectMeaningfulText(patch.body, "candidatePatch.body", 12);
  expectPatchFiles(patch.files);
}

function expectPatchFiles(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Expected non-empty files array");
  }

  return value.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`Expected file object at index ${index}`);
    }

    const record = file as Record<string, unknown>;
    return {
      path: expectMeaningfulText(record.path, `files[${index}].path`, 3),
      content: expectMeaningfulText(record.content, `files[${index}].content`, 4),
      sha: typeof record.sha === "string" ? record.sha : undefined
    };
  });
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected non-empty string argument: ${name}`);
  }

  return value;
}

function expectMeaningfulText(value: unknown, name: string, minimumLength: number): string {
  const original = expectString(value, name);
  const text = original.trim();
  if (text.length < minimumLength || /^(?:\.{3}|…|todo|tbd|n\/?a|placeholder|full file content)$/i.test(text)) {
    throw new Error(`Expected concrete non-placeholder text argument: ${name}`);
  }
  return original;
}

function hasThreeMatchingAttempts(value: string): boolean {
  const match = value.match(/(?:^|\D)(\d+)\s*\/\s*(\d+)(?:\D|$)/);
  return Boolean(match && Number(match[1]) >= 3 && match[1] === match[2]);
}

function expectNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Expected integer argument: ${name}`);
  }

  return value;
}
