import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitHubRestClientLike } from "@squasher/github-mcp";
import type { SandboxClientLike } from "@squasher/harness";

/**
 * Patch revisions and the workspace jobs that produce and test them.
 *
 * The original Squasher patch is revision 0 and lives on the run record. Every later
 * revision comes from a human's requested change, applied by an agent session that has no
 * GitHub write tool, and is kept only if its evidence holds. Nothing here writes to GitHub
 * except `pushRevisionToBranch`, which runs only after a human approves a revision.
 */

export interface RevisionFile {
  path: string;
  content: string;
}

export interface PatchRevision {
  id: string;
  runId: string;
  /** 1, 2, ...; the original patch is 0 and is not stored here. */
  number: number;
  source: "requested-change" | "verification";
  /** The revision this one was made from. */
  basedOn: number;
  changeRequestId?: string;
  changeRequestText?: string;
  createdAt: string;
  title: string;
  body: string;
  summary: string;
  files: RevisionFile[];
  hash: string;
  requirements?: Array<{ requirement: string; verdict: string; evidence?: string }>;
  fileChanges?: Array<{ path: string; summary: string; requirements?: string[] }>;
  testCommands?: TestCommand[];
  proof?: { before?: string; after?: string; regressions?: string; attempts?: string };
}

export interface TestCommand {
  command: string;
  purpose?: string;
}

export interface TestCommandResult {
  command: string;
  purpose?: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export type WorkspaceJobKind = "apply-change" | "verify" | "test-run";

export interface WorkspaceJob {
  id: string;
  runId: string;
  kind: WorkspaceJobKind;
  status: "running" | "succeeded" | "failed";
  /** What is happening now, in the reviewer's words. */
  stage: string;
  createdAt: string;
  updatedAt: string;
  /** The revision this job acts on; 0 is the original patch. */
  revision: number;
  changeRequestId?: string;
  /** Private: the agent session behind an apply-change or verify job. Never sent to the page. */
  sessionId?: string;
  turnId?: string;
  producedRevision?: number;
  testRun?: { commands: TestCommandResult[]; passed: boolean; source: "recorded-commands" };
  error?: string;
}

const revisionsFile = "patch-revisions.jsonl";
const jobsFile = "workspace-jobs.jsonl";

/** A patch larger than this is not sent to a revision session: it would crowd out the work. */
export const maxRevisablePatchChars = 60_000;

export function patchHash(files: RevisionFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return hash.digest("hex");
}

async function readJsonl<T>(dataDir: string, file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(join(dataDir, file), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

async function appendJsonl(dataDir: string, file: string, value: unknown): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await appendFile(join(dataDir, file), `${JSON.stringify(value)}\n`, "utf8");
}

export async function readRevisions(dataDir: string | undefined, runId: string): Promise<PatchRevision[]> {
  if (!dataDir) return [];
  return (await readJsonl<PatchRevision>(dataDir, revisionsFile))
    .filter((revision) => revision.runId === runId)
    .sort((a, b) => a.number - b.number);
}

export async function saveRevision(dataDir: string, revision: Omit<PatchRevision, "id" | "createdAt" | "hash">): Promise<PatchRevision> {
  const saved: PatchRevision = {
    ...revision,
    id: `revision-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    hash: patchHash(revision.files)
  };
  await appendJsonl(dataDir, revisionsFile, saved);
  return saved;
}

/** Every job for a run, at its latest state. Jobs are append-only; the last line wins. */
export async function readJobs(dataDir: string | undefined, runId: string): Promise<WorkspaceJob[]> {
  if (!dataDir) return [];
  const latest = new Map<string, WorkspaceJob>();
  for (const job of await readJsonl<WorkspaceJob>(dataDir, jobsFile)) {
    if (job.runId === runId) latest.set(job.id, job);
  }
  return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function saveJob(dataDir: string, job: WorkspaceJob): Promise<WorkspaceJob> {
  const saved = { ...job, updatedAt: new Date().toISOString() };
  await appendJsonl(dataDir, jobsFile, saved);
  return saved;
}

export function newJob(input: { runId: string; kind: WorkspaceJobKind; revision: number; stage: string; changeRequestId?: string }): WorkspaceJob {
  const now = new Date().toISOString();
  return {
    id: `job-${randomUUID()}`,
    runId: input.runId,
    kind: input.kind,
    status: "running",
    stage: input.stage,
    createdAt: now,
    updatedAt: now,
    revision: input.revision,
    ...(input.changeRequestId ? { changeRequestId: input.changeRequestId } : {})
  };
}

/** A job that stopped making progress (a server restart mid-run) is reported as failed. */
export const staleJobMs = 45 * 60_000;

export function isActive(job: WorkspaceJob, now = Date.now()): boolean {
  return job.status === "running" && now - Date.parse(job.updatedAt) < staleJobMs;
}

const outputTailChars = 4_000;

function tail(text: string): string {
  return text.length > outputTailChars ? `[... ${text.length - outputTailChars} earlier characters omitted ...]\n${text.slice(-outputTailChars)}` : text;
}

/**
 * Re-runs a revision's recorded test commands in a fresh sandbox: clone the repository at
 * its base branch, write the patch over it, run each command from the repository root.
 * No model is involved; the result is exactly what the commands printed and returned.
 */
export async function runRecordedTests(
  sandbox: SandboxClientLike,
  input: {
    owner: string;
    repo: string;
    baseBranch: string;
    files: RevisionFile[];
    commands: TestCommand[];
    onStage: (stage: string) => Promise<void>;
    commandTimeoutMs?: number;
  }
): Promise<{ commands: TestCommandResult[]; passed: boolean }> {
  const workdir = "/tmp/squasher-workspace";
  await input.onStage("Preparing environment");
  const sandboxId = await sandbox.createSandbox();
  try {
    const clone = await sandbox.runCommand(
      sandboxId,
      `git clone --quiet --depth 1 --branch ${shellQuote(input.baseBranch)} https://github.com/${shellQuote(`${input.owner}/${input.repo}`)}.git ${workdir}`,
      5 * 60_000
    );
    if (clone.exitCode !== 0) {
      throw new Error(`The repository could not be cloned: ${tail(clone.stderr || clone.stdout).slice(0, 500)}`);
    }
    for (const file of input.files) {
      await sandbox.writeFile(sandboxId, `${workdir}/${file.path}`, file.content);
    }

    await input.onStage("Running tests");
    const results: TestCommandResult[] = [];
    for (const command of input.commands) {
      const started = Date.now();
      let result: { stdout: string; stderr: string; exitCode: number | null };
      try {
        result = await sandbox.runCommand(sandboxId, `cd ${workdir} && ${command.command}`, input.commandTimeoutMs ?? 10 * 60_000);
      } catch (error) {
        result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null };
      }
      results.push({
        command: command.command,
        ...(command.purpose ? { purpose: command.purpose } : {}),
        exitCode: result.exitCode,
        durationMs: Date.now() - started,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr)
      });
    }
    return { commands: results, passed: results.every((result) => result.exitCode === 0) };
  } finally {
    await sandbox.closeSandbox(sandboxId).catch(() => undefined);
  }
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._\/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Brings an open pull request's branch to an approved revision in one commit on top of its
 * current head. Files the revision no longer contains go back to their state on the base
 * branch: restored where they existed there, deleted where the patch had added them. The
 * branch only fast-forwards, so a branch someone else has moved is never overwritten.
 */
export async function pushRevisionToBranch(
  client: GitHubRestClientLike,
  input: {
    headOwner: string;
    repo: string;
    branch: string;
    revision: PatchRevision;
    /** The files the branch holds now, from the previously submitted version. */
    currentPaths: string[];
    /** Base-branch content of each changed path, or undefined where the patch added it. */
    baseContent: (path: string) => string | undefined;
  }
): Promise<{ commitSha: string }> {
  if (!client.updateBranch) {
    throw new Error("The GitHub client cannot update a branch, so the open pull request cannot be updated");
  }
  const head = await client.getBranch(input.headOwner, input.repo, input.branch);
  const headCommit = await client.getCommit(input.headOwner, input.repo, head.commit.sha);
  const kept = new Set(input.revision.files.map((file) => file.path));
  const restored: RevisionFile[] = [];
  const deletions: string[] = [];
  for (const path of input.currentPaths) {
    if (kept.has(path)) continue;
    const base = input.baseContent(path);
    if (base === undefined) deletions.push(path);
    else restored.push({ path, content: base });
  }

  const tree = await client.createTree(input.headOwner, input.repo, {
    baseTree: headCommit.tree.sha,
    files: [...input.revision.files, ...restored],
    ...(deletions.length ? { deletions } : {})
  });
  const commit = await client.createCommit(input.headOwner, input.repo, {
    message: `Squasher revision ${input.revision.number}: ${input.revision.changeRequestText ?? input.revision.title}`.slice(0, 200),
    tree: tree.sha,
    parents: [head.commit.sha]
  });
  await client.updateBranch(input.headOwner, input.repo, input.branch, commit.sha);
  return { commitSha: commit.sha };
}
