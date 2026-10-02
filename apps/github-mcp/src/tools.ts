import {
  assertsExistingBehaviour,
  claimVerdicts,
  hasRepositoryEvidence,
  minimumExcerptLength,
  ownershipStatuses,
  requirementVerdicts
} from "./claims.js";
import { createHash } from "node:crypto";

export interface GitHubRestClientLike {
  getIssue(owner: string, repo: string, issueNumber: number): Promise<{
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    labels?: Array<{ name: string } | string>;
    comments?: number;
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
    input: { baseTree: string; files: Array<{ path: string; content: string }>; deletions?: string[] }
  ): Promise<{ sha: string }>;
  updateBranch?(owner: string, repo: string, branch: string, sha: string): Promise<void>;
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
  ): Promise<Array<{ number: number; html_url: string; state: string; body?: string | null; head: { ref: string; label: string } }>>;
  listIssueComments?(
    owner: string,
    repo: string,
    issueNumber: number,
    options?: { limit?: number }
  ): Promise<
    Array<{
      id: number;
      html_url?: string;
      body: string | null;
      created_at: string;
      user: { login: string } | null;
      author_association?: string;
    }>
  >;
  getPullRequest?(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<{ number: number; html_url: string; state: string; merged?: boolean; merged_at?: string | null; draft?: boolean }>;
  listPullRequestReviews?(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<Array<{ id: number; state: string; submitted_at?: string; user: { login: string } | null }>>;
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
  | "read_repository_instructions"
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
    {
      name: "read_issue",
      description: "Read a GitHub issue by owner, repo, and number, including its comment discussion.",
      requiresApproval: false
    },
    { name: "read_file", description: "Read a repository file at an optional ref.", requiresApproval: false },
    {
      name: "read_repository_instructions",
      description:
        "Read the repository's own guidance for contributors and agents: CONTRIBUTING, AGENTS.md, CLAUDE.md, pull request templates and the README.",
      requiresApproval: false
    },
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
          // The discussion is where maintainers say what already exists, what they want
          // instead, and how the work should be split. Reading the body alone once led to a
          // patch re-implementing sorting the repository owner had said already existed.
          let discussion: IssueDiscussion;
          try {
            discussion = selectIssueDiscussion(
              client.listIssueComments ? await client.listIssueComments(owner, repo, issueNumber, { limit: 200 }) : []
            );
          } catch (error) {
            discussion = {
              comments: [],
              total: 0,
              omitted: 0,
              error: `Comments could not be read: ${error instanceof Error ? error.message : String(error)}`
            };
          }
          return textResult(
            JSON.stringify(
              {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                url: issue.html_url,
                labels: (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
                commentCount: discussion.total,
                ...(discussion.omitted > 0 ? { commentsOmitted: discussion.omitted } : {}),
                ...(discussion.error ? { commentsError: discussion.error } : {}),
                comments: discussion.comments
              },
              null,
              2
            )
          );
        }

        case "read_repository_instructions": {
          const { owner, repo } = parseRepoArgs(call.arguments);
          const ref = typeof call.arguments.ref === "string" && call.arguments.ref.trim() ? call.arguments.ref.trim() : undefined;
          return textResult(JSON.stringify(await readRepositoryInstructions(client, owner, repo, ref), null, 2));
        }

        case "read_file": {
          const { owner, repo, path, ref, ...range } = parseReadFileArgs(call.arguments);
          const file = await client.getFile(owner, repo, path, ref);
          return textResult(JSON.stringify(readFileWindow(file, range), null, 2));
        }

        case "submit_squasher_result": {
          expectSquasherResult(call.arguments);
          const hasPatch = call.arguments.candidatePatch !== null && typeof call.arguments.candidatePatch === "object";
          return textResult(
            JSON.stringify({
              accepted: true,
              ...(hasPatch
                ? {
                    instruction:
                      "For a result with a candidatePatch, you MUST now immediately call the create_fix_pull_request MCP tool with owner, repo, baseBranch, branchName, title, body, and files (with the exact array matching candidatePatch.files) to initiate the maintainer approval checkpoint. If contribution policy declines that write, do not retry it: the verified patch is kept either way."
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

function parseRepoArgs(args: Record<string, unknown>) {
  return {
    owner: expectString(args.owner, "owner"),
    repo: expectString(args.repo, "repo")
  };
}

/** One discussion comment, as handed to the agent. */
export interface IssueDiscussionComment {
  author: string;
  /** GitHub's association: OWNER, MEMBER and COLLABORATOR speak for the project. */
  association: string;
  maintainer: boolean;
  createdAt: string;
  body: string;
  truncated?: boolean;
}

export interface IssueDiscussion {
  comments: IssueDiscussionComment[];
  total: number;
  /** Comments left out of a long thread, from its middle. */
  omitted: number;
  error?: string;
}

const maintainerAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const maxDiscussionComments = 40;
const maxDiscussionCommentChars = 2_000;
const maxDiscussionChars = 24 * 1024;

/**
 * Bounds an issue's discussion for the model. A long thread keeps its opening comments,
 * which carry the original context, and its most recent ones, which carry the current
 * decision; the middle is dropped and counted. Every maintainer comment is kept whatever
 * its position, because a maintainer's word is what changes the requirement.
 */
export function selectIssueDiscussion(
  raw: Array<{ body: string | null; created_at: string; user: { login: string } | null; author_association?: string }>
): IssueDiscussion {
  const all = raw.map((comment) => {
    const association = (comment.author_association ?? "NONE").toUpperCase();
    const body = (comment.body ?? "").trim();
    const truncated = body.length > maxDiscussionCommentChars;
    return {
      author: comment.user?.login ?? "ghost",
      association,
      maintainer: maintainerAssociations.has(association),
      createdAt: comment.created_at,
      body: truncated ? `${body.slice(0, maxDiscussionCommentChars)}…` : body,
      ...(truncated ? { truncated: true } : {})
    };
  });

  let keep = new Set<number>();
  if (all.length <= maxDiscussionComments) {
    keep = new Set(all.map((_, index) => index));
  } else {
    all.forEach((comment, index) => {
      if (index < 8 || index >= all.length - (maxDiscussionComments - 8) || comment.maintainer) keep.add(index);
    });
  }

  // Then the byte budget, dropping the oldest non-maintainer comments after the opening few.
  const indices = [...keep].sort((a, b) => a - b);
  const size = () => indices.reduce((sum, index) => sum + (all[index]?.body.length ?? 0) + 120, 0);
  while (size() > maxDiscussionChars) {
    const drop = indices.findIndex((index, position) => position >= 3 && !all[index]?.maintainer);
    if (drop < 0) break;
    indices.splice(drop, 1);
  }

  return {
    comments: indices.map((index) => all[index]!),
    total: all.length,
    omitted: all.length - indices.length
  };
}

/** Renders a bounded discussion as plain text for the run's opening message. */
export function formatIssueDiscussion(discussion: IssueDiscussion): string {
  if (discussion.total === 0) {
    return discussion.error ? `(${discussion.error})` : "(no comments)";
  }

  const lines = discussion.comments.map((comment) => {
    const role = comment.maintainer ? `${comment.association}, maintainer` : comment.association;
    return `--- @${comment.author} (${role}) at ${comment.createdAt}\n${comment.body || "(empty)"}`;
  });
  if (discussion.omitted > 0) {
    lines.push(`--- ${discussion.omitted} further comment(s) were omitted to keep this bounded; call read_issue for the rest.`);
  }
  return lines.join("\n\n");
}

/**
 * Where repositories keep guidance for contributors and for agents, in reading order. The
 * README comes last and is cut shorter: it is mostly for users, and its development
 * section is usually near the end of the other documents' coverage anyway.
 */
export const repositoryInstructionPaths = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "DEVELOPMENT.md",
  "docs/development.md",
  "README.md"
];

const maxInstructionFileChars = 12 * 1024;
const maxReadmeChars = 8 * 1024;
const maxInstructionTotalChars = 40 * 1024;

export async function readRepositoryInstructions(
  client: Pick<GitHubRestClientLike, "getFile">,
  owner: string,
  repo: string,
  ref?: string
): Promise<{
  found: Array<{ path: string; content: string; truncated: boolean; totalChars: number }>;
  missing: string[];
  unreadable: Array<{ path: string; error: string }>;
  notice: string;
}> {
  const found: Array<{ path: string; content: string; truncated: boolean; totalChars: number }> = [];
  const missing: string[] = [];
  const unreadable: Array<{ path: string; error: string }> = [];
  let budget = maxInstructionTotalChars;

  for (const path of repositoryInstructionPaths) {
    let text: string;
    try {
      const file = await client.getFile(owner, repo, path, ref);
      text = (file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8")).toString("utf8");
    } catch (error) {
      if (isNotFound(error)) missing.push(path);
      else unreadable.push({ path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const limit = Math.min(path === "README.md" ? maxReadmeChars : maxInstructionFileChars, budget);
    if (limit <= 0) {
      found.push({ path, content: "", truncated: true, totalChars: text.length });
      continue;
    }
    const truncated = text.length > limit;
    found.push({ path, content: truncated ? text.slice(0, limit) : text, truncated, totalChars: text.length });
    budget -= Math.min(text.length, limit);
  }

  return {
    found,
    missing,
    unreadable,
    notice:
      "Use these for build, test, style and contribution rules. Where a document is truncated, read the rest with read_file or in the sandbox clone. Do not invent rules that are not written here."
  };
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
  // Optional explanation fields: absent is fine, but a present value must be usable text.
  if (args.rootCauseSummary !== undefined) expectString(args.rootCauseSummary, "rootCauseSummary");
  if (args.nextStep !== undefined) expectString(args.nextStep, "nextStep");
  if (args.findings !== undefined) {
    if (!Array.isArray(args.findings) || args.findings.some((finding) => typeof finding !== "string")) {
      throw new Error("Expected findings to be an array of strings");
    }
  }
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
  // After the evidence bar, so a result missing basic proof is told about that first.
  expectRequirements(args.requirements, args.status);
  expectDiscussionClaims(args.discussionClaims);
  expectFileChanges(args.fileChanges, args.candidatePatch, args.requirements);
  expectTestCommands(args.testCommands);
  if (args.candidatePatch === null) return;
  if (!args.candidatePatch || typeof args.candidatePatch !== "object" || Array.isArray(args.candidatePatch)) {
    throw new Error("Expected candidatePatch object or null");
  }
  const patch = args.candidatePatch as Record<string, unknown>;
  expectMeaningfulText(patch.title, "candidatePatch.title", 8);
  expectMeaningfulText(patch.body, "candidatePatch.body", 12);
  expectPatchFiles(patch.files);
}

/**
 * Checks the requirement verification. An implemented change must list the requirements it
 * was built against, because "implemented" means nothing without saying what was asked
 * for. No proven status may carry a requirement that failed: that change is not verified.
 *
 * Technical state and ownership are separate: `verdict` says what the code does, and
 * `ownership` says whose work it is per the discussion. Work reserved for or claimed by
 * someone else is never built in this run, whatever its technical state.
 *
 * Whether cited evidence is true is checked where the repository is at hand -- see
 * repositoryEvidenceProblem, applied by the harness. Here only its presence is required.
 */
function expectRequirements(value: unknown, status: unknown): void {
  const isImplementation = typeof status === "string" && implementationStatuses.has(status);
  const isProven = typeof status === "string" && provenResultStatuses.has(status);
  if (value === undefined || value === null) {
    if (isImplementation) {
      throw new Error(
        `Expected requirements: list each acceptance criterion from the issue and its discussion with a verdict (${requirementVerdicts.join(", ")}) and the concrete evidence for it`
      );
    }
    return;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Expected requirements to be a non-empty array");
  }

  const verdicts = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Expected requirement object at index ${index}`);
    }
    const requirement = entry as Record<string, unknown>;
    const name = `requirements[${index}]`;
    expectMeaningfulText(requirement.requirement, `${name}.requirement`, 6);
    if (typeof requirement.verdict !== "string" || !(requirementVerdicts as readonly string[]).includes(requirement.verdict)) {
      throw new Error(`Expected ${name}.verdict to be one of ${requirementVerdicts.join(", ")}`);
    }
    if (requirement.verdict !== "out-of-scope") {
      expectMeaningfulText(requirement.evidence, `${name}.evidence`, 6);
    }
    expectEvidenceShape(requirement, name);
    if (assertsExistingBehaviour("requirement", requirement.verdict) && !hasRepositoryEvidence(requirement)) {
      throw new Error(
        `${name} is marked already-implemented without repository evidence. A comment saying it exists is a claim, not proof: cite codeEvidence (path and an excerpt that occurs in it) or an executedCommand you ran, or mark it missing.`
      );
    }

    const ownership = requirement.ownership;
    if (ownership !== undefined) {
      if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) {
        throw new Error(`Expected ${name}.ownership to be an object`);
      }
      const owned = ownership as Record<string, unknown>;
      if (typeof owned.status !== "string" || !(ownershipStatuses as readonly string[]).includes(owned.status)) {
        throw new Error(`Expected ${name}.ownership.status to be one of ${ownershipStatuses.join(", ")}`);
      }
      expectMeaningfulText(owned.by, `${name}.ownership.by`, 2);
      if (requirement.verdict === "pass") {
        throw new Error(
          `${name} is ${owned.status} for ${String(owned.by)} per the discussion, so it must not be implemented in this run. Leave that work to its owner and exclude it from the patch.`
        );
      }
    } else if (isProven && requirement.verdict === "missing") {
      throw new Error(
        `${name} is still missing, so status "${String(status)}" does not cover it: implement it, mark it out-of-scope with the reason, or record who owns it in ownership.`
      );
    }
    return requirement.verdict;
  });

  if (isProven && verdicts.includes("fail")) {
    throw new Error(
      `A requirement failed verification, so status "${status}" is not available: repair the change and re-verify, or submit the status that honestly describes the result`
    );
  }
  if (isImplementation && !verdicts.includes("pass")) {
    throw new Error("An implemented change must have at least one requirement verified as pass");
  }
}

/**
 * Checks the discussion claims: what someone in the thread asserted, and what the
 * repository showed. A confirmed claim needs the same evidence as an already-implemented
 * requirement; a contradicted one keeps both sides -- the claim and what the code does.
 */
function expectDiscussionClaims(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new Error("Expected discussionClaims to be an array");

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Expected discussion claim object at index ${index}`);
    }
    const claim = entry as Record<string, unknown>;
    const name = `discussionClaims[${index}]`;
    expectMeaningfulText(claim.claim, `${name}.claim`, 6);
    if (typeof claim.verdict !== "string" || !(claimVerdicts as readonly string[]).includes(claim.verdict)) {
      throw new Error(`Expected ${name}.verdict to be one of ${claimVerdicts.join(", ")}`);
    }
    expectMeaningfulText(claim.evidence, `${name}.evidence`, 6);
    expectEvidenceShape(claim, name);
    if (assertsExistingBehaviour("claim", claim.verdict) && !hasRepositoryEvidence(claim)) {
      throw new Error(
        `${name} is marked ${claim.verdict} without repository evidence. Cite codeEvidence or an executedCommand, or mark it unverified.`
      );
    }
  });
}

/**
 * Checks the per-file explanations: each names a file the patch actually changes, and any
 * requirement it cites is one this result lists. That keeps the workspace's
 * requirement-to-file mapping to what the agent declared, never inferred.
 */
function expectFileChanges(value: unknown, candidatePatch: unknown, requirements: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new Error("Expected fileChanges to be an array");
  const patchPaths = new Set(
    candidatePatch && typeof candidatePatch === "object" && Array.isArray((candidatePatch as Record<string, unknown>).files)
      ? ((candidatePatch as Record<string, unknown>).files as Array<Record<string, unknown>>).map((file) => file?.path)
      : []
  );
  const requirementTexts = new Set(
    Array.isArray(requirements) ? requirements.map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).requirement : undefined)) : []
  );

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Expected fileChanges[${index}] to be an object`);
    const change = entry as Record<string, unknown>;
    const path = expectMeaningfulText(change.path, `fileChanges[${index}].path`, 1);
    if (!patchPaths.has(path)) {
      throw new Error(`fileChanges[${index}].path "${path}" is not a file in candidatePatch.files`);
    }
    expectMeaningfulText(change.summary, `fileChanges[${index}].summary`, 8);
    if (change.requirements !== undefined) {
      if (!Array.isArray(change.requirements) || change.requirements.some((text) => typeof text !== "string")) {
        throw new Error(`Expected fileChanges[${index}].requirements to be an array of requirement texts`);
      }
      for (const text of change.requirements as string[]) {
        if (!requirementTexts.has(text)) {
          throw new Error(`fileChanges[${index}] cites requirement "${text}", which is not in requirements; cite the exact requirement text`);
        }
      }
    }
  });
}

/**
 * Commands that re-verify the change from a fresh clone of the repository with the patch
 * applied, run from the repository root. The workspace runs them again on request, so each
 * must be self-contained: setup included, nothing assumed from the agent's own sandbox.
 */
function expectTestCommands(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error("Expected testCommands to be an array of 1 to 8 commands");
  }
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Expected testCommands[${index}] to be an object`);
    const command = entry as Record<string, unknown>;
    const text = expectMeaningfulText(command.command, `testCommands[${index}].command`, 3);
    if (text.length > 1_000) throw new Error(`testCommands[${index}].command is too long; keep it to one runnable command`);
    expectMeaningfulText(command.purpose, `testCommands[${index}].purpose`, 4);
  });
}

function expectEvidenceShape(entry: Record<string, unknown>, name: string): void {
  if (entry.codeEvidence !== undefined) {
    if (!Array.isArray(entry.codeEvidence)) throw new Error(`Expected ${name}.codeEvidence to be an array`);
    entry.codeEvidence.forEach((evidence, index) => {
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        throw new Error(`Expected ${name}.codeEvidence[${index}] to be an object with path and excerpt`);
      }
      const cited = evidence as Record<string, unknown>;
      expectMeaningfulText(cited.path, `${name}.codeEvidence[${index}].path`, 1);
      expectMeaningfulText(cited.excerpt, `${name}.codeEvidence[${index}].excerpt`, minimumExcerptLength);
    });
  }
  if (entry.executedCommand !== undefined) expectString(entry.executedCommand, `${name}.executedCommand`);
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
