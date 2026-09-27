import type { GitHubRestClientLike } from "@byter/github-mcp";

/**
 * How a run is allowed to write back to the issue's repository.
 *
 * - own:     the token can push to the upstream repository (today's behaviour).
 * - fork:    no push access; the fix branch lives in a fork and the pull request crosses
 *            the fork boundary. Requires the repository to be allowlisted.
 * - triage:  no GitHub writes at all. Evidence stays local.
 */
export type ContributionMode = "own" | "fork" | "triage";

export interface ContributionPolicyFinding {
  /** Repository path the phrase was found in, for example "CONTRIBUTING.md". */
  path: string;
  /** The matched line, trimmed and clamped, so a maintainer's own words are quoted back. */
  excerpt: string;
}

export interface ContributionTarget {
  mode: ContributionMode;
  /** Account that will hold the fix branch. Equal to the upstream owner in own mode. */
  headOwner: string;
  upstreamPushAccess: boolean;
  /** Why this mode was chosen. Always populated, including on the happy path. */
  reason: string;
  /** True when the upstream repository rejects writes outright. */
  archived: boolean;
  defaultBranch?: string;
  forkUrl?: string;
  policyFindings?: ContributionPolicyFinding[];
  existingPullRequestUrl?: string;
}

export const defaultContributionMode: ContributionMode = "own";

export function configuredContributionMode(env: NodeJS.ProcessEnv = process.env): ContributionMode {
  const raw = env.BYTER_CONTRIBUTION_MODE?.trim().toLowerCase();
  if (raw === "fork" || raw === "triage" || raw === "own") {
    return raw;
  }

  return defaultContributionMode;
}

/**
 * Repositories that may receive a fork-based pull request. Fails closed: an empty or absent
 * allowlist means no foreign repository is eligible, whatever the mode says.
 */
export function upstreamAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.BYTER_UPSTREAM_ALLOWLIST ?? "")
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
  const findings: ContributionPolicyFinding[] = [];

  for (const path of paths) {
    let text: string;
    try {
      const file = await client.getFile(owner, repo, path);
      text = decodeFileContent(file);
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }

      findings.push({
        path,
        excerpt: `Could not be read, so its contribution policy is unknown: ${errorMessage(error)}`
      });
      continue;
    }

    for (const line of text.split(/\r?\n/)) {
      if (policyPatterns.some((pattern) => pattern.test(line))) {
        findings.push({ path, excerpt: clampExcerpt(line) });
        break;
      }
    }
  }

  return findings;
}

/**
 * Resolves where a run may write. Probes the upstream repository once; every later decision
 * reads this result rather than re-querying GitHub.
 */
export async function resolveContributionTarget(input: {
  client: GitHubRestClientLike;
  owner: string;
  repo: string;
  mode?: ContributionMode;
  allowlist?: string[];
}): Promise<ContributionTarget> {
  const { client, owner, repo } = input;
  const mode = input.mode ?? configuredContributionMode();
  const allowlist = input.allowlist ?? upstreamAllowlist();

  const triage = (reason: string, extra: Partial<ContributionTarget> = {}): ContributionTarget => ({
    mode: "triage",
    headOwner: owner,
    upstreamPushAccess: false,
    archived: false,
    reason,
    ...extra
  });

  if (mode === "triage") {
    return triage("BYTER_CONTRIBUTION_MODE is triage, so no GitHub write is attempted");
  }

  if (!client.getRepository) {
    // An injected client without a probe cannot be reasoned about; preserve today's
    // behaviour rather than silently downgrading an own-repo deployment to triage.
    return {
      mode: "own",
      headOwner: owner,
      upstreamPushAccess: true,
      archived: false,
      reason: "GitHub client does not expose repository metadata; assuming direct push access"
    };
  }

  let probe: Awaited<ReturnType<NonNullable<GitHubRestClientLike["getRepository"]>>>;
  try {
    probe = await client.getRepository(owner, repo);
  } catch (error) {
    return triage(`Upstream repository could not be read: ${errorMessage(error)}`);
  }

  const upstreamPushAccess = probe.permissions?.push === true;
  const archived = probe.archived === true || probe.disabled === true;

  if (archived) {
    return triage("Upstream repository is archived or disabled, so it rejects all writes", {
      archived: true,
      defaultBranch: probe.default_branch
    });
  }

  if (upstreamPushAccess) {
    // Direct access, so a fork would be both impossible and pointless.
    return {
      mode: "own",
      headOwner: owner,
      upstreamPushAccess: true,
      archived: false,
      defaultBranch: probe.default_branch,
      reason: "Token has push access to the upstream repository"
    };
  }

  if (mode === "own") {
    return triage(
      "Token has no push access and BYTER_CONTRIBUTION_MODE is own; set it to fork to contribute through a fork",
      { defaultBranch: probe.default_branch }
    );
  }

  if (!isUpstreamAllowlisted(owner, repo, allowlist)) {
    return triage(
      `${owner}/${repo} is not in BYTER_UPSTREAM_ALLOWLIST, so a fork-based pull request is not permitted`,
      { defaultBranch: probe.default_branch }
    );
  }

  if (!client.getAuthenticatedUser || !client.forkRepository) {
    return triage("GitHub client cannot create forks, so a fork-based pull request is not possible", {
      defaultBranch: probe.default_branch
    });
  }

  const policyFindings = await scanContributionPolicy(client, owner, repo);
  if (policyFindings.length > 0) {
    return triage("The project's own contribution documents refuse automated contributions", {
      defaultBranch: probe.default_branch,
      policyFindings
    });
  }

  let login: string;
  try {
    login = (await client.getAuthenticatedUser()).login;
  } catch (error) {
    return triage(`Could not identify the authenticated GitHub account: ${errorMessage(error)}`, {
      defaultBranch: probe.default_branch
    });
  }

  if (login.toLowerCase() === owner.toLowerCase()) {
    return triage("A repository cannot be forked into the account that already owns it", {
      defaultBranch: probe.default_branch
    });
  }

  const existing = await findOpenByterPullRequest(client, owner, repo, login);
  if (existing) {
    return triage(`A Byter pull request is already open for this repository: ${existing}`, {
      defaultBranch: probe.default_branch,
      existingPullRequestUrl: existing
    });
  }

  let forkUrl: string | undefined;
  try {
    const fork = await client.forkRepository(owner, repo);
    forkUrl = fork.html_url;
  } catch (error) {
    return triage(`Fork could not be created: ${errorMessage(error)}`, {
      defaultBranch: probe.default_branch
    });
  }

  return {
    mode: "fork",
    headOwner: login,
    upstreamPushAccess: false,
    archived: false,
    defaultBranch: probe.default_branch,
    forkUrl,
    reason: `No push access to ${owner}/${repo}; contributing from fork ${login}/${repo}`
  };
}

/** One open Byter pull request per upstream repository, so a repeat run cannot pile on. */
export async function findOpenByterPullRequest(
  client: GitHubRestClientLike,
  owner: string,
  repo: string,
  headOwner: string
): Promise<string | undefined> {
  if (!client.listPullRequests) {
    return undefined;
  }

  try {
    const open = await client.listPullRequests(owner, repo, { state: "open" });
    const match = open.find(
      (pullRequest) =>
        pullRequest.head.label.toLowerCase().startsWith(`${headOwner.toLowerCase()}:`) &&
        pullRequest.head.ref.startsWith("byter/")
    );
    return match?.html_url;
  } catch {
    // A listing failure must not be read as "no pull request exists": that is the direction
    // that duplicates. Treat it as a blocker by reporting a sentinel the caller surfaces.
    return "unknown (GitHub did not return the open pull request list)";
  }
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
