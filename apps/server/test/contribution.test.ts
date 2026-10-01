import { describe, expect, it, vi } from "vitest";
import {
  configuredContributionMode,
  isContributionWritable,
  isUpstreamAllowlisted,
  pullRequestIssueNumber,
  maxOpenPullRequests,
  resolveContributionTarget,
  scanContributionPolicy,
  scanOpenSquasherPullRequests,
  upstreamAllowlist
} from "../src/contribution.js";

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function notFound(): Error {
  return Object.assign(new Error("GitHub API 404 Not Found: {}"), { status: 404 });
}

/** A client where every file probe misses, so the policy scan finds nothing. */
function noPolicyFiles() {
  return vi.fn().mockRejectedValue(notFound());
}

function clientFor(options: {
  push?: boolean;
  archived?: boolean;
  disabled?: boolean;
  login?: string;
  files?: Record<string, string>;
  openPullRequests?: Array<{ number: number; html_url: string; state: string; body?: string | null; head: { ref: string; label: string } }>;
  forkFails?: boolean;
} = {}) {
  const files = options.files ?? {};
  return {
    getRepository: vi.fn().mockResolvedValue({
      full_name: "upstream/project",
      default_branch: "main",
      private: false,
      fork: false,
      archived: options.archived ?? false,
      disabled: options.disabled ?? false,
      html_url: "https://github.test/upstream/project",
      owner: { login: "upstream" },
      permissions: { push: options.push ?? false }
    }),
    getAuthenticatedUser: vi.fn().mockResolvedValue({ login: options.login ?? "contributor" }),
    forkRepository: options.forkFails
      ? vi.fn().mockRejectedValue(new Error("GitHub API 403 Forbidden: forking is disabled"))
      : vi.fn().mockResolvedValue({
          full_name: "contributor/project",
          owner: { login: options.login ?? "contributor" },
          html_url: "https://github.test/contributor/project"
        }),
    listPullRequests: vi.fn().mockResolvedValue(options.openPullRequests ?? []),
    getFile: vi.fn().mockImplementation(async (_owner: string, _repo: string, path: string) => {
      const content = files[path];
      if (content === undefined) throw notFound();
      return { path, sha: "sha", encoding: "base64", content: base64(content) };
    })
  };
}

describe("contribution mode configuration", () => {
  it("defaults to fork, and keeps every explicit mode", () => {
    expect(configuredContributionMode({})).toBe("fork");
    expect(configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: "nonsense" })).toBe("fork");
    expect(configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: " Fork " })).toBe("fork");
    expect(configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: "triage" })).toBe("triage");
    expect(configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: "own" })).toBe("own");
    expect(configuredContributionMode({ BYTER_CONTRIBUTION_MODE: "own" })).toBe("own");
  });

  it("reads a legacy record's triage mode as not writable", () => {
    // Records from before `writable` existed encoded every refusal as mode triage.
    expect(isContributionWritable({ mode: "triage" })).toBe(false);
    expect(isContributionWritable({ mode: "fork" })).toBe(true);
    expect(isContributionWritable({ mode: "fork", writable: false })).toBe(false);
    expect(isContributionWritable(undefined)).toBe(false);
  });

  it("fails closed when no allowlist is configured", () => {
    expect(upstreamAllowlist({})).toEqual([]);
    expect(isUpstreamAllowlisted("upstream", "project", [])).toBe(false);
  });

  it("has no repository-wide pull request cap unless one is set", () => {
    expect(maxOpenPullRequests({})).toBeUndefined();
    expect(maxOpenPullRequests({ SQUASHER_MAX_OPEN_PULL_REQUESTS: "3" })).toBe(3);
    expect(maxOpenPullRequests({ BYTER_MAX_OPEN_PULL_REQUESTS: "3" })).toBe(3);

    // A mistyped cap must not silently become a cap of zero that blocks everything.
    for (const raw of ["0", "-2", "2.5", "many", ""]) {
      expect(maxOpenPullRequests({ SQUASHER_MAX_OPEN_PULL_REQUESTS: raw }), raw).toBeUndefined();
    }
  });

  it("matches allowlist entries without case sensitivity", () => {
    const allowlist = upstreamAllowlist({ SQUASHER_UPSTREAM_ALLOWLIST: " Upstream/Project , other/repo " });

    expect(allowlist).toEqual(["upstream/project", "other/repo"]);
    expect(isUpstreamAllowlisted("UPSTREAM", "Project", allowlist)).toBe(true);
    expect(isUpstreamAllowlisted("upstream", "unlisted", allowlist)).toBe(false);
  });
});

describe("contribution policy scan", () => {
  it("finds an explicit refusal and quotes the project's own line", async () => {
    const client = clientFor({
      files: {
        "CONTRIBUTING.md": [
          "# Contributing",
          "",
          "Please open an issue first.",
          "We do not accept AI-generated patches of any kind.",
          "Run the tests before submitting."
        ].join("\n")
      }
    });

    const findings = await scanContributionPolicy(client as never, "upstream", "project");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("CONTRIBUTING.md");
    expect(findings[0]?.excerpt).toBe("We do not accept AI-generated patches of any kind.");
  });

  it("recognises several phrasings of the same refusal", async () => {
    const phrases = [
      "No AI-generated pull requests, please.",
      "AI-assisted contributions are not accepted here.",
      "Please do not submit machine-generated patches.",
      "Bot pull requests will be closed without review.",
      "No LLM-generated code."
    ];

    for (const phrase of phrases) {
      const client = clientFor({ files: { "CONTRIBUTING.md": phrase } });
      const findings = await scanContributionPolicy(client as never, "upstream", "project");
      expect(findings, phrase).toHaveLength(1);
    }
  });

  it("does not flag a project that merely mentions AI", async () => {
    const client = clientFor({
      files: {
        "README.md": [
          "An AI-powered search library.",
          "We use AI-generated embeddings internally.",
          "Contributions welcome — please add a test."
        ].join("\n")
      }
    });

    expect(await scanContributionPolicy(client as never, "upstream", "project")).toEqual([]);
  });

  it("reports an unreadable policy document rather than passing it silently", async () => {
    const client = {
      getFile: vi.fn().mockRejectedValue(new Error("GitHub API 500 Internal Server Error"))
    };

    const findings = await scanContributionPolicy(client as never, "upstream", "project", ["CONTRIBUTING.md"]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.excerpt).toContain("contribution policy is unknown");
  });

  it("treats a repository with no policy documents as unrestricted", async () => {
    const client = { getFile: noPolicyFiles() };

    expect(await scanContributionPolicy(client as never, "upstream", "project")).toEqual([]);
  });
});

describe("contribution target resolution", () => {
  const allowlist = ["upstream/project"];

  it("uses own mode when the token can push upstream", async () => {
    const client = clientFor({ push: true });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.mode).toBe("own");
    expect(target.headOwner).toBe("upstream");
    expect(target.upstreamPushAccess).toBe(true);
    // A repository the token owns is never forked, even in fork mode.
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("forks when there is no push access and the repository is allowlisted", async () => {
    const client = clientFor({ push: false });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.mode).toBe("fork");
    expect(target.headOwner).toBe("contributor");
    expect(target.forkUrl).toBe("https://github.test/contributor/project");
    expect(client.forkRepository).toHaveBeenCalledWith("upstream", "project");
  });

  it("refuses the write for a repository that is not allowlisted, forks nothing, and keeps the fork mode", async () => {
    const client = clientFor({ push: false });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", issueNumber: 42, mode: "fork", allowlist: [] });

    // Not rewritten to triage: triage now means only an explicit choice not to submit.
    expect(target.mode).toBe("fork");
    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]).toMatchObject({ kind: "configuration" });
    expect(target.reason).toContain("SQUASHER_UPSTREAM_ALLOWLIST");
    expect(target.blockers?.[0]?.action).toContain("Add upstream/project to SQUASHER_UPSTREAM_ALLOWLIST");
    expect(target.preflight).toMatchObject({ allowlisted: false, pushAccess: false, authenticated: true, account: "contributor", policyReviewed: true });
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("refuses before forking when the project's documents say no", async () => {
    const client = clientFor({
      push: false,
      files: { "CONTRIBUTING.md": "AI-generated pull requests are not accepted." }
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]?.kind).toBe("policy");
    expect(target.policyFindings).toHaveLength(1);
    // The order matters: nothing is created in the user's account before this check runs.
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("records every blocker, not just the first", async () => {
    const client = clientFor({
      push: false,
      files: { "CONTRIBUTING.md": "AI-generated pull requests are not accepted." }
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist: [] });

    expect(target.blockers?.map((blocker) => blocker.kind)).toEqual(["configuration", "policy"]);
  });

  it("never writes to an archived repository", async () => {
    const client = clientFor({ push: true, archived: true });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "own", allowlist });

    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]?.kind).toBe("capability");
    expect(target.archived).toBe(true);
  });

  it("refuses the write in own mode without push access, and says how to enable it", async () => {
    const client = clientFor({ push: false });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "own", allowlist });

    expect(target.mode).toBe("own");
    expect(target.writable).toBe(false);
    expect(target.reason).toContain("set it to fork");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("honours an explicit triage mode without probing at all", async () => {
    const client = clientFor({ push: true });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "triage", allowlist });

    expect(target.mode).toBe("triage");
    expect(target.writable).toBe(false);
    expect(target.reason).toContain("kept rather than submitted");
    expect(client.getRepository).not.toHaveBeenCalled();
  });

  it("refuses a second pull request for the same issue", async () => {
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 4, html_url: "https://github.test/pull/4", state: "open", head: { ref: "squasher/fix-42-abc1234567", label: "contributor:squasher/fix-42-abc1234567" } }
      ]
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", issueNumber: 42, mode: "fork", allowlist });

    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]?.kind).toBe("duplicate");
    expect(target.existingPullRequestUrl).toBe("https://github.test/pull/4");
    expect(target.preflight?.duplicatePullRequest).toBe("https://github.test/pull/4");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("does not block a different issue because another issue already has a pull request", async () => {
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 4, html_url: "https://github.test/pull/4", state: "open", head: { ref: "squasher/fix-42-abc1234567", label: "contributor:squasher/fix-42-abc1234567" } }
      ]
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", issueNumber: 43, mode: "fork", allowlist });

    expect(target.writable).toBe(true);
    expect(target.mode).toBe("fork");
    expect(target.preflight?.openSquasherPullRequests).toBe(1);
    expect(target.preflight?.duplicatePullRequest).toBeNull();
    expect(client.forkRepository).toHaveBeenCalled();
  });

  it("recognises a same-issue pull request by the issue it closes, and a pre-rename branch", async () => {
    expect(pullRequestIssueNumber({ head: { ref: "squasher/fix-42-abc" } })).toBe(42);
    expect(pullRequestIssueNumber({ head: { ref: "byter/fix-7-abc" } })).toBe(7);
    expect(pullRequestIssueNumber({ head: { ref: "squasher/other" }, body: "Summary.\n\nFixes #19" })).toBe(19);
    expect(pullRequestIssueNumber({ head: { ref: "squasher/other" }, body: "Mentions #19 only" })).toBeUndefined();
  });

  it("refuses a same-issue duplicate in own mode too", async () => {
    const client = clientFor({
      push: true,
      openPullRequests: [
        { number: 8, html_url: "https://github.test/pull/8", state: "open", head: { ref: "squasher/fix-5-abc", label: "upstream:squasher/fix-5-abc" } }
      ]
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", issueNumber: 5, mode: "fork", allowlist });

    expect(target.mode).toBe("own");
    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]?.kind).toBe("duplicate");
  });

  it("applies an explicit repository-wide cap when one is set", async () => {
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 4, html_url: "https://github.test/pull/4", state: "open", head: { ref: "squasher/fix-42-a", label: "contributor:squasher/fix-42-a" } },
        { number: 5, html_url: "https://github.test/pull/5", state: "open", head: { ref: "byter/fix-45-b", label: "contributor:byter/fix-45-b" } }
      ]
    });

    const target = await resolveContributionTarget({
      client: client as never,
      owner: "upstream",
      repo: "project",
      issueNumber: 50,
      mode: "fork",
      allowlist,
      maxOpenPullRequests: 2
    });

    // Counts both prefixes: a pre-rename pull request occupies a slot too.
    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]?.kind).toBe("configuration");
    expect(target.reason).toContain("limit of 2");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("ignores unrelated open pull requests from other contributors", async () => {
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 5, html_url: "https://github.test/pull/5", state: "open", head: { ref: "feature/x", label: "someone:feature/x" } },
        { number: 6, html_url: "https://github.test/pull/6", state: "open", head: { ref: "squasher/fix-1-a", label: "otheruser:squasher/fix-1-a" } }
      ]
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", issueNumber: 1, mode: "fork", allowlist });

    expect(target.mode).toBe("fork");
    expect(target.writable).toBe(true);
  });

  it("does not read a pull request listing failure as an absence of duplicates", async () => {
    const client = {
      listPullRequests: vi.fn().mockRejectedValue(new Error("GitHub API 502 Bad Gateway"))
    };

    const scan = await scanOpenSquasherPullRequests(client as never, "upstream", "project", "contributor", 42);

    // Unknown, not zero: reporting zero here is the direction that duplicates.
    expect(scan.unreadable).toBe(true);
    expect(scan.urls).toEqual([]);
    expect(scan.forIssue).toEqual([]);
  });

  it("blocks the write on an unreadable listing, since a duplicate cannot be ruled out", async () => {
    const client = clientFor({ push: false });
    client.listPullRequests = vi.fn().mockRejectedValue(new Error("GitHub API 502 Bad Gateway"));

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", issueNumber: 42, mode: "fork", allowlist });

    expect(target.writable).toBe(false);
    expect(target.reason).toContain("cannot be ruled out");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("reports a failed fork as a capability problem", async () => {
    const client = clientFor({ push: false, forkFails: true });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]?.kind).toBe("capability");
    expect(target.reason).toContain("Fork could not be created");
    expect(target.preflight?.forkCapable).toBe(false);
  });

  it("refuses the write when the upstream repository cannot be read", async () => {
    const client = { getRepository: vi.fn().mockRejectedValue(notFound()) };

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.writable).toBe(false);
    expect(target.blockers?.[0]?.kind).toBe("capability");
    expect(target.reason).toContain("could not be read");
  });

  it("preserves own-repository behaviour for a client with no repository probe", async () => {
    // Injected test clients have no getRepository; downgrading them to triage would break
    // every existing own-repository deployment.
    const target = await resolveContributionTarget({ client: {} as never, owner: "upstream", repo: "project", mode: "own", allowlist });

    expect(target.mode).toBe("own");
    expect(target.writable).toBe(true);
    expect(target.upstreamPushAccess).toBe(true);
  });
});
