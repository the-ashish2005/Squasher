import type { GitHubRestClientLike } from "@squasher/github-mcp";
import { brandedEnv } from "./env.js";

/**
 * How a run may submit its verified change to GitHub. None of these affect the engineering
 * work itself: every mode investigates, implements, tests and verifies the same way, and
 * only the final contribution step differs.
 *
 * - fork:    the default. With push access the change goes straight to the upstream
 *            repository; without it, the fix branch lives in a fork and the pull request
 *            crosses the fork boundary, provided the repository is allowlisted.
 * - own:     only repositories the token can push to receive a pull request.
 * - triage:  never submit automatically. The verified patch is kept for a person to use.
 */
export type ContributionMode = "own" | "fork" | "triage";

export interface ContributionPolicyFinding {
  /** Repository path the phrase was found in, for example "CONTRIBUTING.md". */
  path: string;
  /** The matched line, trimmed and clamped, so a maintainer's own words are quoted back. */
  excerpt: string;
}

/**
 * What a repository's own documents say about contributions like this one. Only the two
 * prohibitions block an automatic write; the rest shape how a human proceeds.
 *
 * - ai-prohibited / bots-prohibited: an explicit refusal of AI-generated or bot contributions.
 * - ai-disclosure-required:          AI assistance must be disclosed.
 * - ai-assistance-allowed:           AI assistance is explicitly welcome.
 * - human-assignment-required:       contributors must claim the issue and be assigned first.
 * - unreadable:                      a policy document exists but could not be read.
 */
export type ContributionPolicyKind =
  | "ai-prohibited"
  | "bots-prohibited"
  | "ai-disclosure-required"
  | "ai-assistance-allowed"
  | "human-assignment-required"
  | "unreadable";

export interface ContributionPolicySignal extends ContributionPolicyFinding {
  kind: ContributionPolicyKind;
}

/**
 * Why a contribution cannot be submitted.
 *
 * - configuration: the operator's own settings forbid it (triage mode, own mode without
 *                  push access, not allowlisted, an explicit open pull request cap).
 * - policy:        the project's documents refuse automated contributions.
 * - duplicate:     a Squasher pull request for this same issue is already open.
 * - capability:    it is not technically possible (no client, archived, no access, fork failed).
 */
export type ContributionBlockerKind = "configuration" | "policy" | "duplicate" | "capability";

export interface ContributionBlocker {
  kind: ContributionBlockerKind;
  reason: string;
  /** What a person can do about it. */
  action: string;
}

/**
 * Everything the contribution preflight looked at. Recorded whatever the outcome, so a page
 * can say exactly why a verified patch did or did not become a pull request. `null` means
 * the check did not apply or was not reached.
 */
export interface ContributionPreflight {
  mode: ContributionMode;
  checkedAt: string;
  authenticated: boolean | null;
  account?: string;
  pushAccess: boolean | null;
  archived: boolean | null;
  allowlisted: boolean | null;
  forkCapable: boolean | null;
  policyReviewed: boolean;
  policyFindings: number;
  /** An open Squasher pull request for this same issue, if one exists. */
  duplicatePullRequest: string | null;
  /** This account's open Squasher pull requests on the repository, when they were listed. */
  openSquasherPullRequests: number | null;
}

export interface ContributionTarget {
  /** The configured mode, or own when the token turned out to have push access. */
  mode: ContributionMode;
  /**
   * Whether an approved write may land. Records written before this field existed encoded a
   * refusal as mode "triage"; read it through isContributionWritable, never directly.
   */
  writable?: boolean;
  /** Account that will hold the fix branch. Equal to the upstream owner in own mode. */
  headOwner: string;
  upstreamPushAccess: boolean;
  /** Why the contribution is possible, or the first reason it is not. Always populated. */
  reason: string;
  /** Every reason the contribution is not possible, first one first. Empty when writable. */
  blockers?: ContributionBlocker[];
  /** True when the upstream repository rejects writes outright. */
  archived: boolean;
  defaultBranch?: string;
  forkUrl?: string;
  policyFindings?: ContributionPolicyFinding[];
  existingPullRequestUrl?: string;
  preflight?: ContributionPreflight;
  /** Every policy statement the preflight found, blocking or not. Absent on older records. */
  policySignals?: ContributionPolicySignal[];
}

/**
 * Whether a recorded decision permits a write. Before `writable` existed a refusal was
 * recorded by rewriting the mode to "triage", so an absent flag falls back to that.
 */
export function isContributionWritable(target: Pick<ContributionTarget, "mode" | "writable"> | undefined): boolean {
  if (!target) return false;
  return target.writable ?? target.mode !== "triage";
}

/** Fork is the default: it contributes directly where the token has push access anyway. */
export const defaultContributionMode: ContributionMode = "fork";

export function configuredContributionMode(env: NodeJS.ProcessEnv = process.env): ContributionMode {
  const raw = brandedEnv("CONTRIBUTION_MODE", env)?.trim().toLowerCase();
  if (raw === "fork" || raw === "triage" || raw === "own") {
    return raw;
  }

  return defaultContributionMode;
}

/**
 * Repositories that may receive an automatic fork-based pull request. This authorises the
 * GitHub write only: a repository that is not listed is still investigated, implemented and
 * verified, and its patch is kept. Empty means no foreign repository is eligible.
 */
export function upstreamAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (brandedEnv("UPSTREAM_ALLOWLIST", env) ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function isUpstreamAllowlisted(
  owner: string,
  repo: string,
  allowlist: string[] = upstreamAllowlist()
): boolean {
  return allowlist.includes(`${owner}/${repo}`.toLowerCase());
}

/**
 * An optional cap on how many of this account's Squasher pull requests may be open on one
 * repository at once. Unset means no repository-wide cap: duplicates are prevented per issue
 * instead, so a pull request for #42 never blocks a separate fix for #43. An operator who
 * wants the old courtesy limit sets it explicitly.
 *
 * Anything that is not a positive whole number is treated as unset rather than as zero,
 * because a mistyped cap must not silently block every contribution.
 */
export function maxOpenPullRequests(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = brandedEnv("MAX_OPEN_PULL_REQUESTS", env)?.trim();
  if (!raw) return undefined;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Files where a project is likely to state a contribution policy. */
export const policyProbePaths = [
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "README.md"
];

/**
 * Phrases that state an explicit refusal of machine-generated contributions. This is a
 * keyword scan, not comprehension: it will miss wording it does not recognise, and a clean
 * scan is not evidence that a project welcomes automated pull requests. It errs toward
 * blocking, because a false block costs one skipped contribution while a false pass costs
 * a maintainer's goodwill.
 */
const policyPatterns: RegExp[] = [
  /\bno\s+ai[-\s]generated\b/i,
  /\bno\s+llm[-\s]generated\b/i,
  /\bno\s+machine[-\s]generated\b/i,
  /\bai[-\s](?:generated|assisted)\s+(?:code|content|contributions?|pull\s+requests?|prs?)\s+(?:are|is)\s+(?:not\s+(?:accepted|allowed|permitted|welcome)|prohibited|banned|forbidden|rejected)/i,
  /\b(?:do\s+not|don't|doesn't|does\s+not)\s+accept\s+(?:any\s+)?(?:ai|llm|machine)[-\s](?:generated|assisted|written)\b/i,
  /\bplease\s+(?:do\s+not|don't)\s+(?:submit|open|send|file)\s+(?:any\s+)?(?:ai|llm|machine|bot)[-\s]?(?:generated|assisted|written)?\b/i,
  /\b(?:ai|llm|bot)[-\s]?(?:generated\s+)?(?:pull\s+requests?|prs?|patches)\s+will\s+be\s+(?:closed|rejected|ignored)/i,
  /\bno\s+(?:chatgpt|copilot|claude|gemini|llm)[-\s](?:generated|assisted|written)\b/i
];

/**
 * Statements that shape a contribution without refusing it. A bare mention of AI matches
 * none of these: each needs an instruction (disclose, welcome, assign) tied to it.
 */
const botRefusalPattern = /\b(?:bots?|automated)[-\s]?(?:generated\s+)?(?:pull\s+requests?|prs?|patches|contributions?)\s+(?:are|is|will\s+be)\s+(?:not\s+(?:accepted|allowed|permitted|welcome)|closed|rejected|ignored|prohibited|banned)/i;
const disclosurePatterns: RegExp[] = [
  /\b(?:disclose|disclosure\s+of|declare|state|indicate|label|mark)\b[^.\n]{0,60}\b(?:ai|llm|machine|generative|copilot|chatgpt|claude)\b/i,
  /\b(?:ai|llm|machine)[-\s](?:assisted|generated)\b[^.\n]{0,80}\b(?:must|should|please)\b[^.\n]{0,40}\b(?:be\s+)?(?:disclosed|declared|labell?ed|marked|mentioned)\b/i
];
const allowancePatterns: RegExp[] = [
  /\b(?:ai|llm)[-\s]?(?:assisted|generated)?\s+(?:contributions?|code|tools?|assistance)\s+(?:are|is)\s+(?:welcome|allowed|permitted|accepted|fine)\b/i,
  /\byou\s+(?:may|can)\s+use\s+(?:ai|llms?|copilot|chatgpt|claude)\b/i
];
const assignmentPatterns: RegExp[] = [
  /\b(?:comment|ask)\b[^.\n]{0,80}\bassign(?:ed)?\b/i,
  /\b(?:get|be|wait\s+to\s+be|until\s+you\s+are)\s+assigned\b/i,
  /\bclaim(?:ed)?\b[^.\n]{0,60}\bassign/i
];

/** Classifies one line of a policy document, or undefined when it says nothing relevant. */
export function classifyPolicyLine(line: string): ContributionPolicyKind | undefined {
  if (botRefusalPattern.test(line)) return "bots-prohibited";
  if (policyPatterns.some((pattern) => pattern.test(line))) {
    return /\bbots?\b/i.test(line) && !/\b(?:ai|llm|machine)\b/i.test(line) ? "bots-prohibited" : "ai-prohibited";
  }
  if (disclosurePatterns.some((pattern) => pattern.test(line))) return "ai-disclosure-required";
  if (allowancePatterns.some((pattern) => pattern.test(line))) return "ai-assistance-allowed";
  if (assignmentPatterns.some((pattern) => pattern.test(line))) return "human-assignment-required";
  return undefined;
}

/** Kinds that forbid an automatic write outright. */
export const blockingPolicyKinds: ReadonlySet<ContributionPolicyKind> = new Set(["ai-prohibited", "bots-prohibited", "unreadable"]);

/**
 * Reads the project's own contribution documents and classifies what they say, one signal
 * per kind per document, quoting the maintainer's own line. Missing files say nothing. A
 * read failure other than a missing file is a signal of its own, so an unreadable policy is
 * never mistaken for no policy.
 */
export async function readContributionPolicy(
  client: Pick<GitHubRestClientLike, "getFile">,
  owner: string,
  repo: string,
  paths: string[] = policyProbePaths
): Promise<ContributionPolicySignal[]> {
  const signals: ContributionPolicySignal[] = [];

  for (const path of paths) {
    let text: string;
    try {
      const file = await client.getFile(owner, repo, path);
      text = decodeFileContent(file);
    } catch (error) {
      if (isNotFound(error)) continue;
      signals.push({
        kind: "unreadable",
        path,
        excerpt: `Could not be read, so its contribution policy is unknown: ${errorMessage(error)}`
      });
      continue;
    }

    const seen = new Set<ContributionPolicyKind>();
    for (const line of text.split(/\r?\n/)) {
      const kind = classifyPolicyLine(line);
      if (kind && !seen.has(kind)) {
        seen.add(kind);
        signals.push({ kind, path, excerpt: clampExcerpt(line) });
      }
    }
  }

  return signals;
}

/**
 * Reads the project's own contribution documents and looks for an explicit refusal of
 * automated contributions. Missing files are not findings. Read failures other than a
 * missing file are reported as findings so an unreadable policy never silently passes.
 */
export async function scanContributionPolicy(
  client: Pick<GitHubRestClientLike, "getFile">,
  owner: string,
  repo: string,
  paths: string[] = policyProbePaths
): Promise<ContributionPolicyFinding[]> {
  return blockingFindings(await readContributionPolicy(client, owner, repo, paths));
}

function blockingFindings(signals: ContributionPolicySignal[]): ContributionPolicyFinding[] {
  const findings: ContributionPolicyFinding[] = [];
  const perPath = new Set<string>();
  for (const signal of signals) {
    // One refusal per document, as before: the first is enough to quote.
    if (!blockingPolicyKinds.has(signal.kind) || perPath.has(signal.path)) continue;
    perPath.add(signal.path);
    findings.push({ path: signal.path, excerpt: signal.excerpt });
  }
  return findings;
}

/**
 * The contribution preflight: resolves whether, and where, a verified patch for this issue
 * may be submitted. It never decides whether the issue is worked on; a refusal here only
 * changes how the final contribution step behaves.
 *
 * Read-only checks all run so the page can report the full picture; the one write this
 * performs, creating the fork in the user's own account, happens only once every other
 * check has passed, and early so a large fork has finished importing by the time a
 * maintainer approves.
 */
export async function resolveContributionTarget(input: {
  client: GitHubRestClientLike;
  owner: string;
  repo: string;
  /** The issue being worked on; duplicate detection is per issue. */
  issueNumber?: number;
  mode?: ContributionMode;
  allowlist?: string[];
  /** Overrides SQUASHER_MAX_OPEN_PULL_REQUESTS; mainly so tests need not touch the environment. */
  maxOpenPullRequests?: number;
  now?: () => Date;
}): Promise<ContributionTarget> {
  const { client, owner, repo, issueNumber } = input;
  const mode = input.mode ?? configuredContributionMode();
  const allowlist = input.allowlist ?? upstreamAllowlist();
  const cap = input.maxOpenPullRequests ?? maxOpenPullRequests();
  const preflight: ContributionPreflight = {
    mode,
    checkedAt: (input.now?.() ?? new Date()).toISOString(),
    authenticated: null,
    pushAccess: null,
    archived: null,
    allowlisted: null,
    forkCapable: null,
    policyReviewed: false,
    policyFindings: 0,
    duplicatePullRequest: null,
    openSquasherPullRequests: null
  };
  const blockers: ContributionBlocker[] = [];
  const block = (kind: ContributionBlockerKind, reason: string, action: string) => {
    blockers.push({ kind, reason, action });
  };

  if (mode === "triage") {
    // Explicitly submission-disabled. No probe: nothing will be written, so nothing needs
    // to be known about write access.
    return refused(
      { mode, headOwner: owner, upstreamPushAccess: false, archived: false, preflight },
      [
        {
          kind: "configuration",
          reason: "SQUASHER_CONTRIBUTION_MODE is triage, so the verified patch is kept rather than submitted",
          action: "Set SQUASHER_CONTRIBUTION_MODE to fork (the default) and re-run the issue to submit it"
        }
      ]
    );
  }

  if (!client.getRepository) {
    // An injected client without a probe cannot be reasoned about; preserve the old
    // behaviour rather than silently refusing an own-repo deployment.
    return {
      mode: "own",
      writable: true,
      headOwner: owner,
      upstreamPushAccess: true,
      archived: false,
      reason: "GitHub client does not expose repository metadata; assuming direct push access",
      blockers: [],
      preflight: { ...preflight, pushAccess: true }
    };
  }

  let probe: Awaited<ReturnType<NonNullable<GitHubRestClientLike["getRepository"]>>>;
  try {
    probe = await client.getRepository(owner, repo);
  } catch (error) {
    return refused({ mode, headOwner: owner, upstreamPushAccess: false, archived: false, preflight }, [
      {
        kind: "capability",
        reason: `Upstream repository could not be read: ${errorMessage(error)}`,
        action: "Check GITHUB_TOKEN can read the repository, then re-run the issue"
      }
    ]);
  }

  const upstreamPushAccess = probe.permissions?.push === true;
  const archived = probe.archived === true || probe.disabled === true;
  preflight.pushAccess = upstreamPushAccess;
  preflight.archived = archived;
  const base = { defaultBranch: probe.default_branch, archived, upstreamPushAccess };

  if (archived) {
    return refused({ mode, headOwner: owner, ...base, preflight }, [
      {
        kind: "capability",
        reason: "Upstream repository is archived or disabled, so it rejects all writes",
        action: "Nothing can be submitted there; share the patch by other means if it is still useful"
      }
    ]);
  }

  // Read-only checks first, whatever the mode resolves to, so the record shows the whole
  // picture rather than the first refusal only.
  const policySignals = await readContributionPolicy(client, owner, repo);
  const policyFindings = blockingFindings(policySignals);
  preflight.policyReviewed = true;
  preflight.policyFindings = policyFindings.length;

  let login: string | undefined;
  if (client.getAuthenticatedUser) {
    try {
      login = (await client.getAuthenticatedUser()).login;
      preflight.authenticated = true;
      preflight.account = login;
    } catch (error) {
      preflight.authenticated = false;
      if (!upstreamPushAccess) {
        block(
          "capability",
          `Could not identify the authenticated GitHub account: ${errorMessage(error)}`,
          "Check GITHUB_TOKEN is valid, then re-run the issue"
        );
      }
    }
  }

  const effectiveMode: ContributionMode = upstreamPushAccess ? "own" : mode;
  const headOwner = upstreamPushAccess ? owner : login ?? owner;

  if (!upstreamPushAccess) {
    if (mode === "own") {
      block(
        "configuration",
        "Token has no push access and SQUASHER_CONTRIBUTION_MODE is own; set it to fork to contribute through a fork",
        "Set SQUASHER_CONTRIBUTION_MODE to fork, allowlist the repository, and re-run the issue"
      );
    } else {
      preflight.allowlisted = isUpstreamAllowlisted(owner, repo, allowlist);
      preflight.forkCapable = Boolean(client.forkRepository && client.getAuthenticatedUser) && (!login || login.toLowerCase() !== owner.toLowerCase());
      if (!preflight.allowlisted) {
        block(
          "configuration",
          `${owner}/${repo} is not in SQUASHER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted`,
          `Add ${owner}/${repo} to SQUASHER_UPSTREAM_ALLOWLIST after reading its contribution guidelines, then re-run the issue`
        );
      }
      if (!client.getAuthenticatedUser || !client.forkRepository) {
        block(
          "capability",
          "GitHub client cannot create forks, so a fork-based pull request is not possible",
          "Use a GitHub client and token that can fork repositories"
        );
      } else if (login && login.toLowerCase() === owner.toLowerCase()) {
        block(
          "capability",
          "A repository cannot be forked into the account that already owns it",
          "Grant the token push access to the repository instead"
        );
      }
    }
  }

  if (policyFindings.length > 0) {
    block(
      "policy",
      "The project's own contribution documents refuse automated contributions",
      "Do not submit this automatically; a person may still use the verified patch if the project allows it"
    );
  }

  // Duplicates are per issue. A repository-wide count only applies when the operator set a cap.
  if (login || upstreamPushAccess) {
    const open = await scanOpenSquasherPullRequests(client, owner, repo, headOwner, issueNumber);
    if (open.unreadable) {
      block(
        "capability",
        "GitHub did not return the open pull request list, so an existing pull request for this issue cannot be ruled out",
        "Re-run the issue once GitHub is reachable"
      );
    } else {
      preflight.openSquasherPullRequests = open.urls.length;
      preflight.duplicatePullRequest = open.forIssue[0] ?? null;
      if (open.forIssue[0]) {
        block(
          "duplicate",
          `A Squasher pull request for issue #${issueNumber} is already open: ${open.forIssue[0]}`,
          "Review or close that pull request before submitting another for the same issue"
        );
      } else if (cap !== undefined && open.urls.length >= cap) {
        block(
          "configuration",
          `${open.urls.length} Squasher pull request${open.urls.length === 1 ? " is" : "s are"} already open for this repository, at the SQUASHER_MAX_OPEN_PULL_REQUESTS limit of ${cap}: ${open.urls.join(", ")}`,
          "Wait for those to close, or raise or unset SQUASHER_MAX_OPEN_PULL_REQUESTS"
        );
      }
    }
  }

  const common = {
    mode: effectiveMode,
    headOwner,
    ...base,
    preflight,
    policySignals,
    ...(policyFindings.length > 0 ? { policyFindings } : {}),
    ...(preflight.duplicatePullRequest ? { existingPullRequestUrl: preflight.duplicatePullRequest } : {})
  };

  if (blockers.length > 0) {
    return refused(common, blockers);
  }

  if (upstreamPushAccess) {
    // Direct access, so a fork would be both impossible and pointless.
    return { ...common, writable: true, blockers: [], reason: "Token has push access to the upstream repository" };
  }

  // Every read-only check passed; only now is anything created in the user's account.
  let forkUrl: string | undefined;
  try {
    const fork = await client.forkRepository!(owner, repo);
    forkUrl = fork.html_url;
  } catch (error) {
    preflight.forkCapable = false;
    return refused(common, [
      {
        kind: "capability",
        reason: `Fork could not be created: ${errorMessage(error)}`,
        action: "Check the token is a classic PAT with public_repo and that the repository allows forking, then re-run"
      }
    ]);
  }

  return {
    ...common,
    writable: true,
    blockers: [],
    forkUrl,
    reason: `No push access to ${owner}/${repo}; contributing from fork ${headOwner}/${repo}`
  };
}

function refused(
  target: Omit<ContributionTarget, "writable" | "reason" | "blockers">,
  blockers: ContributionBlocker[]
): ContributionTarget {
  return { ...target, writable: false, blockers, reason: blockers[0]?.reason ?? "Contribution is not possible" };
}

export interface OpenPullRequestScan {
  /** This account's open Squasher pull requests on the upstream repository. */
  urls: string[];
  /** The subset that belong to the issue being worked on. */
  forIssue: string[];
  /** True when the listing could not be read, so the count is unknown and must block. */
  unreadable: boolean;
}

/**
 * Lists this account's open Squasher pull requests on one repository, and which of them are
 * for the given issue. A pull request belongs to an issue when its branch is the reserved
 * squasher/fix-<issue>-… name, or when its body closes that issue.
 */
export async function scanOpenSquasherPullRequests(
  client: GitHubRestClientLike,
  owner: string,
  repo: string,
  headOwner: string,
  issueNumber?: number
): Promise<OpenPullRequestScan> {
  if (!client.listPullRequests) {
    // Without a listing there is nothing to count, and no basis to block either.
    return { urls: [], forIssue: [], unreadable: false };
  }

  try {
    const open = await client.listPullRequests(owner, repo, { state: "open" });
    const mine = open.filter(
      (pullRequest) =>
        pullRequest.head.label.toLowerCase().startsWith(`${headOwner.toLowerCase()}:`) &&
        // squasher/ is the current prefix; byter/ is what pre-rename runs opened, and a
        // pull request still open under that name counts just the same.
        (pullRequest.head.ref.startsWith("squasher/") || pullRequest.head.ref.startsWith("byter/"))
    );
    const forIssue =
      issueNumber === undefined
        ? []
        : mine.filter((pullRequest) => pullRequestIssueNumber(pullRequest) === issueNumber).map((pullRequest) => pullRequest.html_url);
    return { urls: mine.map((pullRequest) => pullRequest.html_url), forIssue, unreadable: false };
  } catch {
    // A listing failure must not be read as "none are open": that is the direction that
    // duplicates. Report it so the caller blocks on an unknown count.
    return { urls: [], forIssue: [], unreadable: true };
  }
}

/** The issue a Squasher pull request is for, from its reserved branch name or its body. */
export function pullRequestIssueNumber(pullRequest: { head: { ref: string }; body?: string | null }): number | undefined {
  const fromBranch = /^(?:squasher|byter)\/fix-(\d+)(?:-|$)/.exec(pullRequest.head.ref)?.[1];
  if (fromBranch) return Number(fromBranch);
  const fromBody = pullRequest.body ? /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(pullRequest.body)?.[1] : undefined;
  return fromBody ? Number(fromBody) : undefined;
}

function decodeFileContent(file: { content: string; encoding: string }): string {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64").toString("utf8");
  }

  return file.content;
}

function clampExcerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
}

function isNotFound(error: unknown): boolean {
  if (error && typeof error === "object" && (error as { status?: number }).status === 404) {
    return true;
  }

  return error instanceof Error && / 404 /.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
