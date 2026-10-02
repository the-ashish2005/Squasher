import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SquasherTrueForgeRuntime } from "@squasher/agent";
import {
  approvalPayloadHash,
  bugProofStatuses,
  createGitHubMcpTools,
  formatIssueDiscussion,
  selectIssueDiscussion,
  squasherResultStatuses,
  createGitHubMcpHttpHandler,
  implementationStatuses,
  provenResultStatuses,
  type SquasherResultStatus,
  type GitHubRestClientLike
} from "@squasher/github-mcp";
import type {
  ResolveToolApprovalInput,
  StartSquasherSessionInput,
  StartSquasherSessionResult,
  TrueForgeTurn,
  TrueForgeRuntimeEventListener,
  TrueForgeRuntimeEvent
} from "@squasher/agent";
import {
  E2bSandboxClient,
  LlmClient,
  SquasherHarness,
  defaultLlmModel,
  withContributionDisclosure,
  type SandboxClientLike,
  type WriteTargetDecision
} from "@squasher/harness";
import {
  configuredContributionMode,
  isContributionWritable,
  resolveContributionTarget,
  type ContributionTarget
} from "./contribution.js";
import {
  contributionStatusLabels,
  deriveRunStatuses,
  implementationStatusLabels,
  type ContributionIssue,
  type PullRequestState,
  type RunStatuses
} from "./run-status.js";
import { brandedEnv } from "./env.js";
import { canTransition, createRun, scanIssueText, transitionRun } from "@squasher/core";
import {
  GitHubRestClient,
  parseIssueCommentWebhook,
  parseIssueWebhook,
  verifyGitHubWebhook
} from "@squasher/github";

import { PostgresStore } from "./db.js";
import { buildRunOutcome, type RunOutcomeInput } from "./run-outcome.js";
import { summarizePolicy } from "./policy-summary.js";
import { askAboutRun, readChangeRequests, recordChangeRequest, WorkspaceInputError, type AskModel, type ChangeRequest } from "./workspace.js";
import {
  isActive,
  maxRevisablePatchChars,
  newJob,
  pushRevisionToBranch,
  readJobs,
  readRevisions,
  runRecordedTests,
  saveJob,
  saveRevision,
  type PatchRevision,
  type RevisionFile,
  type TestCommand,
  type WorkspaceJob
} from "./revisions.js";

type ApprovalActionId = "approve-pr" | "request-diff" | "reject-run";
type GitHubCommentKind = "started" | "completed" | "failed" | "approval";
const maxRequestBodyBytes = 64 * 1024;
const maxLatestRunReadBytes = 256 * 1024;
const maxResultTextBytes = 256 * 1024;
const maxPatchFiles = 40;
const maxPatchFileBytes = 512 * 1024;
const maxPatchTotalBytes = 2 * 1024 * 1024;
const maxHarnessEvents = 120;
const maxResultFindings = 8;

interface RecordedEvidence {
  codeEvidence?: Array<{ path: string; excerpt: string }>;
  executedCommand?: string;
}

interface RecordedRequirement extends RecordedEvidence {
  requirement: string;
  verdict: string;
  evidence?: string;
  ownership?: { status: string; by: string; basis?: string };
}

interface RecordedClaim extends RecordedEvidence {
  claim: string;
  verdict: string;
  evidence: string;
}

function recordedEvidence(entry: Record<string, unknown>): RecordedEvidence {
  const codeEvidence = Array.isArray(entry.codeEvidence)
    ? entry.codeEvidence
        .filter((cited): cited is Record<string, unknown> => isRecord(cited) && typeof cited.path === "string" && typeof cited.excerpt === "string")
        .slice(0, 6)
        .map((cited) => ({ path: clampText(String(cited.path), 300), excerpt: clampText(String(cited.excerpt), 600) }))
    : [];
  return {
    ...(codeEvidence.length ? { codeEvidence } : {}),
    ...(typeof entry.executedCommand === "string" && entry.executedCommand.trim() ? { executedCommand: clampText(entry.executedCommand.trim(), 400) } : {})
  };
}
const maxResultRequirements = 20;
/**
 * Silence that marks an event stream as hung. Generous on purpose: the gap between events
 * is one model round trip plus one tool call, and bootstrapping a toolchain in the sandbox
 * legitimately takes minutes. Only a stream that has produced nothing at all for this long
 * is stuck.
 */
const defaultStreamIdleTimeoutMs = process.env.NODE_ENV === "test" ? 50 : 5 * 60_000;
const maxHarnessTextBytes = 4 * 1024;
const duplicateIssueTriggerWindowMs = 60_000;

export interface SquasherServerOptions {
  staticDir?: string;
  dataDir?: string;
  postgresStore?: PostgresStore;
  trueForgeRuntime?: SquasherSessionStarter;
  mcpHandler?: McpRequestHandler;
  githubClient?: GitHubRestClientLike;
  /**
   * Shared contribution decisions. Supply this alongside an injected `trueForgeRuntime` so the
   * harness consults the same decisions this server records; omitting it still fails closed,
   * because the approval path refuses a write the decision does not cover.
   */
  contributions?: ContributionRegistry;
  /** Answers workspace questions. Defaults to the configured model when one is set. */
  askModel?: AskModel;
  /** Runs a revision's recorded test commands. Defaults to E2B when E2B_API_KEY is set. */
  sandbox?: SandboxClientLike;
}

type McpRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

interface LiveCandidatePatch {
  title: string;
  body: string;
  baseBranch: string;
  branchName: string;
  files: Array<{ path: string; content: string }>;
  hash: string;
  verifiedAt: string;
}

interface TrueForgePendingApproval {
  turnId: string;
  approvalTurnId?: string;
  threadId: string;
  toolCallId: string;
  sourceEventId?: string;
  toolName: "create_fix_pull_request";
  payloadHash: string;
  /** Account the paused write would push the fix branch to, when it is not the upstream owner. */
  headOwner?: string;
}

interface LiveProofResult {
  status: SquasherResultStatus;
  summary: string;
  rootCauseSummary?: string;
  /**
   * Whether the agent itself supplied rootCauseSummary. When it did not, that field holds the
   * summary's opening sentences, which must not be presented as an established root cause.
   */
  rootCauseReported?: boolean;
  proposedFixSummary?: string;
  /** The agent's recommendation for the maintainer, when it made one. */
  nextStep?: string;
  /** Short factual statements of what the agent checked and observed. */
  findings?: string[];
  /** Acceptance criteria and the verdict on each against the final code. */
  requirements?: RecordedRequirement[];
  /** Claims from the issue or its discussion, and what the repository showed. */
  discussionClaims?: RecordedClaim[];
  /** The agent's explanation of each changed file, and the requirements it serves. */
  fileChanges?: Array<{ path: string; summary: string; requirements?: string[] }>;
  /** Commands that re-verify the patch from a fresh clone, for the workspace's Run tests. */
  testCommands?: TestCommand[];
  /**
   * Whether the evidence held when the run completed: proof text, 3/3 count, an executed
   * command in the trace, and no failed requirement. Absent on records from before it was
   * recorded, which are judged by their proof text alone.
   */
  proofVerified?: boolean;
  baseSha?: string;
  /**
   * Each changed file against the base. `change` is "added" when the file does not exist on
   * the base branch; records from before it existed hold only files that could be read.
   */
  patchDiff?: Array<{ path: string; before: string; after: string; change?: "added" | "modified" }>;
  proof?: {
    before?: string;
    after?: string;
    regressions?: string;
    attempts?: string;
  };
  candidatePatch?: LiveCandidatePatch;
  pullRequest?: { number: number; url: string };
}

type HarnessEventCategory = "session" | "agent" | "mcp" | "sandbox" | "subagent" | "github" | "approval";

interface HarnessTraceEvent {
  id: string;
  sequenceNumber?: number;
  at: string;
  type: string;
  category: HarnessEventCategory;
  source: "trueforge" | "squasher";
  status: "info" | "running" | "passed" | "failed";
  summary: string;
  toolName?: string;
  mcpServer?: string;
  target?: string;
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  sandboxId?: string;
  subagent?: string;
  artifact?: string;
}

interface SquasherSessionStarter {
  startSession(input: StartSquasherSessionInput): Promise<StartSquasherSessionResult>;
  requestProofContract?(sessionId: string): Promise<TrueForgeTurn>;
  resolveToolApproval?(input: ResolveToolApprovalInput): Promise<TrueForgeTurn>;
  subscribeToTurn?(sessionId: string, turnId: string, onEvent?: TrueForgeRuntimeEventListener): Promise<TrueForgeRuntimeEvent[]>;
  listSessionEvents?(sessionId: string): Promise<TrueForgeRuntimeEvent[]>;
}

interface PersistedWebhookRunRecord {
  receivedAt: string;
  deliveryId: string;
  repository: string;
  baseBranch: string;
  issueTitle: string;
  issueBody: string;
  /** The issue's comment thread as the agent saw it at intake, bounded; public GitHub data. */
  issueDiscussion?: string;
  dashboardUrl?: string;
  githubStatusComment?: { id?: number; url: string };
  githubComments?: Array<{ id?: number; url: string; kind: GitHubCommentKind; createdAt: string }>;
  verifiedLabel?: { name: "squasher:verified"; appliedAt?: string; error?: string };
  approvalLabel?: { name: "squasher:awaiting-approval"; appliedAt?: string; error?: string };
  lifecycleLabels?: Array<{ name: string; appliedAt?: string; error?: string }>;
  contribution?: ContributionTarget;
  /** A contribution problem after the preflight, such as a write that failed or was lost. */
  contributionIssue?: ContributionIssue;
  pullRequestState?: PullRequestState;
  /** The patch revision most recently submitted to GitHub; absent when it was the original. */
  submittedRevision?: number;
  /** Stamped on every write from deriveRunStatuses; see run-status.ts. */
  implementationStatus?: RunStatuses["implementation"]["status"];
  contributionStatus?: RunStatuses["contribution"]["status"];
  contributionReason?: string;
  run: ReturnType<typeof createRun>;
  scan: ReturnType<typeof scanIssueText>;
  trueForge: {
    status: string;
    reason?: string;
    error?: string;
    session?: { id: string; title: string | null };
    turn?: { id: string; status: string };
    model?: string;
    provider?: string;
    events?: HarnessTraceEvent[];
    result?: LiveProofResult;
    pendingApproval?: TrueForgePendingApproval;
  };
}

export function createSquasherServer(options: SquasherServerOptions = {}): Server {
  const staticDir = resolve(options.staticDir ?? process.env.STATIC_DIR ?? defaultStaticDir());
  const dataDir = options.dataDir ?? process.env.DATA_DIR;
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGDATABASE_URL;
  let postgresStore = options.postgresStore;
  if (!postgresStore && databaseUrl) {
    postgresStore = new PostgresStore(databaseUrl);
    postgresStore.init().catch((err) => {
      console.error("Failed to initialize PostgreSQL store:", err);
    });
  }
  const githubClient = options.githubClient ?? githubClientFromEnv();
  const contributions = options.contributions ?? new ContributionRegistry();
  const trueForgeRuntime = options.trueForgeRuntime ?? trueForgeRuntimeFromEnv(githubClient, contributions);
  const mcpHandler = options.mcpHandler ?? githubMcpHandlerFromEnv(githubClient);
  const activeIssueTriggers = new Set<string>();
  const askModel = options.askModel ?? askModelFromEnv();
  const sandbox = options.sandbox ?? (process.env.E2B_API_KEY ? E2bSandboxClient.fromEnv() : undefined);

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/runs/latest") {
        await handleLatestRun(request, response, dataDir ? resolve(dataDir) : undefined, trueForgeRuntime, postgresStore, githubClient);
        return;
      }

      const workspaceRoute = /^\/api\/runs\/(.+)\/(ask|change-requests|test-runs|revisions\/(\d+)\/approve)$/.exec(url.pathname);
      if (workspaceRoute) {
        await handleWorkspaceRequest(request, response, {
          dataDir: dataDir ? resolve(dataDir) : undefined,
          runId: decodeRunId(`/api/runs/${workspaceRoute[1]}`),
          action: workspaceRoute[3] ? "approve-revision" : (workspaceRoute[2] as "ask" | "change-requests" | "test-runs"),
          revisionNumber: workspaceRoute[3] ? Number(workspaceRoute[3]) : undefined,
          askModel,
          trueForgeRuntime,
          githubClient,
          sandbox,
          postgresStore
        });
        return;
      }

      if (url.pathname.startsWith("/api/runs/") && url.pathname !== "/api/runs/latest") {
        await handleRun(request, response, dataDir ? resolve(dataDir) : undefined, decodeRunId(url.pathname), trueForgeRuntime, postgresStore, githubClient);
        return;
      }

      if (url.pathname === "/mcp") {
        if (!mcpHandler) {
          sendJson(response, 503, { error: "MCP endpoint is not configured" });
          return;
        }
        await mcpHandler(request, response);
        return;
      }

      if (url.pathname === "/api/approvals") {
        await handleApproval(request, response, dataDir ? resolve(dataDir) : undefined, trueForgeRuntime, githubClient, postgresStore);
        return;
      }

      if (url.pathname === "/api/github/webhook") {
        await handleGitHubWebhook(
          request,
          response,
          dataDir ? resolve(dataDir) : undefined,
          trueForgeRuntime,
          githubClient,
          activeIssueTriggers,
          postgresStore,
          contributions
        );
        return;
      }

      await serveStatic(url.pathname, response, staticDir);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.publicMessage });
        return;
      }

      console.error(error);
      sendJson(response, 500, { error: "Server error" });
    }
  });
}

async function handleGitHubWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  githubClient: GitHubRestClientLike | undefined,
  activeIssueTriggers: Set<string>,
  postgresStore?: PostgresStore,
  contributions: ContributionRegistry = new ContributionRegistry()
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    sendJson(response, 503, { error: "GITHUB_WEBHOOK_SECRET is not configured" });
    return;
  }

  if (!dataDir && !postgresStore) {
    sendJson(response, 503, { error: "Storage is required for webhook deduplication" });
    return;
  }

  const payload = await readText(request);
  const signatureHeader = headerValue(request, "x-hub-signature-256");
  if (!verifyGitHubWebhook({ payload, signatureHeader, secret })) {
    sendJson(response, 403, { error: "Invalid GitHub webhook signature" });
    return;
  }

  const deliveryId = headerValue(request, "x-github-delivery");
  if (!deliveryId) {
    sendJson(response, 400, { error: "X-GitHub-Delivery is required" });
    return;
  }

  if (await deliveryWasProcessed(dataDir, deliveryId, postgresStore)) {
    sendJson(response, 202, { ignored: true, reason: "Duplicate GitHub delivery" });
    return;
  }

  const eventName = headerValue(request, "x-github-event");
  if (eventName && eventName !== "issues" && eventName !== "issue_comment") {
    sendJson(response, 202, { ignored: true, reason: `Unsupported GitHub event: ${eventName}` });
    return;
  }

  if (eventName === "issue_comment") {
    await handleGitHubIssueCommentWebhook(payload, response, dataDir, githubClient, trueForgeRuntime, activeIssueTriggers, postgresStore);
    return;
  }

  let webhook: ReturnType<typeof parseIssueWebhook>;
  try {
    webhook = parseIssueWebhook(payload);
  } catch {
    throw new HttpError(400, "Malformed GitHub issues webhook payload");
  }
  if (!["opened", "edited", "reopened", "labeled"].includes(webhook.action)) {
    sendJson(response, 202, { ignored: true, reason: `Unsupported issue action: ${webhook.action}` });
    return;
  }

  const isExplicitRetrigger = webhook.action === "reopened";
  const explicitTrigger = hasExplicitTrigger(webhook);
  if (
    (webhook.action === "labeled" && !hasTriggerLabel(webhook)) ||
    (webhook.action === "edited" && !explicitTrigger)
  ) {
    sendJson(response, 202, {
      ignored: true,
      reason: `Issue does not have the ${triggerLabel()} label or an explicit trigger marker`
    });
    return;
  }

  await processIssueWebhook(
    webhook,
    deliveryId,
    response,
    dataDir,
    githubClient,
    trueForgeRuntime,
    activeIssueTriggers,
    isExplicitRetrigger,
    postgresStore,
    contributions
  );
}

async function processIssueWebhook(
  webhook: ReturnType<typeof parseIssueWebhook>,
  deliveryId: string,
  response: ServerResponse,
  dataDir: string | undefined,
  githubClient: GitHubRestClientLike | undefined,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  activeIssueTriggers: Set<string>,
  isExplicitRetrigger = false,
  postgresStore?: PostgresStore,
  contributions: ContributionRegistry = new ContributionRegistry()
): Promise<void> {
  const issueTriggerKey = triggerKeyFor(webhook);
  if (!isExplicitRetrigger) {
    if (activeIssueTriggers.has(issueTriggerKey)) {
      sendJson(response, 202, { ignored: true, reason: "Duplicate issue trigger" });
      return;
    }
    activeIssueTriggers.add(issueTriggerKey);
  }

  const claim = isExplicitRetrigger
    ? { acquired: true, release: async () => {} }
    : await acquireAtomicTriggerClaim(dataDir, issueTriggerKey, postgresStore);
  if (!claim.acquired) {
    if (!isExplicitRetrigger) {
      activeIssueTriggers.delete(issueTriggerKey);
    }
    sendJson(response, 202, { ignored: true, reason: "Duplicate issue trigger" });
    return;
  }

  try {
    if (await issueTriggerWasRecentlyProcessed(dataDir, webhook, postgresStore)) {
      sendJson(response, 202, { ignored: true, reason: "Duplicate issue trigger" });
      return;
    }

    const issueText = [webhook.issue.title, webhook.issue.body ?? ""].join("\n");
    const scan = scanIssueText(issueText);
    const runId = `github-${webhook.repository.owner.login}-${webhook.repository.name}-${webhook.issue.number}-${createHash("sha256")
      .update(deliveryId)
      .digest("hex")
      .slice(0, 12)}`;
    let run = createRun(runId, {
      owner: webhook.repository.owner.login,
      repo: webhook.repository.name,
      issueNumber: webhook.issue.number,
      url: webhook.issue.html_url
    });
    run = transitionRun(run, "security-review", "GitHub issue webhook verified and scanned", {
      evidence: { action: webhook.action, safeToExecute: scan.safeToExecute, findings: scan.findings.length }
    });
    run = transitionRun(
      run,
      scan.safeToExecute ? "triaging" : "rejected",
      scan.safeToExecute ? "Issue ready for TrueForge triage" : "Issue rejected by security policy"
    );
    // Resolved before the agent starts, because the agent can reach the gated write at any
    // point after that and the harness reads this decision when it pauses.
    // It decides only how the finished work is submitted, never whether it is done.
    const branchName = branchNameForIssue(webhook.issue.number, deliveryId);
    const contribution = await resolveContributionForRun(
      contributions,
      githubClient,
      webhook.repository.owner.login,
      webhook.repository.name,
      webhook.issue.number,
      branchName,
      scan.safeToExecute
    );
    const issueDiscussion = scan.safeToExecute
      ? await readIssueDiscussion(githubClient, webhook.repository.owner.login, webhook.repository.name, webhook.issue.number)
      : undefined;

    const orchestration = await startTrueForgeSessionForIssue(
      run,
      webhook,
      deliveryId,
      scan.safeToExecute,
      trueForgeRuntime,
      issueDiscussion
    );
    run = orchestration.run;

    const record: PersistedWebhookRunRecord = {
      receivedAt: new Date().toISOString(),
      deliveryId,
      repository: webhook.repository.full_name,
      baseBranch: webhook.repository.default_branch,
      issueTitle: webhook.issue.title,
      issueBody: webhook.issue.body ?? "",
      ...(issueDiscussion !== undefined ? { issueDiscussion } : {}),
      dashboardUrl: dashboardUrlFor(run.id),
      contribution,
      run,
      scan,
      trueForge: orchestration.trueForge
    };
    const labeledRecord = await syncLifecycleLabels(record, githubClient);
    const commentRecord = withRunStatuses(await appendGitHubComment(labeledRecord, githubClient, "started"));

    if (postgresStore) {
      await postgresStore.saveWebhookRun(commentRecord).catch((err) => {
        console.error("Postgres saveWebhookRun error:", err);
      });
    }
    if (dataDir) {
      try {
        await mkdir(dataDir, { recursive: true });
        await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(commentRecord)}\n`, "utf8");
      } catch (err) {
        console.warn("Could not append to local webhook-runs.jsonl (ignoring if postgres is active):", err);
      }
    }
    if (orchestration.trueForge.status === "started" && trueForgeRuntime?.subscribeToTurn && (dataDir || postgresStore)) {
      void monitorTrueForgeTurn(dataDir, commentRecord, trueForgeRuntime, githubClient, postgresStore);
    }

    sendJson(response, 202, commentRecord);
  } finally {
    if (!isExplicitRetrigger) {
      activeIssueTriggers.delete(issueTriggerKey);
    }
    await claim.release();
  }
}

interface GitHubApprovalCommand {
  runId?: string;
  patchHash?: string;
}

function parseGitHubApprovalCommand(body: string | null): GitHubApprovalCommand | undefined {
  if (body?.trim().toLowerCase() === "approve") {
    return {};
  }
  const match = body?.trim().match(/^\/squasher\s+approve\s+(\S+)\s+([a-f0-9]{64})$/i);
  return match ? { runId: match[1], patchHash: match[2].toLowerCase() } : undefined;
}

function isMaintainerComment(authorAssociation: string | undefined, permission: string | undefined): boolean {
  const association = authorAssociation?.toUpperCase();
  if (association === "OWNER") return true;
  if (association !== "MEMBER" && association !== "COLLABORATOR") return false;
  return ["admin", "maintain", "write"].includes(permission?.toLowerCase() ?? "");
}

async function handleGitHubIssueCommentWebhook(
  payload: string,
  response: ServerResponse,
  dataDir: string | undefined,
  githubClient: GitHubRestClientLike | undefined,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  activeIssueTriggers: Set<string>,
  postgresStore?: PostgresStore
): Promise<void> {
  let webhook: ReturnType<typeof parseIssueCommentWebhook>;
  try {
    webhook = parseIssueCommentWebhook(payload);
  } catch {
    throw new HttpError(400, "Malformed GitHub issue comment webhook payload");
  }

  if (webhook.action !== "created") {
    sendJson(response, 202, { ignored: true, reason: `Unsupported issue comment action: ${webhook.action}` });
    return;
  }

  if (/(^|\n)\/squasher\s+run(?:\s|$)/i.test(webhook.comment.body ?? "")) {
    const issueWebhook: ReturnType<typeof parseIssueWebhook> = {
      action: "opened",
      issue: {
        ...webhook.issue,
        body: webhook.issue.body ? `${webhook.issue.body}\n\n/squasher run` : "/squasher run"
      },
      repository: webhook.repository
    };
    const commentDeliveryId = `comment-${createHash("sha256").update(`${webhook.repository.full_name}#${webhook.issue.number}:${Date.now()}`).digest("hex").slice(0, 12)}`;
    await processIssueWebhook(issueWebhook, commentDeliveryId, response, dataDir, githubClient, trueForgeRuntime, activeIssueTriggers, true, postgresStore);
    return;
  }

  const command = parseGitHubApprovalCommand(webhook.comment.body);
  if (!command) {
    sendJson(response, 202, { ignored: true, reason: "No Squasher approval command" });
    return;
  }

  const login = webhook.comment.user?.login;
  if (!login) {
    sendJson(response, 403, { error: "GitHub approval commenter could not be identified" });
    return;
  }

  let permission: string | undefined;
  if (webhook.comment.author_association?.toUpperCase() !== "OWNER") {
    if (!githubClient?.getCollaboratorPermission) {
      sendJson(response, 403, { error: "Maintainer permission could not be verified" });
      return;
    }
    try {
      permission = (await githubClient.getCollaboratorPermission(
        webhook.repository.owner.login,
        webhook.repository.name,
        login
      )).permission;
    } catch {
      sendJson(response, 403, { error: "GitHub commenter is not a repository maintainer" });
      return;
    }
  }

  if (!isMaintainerComment(webhook.comment.author_association, permission)) {
    sendJson(response, 403, { error: "GitHub commenter is not a repository maintainer" });
    return;
  }

  if (!dataDir && !postgresStore) {
    sendJson(response, 503, { error: "Storage is required for approval resolution" });
    return;
  }

  const repository = `${webhook.repository.owner.login}/${webhook.repository.name}`;
  const liveRecord = command.runId
    ? await findPersistedRunById(dataDir, command.runId, postgresStore)
    : await findLatestAwaitingRunByIssue(dataDir, repository, webhook.issue.number, postgresStore);
  if (
    !liveRecord ||
    liveRecord.repository !== repository ||
    liveRecord.run.issue.issueNumber !== webhook.issue.number
  ) {
    sendJson(response, 409, { error: "Approval command does not match a persisted GitHub run" });
    return;
  }

  const candidateHash = liveRecord.trueForge.result?.candidatePatch?.hash;
  const patchHash = command.patchHash ?? candidateHash;
  if (!patchHash) {
    sendJson(response, 409, { error: "No approved candidate patch is available for this issue" });
    return;
  }
  const result = await executeApproval(dataDir, liveRecord.run.id, "approve-pr", patchHash, trueForgeRuntime, githubClient, postgresStore);
  sendJson(response, result.statusCode, result.body);
}

async function handleLatestRun(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  postgresStore?: PostgresStore,
  githubClient?: GitHubRestClientLike
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  let latest: any;
  if (postgresStore) {
    try {
      latest = await postgresStore.readLatestRun();
    } catch (err) {
      console.error("Postgres readLatestRun error:", err);
    }
  }
  if (!latest && dataDir) {
    latest = await readLatestJsonlRecord(dataDir, "webhook-runs.jsonl");
  }

  if (!latest) {
    sendJson(response, 404, { error: "No persisted webhook runs found" });
    return;
  }

  const refreshed = await refreshLegacyHarnessTrace(dataDir, latest, trueForgeRuntime);
  const tracked = await refreshPullRequestState(dataDir, hydratePersistedPullRequest(ensureDashboardUrl(refreshed)), githubClient, postgresStore);
  sendJson(response, 200, await withWorkspaceState(dataDir, publicRunPayload(tracked)));
}

interface WorkspaceContext {
  dataDir: string | undefined;
  runId: string;
  action: "ask" | "change-requests" | "test-runs" | "approve-revision";
  revisionNumber?: number;
  askModel: AskModel | undefined;
  trueForgeRuntime: SquasherSessionStarter | undefined;
  githubClient: GitHubRestClientLike | undefined;
  sandbox: SandboxClientLike | undefined;
  postgresStore?: PostgresStore;
}

/**
 * The Contribution Workspace endpoints. All need the maintainer token: a question spends
 * model time, a change request starts an agent session, a test run starts a sandbox, and
 * approving a revision writes to GitHub. All read the run through its public payload or
 * the persisted record, never the browser's copy.
 */
async function handleWorkspaceRequest(request: IncomingMessage, response: ServerResponse, context: WorkspaceContext): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  const approvalToken = process.env.APPROVAL_TOKEN;
  if (!approvalToken) {
    sendJson(response, 503, { error: "APPROVAL_TOKEN is not configured" });
    return;
  }
  if (bearerToken(request) !== approvalToken) {
    sendJson(response, 401, { error: "Maintainer authentication required" });
    return;
  }

  const record = await findPersistedRunById(context.dataDir, context.runId, context.postgresStore);
  if (!record) {
    sendJson(response, 404, { error: "Persisted run not found" });
    return;
  }
  const payload = await readJson(request);

  try {
    if (context.action === "ask") {
      if (!context.askModel) {
        sendJson(response, 503, { error: "Ask Squasher is not configured: no model is available (set DEEPSEEK_API_KEY)" });
        return;
      }
      const publicRun = await withWorkspaceState(context.dataDir, publicRunPayload(hydratePersistedPullRequest(ensureDashboardUrl(record))));
      const answer = await askAboutRun(context.askModel, isRecord(publicRun) ? publicRun : {}, payload.question);
      sendJson(response, 200, { ...answer, answer: safePublicMarkdown(answer.answer) });
      return;
    }

    if (!context.dataDir) {
      sendJson(response, 503, { error: "The contribution workspace needs local storage (DATA_DIR); PostgreSQL is not supported for it yet" });
      return;
    }
    const dataDir = context.dataDir;

    if (context.action === "change-requests") {
      const recorded = await recordChangeRequest(dataDir, {
        runId: context.runId,
        text: payload.text,
        ...(record.trueForge.result?.candidatePatch?.hash ? { patchHash: record.trueForge.result.candidatePatch.hash } : {})
      });
      // Applying is the default; a request can also just be noted.
      let job: WorkspaceJob | undefined;
      let jobError: string | undefined;
      if (payload.apply !== false) {
        try {
          job = await startRevisionJob(context, record, "apply-change", recorded);
        } catch (error) {
          jobError = error instanceof Error ? error.message : String(error);
        }
      }
      sendJson(response, 201, {
        changeRequest: { ...recorded, text: safePublicMarkdown(recorded.text) },
        ...(job ? { job: publicJob(job) } : {}),
        ...(jobError ? { jobError } : {})
      });
      return;
    }

    if (context.action === "test-runs") {
      const job = await startTestRun(context, record);
      sendJson(response, 202, { job: publicJob(job) });
      return;
    }

    const outcome = await approveRevision(context, record, context.revisionNumber ?? -1, payload.hash);
    sendJson(response, 200, outcome);
  } catch (error) {
    if (error instanceof WorkspaceInputError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    if (error instanceof WorkspaceConflict) {
      sendJson(response, 409, { error: error.message });
      return;
    }
    if (error instanceof HttpError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }
    sendJson(response, 502, { error: error instanceof Error ? error.message : "The workspace action failed" });
  }
}

class WorkspaceConflict extends Error {}

/** The patch as it stands now: the latest revision, or the original Squasher patch. */
function currentPatch(record: PersistedWebhookRunRecord, revisions: PatchRevision[]) {
  const latest = revisions.at(-1);
  if (latest) {
    return {
      number: latest.number,
      files: latest.files,
      title: latest.title,
      body: latest.body,
      requirements: latest.requirements ?? record.trueForge.result?.requirements ?? [],
      testCommands: latest.testCommands,
      hash: latest.hash
    };
  }
  const patch = record.trueForge.result?.candidatePatch;
  return {
    number: 0,
    files: patch?.files ?? [],
    title: patch?.title ?? "",
    body: patch?.body ?? "",
    requirements: record.trueForge.result?.requirements ?? [],
    testCommands: record.trueForge.result?.testCommands,
    hash: patch?.hash ?? ""
  };
}

async function assertNoActiveJob(dataDir: string, runId: string): Promise<void> {
  const active = (await readJobs(dataDir, runId)).find((job) => isActive(job));
  if (active) {
    throw new WorkspaceConflict(`Squasher is still working on this run (${active.stage}); wait for it to finish`);
  }
}

/**
 * Starts an agent session that revises the current patch ("apply-change") or re-verifies it
 * unchanged ("verify"). The session has no GitHub write tool. Its result becomes a new
 * revision only if the evidence holds; otherwise the job fails and the patch is unchanged.
 */
async function startRevisionJob(
  context: WorkspaceContext,
  record: PersistedWebhookRunRecord,
  mode: "apply-change" | "verify",
  changeRequest?: ChangeRequest
): Promise<WorkspaceJob> {
  const dataDir = context.dataDir!;
  const runtime = context.trueForgeRuntime;
  if (!runtime?.subscribeToTurn) {
    throw new WorkspaceConflict("Squasher's agent is not configured on this server (DEEPSEEK_API_KEY, E2B_API_KEY, GITHUB_TOKEN), so the change cannot be applied");
  }
  if (runStatusesFor(record).implementation.status !== "verified" || !record.trueForge.result?.candidatePatch) {
    throw new WorkspaceConflict("Only a verified patch can be revised");
  }
  await assertNoActiveJob(dataDir, record.run.id);

  const revisions = await readRevisions(dataDir, record.run.id);
  const current = currentPatch(record, revisions);
  const size = current.files.reduce((sum, file) => sum + file.content.length, 0);
  if (size > maxRevisablePatchChars) {
    throw new WorkspaceConflict(`This patch is too large to revise in the workspace (${size} characters; the limit is ${maxRevisablePatchChars})`);
  }

  let job = await saveJob(
    dataDir,
    newJob({
      runId: record.run.id,
      kind: mode,
      revision: current.number,
      stage: mode === "apply-change" ? "Starting the change" : "Preparing verification",
      ...(changeRequest ? { changeRequestId: changeRequest.id } : {})
    })
  );

  try {
    const started = await runtime.startSession({
      repository: record.repository,
      issueUrl: record.run.issue.url,
      issueTitle: record.issueTitle,
      issueBody: record.issueBody,
      ...(record.issueDiscussion !== undefined ? { issueDiscussion: record.issueDiscussion } : {}),
      baseBranch: record.baseBranch,
      branchName: branchNameForIssue(record.run.issue.issueNumber, record.deliveryId),
      revision: {
        mode,
        files: current.files,
        ...(changeRequest ? { changeRequest: changeRequest.text } : {}),
        requirements: current.requirements.map((entry) => ({ requirement: entry.requirement, verdict: entry.verdict })),
        previousChanges: revisions.flatMap((revision) => (revision.changeRequestText ? [revision.changeRequestText] : []))
      }
    });
    job = await saveJob(dataDir, {
      ...job,
      sessionId: started.session.id,
      turnId: started.turn.id,
      stage: mode === "apply-change" ? "Applying the change and re-running tests" : "Re-running the checks"
    });
  } catch (error) {
    await saveJob(dataDir, { ...job, status: "failed", stage: "Could not start", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  void completeRevisionJob(context, record, job, current, changeRequest).catch(async (error) => {
    await saveJob(dataDir, { ...job, status: "failed", stage: "Failed", error: error instanceof Error ? error.message : String(error) });
  });
  return job;
}

async function completeRevisionJob(
  context: WorkspaceContext,
  record: PersistedWebhookRunRecord,
  job: WorkspaceJob,
  current: ReturnType<typeof currentPatch>,
  changeRequest: ChangeRequest | undefined
): Promise<void> {
  const dataDir = context.dataDir!;
  const runtime = context.trueForgeRuntime!;
  const fail = (error: string) => saveJob(dataDir, { ...job, status: "failed", stage: "Failed", error });

  let events = await reconcileSessionEvents({ trueForgeRuntime: runtime, sessionId: job.sessionId!, turnId: job.turnId!, isSettled: isTrueForgeTurnSettled });
  let result = extractLiveProofResult(events, record);
  // A transient model failure or token cutoff gets the same continuation as a normal run.
  for (let attempt = 1; !result && attempt <= 2 && runtime.requestProofContract; attempt += 1) {
    const turnError = trueForgeTurnError(events);
    if (turnError && !isRecoverableTrueForgeTurnError(turnError)) break;
    const recovery = await runtime.requestProofContract(job.sessionId!);
    const more = await reconcileSessionEvents({ trueForgeRuntime: runtime, sessionId: job.sessionId!, turnId: recovery.id, isSettled: isTrueForgeTurnSettled, ignoreEvents: events });
    events = [...events, ...more];
    result = extractLiveProofResult(events, record);
  }

  if (!result) {
    const turnError = trueForgeTurnError(events);
    await fail(turnError ? `The agent stopped before submitting a result: ${turnError}` : "The agent did not submit a valid result");
    return;
  }
  if (!result.candidatePatch || !provenResultStatuses.has(result.status)) {
    await fail(`Squasher did not produce a revised patch (${result.status}): ${summarizeCommentText(result.summary)}`);
    return;
  }
  const trace = events.flatMap((event, index) => projectTrueForgeEvent(event, index));
  const problem = requirementsProblem(result);
  if (!hasGenuineProof(result) || !hasExecutableProof(trace) || problem) {
    await fail(`The revised patch did not pass verification: ${problem ?? "its executed evidence did not hold"}`);
    return;
  }
  const files: RevisionFile[] = result.candidatePatch.files.map((file) => ({ path: file.path, content: file.content }));
  if (job.kind === "verify" && patchHashOf(files) !== patchHashOf(current.files)) {
    await fail("Re-verification changed the patch, which it must not; the patch is unchanged");
    return;
  }

  const revisions = await readRevisions(dataDir, record.run.id);
  const revision = await saveRevision(dataDir, {
    runId: record.run.id,
    number: (revisions.at(-1)?.number ?? 0) + 1,
    source: job.kind === "verify" ? "verification" : "requested-change",
    basedOn: current.number,
    ...(changeRequest ? { changeRequestId: changeRequest.id, changeRequestText: changeRequest.text } : {}),
    title: result.candidatePatch.title,
    body: result.candidatePatch.body,
    summary: result.summary,
    files,
    ...(result.requirements ? { requirements: result.requirements } : {}),
    ...(result.fileChanges ? { fileChanges: result.fileChanges } : {}),
    ...(result.testCommands ? { testCommands: result.testCommands } : {}),
    ...(result.proof ? { proof: result.proof } : {})
  });
  await saveJob(dataDir, {
    ...job,
    status: "succeeded",
    stage: job.kind === "verify" ? "Verification complete" : `Revision ${revision.number} ready for review`,
    producedRevision: revision.number
  });
}

function patchHashOf(files: RevisionFile[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, file.content])))
    .digest("hex");
}

/**
 * Re-runs the current patch's recorded test commands in a fresh sandbox. A patch with no
 * recorded commands -- every run from before they were recorded -- is re-verified by an
 * agent session instead, which records them for next time.
 */
async function startTestRun(context: WorkspaceContext, record: PersistedWebhookRunRecord): Promise<WorkspaceJob> {
  const dataDir = context.dataDir!;
  if (!record.trueForge.result?.candidatePatch) throw new WorkspaceConflict("This run has no patch to test");
  const revisions = await readRevisions(dataDir, record.run.id);
  const current = currentPatch(record, revisions);
  if (!current.testCommands?.length) {
    return startRevisionJob(context, record, "verify");
  }
  if (!context.sandbox) {
    throw new WorkspaceConflict("No sandbox is configured on this server (E2B_API_KEY), so tests cannot be re-run");
  }
  await assertNoActiveJob(dataDir, record.run.id);

  let job = await saveJob(dataDir, newJob({ runId: record.run.id, kind: "test-run", revision: current.number, stage: "Preparing environment" }));
  const sandbox = context.sandbox;
  void (async () => {
    try {
      const outcome = await runRecordedTests(sandbox, {
        owner: record.run.issue.owner,
        repo: record.run.issue.repo,
        baseBranch: record.baseBranch,
        files: current.files,
        commands: current.testCommands!,
        onStage: async (stage) => {
          job = await saveJob(dataDir, { ...job, stage });
        }
      });
      await saveJob(dataDir, {
        ...job,
        status: "succeeded",
        stage: outcome.passed ? "Tests passed" : "Tests failed",
        testRun: { ...outcome, source: "recorded-commands" }
      });
    } catch (error) {
      await saveJob(dataDir, { ...job, status: "failed", stage: "Test run failed", error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return job;
}

/**
 * Submits an approved revision. Same gates as the original approval -- a writable
 * contribution, a policy that allows it, an unchanged upstream -- plus: it must be the
 * latest revision, the exact one the reviewer saw (by hash), with no work in progress and
 * no failed test run against it. With no pull request yet, one is opened through the same
 * pull request tool as the original write; with one open, its branch is updated.
 */
async function approveRevision(
  context: WorkspaceContext,
  record: PersistedWebhookRunRecord,
  number: number,
  hash: unknown
): Promise<Record<string, unknown>> {
  const dataDir = context.dataDir!;
  const github = context.githubClient;
  if (!github) throw new WorkspaceConflict("No GitHub client is configured, so nothing can be submitted");

  const revisions = await readRevisions(dataDir, record.run.id);
  const revision = revisions.find((entry) => entry.number === number);
  if (!revision) throw new HttpError(404, `Revision ${number} does not exist`);
  if (revision !== revisions.at(-1)) throw new WorkspaceConflict(`Revision ${revisions.at(-1)!.number} is newer; review and approve that one`);
  if (typeof hash !== "string" || hash !== revision.hash) {
    throw new WorkspaceConflict("This approval was for a different version of the patch; reload and review the current one");
  }
  const jobs = await readJobs(dataDir, record.run.id);
  if (jobs.some((job) => isActive(job))) throw new WorkspaceConflict("Squasher is still working on this run; wait for it to finish");
  const lastTest = [...jobs].reverse().find((job) => job.kind === "test-run" && job.revision === revision.number && job.testRun);
  if (lastTest && !lastTest.testRun!.passed) {
    throw new WorkspaceConflict(`The latest test run of revision ${revision.number} failed; fix it or re-run the tests before approving`);
  }

  const policy = summarizePolicy(record.contribution);
  if (!policy.automaticContributionAllowed) throw new WorkspaceConflict(`Repository policy: ${policy.label}. Squasher will not submit this.`);
  if (!isContributionWritable(record.contribution)) {
    throw new WorkspaceConflict(`This run may not write to GitHub: ${record.contribution?.reason ?? "no contribution decision was recorded"}`);
  }
  const drift = await upstreamDriftBlocker(record, github);
  if (drift) throw new WorkspaceConflict(drift);

  const contribution = record.contribution!;
  const { owner, repo } = record.run.issue;
  const original = record.trueForge.result!.candidatePatch!;
  const existing = record.trueForge.result?.pullRequest;

  if (existing) {
    const previous = record.submittedRevision ? revisions.find((entry) => entry.number === record.submittedRevision)?.files : original.files;
    const bases = new Map((record.trueForge.result?.patchDiff ?? []).map((diff) => [diff.path, diff]));
    const currentPaths = (previous ?? original.files).map((file) => file.path);
    const unknown = currentPaths.filter((path) => !revision.files.some((file) => file.path === path) && !bases.has(path));
    if (unknown.length) {
      throw new WorkspaceConflict(`The revision drops ${unknown.join(", ")}, whose original content is unknown, so the pull request cannot be safely updated`);
    }
    const pushed = await pushRevisionToBranch(github, {
      headOwner: contribution.headOwner,
      repo,
      branch: original.branchName,
      revision,
      currentPaths,
      baseContent: (path) => {
        const base = bases.get(path);
        return base && base.change !== "added" ? base.before : undefined;
      }
    });
    await appendUpdatedLiveRecord(dataDir, { ...record, submittedRevision: revision.number }, context.postgresStore);
    return { pullRequest: existing, updated: true, commitSha: pushed.commitSha, revision: revision.number };
  }

  const crossRepository = contribution.headOwner !== owner;
  const disclose = crossRepository || (contribution.policySignals ?? []).some((signal) => signal.kind === "ai-disclosure-required");
  const args: Record<string, unknown> = {
    owner,
    repo,
    baseBranch: original.baseBranch,
    branchName: original.branchName,
    title: revision.title,
    body: disclose ? withContributionDisclosure(revision.body) : revision.body,
    files: revision.files,
    ...(crossRepository ? { headOwner: contribution.headOwner } : {})
  };
  const tools = createGitHubMcpTools({ client: github });
  const written = await tools.callTool({
    name: "create_fix_pull_request",
    arguments: args,
    approval: { approved: true, expectedPayloadHash: approvalPayloadHash("create_fix_pull_request", args) }
  });
  const parsed = JSON.parse(written.content.map((part) => part.text).join("")) as { number: number; url: string };
  const pullRequest = { number: parsed.number, url: parsed.url };

  let run = record.run;
  for (const [status, message] of [
    ["awaiting-approval", `Revision ${revision.number} approved in the contribution workspace`],
    ["approved", "Maintainer approved the revised patch"],
    ["pr-created", "Draft GitHub pull request created from the approved revision"]
  ] as const) {
    if (canTransition(run.status, status)) run = transitionRun(run, status, message);
  }
  await appendUpdatedLiveRecord(
    dataDir,
    {
      ...record,
      run,
      submittedRevision: revision.number,
      trueForge: {
        ...record.trueForge,
        status: "completed",
        pendingApproval: undefined,
        result: { ...record.trueForge.result!, pullRequest }
      }
    },
    context.postgresStore
  );
  return { pullRequest, updated: false, revision: revision.number };
}

/** A job as the page may see it: no session or turn identifiers. */
function publicJob(job: WorkspaceJob) {
  const { sessionId: _sessionId, turnId: _turnId, ...rest } = job;
  const stale = job.status === "running" && !isActive(job);
  return {
    ...rest,
    ...(stale ? { status: "failed" as const, stage: "Stopped", error: "This job stopped making progress, probably because the server restarted" } : {}),
    ...(rest.error ? { error: safePublicMarkdown(rest.error) } : {}),
    ...(rest.testRun
      ? {
          testRun: {
            ...rest.testRun,
            commands: rest.testRun.commands.map((command) => ({
              ...command,
              command: safePublicMarkdown(command.command),
              stdout: safePublicMarkdown(command.stdout),
              stderr: safePublicMarkdown(command.stderr)
            }))
          }
        }
      : {})
  };
}

/**
 * Adds the workspace's state to a public payload: change requests with where each stands,
 * patch revisions, and jobs.
 */
async function withWorkspaceState(dataDir: string | undefined, payload: unknown): Promise<unknown> {
  if (!isRecord(payload) || !isRecord(payload.run) || typeof payload.run.id !== "string") return payload;
  const runId = payload.run.id;
  const [changeRequests, revisions, jobs] = await Promise.all([readChangeRequests(dataDir, runId), readRevisions(dataDir, runId), readJobs(dataDir, runId)]);
  const publicJobs = jobs.map(publicJob);
  return {
    ...payload,
    changeRequests: changeRequests.map((entry) => {
      const job = [...publicJobs].reverse().find((candidate) => candidate.changeRequestId === entry.id);
      const status = !job ? "recorded" : job.status === "running" ? "in-progress" : job.status === "succeeded" ? "implemented" : "failed";
      return {
        ...entry,
        text: safePublicMarkdown(entry.text),
        status,
        ...(job?.producedRevision ? { revision: job.producedRevision } : {}),
        ...(status === "failed" && job?.error ? { error: job.error } : {})
      };
    }),
    revisions: revisions.map((revision) => ({
      number: revision.number,
      source: revision.source,
      basedOn: revision.basedOn,
      createdAt: revision.createdAt,
      hash: revision.hash,
      title: safePublicMarkdown(revision.title),
      summary: safePublicMarkdown(revision.summary),
      ...(revision.changeRequestText ? { changeRequestText: safePublicMarkdown(revision.changeRequestText) } : {}),
      files: revision.files,
      ...(revision.requirements ? { requirements: revision.requirements } : {}),
      ...(revision.fileChanges ? { fileChanges: revision.fileChanges } : {}),
      ...(revision.testCommands ? { testCommands: revision.testCommands } : {}),
      ...(revision.proof ? { proof: revision.proof } : {})
    })),
    workspaceJobs: publicJobs
  };
}

function askModelFromEnv(): AskModel | undefined {
  if (!process.env.DEEPSEEK_API_KEY) return undefined;
  try {
    const client = LlmClient.fromEnv();
    return { complete: (messages) => client.complete(messages, []) };
  } catch {
    return undefined;
  }
}

async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  runId: string,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  postgresStore?: PostgresStore,
  githubClient?: GitHubRestClientLike
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const record = await findPersistedRunById(dataDir, runId, postgresStore);
  if (!record) {
    sendJson(response, 404, { error: "Persisted run not found" });
    return;
  }

  const refreshed = await refreshLegacyHarnessTrace(dataDir, record, trueForgeRuntime);
  const tracked = await refreshPullRequestState(dataDir, hydratePersistedPullRequest(ensureDashboardUrl(refreshed)), githubClient, postgresStore);
  sendJson(response, 200, await withWorkspaceState(dataDir, publicRunPayload(tracked)));
}

/** How long a pull request's observed state is trusted before it is read again. */
const pullRequestStateTtlMs = process.env.NODE_ENV === "test" ? 0 : 5 * 60_000;

/**
 * Follows a submitted pull request after it is opened. Creating it is not merging it, so
 * the contribution status reads GitHub's state rather than assuming: open, reviewed with
 * changes requested or approved, merged, or closed. Read at most every few minutes, only
 * while the pull request can still change, and a read failure leaves the last known state.
 */
async function refreshPullRequestState(
  dataDir: string | undefined,
  value: unknown,
  githubClient: GitHubRestClientLike | undefined,
  postgresStore?: PostgresStore
): Promise<unknown> {
  if (!githubClient?.getPullRequest || !isRecord(value) || !hasRecordShape(value)) return value;
  const record = value as PersistedWebhookRunRecord;
  const pullRequest = record.trueForge.result?.pullRequest;
  if (!pullRequest) return value;

  const previous = record.pullRequestState;
  if (previous && (previous.state !== "open" || Date.now() - Date.parse(previous.checkedAt) < pullRequestStateTtlMs)) {
    return value;
  }

  const { owner, repo } = record.run.issue;
  let state: PullRequestState;
  try {
    const detail = await githubClient.getPullRequest(owner, repo, pullRequest.number);
    const merged = detail.merged === true || Boolean(detail.merged_at);
    state = {
      state: merged ? "merged" : detail.state === "closed" ? "closed" : "open",
      checkedAt: new Date().toISOString()
    };
    if (state.state === "open" && githubClient.listPullRequestReviews) {
      const decisive = (await githubClient.listPullRequestReviews(owner, repo, pullRequest.number)).filter(
        (review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED"
      );
      const latest = decisive.at(-1);
      if (latest) state.reviewDecision = latest.state === "APPROVED" ? "approved" : "changes_requested";
    }
  } catch {
    return value;
  }

  // Saved even when nothing changed: the check time is what keeps the dashboard's
  // five-second poll from reading GitHub on every request once the window has passed.
  const updated: PersistedWebhookRunRecord = { ...record, pullRequestState: state };
  await appendUpdatedLiveRecord(dataDir, updated, postgresStore);
  return updated;
}

function publicRunPayload(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.trueForge)) return value;

  const publicRun = isRecord(value.run) && Array.isArray(value.run.events)
    ? {
        ...value.run,
        events: value.run.events.map((event) => {
          if (!isRecord(event)) return event;
          const { evidence: _evidence, ...publicEvent } = event;
          return {
            ...publicEvent,
            ...(typeof publicEvent.message === "string" ? { message: safePublicMarkdown(publicEvent.message) } : {})
          };
        })
      }
    : value.run;
  const { session: _session, turn: _turn, pendingApproval: _pendingApproval, ...trueForge } = value.trueForge;
  const result = isRecord(trueForge.result)
    ? {
        ...trueForge.result,
        ...(typeof trueForge.result.kind === "string" ? { kind: "squasher.result" } : {}),
        ...(typeof trueForge.result.summary === "string" ? { summary: safePublicMarkdown(trueForge.result.summary) } : {}),
        ...(typeof trueForge.result.rootCauseSummary === "string" ? { rootCauseSummary: safePublicMarkdown(trueForge.result.rootCauseSummary) } : {}),
        ...(typeof trueForge.result.proposedFixSummary === "string" ? { proposedFixSummary: safePublicMarkdown(trueForge.result.proposedFixSummary) } : {}),
        ...(typeof trueForge.result.nextStep === "string" ? { nextStep: safePublicMarkdown(trueForge.result.nextStep) } : {}),
        ...(Array.isArray(trueForge.result.findings)
          ? { findings: trueForge.result.findings.filter((finding): finding is string => typeof finding === "string").map(safePublicMarkdown) }
          : {}),
        ...(Array.isArray(trueForge.result.requirements)
          ? {
              requirements: trueForge.result.requirements.flatMap((entry) =>
                isRecord(entry) && typeof entry.requirement === "string" && typeof entry.verdict === "string"
                  ? [
                      {
                        requirement: safePublicMarkdown(entry.requirement),
                        verdict: entry.verdict,
                        ...(typeof entry.evidence === "string" ? { evidence: safePublicMarkdown(entry.evidence) } : {}),
                        ...publicEvidence(entry),
                        ...(isRecord(entry.ownership) && typeof entry.ownership.status === "string" && typeof entry.ownership.by === "string"
                          ? { ownership: { status: entry.ownership.status, by: safePublicMarkdown(entry.ownership.by) } }
                          : {})
                      }
                    ]
                  : []
              )
            }
          : {}),
        ...(Array.isArray(trueForge.result.fileChanges)
          ? {
              fileChanges: trueForge.result.fileChanges.flatMap((entry) =>
                isRecord(entry) && typeof entry.path === "string" && typeof entry.summary === "string"
                  ? [
                      {
                        path: safePublicMarkdown(entry.path),
                        summary: safePublicMarkdown(entry.summary),
                        ...(Array.isArray(entry.requirements)
                          ? { requirements: entry.requirements.filter((text): text is string => typeof text === "string").map(safePublicMarkdown) }
                          : {})
                      }
                    ]
                  : []
              )
            }
          : {}),
        ...(Array.isArray(trueForge.result.discussionClaims)
          ? {
              discussionClaims: trueForge.result.discussionClaims.flatMap((entry) =>
                isRecord(entry) && typeof entry.claim === "string" && typeof entry.verdict === "string" && typeof entry.evidence === "string"
                  ? [
                      {
                        claim: safePublicMarkdown(entry.claim),
                        verdict: entry.verdict,
                        evidence: safePublicMarkdown(entry.evidence),
                        ...publicEvidence(entry)
                      }
                    ]
                  : []
              )
            }
          : {}),
        ...(isRecord(trueForge.result.proof)
          ? {
              proof: Object.fromEntries(
                Object.entries(trueForge.result.proof).map(([key, field]) => [key, typeof field === "string" ? safePublicMarkdown(field) : field])
              )
            }
          : {}),
        ...(isRecord(trueForge.result.candidatePatch) && typeof trueForge.result.candidatePatch.body === "string"
          ? {
              candidatePatch: {
                ...trueForge.result.candidatePatch,
                body: safePublicMarkdown(trueForge.result.candidatePatch.body),
                ...(typeof trueForge.result.candidatePatch.branchName === "string"
                  ? { branchName: normalizePublicBranchName(trueForge.result.candidatePatch.branchName) }
                  : {})
              }
            }
          : {})
      }
    : trueForge.result;
  const events = Array.isArray(trueForge.events)
    ? trueForge.events.map((event, index) => {
        if (!isRecord(event)) return event;
        const { sandboxId: _sandboxId, sequenceNumber: _sequenceNumber, mcpServer: _mcpServer, ...publicEvent } = event;
        return {
          ...Object.fromEntries(
          Object.entries(publicEvent).map(([key, field]) => [
            key,
            typeof field === "string" && ["summary", "target", "command", "stdout", "stderr", "artifact", "subagent"].includes(key)
              ? safePublicMarkdown(field)
              : field
          ])
          ),
          id: `event-${index + 1}`,
          source: publicEvent.source === "trueforge" ? "trueforge" : "squasher",
          ...(publicEvent.category === "session" ? { category: "agent" } : {}),
          ...(typeof publicEvent.type === "string"
            ? { type: publicEvent.type.replace(/session/gi, "run").replace(/turn/gi, "step") }
            : {})
        };
      })
    : trueForge.events;

  const normalizeLabel = (label: unknown, fallbackName: string) => isRecord(label)
    ? { ...label, name: fallbackName }
    : label;
  const lifecycleLabels = Array.isArray(value.lifecycleLabels)
    ? value.lifecycleLabels.map((label) => isRecord(label) && typeof label.name === "string"
      ? { ...label, name: `squasher:${label.name.split(":").at(-1)}` }
      : label)
    : value.lifecycleLabels;

  // Derived from the private record, which still holds the approval checkpoint; the result
  // carries no private data, and every text in it is ours or already public.
  const statuses = hasRecordShape(value) ? runStatusesFor(value) : undefined;
  const publicStatuses = statuses
    ? {
        implementation: {
          ...statuses.implementation,
          reason: safePublicMarkdown(statuses.implementation.reason),
          label: implementationStatusLabels[statuses.implementation.status]
        },
        contribution: {
          ...statuses.contribution,
          reason: safePublicMarkdown(statuses.contribution.reason),
          ...(statuses.contribution.action ? { action: safePublicMarkdown(statuses.contribution.action) } : {}),
          label: contributionStatusLabels[statuses.contribution.status]
        }
      }
    : undefined;

  return {
    ...value,
    ...(typeof value.issueTitle === "string" ? { issueTitle: safePublicMarkdown(value.issueTitle) } : {}),
    ...(typeof value.issueBody === "string" ? { issueBody: safePublicMarkdown(value.issueBody) } : {}),
    ...(typeof value.issueDiscussion === "string" ? { issueDiscussion: safePublicMarkdown(value.issueDiscussion) } : {}),
    policy: summarizePolicy(isRecord(value.contribution) ? (value.contribution as unknown as ContributionTarget) : undefined),
    run: publicRun,
    trueForge: { ...trueForge, result, events },
    ...(publicStatuses
      ? {
          statuses: publicStatuses,
          implementationStatus: publicStatuses.implementation.status,
          contributionStatus: publicStatuses.contribution.status,
          contributionReason: publicStatuses.contribution.reason
        }
      : {}),
    outcome: buildRunOutcome({
      ...runOutcomeInput(value, publicRun, result, events, Boolean(value.trueForge.pendingApproval)),
      ...(publicStatuses ? { statuses: publicStatuses } : {})
    }),
    verifiedLabel: normalizeLabel(value.verifiedLabel, "squasher:verified"),
    approvalLabel: normalizeLabel(value.approvalLabel, "squasher:awaiting-approval"),
    lifecycleLabels
  };
}

/**
 * Collects what the run outcome is derived from. Text is taken from the already-sanitized
 * public copies; only the pending-approval flag and the root-cause provenance come from the
 * private record, and neither carries text of its own.
 */
function runOutcomeInput(
  value: Record<string, unknown>,
  publicRun: unknown,
  publicResult: unknown,
  publicEvents: unknown,
  pendingApproval: boolean
): RunOutcomeInput {
  const run = isRecord(publicRun) ? publicRun : {};
  const issue = isRecord(run.issue) ? run.issue : {};
  const harness = isRecord(value.trueForge) ? value.trueForge : {};
  const scan = isRecord(value.scan) ? value.scan : {};
  const contribution = isRecord(value.contribution) ? value.contribution : undefined;
  const privateResult = isRecord(harness.result) ? harness.result : undefined;
  const result = isRecord(publicResult) ? publicResult : undefined;
  const proof = result && isRecord(result.proof) ? result.proof : undefined;
  const patch = result && isRecord(result.candidatePatch) ? result.candidatePatch : undefined;
  const text = (field: unknown) => (typeof field === "string" && field.trim() ? field : undefined);

  return {
    runStatus: typeof run.status === "string" ? run.status : "received",
    runEvents: Array.isArray(run.events)
      ? run.events.flatMap((event) =>
          isRecord(event) && typeof event.status === "string" && typeof event.message === "string"
            ? [{ status: event.status, message: event.message }]
            : []
        )
      : [],
    harness: {
      status: typeof harness.status === "string" ? harness.status : "unknown",
      ...(text(harness.error) ? { error: safePublicMarkdown(harness.error as string) } : {}),
      ...(text(harness.reason) ? { reason: safePublicMarkdown(harness.reason as string) } : {})
    },
    pendingApproval,
    scan: {
      safeToExecute: scan.safeToExecute !== false,
      findingCount: Array.isArray(scan.findings) ? scan.findings.length : 0
    },
    repository: {
      owner: typeof issue.owner === "string" ? issue.owner : "",
      repo: typeof issue.repo === "string" ? issue.repo : "",
      issueNumber: typeof issue.issueNumber === "number" ? issue.issueNumber : 0
    },
    ...(contribution && typeof contribution.mode === "string"
      ? {
          contribution: {
            mode: contribution.mode,
            ...(typeof contribution.writable === "boolean" ? { writable: contribution.writable } : {}),
            ...(typeof contribution.headOwner === "string" ? { headOwner: contribution.headOwner } : {}),
            ...(text(contribution.reason) ? { reason: safePublicMarkdown(contribution.reason as string) } : {}),
            ...(Array.isArray(contribution.policyFindings)
              ? {
                  policyFindings: contribution.policyFindings.flatMap((finding) =>
                    isRecord(finding) && typeof finding.path === "string" && typeof finding.excerpt === "string"
                      ? [{ path: finding.path, excerpt: safePublicMarkdown(finding.excerpt) }]
                      : []
                  )
                }
              : {})
          }
        }
      : {}),
    ...(result && typeof result.status === "string"
      ? {
          result: {
            status: result.status,
            summary: typeof result.summary === "string" ? result.summary : "",
            ...(privateResult && rootCauseWasReported(privateResult) && text(result.rootCauseSummary)
              ? { rootCause: result.rootCauseSummary as string }
              : {}),
            ...(text(result.nextStep) ? { nextStep: result.nextStep as string } : {}),
            ...(Array.isArray(result.requirements)
              ? {
                  requirements: result.requirements.flatMap((entry) =>
                    isRecord(entry) && typeof entry.requirement === "string" && typeof entry.verdict === "string"
                      ? [
                          {
                            requirement: entry.requirement,
                            verdict: entry.verdict,
                            ...(typeof entry.evidence === "string" ? { evidence: entry.evidence } : {}),
                            ...(isRecord(entry.ownership) && typeof entry.ownership.status === "string" && typeof entry.ownership.by === "string"
                              ? { ownership: { status: entry.ownership.status, by: entry.ownership.by } }
                              : {})
                          }
                        ]
                      : []
                  )
                }
              : {}),
            ...(Array.isArray(result.discussionClaims)
              ? {
                  discussionClaims: result.discussionClaims.flatMap((entry) =>
                    isRecord(entry) && typeof entry.claim === "string" && typeof entry.verdict === "string" && typeof entry.evidence === "string"
                      ? [{ claim: entry.claim, verdict: entry.verdict, evidence: entry.evidence }]
                      : []
                  )
                }
              : {}),
            ...(Array.isArray(result.findings) ? { findings: result.findings.filter((finding): finding is string => typeof finding === "string") } : {}),
            ...(proof
              ? {
                  proof: Object.fromEntries(
                    (["before", "after", "regressions", "attempts"] as const).flatMap((key) => (typeof proof[key] === "string" ? [[key, proof[key]]] : []))
                  )
                }
              : {}),
            ...(patch
              ? {
                  candidatePatch: {
                    ...(typeof patch.title === "string" ? { title: patch.title } : {}),
                    ...(typeof patch.branchName === "string" ? { branchName: patch.branchName } : {}),
                    files: Array.isArray(patch.files)
                      ? patch.files.flatMap((file) => (typeof file === "string" ? [file] : isRecord(file) && typeof file.path === "string" ? [file.path] : []))
                      : []
                  }
                }
              : {}),
            ...(isRecord(result.pullRequest) && typeof result.pullRequest.number === "number" && typeof result.pullRequest.url === "string"
              ? { pullRequest: { number: result.pullRequest.number, url: result.pullRequest.url } }
              : {})
          }
        }
      : {}),
    trace: Array.isArray(publicEvents) ? publicEvents.filter(isRecord) : [],
    traceCapacity: maxHarnessEvents
  };
}

/**
 * Whether rootCauseSummary is the agent's own statement. Records extracted before the flag
 * existed are judged by content: extraction filled a missing value with sentences lifted
 * from the summary, so a value that reproduces that fallback, or appears verbatim in the
 * summary, is treated as not reported. That can undercount a root cause the agent stated
 * in its summary, which is the safe direction: the page then says none was established.
 */
function rootCauseWasReported(result: Record<string, unknown>): boolean {
  if (typeof result.rootCauseReported === "boolean") return result.rootCauseReported;
  if (typeof result.rootCauseSummary !== "string" || typeof result.summary !== "string") return false;
  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
  const rootCause = collapse(result.rootCauseSummary);
  if (!rootCause) return false;
  if (rootCause === collapse(clampText(summarizeCommentText(result.summary), 520))) return false;
  return !collapse(result.summary).includes(rootCause);
}

function publicEvidence(entry: Record<string, unknown>) {
  const codeEvidence = Array.isArray(entry.codeEvidence)
    ? entry.codeEvidence.flatMap((cited) =>
        isRecord(cited) && typeof cited.path === "string" && typeof cited.excerpt === "string"
          ? [{ path: safePublicMarkdown(cited.path), excerpt: safePublicMarkdown(cited.excerpt) }]
          : []
      )
    : [];
  return {
    ...(codeEvidence.length ? { codeEvidence } : {}),
    ...(typeof entry.executedCommand === "string" ? { executedCommand: safePublicMarkdown(entry.executedCommand) } : {})
  };
}

function hasRecordShape(value: Record<string, unknown>): value is Record<string, unknown> & PersistedWebhookRunRecord {
  return (
    isRecord(value.run) &&
    Array.isArray(value.run.events) &&
    isRecord(value.scan) &&
    isRecord(value.trueForge) &&
    typeof value.trueForge.status === "string"
  );
}

function safePublicMarkdown(value: string): string {
  return normalizePublicBrandText(value)
    .replace(/(?:\/tmp|\/workspace|\/home\/[^/\s]+)\/[^\s),;]+/g, "[sandbox path]")
    .replace(/\b[A-Za-z]:\\[^\s),;]+/g, "[local path]")
    .replace(/<[^>\n]*>/g, "")
    .split(/\r?\n/)
    .map((line) => redactHarnessText(line).trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePublicBrandText(value: string): string {
  const legacyBrand = new RegExp(["repro", "smith"].join(""), "gi");
  return value.replace(legacyBrand, "Squasher");
}

function normalizePublicBranchName(value: string): string {
  const fixPrefix = value.indexOf("/fix-");
  return fixPrefix >= 0 ? `squasher${value.slice(fixPrefix)}` : value;
}

function ensureDashboardUrl(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.run) || typeof value.run.id !== "string") {
    return value;
  }
  if (typeof value.dashboardUrl === "string" && value.dashboardUrl.length > 0) {
    return value;
  }
  return { ...value, dashboardUrl: dashboardUrlFor(value.run.id) };
}

function decodeRunId(pathname: string): string {
  const value = pathname.slice("/api/runs/".length);
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Invalid run id");
  }
}

async function refreshLegacyHarnessTrace(
  dataDir: string | undefined,
  value: unknown,
  trueForgeRuntime: SquasherSessionStarter | undefined
): Promise<unknown> {
  if (!dataDir || !trueForgeRuntime?.listSessionEvents || !isRecord(value) || !isRecord(value.trueForge)) {
    return value;
  }

  const session = isRecord(value.trueForge.session) && typeof value.trueForge.session.id === "string"
    ? value.trueForge.session.id
    : undefined;
  const currentEvents = Array.isArray(value.trueForge.events) ? value.trueForge.events : [];
  const hasRichTrace = currentEvents.some((event) => isRecord(event) && typeof event.category === "string");
  const needsMetadata = typeof value.trueForge.model !== "string" || typeof value.trueForge.provider !== "string";
  if (!session || (!needsMetadata && hasRichTrace)) {
    return value;
  }

  try {
    const events = hasRichTrace ? [] : await trueForgeRuntime.listSessionEvents(session);
    const projected = hasRichTrace ? [] : events.flatMap((event, index) => projectTrueForgeEvent(event, index));
    if (!hasRichTrace && projected.length === 0 && !needsMetadata) return value;
    const updated = {
      ...value,
      trueForge: {
        ...value.trueForge,
        ...(typeof value.trueForge.model === "string"
          ? {}
          : { model: process.env.MODEL_NAME ?? "TrueForge configured model" }),
        ...(typeof value.trueForge.provider === "string"
          ? {}
          : { provider: process.env.MODEL_PROVIDER ?? "agentrouter" }),
        ...(hasRichTrace ? {} : { events: mergeHarnessEvents([], projected) })
      }
    } as PersistedWebhookRunRecord;
    await appendUpdatedLiveRecord(dataDir, updated);
    return updated;
  } catch (error) {
    console.error("Legacy TrueForge trace refresh failed", error);
    return value;
  }
}

function hydratePersistedPullRequest(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.run) || value.run.status !== "pr-created" || !isRecord(value.trueForge)) {
    return value;
  }

  const result = isRecord(value.trueForge.result) ? value.trueForge.result : {};
  if (isPullRequest(result.pullRequest)) {
    return value;
  }

  const events = Array.isArray(value.run.events) ? value.run.events : [];
  const eventEvidence = [...events]
    .reverse()
    .map((event) => (isRecord(event) && isRecord(event.evidence) ? event.evidence : undefined))
    .find((evidence) => isPullRequestEvidence(evidence));
  const fromEvent = eventEvidence && isPullRequestEvidence(eventEvidence)
    ? { number: eventEvidence.pullRequestNumber, url: eventEvidence.pullRequestUrl }
    : undefined;
  const summary = typeof result.summary === "string" ? result.summary : "";
  const fromSummary = summary.match(/Draft PR created:\s+(https:\/\/github\.com\/[^\s]+)/)?.[1];
  const pullRequest = fromEvent ?? (fromSummary ? { number: Number(fromSummary.match(/\/pull\/(\d+)(?:\?|$)/)?.[1]), url: fromSummary } : undefined);

  if (!isPullRequest(pullRequest)) {
    return value;
  }

  return {
    ...value,
    trueForge: {
      ...value.trueForge,
      result: { ...result, pullRequest }
    }
  };
}

function isPullRequestEvidence(value: Record<string, unknown> | undefined): value is Record<string, unknown> & {
  pullRequestNumber: number;
  pullRequestUrl: string;
} {
  return value !== undefined && typeof value.pullRequestNumber === "number" && typeof value.pullRequestUrl === "string";
}

function isPullRequest(value: unknown): value is { number: number; url: string } {
  return isRecord(value) && typeof value.number === "number" && Number.isInteger(value.number) && value.number > 0 && typeof value.url === "string";
}

/**
 * Reads and bounds the issue's comment thread for the agent's opening message. A client
 * without comment support, or a read failure, yields a stated gap rather than silence, so
 * the agent knows the discussion was not seen and can read it itself.
 */
async function readIssueDiscussion(
  githubClient: GitHubRestClientLike | undefined,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string | undefined> {
  if (!githubClient?.listIssueComments) return undefined;
  try {
    return formatIssueDiscussion(selectIssueDiscussion(await githubClient.listIssueComments(owner, repo, issueNumber, { limit: 200 })));
  } catch (error) {
    return `(The comments could not be read before the run started: ${error instanceof Error ? error.message : String(error)}. Call read_issue to read them.)`;
  }
}

async function startTrueForgeSessionForIssue(
  run: ReturnType<typeof createRun>,
  webhook: ReturnType<typeof parseIssueWebhook>,
  deliveryId: string,
  safeToExecute: boolean,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  issueDiscussion?: string
) {
  if (!safeToExecute) {
    return {
      run,
      trueForge: {
        status: "skipped",
        reason: "Issue was rejected by security policy"
      }
    };
  }

  if (!trueForgeRuntime) {
    return {
      run,
      trueForge: {
        status: "not-configured",
        reason: "GITHUB_TOKEN, DEEPSEEK_API_KEY and E2B_API_KEY are required before live orchestration can start"
      }
    };
  }

  try {
    const result = await trueForgeRuntime.startSession({
      repository: webhook.repository.full_name,
      issueUrl: webhook.issue.html_url,
      issueTitle: webhook.issue.title,
      issueBody: webhook.issue.body ?? "",
      ...(issueDiscussion !== undefined ? { issueDiscussion } : {}),
      baseBranch: webhook.repository.default_branch,
      branchName: branchNameForIssue(webhook.issue.number, deliveryId)
    });

    return {
      run: transitionRun(run, "environment-building", "TrueForge session started", {
        evidence: {
          sessionId: result.session.id,
          turnId: result.turn.id,
          turnStatus: result.turn.status
        }
      }),
      trueForge: {
        status: "started",
        session: result.session,
        turn: result.turn,
        model: process.env.DEEPSEEK_MODEL ?? defaultLlmModel,
        provider: process.env.MODEL_PROVIDER ?? "deepseek"
      }
    };
  } catch (error) {
    return {
      run: transitionRun(run, "failed", "TrueForge session start failed", {
        evidence: {
          error: error instanceof Error ? error.message : "Unknown TrueForge error"
        }
      }),
      trueForge: {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown TrueForge error"
      }
    };
  }
}

async function handleApproval(
  request: IncomingMessage,
  response: ServerResponse,
  dataDir: string | undefined,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  githubClient: GitHubRestClientLike | undefined,
  postgresStore?: PostgresStore
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const approvalToken = process.env.APPROVAL_TOKEN;
  if (!approvalToken) {
    sendJson(response, 503, { error: "APPROVAL_TOKEN is not configured" });
    return;
  }

  if (bearerToken(request) !== approvalToken) {
    sendJson(response, 401, { error: "Approval authentication required" });
    return;
  }

  if (!dataDir && !postgresStore) {
    sendJson(response, 503, { error: "Storage is required for approval persistence" });
    return;
  }

  const payload = await readJson(request);
  const actionId = expectApprovalAction(payload.actionId);
  const runId = expectString(payload.runId, "runId");
  const patchHash = expectString(payload.patchHash, "patchHash");
  const result = await executeApproval(dataDir, runId, actionId, patchHash, trueForgeRuntime, githubClient, postgresStore);
  sendJson(response, result.statusCode, result.body);
}

interface ApprovalExecutionResult {
  statusCode: number;
  body: unknown;
}

async function executeApproval(
  dataDir: string | undefined,
  runId: string,
  actionId: ApprovalActionId,
  patchHash: string,
  trueForgeRuntime: SquasherSessionStarter | undefined,
  githubClient: GitHubRestClientLike | undefined,
  postgresStore?: PostgresStore
): Promise<ApprovalExecutionResult> {
  const liveRecord = await findPersistedRunById(dataDir, runId, postgresStore);
  if (!liveRecord) {
    return { statusCode: 404, body: { error: "Persisted run not found" } };
  }

  const candidatePatch = liveRecord.trueForge.result?.candidatePatch;
  if (!candidatePatch || candidatePatch.hash !== patchHash || !Array.isArray(candidatePatch.files) || candidatePatch.files.length === 0) {
    return { statusCode: 409, body: { error: "Approval payload has no valid patch files" } };
  }
  const previousReceipt = await findApprovalReceipt(dataDir, runId, actionId, patchHash, postgresStore);
  const canReconcilePersistedApproval = Boolean(
    actionId === "approve-pr" && liveRecord.trueForge.pendingApproval?.approvalTurnId
  );
  if (previousReceipt?.resultStatus === "writing" && !canReconcilePersistedApproval) {
    return { statusCode: 409, body: { error: "This approval is already being processed" } };
  }
  if (
    previousReceipt &&
    previousReceipt.resultStatus !== "write-failed" &&
    !(previousReceipt.resultStatus === "writing" && canReconcilePersistedApproval)
  ) {
    return { statusCode: 200, body: previousReceipt };
  }
  if (liveRecord.run.status !== "awaiting-approval") {
    return { statusCode: 409, body: { error: "Live run is not awaiting approval" } };
  }

  if (actionId === "approve-pr") {
    // Enforced here rather than only inside the harness: an injected runtime that never
    // received the write-target resolver must fail closed, not write to the upstream
    // repository. This is the authoritative gate.
    const policy = contributionApprovalBlocker(liveRecord);
    if (policy) {
      return { statusCode: 409, body: { error: policy } };
    }

    // A paused run can sit for hours, so the destination is re-checked at the moment of
    // approval rather than trusting the state observed when the patch was produced.
    const drift = await upstreamDriftBlocker(liveRecord, githubClient);
    if (drift) {
      return { statusCode: 409, body: { error: drift } };
    }
  }

  if (actionId !== "approve-pr") {
    let run = liveRecord.run;
    let trueForge = liveRecord.trueForge;
    if (actionId === "reject-run" && canTransition(run.status, "rejected")) {
      run = transitionRun(run, "rejected", "Maintainer rejected the live candidate patch");
    }
    if (
      actionId === "reject-run" &&
      liveRecord.trueForge.pendingApproval &&
      liveRecord.trueForge.session?.id &&
      trueForgeRuntime?.resolveToolApproval
    ) {
      try {
        const denialTurn = await trueForgeRuntime.resolveToolApproval({
          sessionId: liveRecord.trueForge.session.id,
          previousTurnId: liveRecord.trueForge.pendingApproval.turnId,
          threadId: liveRecord.trueForge.pendingApproval.threadId,
          toolCallId: liveRecord.trueForge.pendingApproval.toolCallId,
          decision: "deny",
          reason: "Maintainer rejected the candidate patch"
        });
        const denialEvents = trueForgeRuntime.subscribeToTurn
          ? await trueForgeRuntime.subscribeToTurn(liveRecord.trueForge.session.id, denialTurn.id)
          : [];
        trueForge = {
          ...trueForge,
          status: "completed",
          turn: denialTurn,
          pendingApproval: undefined,
          events: mergeHarnessEvents(
            trueForge.events ?? [],
            denialEvents.flatMap((event, index) => projectTrueForgeEvent(event, index))
          )
        };
      } catch (error) {
        return {
          statusCode: 502,
          body: { error: error instanceof Error ? error.message : "TrueForge rejection resume failed" }
        };
      }
    }
    const receipt = buildApprovalReceipt(runId, actionId, patchHash, resultStatusFor(actionId), messageFor(actionId));
    await appendApprovalReceipt(dataDir, receipt, postgresStore);
    const baseRecord: PersistedWebhookRunRecord = {
      ...liveRecord,
      run,
      trueForge: {
        ...trueForge,
        events: mergeHarnessEvents(trueForge.events ?? [], [{
          id: `approval:${runId}:${actionId}`,
          at: receipt.savedAt,
          type: "approval.received",
          category: "approval",
          source: "squasher",
          status: actionId === "reject-run" ? "failed" : "passed",
          summary: actionId === "reject-run" ? "Maintainer rejected the candidate patch" : "Maintainer requested a diff review",
          artifact: actionId === "reject-run" ? "run stopped" : "write held"
        }])
      }
    };
    const cleanedRecord = actionId === "reject-run"
      ? await removeAwaitingApprovalLabel(baseRecord, githubClient)
      : baseRecord;
    const statusLabeledRecord = await syncLifecycleLabels(cleanedRecord, githubClient);
    const updatedRecord = await appendGitHubComment(statusLabeledRecord, githubClient, "approval");
    await appendUpdatedLiveRecord(dataDir, updatedRecord, postgresStore);
    return { statusCode: 200, body: receipt };
  }

  const pendingApproval = liveRecord.trueForge.pendingApproval;
  const sessionId = liveRecord.trueForge.session?.id;

  if (!pendingApproval) {
    return { statusCode: 409, body: { error: "TrueForge did not return the mandatory native approval checkpoint" } };
  }

  if (pendingApproval.payloadHash !== candidatePatch.hash) {
    return { statusCode: 409, body: { error: "TrueForge is not waiting on this exact candidate patch" } };
  }
  if (!sessionId || !trueForgeRuntime?.resolveToolApproval || !trueForgeRuntime.subscribeToTurn) {
    return { statusCode: 503, body: { error: "TrueForge approval resume is not configured" } };
  }

  const writingReceipt = buildApprovalReceipt(
    runId,
    actionId,
    patchHash,
    "writing",
    "Approval accepted; resuming the paused TrueForge GitHub write"
  );
  await appendApprovalReceipt(dataDir, writingReceipt, postgresStore);

  let approvalRecord = liveRecord;
  let approvalTurn: TrueForgeTurn;
  let approvalEvents: TrueForgeRuntimeEvent[];
  try {
    if (pendingApproval.approvalTurnId) {
      approvalTurn = {
        id: pendingApproval.approvalTurnId,
        sessionId,
        status: "running"
      };
    } else {
      approvalTurn = await trueForgeRuntime.resolveToolApproval({
        sessionId,
        previousTurnId: pendingApproval.turnId,
        threadId: pendingApproval.threadId,
        toolCallId: pendingApproval.toolCallId,
        decision: "allow"
      });
      approvalRecord = {
        ...liveRecord,
        trueForge: {
          ...liveRecord.trueForge,
          turn: approvalTurn,
          pendingApproval: {
            ...pendingApproval,
            approvalTurnId: approvalTurn.id
          }
        }
      };
      await appendUpdatedLiveRecord(dataDir, approvalRecord, postgresStore);
    }
    approvalEvents = await reconcileSessionEvents({
      trueForgeRuntime,
      sessionId,
      turnId: approvalTurn.id,
      // Settled on a parsed pull request (success) or a definitive turn.done error
      // (failure). Without the second condition, a write that fails fast -- for example
      // a fork still finishing GitHub's own import, which can 403 on the first git write
      // for several minutes on a large repository even after its branch is readable --
      // was invisible to this check: it kept polling for the full budget below and then
      // reported a generic timeout, discarding the real error that had already arrived.
      isSettled: (evts) => {
        try {
          parsePullRequestFromTrueForgeEvents(evts, pendingApproval.toolCallId);
          return true;
        } catch {
          return trueForgeTurnError(evts) !== undefined;
        }
      },
      maxPollAttempts: 30,
      pollIntervalMs: process.env.NODE_ENV === "test" ? 5 : 1000
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TrueForge approval resume failed";
    const failedReceipt = buildApprovalReceipt(runId, actionId, patchHash, "write-failed", message);
    await appendApprovalReceipt(dataDir, failedReceipt, postgresStore);

    // The harness has no record of the paused call, so no approval can ever resume this
    // run: retrying only repeats this. Runs written before the checkpoint survived a
    // failed write are in exactly this state. Settle the run instead of leaving it
    // advertising an approval button that fails on every click with nothing to show why.
    if (/no harness tool call is awaiting approval/i.test(message)) {
      // The approval step is lost, the verified patch is not: the run returns to
      // patch-ready and the contribution records why it can no longer be written.
      const reason =
        "The approved write cannot be resumed: the harness no longer holds the paused tool call. The verified patch is kept.";
      const strandedRecord: PersistedWebhookRunRecord = {
        ...liveRecord,
        run: canTransition(liveRecord.run.status, "patch-ready")
          ? transitionRun(liveRecord.run, "patch-ready", reason)
          : liveRecord.run,
        trueForge: { ...liveRecord.trueForge, pendingApproval: undefined },
        contributionIssue: {
          status: "blocked",
          reason,
          action: "Re-run the issue to produce an approvable write, or apply the verified patch by hand",
          at: new Date().toISOString()
        }
      };
      const labelled = await syncLifecycleLabels(strandedRecord, githubClient);
      await appendUpdatedLiveRecord(dataDir, labelled, postgresStore);
    }

    return { statusCode: 502, body: { error: failedReceipt.message } };
  }

  let pullRequest: { number: number; url: string };
  try {
    pullRequest = parsePullRequestFromTrueForgeEvents(approvalEvents, pendingApproval.toolCallId);
  } catch (error) {
    // A definitive turn.done error names the real cause (a GitHub API error, for
    // instance) and is always more useful than the generic parse failure below.
    const turnError = trueForgeTurnError(approvalEvents);
    const failedReceipt = buildApprovalReceipt(
      runId,
      actionId,
      patchHash,
      "write-failed",
      turnError ?? (error instanceof Error ? error.message : "TrueForge did not return a pull request receipt")
    );
    await appendApprovalReceipt(dataDir, failedReceipt, postgresStore);

    if (turnError) {
      // The paused write definitively failed rather than merely running slowly, so the
      // turn it was attempted on is dead. Clearing approvalTurnId here is what lets the
      // next approval click start a fresh attempt instead of re-polling that dead turn
      // forever -- which, before this fix, is exactly what happened: every retry landed
      // on the same already-terminated turn and reported the same result. A run whose
      // write failed only because a large fork was still finishing GitHub's own import
      // (see the isSettled comment above) can then be retried once that settles, without
      // starting the whole triage over.
      //
      // The failure is a contribution problem, never an engineering one: the verified
      // patch stands, and so does the checkpoint that lets the write be retried.
      await appendUpdatedLiveRecord(
        dataDir,
        {
          ...approvalRecord,
          trueForge: {
            ...approvalRecord.trueForge,
            pendingApproval: { ...pendingApproval, approvalTurnId: undefined }
          },
          contributionIssue: {
            status: "blocked",
            reason: `The GitHub write failed: ${failedReceipt.message}`,
            action: "The approval checkpoint is still held, so the write can be approved again once the cause is fixed",
            at: new Date().toISOString()
          }
        },
        postgresStore
      );
    }

    return { statusCode: 502, body: { error: failedReceipt.message } };
  }
  let run = approvalRecord.run;
  if (canTransition(run.status, "approved")) {
    run = transitionRun(run, "approved", "Maintainer approved the verified candidate patch");
  }
  if (canTransition(run.status, "pr-created")) {
    run = transitionRun(run, "pr-created", "Draft GitHub pull request created", {
      evidence: { pullRequestUrl: pullRequest.url, pullRequestNumber: pullRequest.number }
    });
  }
  const { contributionIssue: _resolvedIssue, ...approvedRecord } = approvalRecord;
  const updatedRecord: PersistedWebhookRunRecord = {
    ...approvedRecord,
    run,
    trueForge: {
      ...approvalRecord.trueForge,
      status: "completed",
      turn: approvalTurn,
      pendingApproval: undefined,
      events: mergeHarnessEvents(approvalRecord.trueForge.events ?? [], [
        ...approvalEvents.flatMap((event, index) => projectTrueForgeEvent(event, index)),
        {
          id: `approval:${runId}:${actionId}`,
          at: new Date().toISOString(),
          type: "approval.received",
          category: "approval",
          source: "squasher",
          status: "passed",
          summary: "Maintainer approval resumed the TrueForge GitHub write",
          toolName: "create_fix_pull_request",
          target: `${approvalRecord.run.issue.owner}/${approvalRecord.run.issue.repo}`,
          artifact: `draft PR #${pullRequest.number}`
        }
      ]),
      result: {
        ...approvalRecord.trueForge.result!,
        summary: `${approvalRecord.trueForge.result?.summary ?? "Verified candidate patch"} Draft PR created: ${pullRequest.url}`,
        pullRequest
      }
    }
  };
  const cleanedRecord = await removeAwaitingApprovalLabel(updatedRecord, githubClient);
  const statusLabeledRecord = await syncLifecycleLabels(cleanedRecord, githubClient);
  const commentedRecord = await appendGitHubComment(statusLabeledRecord, githubClient, "approval");
  await appendUpdatedLiveRecord(dataDir, commentedRecord, postgresStore);
  const receipt = buildApprovalReceipt(
    runId,
    actionId,
    patchHash,
    "pr-created",
    "Draft GitHub pull request created",
    { pullRequest }
  );
  await appendApprovalReceipt(dataDir, receipt, postgresStore);
  return { statusCode: 200, body: receipt };
}

interface ApprovalReceipt {
  id: string;
  runId: string;
  actionId: ApprovalActionId;
  actor: string;
  approvedPayloadHash: string;
  patchHash: string;
  resultStatus: string;
  message: string;
  savedAt: string;
  pullRequest?: { number: number; url: string };
}

function buildApprovalReceipt(
  runId: string,
  actionId: ApprovalActionId,
  patchHash: string,
  resultStatus: string,
  message: string,
  extra: Pick<ApprovalReceipt, "pullRequest"> = {}
): ApprovalReceipt {
  const savedAt = new Date().toISOString();
  return {
    id: createHash("sha256").update(`${runId}:${actionId}:${patchHash}:${resultStatus}:${savedAt}`).digest("hex").slice(0, 16),
    runId,
    actionId,
    actor: "token-authenticated maintainer",
    approvedPayloadHash: createHash("sha256").update(`${runId}:${actionId}:${patchHash}`).digest("hex"),
    patchHash,
    resultStatus,
    message,
    savedAt,
    ...extra
  };
}

async function appendApprovalReceipt(dataDir: string | undefined, receipt: ApprovalReceipt, postgresStore?: PostgresStore): Promise<void> {
  if (postgresStore) {
    await postgresStore.saveApprovalReceipt(receipt as any).catch((err) => {
      console.error("Postgres saveApprovalReceipt error:", err);
    });
  }
  if (dataDir) {
    try {
      await mkdir(dataDir, { recursive: true });
      await appendFile(join(dataDir, "approvals.jsonl"), `${JSON.stringify(receipt)}\n`, "utf8");
    } catch (err) {
      console.warn("Could not append to local approvals.jsonl:", err);
    }
  }
}

/** The facts a run's two statuses are derived from; see run-status.ts. */
function runStatusFacts(record: PersistedWebhookRunRecord) {
  const result = record.trueForge.result;
  return {
    runStatus: record.run.status,
    runEvents: record.run.events.map((event) => ({ status: event.status, message: event.message })),
    harness: {
      status: record.trueForge.status,
      ...(record.trueForge.error ? { error: record.trueForge.error } : {}),
      ...(record.trueForge.reason ? { reason: record.trueForge.reason } : {})
    },
    scanSafe: record.scan.safeToExecute,
    pendingApproval: Boolean(record.trueForge.pendingApproval),
    ...(result
      ? {
          result: {
            status: result.status,
            hasPatch: Boolean(result.candidatePatch),
            proofVerified: result.proofVerified ?? hasGenuineProof(result),
            ...(result.pullRequest ? { pullRequest: result.pullRequest } : {})
          }
        }
      : {}),
    ...(record.contribution ? { contribution: record.contribution } : {}),
    ...(record.contributionIssue ? { contributionIssue: record.contributionIssue } : {}),
    ...(record.pullRequestState ? { pullRequestState: record.pullRequestState } : {})
  };
}

function runStatusesFor(record: PersistedWebhookRunRecord): RunStatuses {
  return deriveRunStatuses(runStatusFacts(record));
}

/** Stamps the derived statuses so every persisted record carries them. */
function withRunStatuses(record: PersistedWebhookRunRecord): PersistedWebhookRunRecord {
  const statuses = runStatusesFor(record);
  return {
    ...record,
    implementationStatus: statuses.implementation.status,
    contributionStatus: statuses.contribution.status,
    contributionReason: statuses.contribution.reason
  };
}

async function appendUpdatedLiveRecord(dataDir: string | undefined, unstamped: PersistedWebhookRunRecord, postgresStore?: PostgresStore): Promise<void> {
  const record = withRunStatuses(unstamped);
  if (postgresStore) {
    await postgresStore.saveWebhookRun(record).catch((err) => {
      console.error("Postgres saveWebhookRun error:", err);
    });
  }
  if (dataDir) {
    try {
      await mkdir(dataDir, { recursive: true });
      await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      console.warn("Could not append to local webhook-runs.jsonl:", err);
    }
  }
}

const lifecycleLabelDefinitions = [
  { name: "squasher:triaging", color: "1d5fd1", description: "Squasher is triaging this issue" },
  { name: "squasher:needs-info", color: "a85b00", description: "Squasher needs more issue information" },
  { name: "squasher:not-reproduced", color: "6e7781", description: "Squasher could not reproduce this issue" },
  {
    name: "squasher:not-actionable",
    color: "6e7781",
    description: "Squasher understood this request but did not build it"
  },
  { name: "squasher:security-review", color: "b42318", description: "Squasher held this issue for security review" },
  { name: "squasher:pr-created", color: "1a7f37", description: "Squasher created a draft pull request" },
  // Reconciled here as well as applied by applyVerifiedLabel and
  // applyAwaitingApprovalLabel. Those only ever add, and each only retracts a label the
  // same record applied, so a second run over one issue used to leave the first run's
  // claims in place: an issue could carry byter:verified and byter:not-reproduced at
  // once, publicly asserting a proof that a later run had disproved.
  { name: "squasher:verified", color: "8250df", description: "Issue verified by reproducible evidence" },
  // Kept distinct from byter:verified on purpose. That label asserts a reproduced defect,
  // and an implemented change never reproduced anything; reusing it would make Squasher's own
  // evidence claim mean two different things.
  {
    name: "squasher:implemented",
    color: "0969da",
    description: "Squasher implemented and verified the requested change"
  },
  {
    name: "squasher:awaiting-approval",
    color: "d1242f",
    description: "Verified patch is waiting for maintainer approval"
  }
] as const;

/**
 * Label names this application used before the rename. Not applied any more, only retracted,
 * so a re-run cleans up what earlier runs left on an issue.
 */
const legacyLifecycleLabelNames = [
  "byter:triaging",
  "byter:needs-info",
  "byter:not-reproduced",
  "byter:not-actionable",
  "byter:security-review",
  "byter:pr-created",
  "byter:verified",
  "byter:implemented",
  "byter:awaiting-approval"
] as const;

/**
 * The complete set of Squasher labels the issue should carry right now. Anything defined
 * above and absent from this set is removed, so the labels always describe the latest
 * run rather than the union of every run.
 */
function desiredLifecycleLabels(record: PersistedWebhookRunRecord): string[] {
  if (!record.scan.safeToExecute) return ["squasher:security-review"];

  const labels: string[] = [];

  // At most one status label, mirroring where the run actually is.
  if (record.run.status === "pr-created") labels.push("squasher:pr-created");
  else if (record.run.status === "needs-info") labels.push("squasher:needs-info");
  else if (record.run.status === "not-reproduced") labels.push("squasher:not-reproduced");
  else if (record.run.status === "not-actionable") labels.push("squasher:not-actionable");
  else if (
    record.run.status !== "awaiting-approval" &&
    (record.run.status === "triaging" || record.trueForge.status === "started")
  ) {
    labels.push("squasher:triaging");
  }

  // Claims about the evidence, retracted as soon as they no longer hold. The run status
  // gates this, not hasGenuineProof alone: a result can carry well-formed proof text and
  // still have been refused, as when a patch arrives with no approval checkpoint, and
  // that run must not be labelled verified.
  if (provenRunStatuses.has(record.run.status) && hasGenuineProof(record.trueForge.result)) {
    const status = record.trueForge.result?.status;
    labels.push(status && implementationStatuses.has(status) ? "squasher:implemented" : "squasher:verified");
    if (record.run.status === "awaiting-approval") labels.push("squasher:awaiting-approval");
  }

  return labels;
}

/**
 * Statuses only reachable once the proof contract was accepted. "rejected" stays in the
 * set because the maintainer declined the patch, which does not unmake the reproduction.
 */
const provenRunStatuses = new Set([
  "verified",
  "patch-ready",
  "awaiting-approval",
  "approved",
  "pr-created",
  "rejected"
]);

/**
 * Resolves and registers where this run may write. A run whose issue failed the security
 * scan is never a write candidate, so the probe is skipped and the run is pinned to triage.
 */
async function resolveContributionForRun(
  contributions: ContributionRegistry,
  githubClient: GitHubRestClientLike | undefined,
  owner: string,
  repo: string,
  issueNumber: number,
  branchName: string,
  safeToExecute: boolean
): Promise<ContributionTarget> {
  const blocked = (kind: "capability" | "policy", reason: string, action: string): ContributionTarget => ({
    mode: configuredContributionMode(),
    writable: false,
    headOwner: owner,
    upstreamPushAccess: false,
    archived: false,
    reason,
    blockers: [{ kind, reason, action }]
  });

  let target: ContributionTarget;
  if (!githubClient) {
    target = blocked("capability", "No GitHub client is configured, so no write is possible", "Set GITHUB_TOKEN and re-run the issue");
  } else if (!safeToExecute) {
    target = blocked(
      "policy",
      "Issue was rejected by the security scan, so no GitHub write is attempted",
      "Review the security findings; if they are false positives, edit the issue and re-run"
    );
  } else {
    try {
      target = await resolveContributionTarget({ client: githubClient, owner, repo, issueNumber });
    } catch (error) {
      target = blocked(
        "capability",
        `Contribution policy could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        "Re-run the issue once GitHub is reachable"
      );
    }
  }

  // Keyed by branch as well as repository: two issues in one repository can run at once and
  // each must get its own decision, since duplicates are judged per issue.
  contributions.set(owner, repo, target, branchName);
  return target;
}

/**
 * Refuses an approval that the run's recorded contribution decision does not permit, and
 * refuses a write whose paused destination disagrees with that decision.
 *
 * This is deliberately independent of the harness: the harness stamps the destination so the
 * approver can see it and the payload hash covers it, but a runtime injected without the
 * write-target resolver would stamp nothing, and an unstamped write goes to the upstream
 * repository. Checking here means that case is refused rather than silently written.
 */
function contributionApprovalBlocker(record: PersistedWebhookRunRecord): string | undefined {
  const contribution = record.contribution;
  if (!contribution) {
    // Records written before contribution modes carry no decision; leave them as they were.
    return undefined;
  }

  if (!isContributionWritable(contribution)) {
    return `This run may not write to GitHub: ${contribution.reason}`;
  }

  // An unstamped write defaults to the upstream repository, which in fork mode is exactly
  // the destination that has no push access, so this single comparison covers both a
  // mis-stamped destination and a harness that stamped nothing at all.
  const pausedHeadOwner = record.trueForge.pendingApproval?.headOwner ?? record.run.issue.owner;
  if (pausedHeadOwner !== contribution.headOwner) {
    return (
      `The paused write targets ${pausedHeadOwner} but this run resolved to ${contribution.headOwner}. ` +
      "Refusing rather than writing to an unverified destination."
    );
  }

  return undefined;
}

/**
 * Re-reads the upstream repository at approval time and reports why the write must not
 * proceed, or undefined when nothing has drifted. Only decisive, cheap checks belong here:
 * a probe failure is not treated as a blocker, because that would make every approval
 * dependent on GitHub being reachable at that instant.
 */
async function upstreamDriftBlocker(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<string | undefined> {
  if (!githubClient?.getRepository) {
    return undefined;
  }

  const { owner, repo } = record.run.issue;
  let probe: Awaited<ReturnType<NonNullable<GitHubRestClientLike["getRepository"]>>>;
  try {
    probe = await githubClient.getRepository(owner, repo);
  } catch {
    return undefined;
  }

  if (probe.archived === true || probe.disabled === true) {
    return `${owner}/${repo} was archived or disabled after this patch was prepared, so it no longer accepts writes`;
  }

  if (record.baseBranch && probe.default_branch && record.baseBranch !== probe.default_branch) {
    return `${owner}/${repo} changed its default branch from ${record.baseBranch} to ${probe.default_branch} after this patch was prepared; re-run the issue against the new base`;
  }

  return undefined;
}

/** Issue labels and comments are upstream writes, so they need push access to upstream. */
function canWriteToUpstream(record: PersistedWebhookRunRecord): boolean {
  // An absent decision means this record predates contribution modes; preserve the old
  // attempt-and-swallow behaviour rather than silently going quiet on existing deployments.
  // Explicit triage means no automatic GitHub writes at all, status labels and comments included.
  return record.contribution === undefined || (record.contribution.upstreamPushAccess && record.contribution.mode !== "triage");
}

async function syncLifecycleLabels(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  if (!githubClient || !canWriteToUpstream(record)) return record;
  const desired = desiredLifecycleLabels(record);
  const owner = record.run.issue.owner;
  const repo = record.run.issue.repo;
  const issueNumber = record.run.issue.issueNumber;
  const applied: Array<{ name: string; appliedAt?: string; error?: string }> = [];

  for (const labelName of desired) {
    const definition = lifecycleLabelDefinitions.find((label) => label.name === labelName);
    if (!definition) continue;
    try {
      try {
        await githubClient.updateLabel?.(owner, repo, definition.name, definition.color, definition.description);
      } catch {
        if (!githubClient.createLabel) throw new Error("GitHub label is unavailable");
        await githubClient.createLabel(owner, repo, definition.name, definition.color, definition.description);
      }
      await githubClient.addLabels(owner, repo, issueNumber, [definition.name]);
      applied.push({ name: definition.name, appliedAt: new Date().toISOString() });
    } catch {
      applied.push({ name: definition.name, error: "GitHub did not accept the lifecycle label request" });
    }
  }

  if (githubClient.removeLabel) {
    // Legacy names are retracted alongside the current ones. Issues labelled before the
    // rename still carry byter:*, and dropping those names from reconciliation entirely
    // would strand them there permanently -- an issue reading both byter:verified and
    // squasher:not-reproduced, which is the contradiction reconciliation exists to prevent.
    const retractable = [...lifecycleLabelDefinitions.map((definition) => definition.name), ...legacyLifecycleLabelNames];
    for (const name of retractable) {
      if (desired.includes(name)) continue;
      try {
        await githubClient.removeLabel(owner, repo, issueNumber, name);
      } catch {
        // A missing label is already in the desired state.
      }
    }
  }

  return { ...record, lifecycleLabels: applied };
}

async function applyVerifiedLabel(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  // byter:verified asserts a reproduced defect. An implemented change clears the same
  // evidence bar but reproduced nothing, so it earns byter:implemented from
  // desiredLifecycleLabels instead and must not pick this one up on the way past.
  if (
    !githubClient ||
    !canWriteToUpstream(record) ||
    record.verifiedLabel ||
    !hasGenuineProof(record.trueForge.result) ||
    !bugProofStatuses.has(record.trueForge.result?.status ?? "")
  ) {
    return record;
  }

  try {
    const owner = record.run.issue.owner;
    const repo = record.run.issue.repo;
    const issueNumber = record.run.issue.issueNumber;
    const labelName = "squasher:verified";
    const labelColor = "8250df";
    try {
      await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Issue verified by reproducible evidence");
    } catch {
      // The label may not exist yet; addLabels below will take the create path.
    }
    try {
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    } catch (error) {
      if (!githubClient.createLabel) throw error;
      await githubClient.createLabel(owner, repo, labelName, labelColor, "Issue verified by reproducible evidence");
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    }
    await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Issue verified by reproducible evidence");
    return {
      ...record,
      verifiedLabel: { name: "squasher:verified", appliedAt: new Date().toISOString() }
    };
  } catch {
    return {
      ...record,
      verifiedLabel: { name: "squasher:verified", error: "GitHub did not accept the verified label request" }
    };
  }
}

async function applyAwaitingApprovalLabel(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  if (
    !githubClient ||
    !canWriteToUpstream(record) ||
    record.approvalLabel ||
    record.run.status !== "awaiting-approval" ||
    !hasGenuineProof(record.trueForge.result)
  ) {
    return record;
  }

  try {
    const owner = record.run.issue.owner;
    const repo = record.run.issue.repo;
    const issueNumber = record.run.issue.issueNumber;
    const labelName = "squasher:awaiting-approval";
    const labelColor = "d1242f";
    try {
      await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Verified patch is waiting for maintainer approval");
    } catch {
      // The label may not exist yet; addLabels below will take the create path.
    }
    try {
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    } catch (error) {
      if (!githubClient.createLabel) throw error;
      await githubClient.createLabel(owner, repo, labelName, labelColor, "Verified patch is waiting for maintainer approval");
      await githubClient.addLabels(owner, repo, issueNumber, [labelName]);
    }
    await githubClient.updateLabel?.(owner, repo, labelName, labelColor, "Verified patch is waiting for maintainer approval");
    return {
      ...record,
      approvalLabel: { name: labelName, appliedAt: new Date().toISOString() }
    };
  } catch {
    return {
      ...record,
      approvalLabel: {
        name: "squasher:awaiting-approval",
        error: "GitHub did not accept the approval label request"
      }
    };
  }
}

async function removeAwaitingApprovalLabel(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<PersistedWebhookRunRecord> {
  if (!githubClient?.removeLabel || !record.approvalLabel?.appliedAt) {
    return record;
  }

  try {
    await githubClient.removeLabel(
      record.run.issue.owner,
      record.run.issue.repo,
      record.run.issue.issueNumber,
      "squasher:awaiting-approval"
    );
    return { ...record, approvalLabel: undefined };
  } catch {
    return record;
  }
}

function hasGenuineProof(result: LiveProofResult | undefined): boolean {
  const proof = result?.proof;
  const hasValidPatchFiles = Boolean(
    result?.candidatePatch &&
    Array.isArray(result.candidatePatch.files) &&
    result.candidatePatch.files.length > 0 &&
    isMeaningfulProofText(result.candidatePatch.title, 8) &&
    isMeaningfulProofText(result.candidatePatch.body, 12) &&
    result.candidatePatch.files.every((file) => isMeaningfulProofText(file.path, 3) && isMeaningfulProofText(file.content, 4))
  );
  return Boolean(
    result &&
      provenResultStatuses.has(result.status) &&
      isMeaningfulProofText(result.summary, 20) &&
      isMeaningfulProofText(proof?.before, 6) &&
      isMeaningfulProofText(proof?.after, 6) &&
      isMeaningfulProofText(proof?.regressions, 6) &&
      hasThreeMatchingAttempts(proof?.attempts) &&
      (!result?.candidatePatch || hasValidPatchFiles)
  );
}

/**
 * Why a result's requirement verification does not support its status, or undefined. An
 * implemented change must say what was asked for and show it passing; no proven status may
 * carry a failed requirement. The tool enforces the same rule when the result is submitted;
 * this re-checks what was actually parsed.
 */
function requirementsProblem(result: LiveProofResult): string | undefined {
  if (!provenResultStatuses.has(result.status)) return undefined;
  const requirements = result.requirements ?? [];
  if (requirements.some((requirement) => requirement.verdict === "fail")) {
    return "a requirement failed verification";
  }
  if (requirements.some((requirement) => requirement.verdict === "missing" && !requirement.ownership)) {
    return "a requirement is still missing and nobody else owns it";
  }
  if (requirements.some((requirement) => requirement.ownership && requirement.verdict === "pass")) {
    return "the change implements work the discussion reserved for someone else";
  }
  if (implementationStatuses.has(result.status) && !requirements.some((requirement) => requirement.verdict === "pass")) {
    return "the implemented change lists no requirement verified as pass";
  }
  return undefined;
}

function isMeaningfulProofText(value: unknown, minimumLength: number): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text.length >= minimumLength && !/^(?:\.{3}|…|todo|tbd|n\/?a|placeholder|full file content)$/i.test(text);
}

function hasThreeMatchingAttempts(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/(?:^|\D)(\d+)\s*\/\s*(\d+)(?:\D|$)/);
  return Boolean(match && Number(match[1]) >= 3 && match[1] === match[2]);
}

function hasExecutableProof(events: HarnessTraceEvent[]): boolean {
  const ranReproducer = events.some((event) => {
    if (event.category !== "sandbox" || typeof event.command !== "string") return false;
    const command = event.command.toLowerCase();
    return /\b(?:repro|test|spec|vitest|jest|pytest)\b/.test(command) &&
      /\b(?:node|pnpm|npm|npx|bun|deno|python|pytest|cargo|go|dotnet|mvn|gradle)\b/.test(command);
  });
  const completedSandboxCommand = events.some((event) =>
    event.category === "sandbox" && event.type === "tool.response" && event.status === "passed"
  );
  return ranReproducer && completedSandboxCommand;
}

async function appendGitHubComment(
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined,
  kind: GitHubCommentKind
): Promise<PersistedWebhookRunRecord> {
  if (!githubClient || !canWriteToUpstream(record)) {
    return record;
  }

  const body = buildGitHubStatusComment(record, kind);
  try {
    if (record.githubStatusComment?.id !== undefined && githubClient.updateIssueComment) {
      const updated = await githubClient.updateIssueComment(
        record.run.issue.owner,
        record.run.issue.repo,
        record.githubStatusComment.id,
        body
      );
      return {
        ...record,
        githubComments: (record.githubComments ?? [{
          id: record.githubStatusComment.id,
          url: record.githubStatusComment.url,
          kind: "started",
          createdAt: record.receivedAt
        }]).map((comment) => comment.id === record.githubStatusComment?.id
          ? { ...comment, kind, url: updated.html_url ?? comment.url }
          : comment),
        githubStatusComment: {
          id: updated.id ?? record.githubStatusComment.id,
          url: updated.html_url ?? record.githubStatusComment.url
        }
      };
    }
    const created = await githubClient.createIssueComment(
      record.run.issue.owner,
      record.run.issue.repo,
      record.run.issue.issueNumber,
      body
    );
    const comment = {
      ...(created.id !== undefined ? { id: created.id } : {}),
      url: created.html_url,
      kind,
      createdAt: new Date().toISOString()
    };
    return {
      ...record,
      githubComments: [comment],
      githubStatusComment: {
        ...(created.id !== undefined ? { id: created.id } : {}),
        url: created.html_url
      }
    };
  } catch (error) {
    console.error("GitHub progress comment creation failed", error);
    return record;
  }
}

/**
 * Evidence headings for the public issue comment. An implemented change has no
 * reproduction and observed no failure, so it must not be described as though it did.
 */
function evidenceLabelsFor(result: LiveProofResult | undefined) {
  return result && implementationStatuses.has(result.status)
    ? {
        attempts: "Verification",
        attemptsFallback: "3/3 matching runs",
        before: "Before change",
        beforeFallback: "Requested behaviour absent",
        after: "After change",
        afterFallback: "New behaviour verified",
        regressions: "Existing checks",
        heading: "Requested change"
      }
    : {
        attempts: "Reproduction",
        attemptsFallback: "3/3 matching failures",
        before: "Before",
        beforeFallback: "Failure observed",
        after: "After",
        afterFallback: "Passes after patch",
        regressions: "Regression suite",
        heading: "Root cause"
      };
}

export function buildGitHubStatusComment(record: PersistedWebhookRunRecord, kind: GitHubCommentKind): string {
  const status = githubCommentStatus(record);
  const result = record.trueForge.result;
  const pullRequest = result?.pullRequest;
  const reviewUrl = record.dashboardUrl ? `${record.dashboardUrl.replace(/\/$/, "")}/review` : "#";
  const runUrl = record.dashboardUrl ?? "#";
  const lines = [
    `<!-- squasher-run:${record.run.id} -->`,
    `## Squasher · ${status.label}`,
    "",
    `Issue #${record.run.issue.issueNumber}: ${safeCommentText(record.issueTitle, 240)}`,
    `**Status:** ${status.detail}`,
    "",
    `[Open Squasher run →](${record.dashboardUrl ?? "#"})`
  ];

  if (!record.scan.safeToExecute || record.run.status === "security-review") {
    lines.push(
      "",
      "Squasher detected potentially unsafe reproduction instructions and held execution.",
      "",
      "**Execution:** Blocked",
      "**GitHub writes:** None",
      "",
      `**[Review security analysis ->](${runUrl})**`
    );
  } else if (record.run.status === "needs-info") {
    lines.push(
      "",
      "Squasher could not build a reliable reproduction from the current report.",
      "",
      "**Next step:** Add the missing runtime, input, or expected-output details and trigger a new run.",
      "",
      `**[View investigation ->](${runUrl})**`
    );
  } else if (record.run.status === "not-reproduced") {
    lines.push(
      "",
      "Squasher built the reported environment but did not observe the claimed failure.",
      "",
      `**Reproduction attempts:** ${safeCommentText(result?.proof?.attempts ?? "No matching failure observed", 180)}`,
      "",
      "This does not prove the bug does not exist.",
      "",
      `**[View evidence ->](${runUrl})**`
    );
  } else if (record.run.status !== "failed" && result?.candidatePatch && hasGenuineProof(result)) {
    const evidence = evidenceLabelsFor(result);
    lines.push(
      "",
      "### Evidence",
      `- **${evidence.attempts}:** ${commentProofText(result.proof?.attempts, evidence.attemptsFallback, 180)}`,
      `- **${evidence.before}:** ${commentProofText(result.proof?.before, evidence.beforeFallback, 260)}`,
      `- **${evidence.after}:** ${commentProofText(result.proof?.after, evidence.afterFallback, 260)}`,
      `- **${evidence.regressions}:** ${commentProofText(result.proof?.regressions, "Passed", 260)}`,
      "",
      `### ${evidence.heading}`,
      safeCommentMarkdown(result.rootCauseSummary ?? summarizeCommentText(result.summary), 360),
      "",
      "### Proposed fix",
      safeCommentMarkdown(result.proposedFixSummary ?? summarizeCommentText(result.candidatePatch.body), 360),
      "",
      `**Patch:** ${result.candidatePatch.files.length} file${result.candidatePatch.files.length === 1 ? "" : "s"} · review on the dashboard before approval`,
      `**Files:** ${result.candidatePatch.files.map((file) => `\`${safeCommentText(file.path, 180)}\``).join(", ")}`
    );
    if (record.run.status === "awaiting-approval") {
      lines.push(
        "",
        "> ⏸ **TrueForge is paused. No branch, commit, or pull request has been created.**",
        "",
        `**[Review evidence & approve patch →](${reviewUrl})**`
      );
    }
  } else if (record.run.status !== "failed" && result && hasGenuineProof(result)) {
    const evidence = evidenceLabelsFor(result);
    lines.push(
      "",
      "### Evidence",
      `- **${evidence.attempts}:** ${commentProofText(result.proof?.attempts, evidence.attemptsFallback, 180)}`,
      `- **${evidence.before}:** ${commentProofText(result.proof?.before, evidence.beforeFallback, 260)}`,
      `- **${evidence.after}:** ${commentProofText(result.proof?.after, evidence.afterFallback, 260)}`,
      `- **${evidence.regressions}:** ${commentProofText(result.proof?.regressions, "Passed", 260)}`,
      "",
      "### Finding",
      safeCommentMarkdown(result.rootCauseSummary ?? summarizeCommentText(result.summary), 360),
      "",
      "No candidate patch was returned, so Squasher did not request repository write approval.",
      `**[View verification evidence →](${runUrl})**`
    );
  } else if (record.run.status === "failed") {
    const failureReason = record.trueForge.error ?? record.run.events?.slice(-1)[0]?.message ?? "TrueForge completed without a valid proof contract.";
    lines.push(
      "",
      "> The run did not produce a complete proof-and-approval contract. No verified label or repository mutation was made.",
      "",
      "### Failure details",
      safeCommentMarkdown(failureReason, 4000),
      "",
      `**[View full investigation trace →](${runUrl})**`
    );
  }
  if (pullRequest) {
    lines.push(
      "",
      "### Validation complete",
      "- ✅ Issue verified",
      "- ✅ Candidate patch validated",
      "- ✅ Maintainer approved",
      `- ✅ Draft PR created: [#${pullRequest.number}](${pullRequest.url})`,
      "",
      `**[View verification evidence →](${record.dashboardUrl ?? "#"})**`
    );
  }

  return lines.join("\n");
}

function safeCommentText(value: string, maxBytes: number): string {
  return clampCommentText(redactHarnessText(value), maxBytes);
}

function safeCommentMarkdown(value: string, maxBytes: number): string {
  const redactedLines = value
    .replace(/<[^>\n]*>/g, "")
    .split(/\r?\n/)
    .map((line) => redactHarnessText(line).trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clampCommentText(redactedLines, maxBytes);
}

function clampCommentText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const suffix = "...";
  const byteLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(prefix + character, "utf8") > byteLimit) break;
    prefix += character;
  }

  const minimumBoundary = Math.floor(prefix.length * 0.6);
  const boundary = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("."),
    prefix.lastIndexOf(","),
    prefix.lastIndexOf(";")
  );
  if (boundary >= minimumBoundary) prefix = prefix.slice(0, boundary + (prefix[boundary] === "." ? 1 : 0));
  return `${prefix.trimEnd()}${suffix}`;
}

function commentProofText(value: string | undefined, fallback: string, maxBytes: number): string {
  return safeCommentText(summarizeCommentText(value ?? fallback), maxBytes);
}

function safeCodeText(value: string, maxBytes: number): string {
  return clampText(
    value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[REDACTED]")
      .replace(/`{4,}/g, "```")
      .trim(),
    maxBytes
  );
}

function commentUpdateLabel(kind: GitHubCommentKind): string {
  if (kind === "started") return "TrueForge handoff started";
  if (kind === "completed") return "Proof processing completed";
  if (kind === "failed") return "Run stopped";
  return "Maintainer decision recorded";
}

function summarizeCommentText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const sentences = compact.match(/[^.!?]+[.!?](?:\s|$)/g)?.slice(0, 2).join(" ").trim();
  return clampText(sentences || compact, 360);
}

function githubCommentStatus(record: PersistedWebhookRunRecord): { label: string; detail: string } {
  if (!record.scan.safeToExecute || record.run.status === "security-review") {
    return { label: "Security review", detail: "Execution was held after the issue text failed the safety scan." };
  }
  if (record.run.status === "pr-created") {
    return { label: "Fix proposed", detail: "Approved patch validated; draft pull request created." };
  }
  if (record.run.status === "needs-info") {
    return { label: "Needs information", detail: "The issue needs more detail before Squasher can reproduce it." };
  }
  if (record.run.status === "not-reproduced") {
    return { label: "Not reproduced", detail: "The reported failure was not observed in the investigated environment." };
  }
  if (record.run.status === "not-actionable") {
    return {
      label: "Not actionable",
      detail: "The request was understood but not implemented; the summary explains why."
    };
  }
  if (record.run.status === "awaiting-approval") {
    return { label: "Patch ready for review", detail: "Verified evidence is ready; TrueForge is paused before GitHub writes." };
  }
  if (record.run.status === "patch-ready" || record.run.status === "verified") {
    return implementationStatuses.has(record.trueForge.result?.status ?? "")
      ? { label: "Implemented", detail: "The requested change is implemented and backed by executable evidence." }
      : { label: "Verified", detail: "The reported failure is backed by executable evidence." };
  }
  if (record.run.status === "rejected") {
    return { label: "Run rejected", detail: "The run was stopped before repository mutation." };
  }
  if (record.run.status === "failed") {
    return { label: "Run failed", detail: record.trueForge.error ?? "TrueForge did not complete successfully." };
  }
  if (record.trueForge.status === "started") {
    if (record.run.status === "reproducing") {
      return { label: "Reproducing", detail: "TrueForge is running the reported scenario in an isolated environment." };
    }
    if (record.run.status === "environment-building") {
      return { label: "Environment building", detail: "TrueForge is preparing an isolated environment for reproduction." };
    }
    return { label: "Investigating", detail: "TrueForge is inspecting the issue and collecting executable evidence." };
  }
  return { label: "Investigation queued", detail: "Squasher accepted the signed issue and is preparing the investigation." };
}

async function findPersistedRunById(
  dataDir: string | undefined,
  runId: string,
  postgresStore?: PostgresStore
): Promise<PersistedWebhookRunRecord | undefined> {
  if (postgresStore) {
    try {
      const run = await postgresStore.findRunById(runId);
      if (run) return run;
    } catch (err) {
      console.error("Postgres findRunById error:", err);
    }
  }
  if (!dataDir) return undefined;
  try {
    let match: PersistedWebhookRunRecord | undefined;
    for await (const line of readJsonlLines(join(dataDir, "webhook-runs.jsonl"))) {
      try {
        const record = JSON.parse(line) as PersistedWebhookRunRecord;
        if (record.run?.id === runId) match = record;
      } catch {
        // Ignore a partial or malformed line.
      }
    }
    return match;
  } catch {
    return undefined;
  }
}

async function findLatestAwaitingRunByIssue(
  dataDir: string | undefined,
  repository: string,
  issueNumber: number,
  postgresStore?: PostgresStore
): Promise<PersistedWebhookRunRecord | undefined> {
  if (postgresStore) {
    try {
      const run = await postgresStore.findLatestAwaitingRunByIssue(repository, issueNumber);
      if (run) return run;
    } catch (err) {
      console.error("Postgres findLatestAwaitingRunByIssue error:", err);
    }
  }
  if (!dataDir) return undefined;
  try {
    let match: PersistedWebhookRunRecord | undefined;
    for await (const line of readJsonlLines(join(dataDir, "webhook-runs.jsonl"))) {
      try {
        const record = JSON.parse(line) as PersistedWebhookRunRecord;
        if (
          record.repository === repository &&
          record.run?.issue.issueNumber === issueNumber &&
          (record.run.status === "awaiting-approval" || Boolean(record.trueForge?.pendingApproval)) &&
          (!match || Date.parse(record.run.createdAt) > Date.parse(match.run.createdAt))
        ) {
          match = record;
        }
      } catch {
        // Ignore a partial or malformed line.
      }
    }
    return match;
  } catch {
    return undefined;
  }
}

async function findApprovalReceipt(
  dataDir: string | undefined,
  runId: string,
  actionId: ApprovalActionId,
  patchHash: string,
  postgresStore?: PostgresStore
): Promise<ApprovalReceipt | undefined> {
  let postgresReceipt: ApprovalReceipt | undefined;
  if (postgresStore) {
    try {
      const receipt = await postgresStore.findApprovalReceipt(runId, actionId, patchHash);
      if (receipt) postgresReceipt = receipt as ApprovalReceipt;
    } catch (error) {
      console.error("Postgres findApprovalReceipt error:", error);
    }
  }
  if (!dataDir) return postgresReceipt;
  try {
    let match: ApprovalReceipt | undefined;
    for await (const line of readJsonlLines(join(dataDir, "approvals.jsonl"))) {
      try {
        const receipt = JSON.parse(line) as ApprovalReceipt;
        if (receipt.runId === runId && receipt.actionId === actionId && receipt.patchHash === patchHash) {
          match = receipt;
        }
      } catch {
        // Ignore a partial or malformed line.
      }
    }
    if (!match) return postgresReceipt;
    if (!postgresReceipt) return match;
    return Date.parse(match.savedAt) >= Date.parse(postgresReceipt.savedAt) ? match : postgresReceipt;
  } catch {
    return postgresReceipt;
  }
}

function parsePullRequestFromTrueForgeEvents(
  events: TrueForgeRuntimeEvent[],
  toolCallId: string
): { number: number; url: string } {
  for (const event of [...events].reverse()) {
    if (event.type !== "tool.response") continue;
    const raw = unwrapRuntimeEvent(event.raw);
    if (!isRecord(raw)) continue;
    const responseToolCallId = firstString(raw, ["toolCallId", "tool_call_id"]);
    if (responseToolCallId !== toolCallId) continue;
    const pullRequest = findPullRequest(raw.content);
    if (pullRequest) return pullRequest;
  }
  throw new Error("TrueForge did not return a pull request receipt for the approved tool call");
}

function findPullRequest(value: unknown, depth = 0): { number: number; url: string } | undefined {
  if (depth > 8) return undefined;
  if (typeof value === "string") {
    try {
      return findPullRequest(JSON.parse(value) as unknown, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findPullRequest(item, depth + 1);
      if (match) return match;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.number === "number" && Number.isInteger(value.number) && value.number > 0 && typeof value.url === "string") {
    return { number: value.number, url: value.url };
  }
  for (const item of Object.values(value)) {
    const match = findPullRequest(item, depth + 1);
    if (match) return match;
  }
  return undefined;
}

async function serveStatic(pathname: string, response: ServerResponse, staticDir: string): Promise<void> {
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(staticDir, requestedPath);
  if (!isInside(staticDir, target)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) {
      throw new Error("Not a file");
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", contentTypeFor(target));
    createReadStream(target).pipe(response);
  } catch {
    const fallback = join(staticDir, "index.html");
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(await readFile(fallback, "utf8"));
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readText(request);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Malformed JSON payload");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Expected object payload");
  }

  return parsed as Record<string, unknown>;
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxRequestBodyBytes) {
      throw new HttpError(413, "Request body too large");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`) || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, `Expected non-empty string: ${name}`);
  }

  return value;
}

function expectApprovalAction(value: unknown): ApprovalActionId {
  if (value === "approve-pr" || value === "request-diff" || value === "reject-run") {
    return value;
  }

  throw new HttpError(400, "Expected valid approval action");
}

async function deliveryWasProcessed(
  dataDir: string | undefined,
  deliveryId: string,
  postgresStore?: PostgresStore
): Promise<boolean> {
  if (postgresStore) {
    try {
      return await postgresStore.deliveryWasProcessed(deliveryId);
    } catch (err) {
      console.error("Postgres deliveryWasProcessed error:", err);
    }
  }
  if (!dataDir) return false;
  try {
    const needle = `"deliveryId":${JSON.stringify(deliveryId)}`;
    for await (const line of readJsonlLines(join(dataDir, "webhook-runs.jsonl"))) {
      if (line.includes(needle)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function triggerKeyFor(webhook: ReturnType<typeof parseIssueWebhook>): string {
  const contentDigest = createHash("sha256")
    .update(`${webhook.issue.title}\n${webhook.issue.body ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `${webhook.repository.full_name.toLowerCase()}#${webhook.issue.number}:${contentDigest}`;
}

async function acquireAtomicTriggerClaim(
  dataDir: string | undefined,
  key: string,
  postgresStore?: PostgresStore
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  if (postgresStore) {
    try {
      return await postgresStore.acquireTriggerClaim(key, duplicateIssueTriggerWindowMs);
    } catch (err) {
      console.error("Postgres acquireTriggerClaim error:", err);
    }
  }
  if (!dataDir) {
    return { acquired: true, release: async () => {} };
  }
  try {
    const claimsDir = join(dataDir, ".claims");
    await mkdir(claimsDir, { recursive: true });
    const safeName = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const claimPath = join(claimsDir, `claim-${safeName}.lock`);
    const now = Date.now();
    const token = randomUUID();

    const makeConditionalRelease = (ownerToken: string) => async () => {
      try {
        const current = JSON.parse(await readFile(claimPath, "utf8"));
        if (current?.token === ownerToken) {
          await unlink(claimPath);
        }
      } catch {
        // ignore
      }
    };

    try {
      await writeFile(claimPath, JSON.stringify({ key, time: now, token }), { flag: "wx" });
      return {
        acquired: true,
        release: makeConditionalRelease(token)
      };
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        try {
          const content = JSON.parse(await readFile(claimPath, "utf8"));
          if (typeof content?.time === "number" && now - content.time < duplicateIssueTriggerWindowMs) {
            return { acquired: false, release: async () => {} };
          }
          // Stale claim expired: overwrite with new ownership token
          await writeFile(claimPath, JSON.stringify({ key, time: now, token }));
          return {
            acquired: true,
            release: makeConditionalRelease(token)
          };
        } catch {
          return { acquired: false, release: async () => {} };
        }
      }
      return { acquired: false, release: async () => {} };
    }
  } catch {
    return { acquired: true, release: async () => {} };
  }
}

async function issueTriggerWasRecentlyProcessed(
  dataDir: string | undefined,
  webhook: ReturnType<typeof parseIssueWebhook>,
  postgresStore?: PostgresStore
): Promise<boolean> {
  if (webhook.action === "reopened") {
    return false;
  }

  const cutoff = Date.now() - duplicateIssueTriggerWindowMs;
  if (postgresStore) {
    try {
      return await postgresStore.issueTriggerWasRecentlyProcessed(
        webhook.repository.full_name,
        webhook.issue.number,
        webhook.issue.title,
        webhook.issue.body ?? "",
        cutoff
      );
    } catch (err) {
      console.error("Postgres issueTriggerWasRecentlyProcessed error:", err);
    }
  }
  if (!dataDir) return false;
  try {
    for await (const line of readJsonlLines(join(dataDir, "webhook-runs.jsonl"))) {
      let record: PersistedWebhookRunRecord;
      try {
        record = JSON.parse(line) as PersistedWebhookRunRecord;
      } catch {
        continue;
      }
      if (
        record.repository === webhook.repository.full_name &&
        record.run?.issue.issueNumber === webhook.issue.number &&
        record.issueTitle === webhook.issue.title &&
        record.issueBody === (webhook.issue.body ?? "") &&
        Date.parse(record.receivedAt) >= cutoff
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function* readJsonlLines(path: string): AsyncGenerator<string> {
  const maxLineBytes = 4 * 1024 * 1024;
  const input = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  let buffer = "";
  let discardingOversizedLine = false;

  try {
    for await (const chunk of input) {
      let nextChunk = chunk as string;
      if (discardingOversizedLine) {
        const newline = nextChunk.indexOf("\n");
        if (newline < 0) continue;
        discardingOversizedLine = false;
        nextChunk = nextChunk.slice(newline + 1);
      }

      buffer += nextChunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") <= maxLineBytes && line.length > 0) {
          yield line;
        }
        newline = buffer.indexOf("\n");
      }

      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
        buffer = "";
        discardingOversizedLine = true;
      }
    }

    if (!discardingOversizedLine && buffer.length > 0 && Buffer.byteLength(buffer, "utf8") <= maxLineBytes) {
      yield buffer.replace(/\r$/, "");
    }
  } finally {
    input.destroy();
  }
}

/**
 * Reads the newest record from the tail of a JSONL file.
 *
 * The window grows until it holds a complete record. One record can be larger than any
 * fixed window — a candidate patch carries the full text of every file it changes, and a
 * three-file patch against a real repository measured 315 KB against a 256 KB window. When
 * the newest record is larger than the window, every line in that window is a fragment of
 * it, nothing parses, and the run vanishes from the dashboard behind "No persisted webhook
 * runs found" while sitting complete in the file.
 *
 * Records that merely share a window with a larger neighbour were always fine: the window
 * ends at EOF, so the newest record is complete in it whenever it fits at all.
 */
async function readLatestJsonlRecord(dataDir: string, fileName: string): Promise<unknown | undefined> {
  let file;
  try {
    file = await open(join(dataDir, fileName), "r");
    const metadata = await file.stat();
    if (metadata.size === 0) return undefined;

    for (
      let length = Math.min(metadata.size, maxLatestRunReadBytes);
      ;
      length = Math.min(metadata.size, length * 4)
    ) {
      const start = metadata.size - length;
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, start);
      const text = buffer.toString("utf8");

      // A window that starts mid-file opens mid-record; drop that leading fragment rather
      // than letting it parse-fail and be mistaken for a malformed record.
      const firstNewline = text.indexOf("\n");
      const usable = start > 0 ? (firstNewline === -1 ? "" : text.slice(firstNewline + 1)) : text;

      let latest: unknown;
      let latestReceivedAt = Number.NEGATIVE_INFINITY;
      for (const line of usable.split("\n").filter(Boolean)) {
        try {
          const candidate = JSON.parse(line) as unknown;
          const receivedAt = receivedAtTimestamp(candidate);
          if (latest === undefined || receivedAt >= latestReceivedAt) {
            latest = candidate;
            latestReceivedAt = receivedAt;
          }
        } catch {
          // Ignore a partial or malformed trailing line.
        }
      }

      if (latest !== undefined) return latest;
      // Nothing complete in this window: either it opened inside one oversized record, or
      // the tail is malformed. Widen until the whole file has been seen.
      if (length >= metadata.size) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (file) {
      await file.close().catch(() => {});
    }
  }
}

function receivedAtTimestamp(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return Number.NEGATIVE_INFINITY;
  }

  const receivedAt = (value as { receivedAt?: unknown }).receivedAt;
  if (typeof receivedAt !== "string") {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = Date.parse(receivedAt);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function isTrueForgeTurnSettled(events: TrueForgeRuntimeEvent[]): boolean {
  return events.some((event) => event.type === "turn.done" || event.type === "tool.approval_required");
}

function trueForgeTurnError(events: TrueForgeRuntimeEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "turn.done") continue;
    const raw = unwrapRuntimeEvent(event.raw);
    if (!isRecord(raw) || !isRecord(raw.state) || raw.state.status !== "error") continue;
    if (typeof raw.state.message === "string" && raw.state.message.trim()) {
      return clampText(raw.state.message.trim(), 1_000);
    }
    return "TrueForge turn ended with an unspecified provider error";
  }
  return undefined;
}

/**
 * Result submissions the harness refused: the structured-output guard sent a correction, or
 * the tool itself returned an error. A refused submission is not the run's result. Counting
 * it once stopped a live run from ever being asked to resubmit: its model call dropped right
 * after the guard asked for a corrected "3/3", the server took the refused submission as
 * final, judged it, and failed a run whose only fault was a connection error.
 */
function rejectedResultSubmissions(events: TrueForgeRuntimeEvent[]): Set<string> {
  const rejected = new Set<string>();
  let latestSubmissions: string[] = [];
  for (const event of events) {
    const raw = unwrapRuntimeEvent(event.raw);
    if (!isRecord(raw)) continue;
    if (event.type === "model.message") {
      const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      latestSubmissions = toolCalls.flatMap((toolCall) =>
        isRecord(toolCall) &&
        typeof toolCall.id === "string" &&
        isRecord(toolCall.function) &&
        typeof toolCall.function.name === "string" &&
        toolCall.function.name.endsWith("submit_squasher_result")
          ? [toolCall.id]
          : []
      );
      continue;
    }
    if (
      event.type === "squasher.structured_output.guard" &&
      typeof raw.toolName === "string" &&
      raw.toolName.endsWith("submit_squasher_result") &&
      (raw.outcome === "retrying" || raw.outcome === "failed")
    ) {
      for (const id of latestSubmissions) rejected.add(id);
      continue;
    }
    if (event.type === "tool.response" && typeof raw.toolCallId === "string" && typeof raw.content === "string") {
      if (/^\s*\{\s*"error"/.test(raw.content) || /^Rejected before execution/.test(raw.content)) rejected.add(raw.toolCallId);
    }
  }
  return rejected;
}

/**
 * Turn failures worth one more turn in the same session: a token limit, or a transient
 * connection failure that outlasted the model client's own retries. The session still holds
 * the work, so a continuation resumes it rather than discarding it.
 */
function isRecoverableTrueForgeTurnError(message: string): boolean {
  return (
    /max[_ -]?tokens?\s+breached|token\s+(?:budget|limit)/i.test(message) ||
    /Model request failed:.*(?:connection error|timed?\s*out|terminated|ECONNRESET|socket hang up|fetch failed)/i.test(message)
  );
}

function extractTrueForgePendingApproval(
  events: TrueForgeRuntimeEvent[],
  turnId: string,
  expectedPayloadHash: string,
  candidatePatch?: LiveCandidatePatch
): TrueForgePendingApproval | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "tool.approval_required") continue;
    const raw = unwrapRuntimeEvent(event.raw);
    if (!isRecord(raw)) continue;
    const threadId = firstString(raw, ["threadId", "thread_id"]) ?? "main";
    const headOwner = firstString(raw, ["headOwner", "head_owner"]);
    const toolCallRefs = Array.isArray(raw.toolCalls) ? raw.toolCalls : Array.isArray(raw.tool_calls) ? raw.tool_calls : [];

    for (const ref of toolCallRefs) {
      if (!isRecord(ref)) continue;
      const toolCallId = firstString(ref, ["id", "toolCallId", "tool_call_id"]);
      if (!toolCallId) continue;
      const sourceEventId = firstString(ref, ["sourceEventId", "source_event_id"]);
      const toolCall =
        findTrueForgeToolCall(events, toolCallId, sourceEventId) ??
        findTrueForgeToolCall(events, toolCallId);
      if (!toolCall || !toolCall.name.endsWith("create_fix_pull_request")) continue;

      return {
        turnId,
        threadId,
        toolCallId,
        ...(sourceEventId ? { sourceEventId } : {}),
        ...(headOwner ? { headOwner } : {}),
        toolName: "create_fix_pull_request",
        payloadHash: expectedPayloadHash
      };
    }

    const fallbackCall = findTrueForgeToolCallByName(events, "create_fix_pull_request");
    if (fallbackCall) {
      return {
        turnId,
        threadId,
        toolCallId: fallbackCall.id,
        ...(headOwner ? { headOwner } : {}),
        toolName: "create_fix_pull_request",
        payloadHash: expectedPayloadHash
      };
    }
  }
  return undefined;
}

function findTrueForgeToolCallByName(
  events: TrueForgeRuntimeEvent[],
  targetName: string
): { id: string; name: string; arguments: Record<string, unknown> } | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "model.message") continue;
    const raw = unwrapRuntimeEvent(event.raw);
    if (!isRecord(raw)) continue;
    const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall) || typeof toolCall.id !== "string" || !isRecord(toolCall.function)) continue;
      if (typeof toolCall.function.name !== "string" || !toolCall.function.name.endsWith(targetName)) continue;
      return {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseToolArguments(toolCall.function.arguments)
      };
    }
  }
  return undefined;
}

function findTrueForgeToolCall(
  events: TrueForgeRuntimeEvent[],
  toolCallId: string,
  sourceEventId?: string
): { name: string; arguments: Record<string, unknown> } | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "model.message") continue;
    const raw = unwrapRuntimeEvent(event.raw);
    if (!isRecord(raw) || (sourceEventId && raw.id !== sourceEventId)) continue;
    const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall) || toolCall.id !== toolCallId || !isRecord(toolCall.function)) continue;
      if (typeof toolCall.function.name !== "string") continue;
      return {
        name: toolCall.function.name,
        arguments: parseToolArguments(toolCall.function.arguments)
      };
    }
  }
  return undefined;
}

interface ReconcileSessionEventsOptions {
  trueForgeRuntime: SquasherSessionStarter;
  sessionId: string;
  turnId?: string;
  persistTraceEvent?: TrueForgeRuntimeEventListener;
  isSettled?: (events: TrueForgeRuntimeEvent[]) => boolean;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  /** How long the event stream may stay silent before it is treated as hung. */
  idleTimeoutMs?: number;
  ignoreEvents?: TrueForgeRuntimeEvent[];
}

async function reconcileSessionEvents(options: ReconcileSessionEventsOptions): Promise<TrueForgeRuntimeEvent[]> {
  const {
    trueForgeRuntime,
    sessionId,
    turnId,
    persistTraceEvent,
    isSettled = isTrueForgeTurnSettled,
    maxPollAttempts = 60,
    pollIntervalMs = process.env.NODE_ENV === "test" ? 5 : 5000,
    idleTimeoutMs = defaultStreamIdleTimeoutMs,
    ignoreEvents = []
  } = options;

  let allEvents: TrueForgeRuntimeEvent[] = [];
  const seenEventKeys = new Set(ignoreEvents.map(runtimeEventKey));

  const recordEvents = async (incoming: TrueForgeRuntimeEvent[]) => {
    for (const event of incoming) {
      const key = runtimeEventKey(event);
      if (!seenEventKeys.has(key)) {
        seenEventKeys.add(key);
        allEvents.push(event);
        if (persistTraceEvent) {
          await persistTraceEvent(event);
        }
      }
    }
  };

  let streamError: unknown;
  if (turnId && trueForgeRuntime.subscribeToTurn) {
    try {
      // subscribeToTurn has no timeout of its own: the harness's generator terminates once
      // it yields a turn's terminal event, but only if that event is still in its in-memory
      // history. A session reloaded from its snapshot after a restart starts with no history
      // at all -- snapshots deliberately exclude events -- so re-subscribing to a turn from
      // before the restart waits on events that will never arrive.
      //
      // The bound is on silence, not on total duration. A total cap cannot tell a hung
      // stream from a busy one, and killed a healthy run: an investigation that had made 34
      // tool calls over ten minutes was cut off at a five minute ceiling. A stream still
      // delivering events is working however long it has run; one that has delivered nothing
      // for this long is hung.
      const streamed = await withIdleTimeout(
        (touch) =>
          trueForgeRuntime.subscribeToTurn!(sessionId, turnId, async (event) => {
            touch();
            await recordEvents([event]);
          }),
        idleTimeoutMs
      );
      await recordEvents(streamed);
    } catch (err) {
      streamError = err;
      console.warn("TrueForge turn stream dropped; falling back to session event polling", err);
    }
  }

  if (isSettled(allEvents)) {
    return allEvents;
  }

  if (trueForgeRuntime.listSessionEvents) {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      try {
        const listed = await trueForgeRuntime.listSessionEvents(sessionId);
        if (Array.isArray(listed) && listed.length > 0) {
          await recordEvents(listed);
          if (isSettled(allEvents)) {
            return allEvents;
          }
        }
      } catch (pollError) {
        console.warn("Transient TrueForge listSessionEvents error during reconciliation:", pollError);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  if (streamError) {
    throw streamError;
  }

  throw new Error("TrueForge turn did not reach its expected terminal event before reconciliation timed out");
}

/** Rejects with a distinguishable error if `promise` has not settled within `timeoutMs`. */
/**
 * Runs `start`, rejecting only if it goes `idleMs` without reporting activity.
 *
 * `start` receives a `touch` callback and calls it on every sign of life. Work that keeps
 * producing events runs as long as it needs; work that has produced nothing for `idleMs` is
 * treated as hung.
 */
function withIdleTimeout<T>(start: (touch: () => void) => Promise<T>, idleMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };

    const touch = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => finish(() => reject(new Error(`No activity for ${idleMs}ms`))),
        idleMs
      );
    };

    touch();
    start(touch).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function runtimeEventKey(event: TrueForgeRuntimeEvent): string {
  const raw = unwrapRuntimeEvent(event.raw);
  return isRecord(raw) && typeof raw.id === "string"
    ? raw.id
    : `${event.sequenceNumber ?? "seq"}-${event.type}-${createHash("sha256").update(JSON.stringify(raw ?? {})).digest("hex").slice(0, 16)}`;
}

async function monitorTrueForgeTurn(
  dataDir: string | undefined,
  record: PersistedWebhookRunRecord,
  trueForgeRuntime: SquasherSessionStarter,
  githubClient: GitHubRestClientLike | undefined,
  postgresStore?: PostgresStore
): Promise<void> {
  if (!record.trueForge.session?.id || !record.trueForge.turn?.id || !trueForgeRuntime.subscribeToTurn) {
    return;
  }

  try {
    let liveRecord = record;
    let activeTurnId = record.trueForge.turn.id;
    let liveEventIndex = 0;
    const persistTraceEvent: TrueForgeRuntimeEventListener = async (event) => {
      const projected = projectTrueForgeEvent(event, liveEventIndex);
      liveEventIndex += 1;
      if (projected.length === 0) return;
      const previousEvents = liveRecord.trueForge.events ?? [];
      const nextEvents = mergeHarnessEvents(previousEvents, projected);
      if (JSON.stringify(previousEvents) === JSON.stringify(nextEvents)) return;
      liveRecord = {
        ...liveRecord,
        trueForge: {
          ...liveRecord.trueForge,
          events: nextEvents
        }
      };
      await appendUpdatedLiveRecord(dataDir, liveRecord, postgresStore);
    };

    let events = await reconcileSessionEvents({
      trueForgeRuntime,
      sessionId: record.trueForge.session.id,
      turnId: record.trueForge.turn.id,
      persistTraceEvent,
      isSettled: isTrueForgeTurnSettled
    });

    let completed = events.some((event) => event.type === "turn.done");
    let settled = isTrueForgeTurnSettled(events);
    let turnError = trueForgeTurnError(events);
    let result = settled ? extractLiveProofResult(events, record) : undefined;
    if (result) {
      result = await hydratePatchEvidence(result, record, githubClient);
    }
    if (settled && !result && trueForgeRuntime.listSessionEvents) {
      try {
        const persistedEvents = await trueForgeRuntime.listSessionEvents(record.trueForge.session.id);
        if (persistedEvents.length > 0) {
          events = [...events, ...persistedEvents];
          for (const event of persistedEvents) {
            await persistTraceEvent(event);
          }
          result = extractLiveProofResult(events, record);
          if (result) {
            result = await hydratePatchEvidence(result, record, githubClient);
          }
        }
      } catch (error) {
        console.error("TrueForge persisted event refresh failed", error);
      }
    }
    const maxContinuationTurns = 3;
    for (
      let continuationAttempt = 1;
      completed &&
        !result &&
        trueForgeRuntime.requestProofContract &&
        continuationAttempt <= maxContinuationTurns &&
        (!turnError || isRecoverableTrueForgeTurnError(turnError));
      continuationAttempt += 1
    ) {
      try {
        const recoveryTurn = await trueForgeRuntime.requestProofContract(record.trueForge.session.id);
        activeTurnId = recoveryTurn.id;
        liveRecord = {
          ...liveRecord,
          trueForge: {
            ...liveRecord.trueForge,
            status: "started",
            turn: recoveryTurn,
            error: `TrueForge workflow continuation ${continuationAttempt}/${maxContinuationTurns} requested`
          }
        };
        await appendUpdatedLiveRecord(dataDir, liveRecord, postgresStore);

        const recoveryEvents = await reconcileSessionEvents({
          trueForgeRuntime,
          sessionId: record.trueForge.session.id,
          turnId: recoveryTurn.id,
          persistTraceEvent,
          isSettled: isTrueForgeTurnSettled,
          ignoreEvents: events
        });
        events = [...events, ...recoveryEvents];
        completed = events.some((event) => event.type === "turn.done");
        settled = isTrueForgeTurnSettled(events);
        turnError = trueForgeTurnError(recoveryEvents);
        result = settled ? extractLiveProofResult(events, record) : undefined;
        if (result) {
          result = await hydratePatchEvidence(result, record, githubClient);
        }
      } catch (error) {
        console.error("TrueForge workflow continuation failed", error);
        break;
      }
    }
    const eventMetadata = mergeHarnessEvents(
      liveRecord.trueForge.events ?? [],
      events.flatMap((event, index) => projectTrueForgeEvent(event, index))
    );
    const pendingApproval = result?.candidatePatch
      ? extractTrueForgePendingApproval(events, activeTurnId, result.candidatePatch.hash, result.candidatePatch)
      : undefined;
    // An implemented change must have executed its checks too: the whole point of the
    // implementation path is that tests were run, not that code was written.
    const requiresExecutableProof = Boolean(
      result && (provenResultStatuses.has(result.status) || result.candidatePatch)
    );
    // Whether the engineering held up. Deliberately says nothing about GitHub: a verified
    // patch with no approval checkpoint -- because policy refused the write, or the agent
    // never requested it -- is still a verified patch. Folding the checkpoint into this
    // check is what used to report every blocked contribution as a failed run.
    const requirementProblem = result ? requirementsProblem(result) : undefined;
    const proofValid = Boolean(
      result &&
      (!requiresExecutableProof || (hasGenuineProof(result) && hasExecutableProof(eventMetadata))) &&
      !requirementProblem
    );
    if (result && requiresExecutableProof) {
      result = { ...result, proofVerified: proofValid };
    }
    const validResult = proofValid;
    let run = record.run;
    if (settled && validResult && result) {
      run = applyLiveProofResult(run, result, { checkpoint: Boolean(pendingApproval) });
    } else if (settled && canTransition(run.status, "failed")) {
      run = transitionRun(
        run,
        "failed",
        result?.candidatePatch
          ? `The candidate patch did not pass verification: ${requirementProblem ?? "its executed evidence did not hold"}`
          : turnError
            ? `TrueForge turn failed: ${turnError}`
            : "TrueForge completed without a valid squasher.result contract"
      );
    }
    const completedRecord: PersistedWebhookRunRecord = {
      ...liveRecord,
      run,
      trueForge: {
        ...liveRecord.trueForge,
        status: pendingApproval ? "paused" : completed ? "completed" : "started",
        ...(pendingApproval
          ? { error: undefined }
          : settled
            ? validResult
              ? { error: undefined }
              : { error: result?.candidatePatch
                  ? `The candidate patch did not pass verification: ${requirementProblem ?? "its executed evidence did not hold"}`
                  : turnError
                    ? `TrueForge turn failed: ${turnError}`
                    : "TrueForge completed without a valid squasher.result contract" }
          : { error: "TrueForge turn is still running; completion has not been observed" }),
        events: eventMetadata,
        ...(pendingApproval ? { pendingApproval } : {}),
        ...(result ? { result } : {})
      }
    };
    const labeledRecord = await syncLifecycleLabels(completedRecord, githubClient);
    const verifiedRecord = validResult ? await applyVerifiedLabel(labeledRecord, githubClient) : labeledRecord;
    const approvalLabeledRecord = validResult
      ? await applyAwaitingApprovalLabel(verifiedRecord, githubClient)
      : verifiedRecord;
    const commentedRecord = await appendGitHubComment(approvalLabeledRecord, githubClient, validResult ? "completed" : "failed");
    await appendUpdatedLiveRecord(dataDir, commentedRecord, postgresStore);
  } catch (error) {
    console.error("TrueForge turn subscription failed", error);
    let failedRun = record.run;
    if (failedRun.status === "environment-building") {
      failedRun = transitionRun(failedRun, "failed", "TrueForge turn monitoring failed");
    }
    const failedRecord = {
      ...record,
      run: failedRun,
      trueForge: {
        ...record.trueForge,
        status: "failed",
        error: "TrueForge turn monitoring failed"
      }
    } satisfies PersistedWebhookRunRecord;
    const commentedRecord = await appendGitHubComment(failedRecord, githubClient, "failed");
    await appendUpdatedLiveRecord(dataDir, commentedRecord, postgresStore);
  }
}

function projectTrueForgeEvent(event: TrueForgeRuntimeEvent, fallbackIndex = 0): HarnessTraceEvent[] {
  const raw = unwrapRuntimeEvent(event.raw);
  if (!isRecord(raw)) return [];

  const type = typeof raw.type === "string" ? raw.type : event.type;
  const at = typeof raw.created_at === "string"
    ? raw.created_at
    : typeof raw.createdAt === "string"
      ? raw.createdAt
      : new Date().toISOString();
  const eventId = typeof raw.id === "string" ? raw.id : `${event.sequenceNumber ?? "event"}-${type}-${fallbackIndex}`;
  const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
  const base = {
    sequenceNumber: event.sequenceNumber,
    at,
    type,
    source: "trueforge" as const
  };

  if (type === "model.message" && toolCalls.length > 0) {
    return toolCalls.flatMap((toolCall, index) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) return [];
      const name = typeof toolCall.function.name === "string" ? toolCall.function.name : "unknown";
      const args = parseToolArguments(toolCall.function.arguments);
      const category = categoryForTool(name);
      return [{
        ...base,
        id: `${eventId}:tool:${index}`,
        category,
        status: category === "sandbox" ? "running" as const : "info" as const,
        summary: summaryForTool(name, args),
        toolName: name,
        ...(typeof args.path === "string" ? { target: redactHarnessText(args.path) } : {}),
        ...(typeof args.issueNumber === "number" ? { target: `issue #${args.issueNumber}` } : {}),
        ...(typeof args.command === "string" ? { command: redactHarnessText(args.command) } : {}),
        ...(typeof args.sandboxId === "string" ? { sandboxId: args.sandboxId } : {}),
        ...(category === "mcp" ? { mcpServer: "squasher-github" } : {}),
        ...(category === "subagent" ? { subagent: typeof args.name === "string" ? args.name : name } : {})
      }];
    });
  }

  if (type === "model.message") {
    return [{
      ...base,
      id: eventId,
      category: "agent",
      status: "info",
      summary: summarizeAgentMessage(clampText(contentText(raw.content), maxHarnessTextBytes))
    }];
  }

  if (type === "tool.response") {
    const response = parseToolResponse(clampText(contentText(raw.content), maxResultTextBytes));
    const isSandbox = response.exitCode !== undefined || typeof response.result === "string";
    const category: HarnessEventCategory = isSandbox ? "sandbox" : "mcp";
    return [{
      ...base,
      id: eventId,
      category,
      status: response.exitCode !== undefined && response.exitCode !== 0 ? "failed" : "passed",
      summary: isSandbox ? "Sandbox command completed" : "MCP tool response received",
      ...(response.exitCode !== undefined ? { exitCode: response.exitCode } : {}),
      ...(response.stdout ? { stdout: redactHarnessText(response.stdout) } : {}),
      ...(response.stderr ? { stderr: redactHarnessText(response.stderr) } : {})
    }];
  }

  if (type === "tool.approval_required") {
    return [{
      ...base,
      id: eventId,
      category: "approval",
      status: "running",
      summary: "TrueForge paused the GitHub write for maintainer approval",
      toolName: "create_fix_pull_request",
      artifact: "write held"
    }];
  }

  if (type === "sandbox.created") {
    const sandboxId = firstString(raw, ["sandbox_id", "sandboxId", "id"]);
    return [{
      ...base,
      id: eventId,
      category: "sandbox",
      status: "passed",
      summary: "Sandbox created",
      ...(sandboxId ? { sandboxId } : {})
    }];
  }

  if (type.includes("subagent") || type.includes("delegate")) {
    return [{
      ...base,
      id: eventId,
      category: "subagent",
      status: type.includes("failed") ? "failed" : type.includes("created") || type.includes("started") ? "running" : "passed",
      summary: "Specialized agent activity recorded",
      subagent: firstString(raw, ["name", "agent", "subagent"]) ?? "specialized agent"
    }];
  }

  const category: HarnessEventCategory = type.startsWith("mcp.") ? "mcp" : type === "turn.done" || type === "turn.created" ? "session" : "agent";
  return [{
    ...base,
    id: eventId,
    category,
    status: type === "turn.done" ? "passed" : "info",
    summary: summaryForEvent(type)
  }];
}

function mergeHarnessEvents(existing: HarnessTraceEvent[], incoming: HarnessTraceEvent[]): HarnessTraceEvent[] {
  const merged = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) {
    merged.set(event.id, event);
  }
  return [...merged.values()]
    .sort((left, right) => (left.sequenceNumber ?? Number.MAX_SAFE_INTEGER) - (right.sequenceNumber ?? Number.MAX_SAFE_INTEGER))
    .slice(-maxHarnessEvents);
}

function categoryForTool(name: string): HarnessEventCategory {
  if (name === "exec" || name === "shell" || name === "run_command") return "sandbox";
  if (name === "read_issue" || name === "read_file" || name === "submit_squasher_result" || name === "add_verified_label" || name === "comment_on_issue") return "mcp";
  if (name.endsWith("create_fix_pull_request")) return "github";
  if (name.includes("subagent") || name.includes("delegate") || name === "task") return "subagent";
  return "agent";
}

function summaryForTool(name: string, args: Record<string, unknown>): string {
  if (name === "exec" || name === "shell" || name === "run_command") return "Running a command in the sandbox";
  if (name === "read_file") return `Reading ${typeof args.path === "string" ? redactHarnessText(args.path) : "a repository file"} through GitHub MCP`;
  if (name === "read_issue") return `Reading ${typeof args.issueNumber === "number" ? `issue #${args.issueNumber}` : "the GitHub issue"} through GitHub MCP`;
  if (name === "submit_squasher_result") return "Submitting the Squasher proof contract";
  if (name.endsWith("create_fix_pull_request")) return "Preparing the GitHub pull request write for approval";
  if (categoryForTool(name) === "subagent") return `Delegating ${typeof args.name === "string" ? args.name : "a focused task"}`;
  return `Calling ${name}`;
}

function summaryForEvent(type: string): string {
  if (type === "mcp.initialize") return "GitHub MCP connection initialized";
  if (type === "turn.created") return "TrueForge turn created";
  if (type === "turn.done") return "TrueForge turn completed";
  return `${type.replace(/[._-]+/g, " ")} event received`;
}

function summarizeAgentMessage(value: string): string {
  const boundedValue = clampText(value, maxHarnessTextBytes);
  const firstLine = redactHarnessText(boundedValue.replace(/```[\s\S]*?```/g, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "");
  if (!firstLine) return "Agent status update received";
  if (/^(agent finding|observed|evidence|next action|created|reproduced|verified)\b/i.test(firstLine)) {
    return clampText(firstLine, 240);
  }
  return "Agent status update received";
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseToolResponse(value: string): { result?: string; exitCode?: number | null; stdout?: string; stderr?: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    const outer = isRecord(parsed) && isRecord(parsed.response) ? parsed.response : parsed;
    if (!isRecord(outer)) return {};
    const result = typeof outer.result === "string" ? outer.result : undefined;
    const stdout = typeof outer.stdout === "string" ? outer.stdout : result;
    const stderr = typeof outer.stderr === "string" ? outer.stderr : undefined;
    return {
      ...(result ? { result } : {}),
      ...(typeof outer.exitCode === "number" ? { exitCode: outer.exitCode } : {}),
      ...(stdout ? { stdout } : {}),
      ...(stderr ? { stderr } : {})
    };
  } catch {
    return value ? { stdout: value } : {};
  }
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return undefined;
}

function redactHarnessText(value: string): string {
  const boundedValue = clampText(value, maxHarnessTextBytes);
  return clampText(
    boundedValue
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+["']?/gi, "[REDACTED]")
      .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, "[REDACTED]")
      .replace(/\s+/g, " ")
      .trim(),
    maxHarnessTextBytes
  );
}

function extractLiveProofResult(events: TrueForgeRuntimeEvent[], record: PersistedWebhookRunRecord): LiveProofResult | undefined {
  const submittedResult = extractSubmittedSquasherResult(events);
  const doneEvents = events.filter((event) => event.type === "turn.done").reverse();
  const streamedDeltaText = joinBoundedTexts(
    events
      .filter((event) => event.type === "model.message.delta")
      .flatMap((event) => resultOutputTexts(event.raw)),
    maxResultTextBytes
  );
  const outputTexts = [
    ...doneEvents.flatMap((event) => resultOutputTexts(event.raw)),
    ...(streamedDeltaText ? [streamedDeltaText] : []),
    ...events
      .filter((event) => event.type === "model.message")
      .reverse()
      .flatMap((event) => resultOutputTexts(event.raw)),
    ...[...events].reverse().flatMap((event) => resultOutputTexts(event.raw))
  ];
  const parsed = submittedResult ?? outputTexts
    .map((outputText) => parseResultJson(clampText(outputText, maxResultTextBytes)))
    .find((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  if (!parsed) {
    const joinedOutput = outputTexts.join("");
    console.error("TrueForge completion had no parsable proof contract", JSON.stringify({
      outputCount: outputTexts.length,
      outputLengths: outputTexts.map((output) => output.length),
      joinedLength: joinedOutput.length,
      hasResultMarker: joinedOutput.includes("squasher.result"),
      hasCandidatePatch: joinedOutput.includes("candidatePatch"),
      hasKnownStatus: /\"status\"\s*:\s*\"(?:patch-ready|verified|not-reproduced|blocked|failed)\"/.test(joinedOutput),
      hasJsonObject: joinedOutput.includes("{")
    }));
    return undefined;
  }

  const rawCandidatePatch = isRecord(parsed.candidatePatch)
    ? parsed.candidatePatch
    : isCandidatePatchObject(parsed)
      ? parsed
      : undefined;
  const status = parseLiveResultStatus(parsed.status) ?? (rawCandidatePatch ? "patch-ready" : undefined);
  if (!status) {
    return undefined;
  }
  if (provenResultStatuses.has(status) && !submittedResult) {
    console.error("TrueForge positive proof was not submitted through submit_squasher_result");
    return undefined;
  }

  const summary = clampText(typeof parsed.summary === "string" ? parsed.summary : `TrueForge reported ${status}`, 2_000);
  const proof = isRecord(parsed.proof)
    ? {
        ...(typeof parsed.proof.before === "string" ? { before: clampText(parsed.proof.before, 2_000) } : {}),
        ...(typeof parsed.proof.after === "string" ? { after: clampText(parsed.proof.after, 2_000) } : {}),
        ...(typeof parsed.proof.regressions === "string" ? { regressions: clampText(parsed.proof.regressions, 2_000) } : {}),
        // Clamped alongside its sibling proof fields: hasGenuineProof re-checks the N/N
        // count on this stored copy, and a 200-byte cut dropped counts that the model had
        // written later in a longer narrative, failing runs that had genuinely proved 3/3.
        ...(typeof parsed.proof.attempts === "string" ? { attempts: clampText(parsed.proof.attempts, 2_000) } : {})
      }
    : undefined;
  const candidatePatch = provenResultStatuses.has(status)
    ? normalizeCandidatePatch(rawCandidatePatch, record, summary)
    : undefined;

  return {
    // A defect that arrives with a patch is patch-ready whatever it called itself, so a
    // bare "verified" plus a fix still reaches the approval path. An implemented change
    // keeps its own status: collapsing it to patch-ready would relabel work that never
    // reproduced anything as a proven defect.
    status: candidatePatch && bugProofStatuses.has(status) ? "patch-ready" : status,
    summary,
    rootCauseSummary: clampText(
      typeof parsed.rootCauseSummary === "string" ? parsed.rootCauseSummary : summarizeCommentText(summary),
      520
    ),
    rootCauseReported: typeof parsed.rootCauseSummary === "string" && parsed.rootCauseSummary.trim().length > 0,
    ...(typeof parsed.nextStep === "string" && parsed.nextStep.trim() ? { nextStep: clampText(parsed.nextStep.trim(), 520) } : {}),
    ...(Array.isArray(parsed.requirements)
      ? {
          requirements: parsed.requirements
            .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.requirement === "string" && typeof entry.verdict === "string")
            .slice(0, maxResultRequirements)
            .map((entry) => ({
              requirement: clampText(String(entry.requirement).trim(), 400),
              verdict: String(entry.verdict),
              ...(typeof entry.evidence === "string" ? { evidence: clampText(entry.evidence.trim(), 600) } : {}),
              ...recordedEvidence(entry),
              ...(isRecord(entry.ownership) && typeof entry.ownership.status === "string" && typeof entry.ownership.by === "string"
                ? {
                    ownership: {
                      status: entry.ownership.status,
                      by: clampText(entry.ownership.by, 120),
                      ...(typeof entry.ownership.basis === "string" ? { basis: clampText(entry.ownership.basis, 400) } : {})
                    }
                  }
                : {})
            }))
        }
      : {}),
    ...(Array.isArray(parsed.testCommands)
      ? {
          testCommands: parsed.testCommands
            .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.command === "string")
            .slice(0, 8)
            .map((entry) => ({
              command: clampText(String(entry.command).trim(), 1_000),
              ...(typeof entry.purpose === "string" ? { purpose: clampText(entry.purpose.trim(), 300) } : {})
            }))
        }
      : {}),
    ...(Array.isArray(parsed.fileChanges)
      ? {
          fileChanges: parsed.fileChanges
            .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.path === "string" && typeof entry.summary === "string")
            .slice(0, maxPatchFiles)
            .map((entry) => ({
              path: String(entry.path),
              summary: clampText(String(entry.summary).trim(), 800),
              ...(Array.isArray(entry.requirements)
                ? { requirements: entry.requirements.filter((text): text is string => typeof text === "string").slice(0, 12).map((text) => clampText(text, 400)) }
                : {})
            }))
        }
      : {}),
    ...(Array.isArray(parsed.discussionClaims)
      ? {
          discussionClaims: parsed.discussionClaims
            .filter(
              (entry): entry is Record<string, unknown> =>
                isRecord(entry) && typeof entry.claim === "string" && typeof entry.verdict === "string" && typeof entry.evidence === "string"
            )
            .slice(0, maxResultRequirements)
            .map((entry) => ({
              claim: clampText(String(entry.claim).trim(), 400),
              verdict: String(entry.verdict),
              evidence: clampText(String(entry.evidence).trim(), 600),
              ...recordedEvidence(entry)
            }))
        }
      : {}),
    ...(Array.isArray(parsed.findings)
      ? {
          findings: parsed.findings
            .filter((finding): finding is string => typeof finding === "string" && finding.trim().length > 0)
            .slice(0, maxResultFindings)
            .map((finding) => clampText(finding.trim(), 360))
        }
      : {}),
    proposedFixSummary: clampText(
      typeof parsed.proposedFixSummary === "string"
        ? parsed.proposedFixSummary
        : candidatePatch
          ? summarizeCommentText(candidatePatch.body)
          : "No candidate fix was proposed because the proof was incomplete.",
      520
    ),
    ...(proof && Object.keys(proof).length > 0 ? { proof } : {}),
    ...(candidatePatch ? { candidatePatch } : {})
  };
}

function extractSubmittedSquasherResult(events: TrueForgeRuntimeEvent[]): Record<string, unknown> | undefined {
  const rejected = rejectedResultSubmissions(events);
  for (const event of [...events].reverse()) {
    if (event.type !== "model.message") continue;
    const raw = unwrapRuntimeEvent(event.raw);
    if (!isRecord(raw)) continue;
    const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    for (const toolCall of [...toolCalls].reverse()) {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
      if (typeof toolCall.function.name !== "string" || !toolCall.function.name.endsWith("submit_squasher_result")) continue;
      if (typeof toolCall.id === "string" && rejected.has(toolCall.id)) continue;
      const submitted = parseToolArguments(toolCall.function.arguments);
      if (isSquasherResultContract(submitted)) return submitted;
    }
  }
  return undefined;
}

async function hydratePatchEvidence(
  result: LiveProofResult,
  record: PersistedWebhookRunRecord,
  githubClient: GitHubRestClientLike | undefined
): Promise<LiveProofResult> {
  if (!result.candidatePatch || !githubClient || typeof githubClient.getFile !== "function") {
    return result;
  }

  const diffs: Array<{ path: string; before: string; after: string; change: "added" | "modified" }> = [];
  for (const file of result.candidatePatch.files) {
    try {
      const source = await githubClient.getFile(
        record.run.issue.owner,
        record.run.issue.repo,
        file.path,
        result.candidatePatch.baseBranch
      );
      const before = source.encoding.toLowerCase() === "base64"
        ? Buffer.from(source.content.replace(/\s+/g, ""), "base64").toString("utf8")
        : source.content;
      diffs.push({ path: file.path, before, after: file.content, change: "modified" });
    } catch (error) {
      // Absent on the base branch means the patch adds it: an honest, complete diff. Any
      // other failure leaves the file out, so the page says its base is unknown instead.
      if (isRecord(error) && error.status === 404) {
        diffs.push({ path: file.path, before: "", after: file.content, change: "added" });
      } else if (error instanceof Error && / 404 /.test(error.message)) {
        diffs.push({ path: file.path, before: "", after: file.content, change: "added" });
      } else {
        console.warn(`Could not load base content for ${file.path}`, error);
      }
    }
  }

  let baseSha: string | undefined;
  if (typeof githubClient.getBranch === "function") {
    try {
      baseSha = (await githubClient.getBranch(
        record.run.issue.owner,
        record.run.issue.repo,
        result.candidatePatch.baseBranch
      )).commit.sha;
    } catch {
      baseSha = undefined;
    }
  }

  return {
    ...result,
    ...(baseSha ? { baseSha } : {}),
    ...(diffs.length > 0 ? { patchDiff: diffs } : {})
  };
}

function resultOutputTexts(value: unknown): string[] {
  const event = unwrapRuntimeEvent(value);
  if (!isRecord(event)) return [];

  const state = isRecord(event.state) ? event.state : undefined;
  const candidates = [
    state?.output,
    state?.result,
    event.output,
    event.result,
    event.content,
    event.delta,
    event.text,
    event.message,
    event.toolCalls,
    event.tool_calls,
    event.input,
    event.args,
    event.arguments,
    event.payload
  ];

  return candidates.map((candidate) => clampText(contentText(candidate), maxResultTextBytes)).filter((text) => text.length > 0);
}

function joinBoundedTexts(values: string[], maxBytes: number): string {
  let result = "";
  for (const value of values) {
    const remaining = maxBytes - Buffer.byteLength(result, "utf8");
    if (remaining <= 0) break;
    result += clampText(value, remaining);
  }
  return result;
}

function normalizeCandidatePatch(value: unknown, record: PersistedWebhookRunRecord, summary: string): LiveCandidatePatch | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.body !== "string" || !Array.isArray(value.files)) {
    return undefined;
  }
  if (value.files.length === 0 || value.files.length > maxPatchFiles) {
    return undefined;
  }

  const files: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") {
      return undefined;
    }
    if (
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      return undefined;
    }
    const fileBytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += fileBytes;
    if (fileBytes > maxPatchFileBytes || totalBytes > maxPatchTotalBytes) {
      return undefined;
    }
    files.push({ path: file.path, content: file.content });
  }

  const baseBranch = record.baseBranch;
  const branchName = branchNameForIssue(record.run.issue.issueNumber, record.deliveryId);
  const writeArguments = {
    owner: record.run.issue.owner,
    repo: record.run.issue.repo,
    baseBranch,
    branchName,
    title: clampText(value.title, 200),
    body: clampText(value.body || summary, 10_000),
    files
  };

  return {
    title: writeArguments.title,
    body: writeArguments.body,
    baseBranch: writeArguments.baseBranch,
    branchName: writeArguments.branchName,
    files: writeArguments.files,
    hash: approvalPayloadHash("create_fix_pull_request", writeArguments),
    verifiedAt: new Date().toISOString()
  };
}

function branchNameForIssue(issueNumber: number, deliveryId: string): string {
  return `squasher/fix-${issueNumber}-${createHash("sha256").update(deliveryId).digest("hex").slice(0, 10)}`;
}

function applyLiveProofResult(
  run: ReturnType<typeof createRun>,
  result: LiveProofResult,
  options: { checkpoint?: boolean } = {}
) {
  if (result.candidatePatch) {
    // One path to a pull request, shared by both kinds of work: the state machine's names
    // are written for a defect, so an implemented change is narrated for what it actually
    // did rather than as a reproduction it never performed.
    const implemented = implementationStatuses.has(result.status);
    const narration: Partial<Record<string, string>> = implemented
      ? {
          reproducing: "Squasher inspected the repository for the requested change",
          verified: "Squasher confirmed the requested change is implementable here",
          minimizing: "Squasher scoped the change to the smallest surface",
          fixing: "Squasher implemented the requested change",
          validating: "Squasher verified the new behaviour and existing checks"
        }
      : {};

    // Awaiting approval only when a write is actually paused; otherwise the verified patch
    // rests at patch-ready and the contribution status says why it went no further.
    const stages = ["reproducing", "verified", "minimizing", "fixing", "validating", "patch-ready", "awaiting-approval"] as const;
    for (const status of stages) {
      if (status === "awaiting-approval" && options.checkpoint === false) break;
      if (canTransition(run.status, status)) {
        run = transitionRun(run, status, narration[status] ?? `TrueForge proof: ${status}`, {
          evidence: { summary: result.summary, ...(result.proof ? { proof: result.proof } : {}) }
        });
      }
    }
    return run;
  }

  // Understood and declined, which is not the same as a reproduction that failed.
  if (result.status === "not-actionable" && canTransition(run.status, "not-actionable")) {
    return transitionRun(run, "not-actionable", result.summary);
  }

  // Implemented and verified, but no patch survived normalization, so there is nothing to
  // approve. Recorded as verified work rather than dropped silently.
  if (implementationStatuses.has(result.status) && canTransition(run.status, "reproducing")) {
    run = transitionRun(run, "reproducing", "Squasher inspected the repository for the requested change");
    if (canTransition(run.status, "verified")) {
      return transitionRun(run, "verified", result.summary);
    }
  }

  if (result.status === "not-reproduced" && canTransition(run.status, "reproducing")) {
    run = transitionRun(run, "reproducing", "TrueForge attempted reproduction");
    if (canTransition(run.status, "not-reproduced")) {
      return transitionRun(run, "not-reproduced", result.summary);
    }
  }
  if (result.status === "verified" && canTransition(run.status, "reproducing")) {
    run = transitionRun(run, "reproducing", "TrueForge reproduced the issue");
    if (canTransition(run.status, "verified")) {
      return transitionRun(run, "verified", result.summary);
    }
  }
  if ((result.status === "blocked" || result.status === "failed") && canTransition(run.status, "failed")) {
    return transitionRun(run, "failed", result.summary);
  }
  return run;
}

function parseLiveResultStatus(value: unknown): LiveProofResult["status"] | undefined {
  return typeof value === "string" && (squasherResultStatuses as readonly string[]).includes(value)
    ? (value as SquasherResultStatus)
    : undefined;
}

function unwrapRuntimeEvent(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.event)) return value.event;
  if (isRecord(value) && isRecord(value.data)) {
    if (isRecord(value.data.event)) return value.data.event;
    return value.data;
  }
  return value;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if ("content" in value) return contentText(value.content);
    if ("output" in value) return contentText(value.output);
    if ("delta" in value) return contentText(value.delta);
    if (isRecord(value.function) && typeof value.function.arguments === "string") return value.function.arguments;
    if (value.kind === "squasher.result" || isRecord(value.candidatePatch) || isCandidatePatchObject(value)) {
      return JSON.stringify(value);
    }
    return "";
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part)) {
        if (typeof part.text === "string") return part.text;
        if ("content" in part) return contentText(part.content);
        if (isRecord(part.function)) return contentText(part.function.arguments);
      }
      return "";
    })
    .join("");
}

function parseResultJson(text: string): Record<string, unknown> | undefined {
  const candidates = balancedJsonObjects(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (!isRecord(parsed)) continue;
      if (isSquasherResultContract(parsed)) return parsed;
    } catch {
      // Try the next bounded candidate.
    }
  }
  return undefined;
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
  return objects;
}

function isCandidatePatchObject(value: Record<string, unknown>): boolean {
  return typeof value.title === "string" && typeof value.body === "string" && Array.isArray(value.files);
}

function isSquasherResultContract(value: Record<string, unknown>): boolean {
  const proof = isRecord(value.proof) ? value.proof : undefined;
  if (
    value.kind !== "squasher.result" ||
    !parseLiveResultStatus(value.status) ||
    typeof value.summary !== "string" ||
    !proof ||
    !["before", "after", "regressions", "attempts"].every((key) => typeof proof[key] === "string") ||
    !("candidatePatch" in value)
  ) {
    return false;
  }

  return value.candidatePatch === null || (isRecord(value.candidatePatch) && isCandidatePatchObject(value.candidatePatch));
}

function clampText(value: string, maxBytes: number): string {
  if (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const prefix = value.slice(0, maxBytes);
  if (Buffer.byteLength(prefix, "utf8") <= maxBytes) return prefix;
  return Buffer.from(prefix, "utf8").subarray(0, maxBytes).toString("utf8");
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = headerValue(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function dashboardUrlFor(runId: string): string {
  const configuredBase = (process.env.APP_BASE_URL ?? process.env.PUBLIC_BASE_URL)?.trim().replace(/\/+$/, "");
  if (configuredBase) {
    return `${configuredBase}/runs/${encodeURIComponent(runId)}`;
  }

  return `http://localhost/runs/${encodeURIComponent(runId)}`;
}

function requiresExplicitTrigger(): boolean {
  return brandedEnv("REQUIRE_TRIGGER_LABEL") === "true";
}

/** Applied by maintainers to opt an issue in. */
const defaultTriggerLabel = "squasher:run";

/**
 * Pre-rename trigger label. Still honoured: repositories already carry byter:run on their
 * issues and in their issue templates, and a rename that silently stopped triggering those
 * would look like Squasher had simply stopped working.
 */
const legacyTriggerLabel = "byter:run";

function triggerLabel(): string {
  return brandedEnv("TRIGGER_LABEL")?.trim() || defaultTriggerLabel;
}

function hasTriggerLabel(webhook: ReturnType<typeof parseIssueWebhook>): boolean {
  // The configured label plus the pre-rename one, so issues already labelled byter:run
  // keep triggering.
  const targets = new Set([triggerLabel().toLowerCase(), legacyTriggerLabel]);
  if (webhook.action === "labeled" && targets.has(webhook.label?.name?.toLowerCase() ?? "")) {
    return true;
  }
  return (webhook.issue.labels ?? []).some((label) =>
    targets.has((typeof label === "string" ? label : label.name)?.toLowerCase() ?? "")
  );
}

function hasExplicitTrigger(webhook: ReturnType<typeof parseIssueWebhook>): boolean {
  if (/(^|\n)\/squasher\s+run(?:\s|$)/i.test(webhook.issue.body ?? "")) {
    return true;
  }
  return hasTriggerLabel(webhook);
}

function resultStatusFor(actionId: ApprovalActionId) {
  if (actionId === "approve-pr") {
    return "approved";
  }

  if (actionId === "reject-run") {
    return "rejected";
  }

  return "awaiting-approval";
}

function messageFor(actionId: ApprovalActionId): string {
  if (actionId === "approve-pr") {
    return "PR write approval accepted by production API";
  }

  if (actionId === "reject-run") {
    return "Run rejection accepted by production API";
  }

  return "Diff review request accepted by production API";
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicMessage: string
  ) {
    super(publicMessage);
    this.name = "HttpError";
  }
}

function githubClientFromEnv(): GitHubRestClientLike | undefined {
  const githubToken = process.env.GITHUB_TOKEN;
  return githubToken ? new GitHubRestClient({ token: githubToken }) : undefined;
}

function githubMcpHandlerFromEnv(githubClient: GitHubRestClientLike | undefined): McpRequestHandler | undefined {
  const mcpAuthToken = process.env.MCP_AUTH_TOKEN;
  if (!githubClient || !mcpAuthToken) return undefined;

  return createGitHubMcpHttpHandler({
    client: githubClient,
    authToken: mcpAuthToken,
    readOnly: false
  });
}

function trueForgeRuntimeFromEnv(
  githubClient: GitHubRestClientLike | undefined,
  contributions: ContributionRegistry
): SquasherSessionStarter | undefined {
  if (!githubClient || !process.env.DEEPSEEK_API_KEY || !process.env.E2B_API_KEY) {
    return undefined;
  }

  return new SquasherTrueForgeRuntime(
    {
      modelName: process.env.DEEPSEEK_MODEL ?? defaultLlmModel,
      modelProvider: process.env.MODEL_PROVIDER ?? "deepseek"
    },
    SquasherHarness.fromEnv(githubClient, {
      resolveWriteTarget: ({ owner, repo, branchName }) => contributions.decide(owner, repo, branchName)
    })
  );
}

/**
 * Per-server cache of contribution decisions, keyed by repository. Populated once per run at
 * webhook intake and read by the harness when it is about to pause a GitHub write, so the
 * write destination is decided by policy rather than by the model, and GitHub is probed once
 * per run rather than once per tool call.
 */
export class ContributionRegistry {
  private readonly entries = new Map<string, ContributionTarget>();

  private static key(owner: string, repo: string, branchName?: string): string {
    return `${owner}/${repo}`.toLowerCase() + (branchName ? `#${branchName}` : "");
  }

  set(owner: string, repo: string, target: ContributionTarget, branchName?: string): void {
    this.entries.set(ContributionRegistry.key(owner, repo), target);
    if (branchName) this.entries.set(ContributionRegistry.key(owner, repo, branchName), target);
  }

  /** The decision for this run's reserved branch, falling back to the repository's latest. */
  get(owner: string, repo: string, branchName?: string): ContributionTarget | undefined {
    return (
      (branchName ? this.entries.get(ContributionRegistry.key(owner, repo, branchName)) : undefined) ??
      this.entries.get(ContributionRegistry.key(owner, repo))
    );
  }

  decide(owner: string, repo: string, branchName?: string): WriteTargetDecision {
    const target = this.get(owner, repo, branchName);
    if (!target) {
      // No decision was recorded for this repository, so nothing has established that a
      // write is permitted. Fail closed rather than defaulting to the upstream repository.
      return {
        allowed: false,
        reason: `no contribution decision was recorded for ${owner}/${repo}`
      };
    }

    if (!isContributionWritable(target)) {
      return { allowed: false, reason: target.reason };
    }

    const disclose = (target.policySignals ?? []).some((signal) => signal.kind === "ai-disclosure-required");
    return { allowed: true, headOwner: target.headOwner, ...(disclose ? { disclose: true } : {}) };
  }
}

function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
