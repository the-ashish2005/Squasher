import { describe, expect, it, vi } from "vitest";
import {
  configuredContributionMode,
  isUpstreamAllowlisted,
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
  openPullRequests?: Array<{ number: number; html_url: string; state: string; head: { ref: string; label: string } }>;
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
  it("defaults to own so existing deployments are unchanged", () => {
    expect(configuredContributionMode({})).toBe("own");
    expect(configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: "nonsense" })).toBe("own");
    expect(configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: " Fork " })).toBe("fork");
    expect(configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: "triage" })).toBe("triage");
  });

  it("fails closed when no allowlist is configured", () => {
    expect(upstreamAllowlist({})).toEqual([]);
    expect(isUpstreamAllowlisted("upstream", "project", [])).toBe(false);
  });

  it("defaults the open pull request limit to one, and only accepts a positive whole number", () => {
    expect(maxOpenPullRequests({})).toBe(1);
    expect(maxOpenPullRequests({ SQUASHER_MAX_OPEN_PULL_REQUESTS: "3" })).toBe(3);
    expect(maxOpenPullRequests({ BYTER_MAX_OPEN_PULL_REQUESTS: "3" })).toBe(3);

    // A mistyped limit must not silently become "no limit".
    for (const raw of ["0", "-2", "2.5", "many", ""]) {
      expect(maxOpenPullRequests({ SQUASHER_MAX_OPEN_PULL_REQUESTS: raw }), raw).toBe(1);
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

  it("refuses a repository that is not allowlisted, and forks nothing", async () => {
    const client = clientFor({ push: false });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist: [] });

    expect(target.mode).toBe("triage");
    expect(target.reason).toContain("SQUASHER_UPSTREAM_ALLOWLIST");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("refuses before forking when the project's documents say no", async () => {
    const client = clientFor({
      push: false,
      files: { "CONTRIBUTING.md": "AI-generated pull requests are not accepted." }
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.mode).toBe("triage");
    expect(target.policyFindings).toHaveLength(1);
    // The order matters: nothing is created in the user's account before this check runs.
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("never writes to an archived repository", async () => {
    const client = clientFor({ push: true, archived: true });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "own", allowlist });

    expect(target.mode).toBe("triage");
    expect(target.archived).toBe(true);
  });

  it("stays in triage when own mode has no push access", async () => {
    const client = clientFor({ push: false });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "own", allowlist });

    expect(target.mode).toBe("triage");
    expect(target.reason).toContain("set it to fork");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("honours triage mode without probing at all", async () => {
    const client = clientFor({ push: true });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "triage", allowlist });

    expect(target.mode).toBe("triage");
    expect(client.getRepository).not.toHaveBeenCalled();
  });

  it("refuses a second pull request while one is still open", async () => {
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 4, html_url: "https://github.test/pull/4", state: "open", head: { ref: "squasher/fix-42", label: "contributor:squasher/fix-42" } }
      ]
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.mode).toBe("triage");
    expect(target.existingPullRequestUrl).toBe("https://github.test/pull/4");
    expect(target.reason).toContain("SQUASHER_MAX_OPEN_PULL_REQUESTS");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("allows a second pull request when the limit is raised", async () => {
    // The default of one is a courtesy to maintainers receiving unsolicited pull requests,
    // not a correctness rule, so an operator who knows it does not apply can raise it.
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 4, html_url: "https://github.test/pull/4", state: "open", head: { ref: "squasher/fix-42", label: "contributor:squasher/fix-42" } }
      ]
    });

    const target = await resolveContributionTarget({
      client: client as never,
      owner: "upstream",
      repo: "project",
      mode: "fork",
      allowlist,
      maxOpenPullRequests: 2
    });

    expect(target.mode).toBe("fork");
    expect(client.forkRepository).toHaveBeenCalled();
  });

  it("still refuses once the raised limit is reached", async () => {
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 4, html_url: "https://github.test/pull/4", state: "open", head: { ref: "squasher/fix-42", label: "contributor:squasher/fix-42" } },
        { number: 5, html_url: "https://github.test/pull/5", state: "open", head: { ref: "byter/fix-45", label: "contributor:byter/fix-45" } }
      ]
    });

    const target = await resolveContributionTarget({
      client: client as never,
      owner: "upstream",
      repo: "project",
      mode: "fork",
      allowlist,
      maxOpenPullRequests: 2
    });

    // Counts both prefixes: a pre-rename pull request occupies a slot too.
    expect(target.mode).toBe("triage");
    expect(target.reason).toContain("limit of 2");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("ignores unrelated open pull requests from other contributors", async () => {
    const client = clientFor({
      push: false,
      openPullRequests: [
        { number: 5, html_url: "https://github.test/pull/5", state: "open", head: { ref: "feature/x", label: "someone:feature/x" } },
        { number: 6, html_url: "https://github.test/pull/6", state: "open", head: { ref: "squasher/fix-1", label: "otheruser:squasher/fix-1" } }
      ]
    });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.mode).toBe("fork");
  });

  it("does not read a pull request listing failure as an absence of duplicates", async () => {
    const client = {
      listPullRequests: vi.fn().mockRejectedValue(new Error("GitHub API 502 Bad Gateway"))
    };

    const scan = await scanOpenSquasherPullRequests(client as never, "upstream", "project", "contributor");

    // Unknown, not zero: reporting zero here is the direction that duplicates.
    expect(scan.unreadable).toBe(true);
    expect(scan.urls).toEqual([]);
  });

  it("blocks on an unreadable listing however high the limit is", async () => {
    const client = clientFor({ push: false });
    client.listPullRequests = vi.fn().mockRejectedValue(new Error("GitHub API 502 Bad Gateway"));

    const target = await resolveContributionTarget({
      client: client as never,
      owner: "upstream",
      repo: "project",
      mode: "fork",
      allowlist,
      maxOpenPullRequests: 10
    });

    expect(target.mode).toBe("triage");
    expect(target.reason).toContain("unknown");
    expect(client.forkRepository).not.toHaveBeenCalled();
  });

  it("refuses when forking is disabled on the upstream repository", async () => {
    const client = clientFor({ push: false, forkFails: true });

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.mode).toBe("triage");
    expect(target.reason).toContain("Fork could not be created");
  });

  it("falls back to triage when the upstream repository cannot be read", async () => {
    const client = { getRepository: vi.fn().mockRejectedValue(notFound()) };

    const target = await resolveContributionTarget({ client: client as never, owner: "upstream", repo: "project", mode: "fork", allowlist });

    expect(target.mode).toBe("triage");
    expect(target.reason).toContain("could not be read");
  });

  it("preserves own-repository behaviour for a client with no repository probe", async () => {
    // Injected test clients have no getRepository; downgrading them to triage would break
    // every existing own-repository deployment.
    const target = await resolveContributionTarget({ client: {} as never, owner: "upstream", repo: "project", mode: "own", allowlist });

    expect(target.mode).toBe("own");
    expect(target.upstreamPushAccess).toBe(true);
  });
});
