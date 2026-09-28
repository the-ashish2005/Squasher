import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubRestClient, validateHeadRef } from "../src/index.js";

function jsonFetch(handler: (url: string, init: RequestInit) => unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(handler(String(url), init ?? {})), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("GitHubRestClient", () => {
  it("uses GitHub REST headers and encodes content path segments", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ path: "src/file name.ts", sha: "abc", encoding: "base64", content: "YQ==" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const client = new GitHubRestClient({
      token: "token",
      apiBaseUrl: "https://api.github.test",
      fetchImpl
    });

    await client.getFile("owner-name", "repo.name", "src/file name?#.ts", "main");

    expect(calls[0]?.url).toBe(
      "https://api.github.test/repos/owner-name/repo.name/contents/src/file%20name%3F%23.ts?ref=main"
    );
    expect((calls[0]?.init.headers as Record<string, string>)["User-Agent"]).toBe("Squasher/0.1.0");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("rejects owner or repo values that would escape REST path segments", async () => {
    const client = new GitHubRestClient({
      token: "token",
      fetchImpl: (() => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    await expect(client.getIssue("owner/name", "repo", 1)).rejects.toThrow("Invalid GitHub owner");
    await expect(client.getIssue("owner", "repo/name", 1)).rejects.toThrow("Invalid GitHub repository name");
  });

  it("rejects traversal repository paths before making a request", async () => {
    const client = new GitHubRestClient({
      token: "token",
      fetchImpl: (() => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    await expect(client.getFile("owner", "repo", "../issues/1")).rejects.toThrow("Invalid GitHub repository path");
    await expect(client.getFile("owner", "repo", "src/../token")).rejects.toThrow(
      "Invalid GitHub repository path"
    );
    await expect(client.getFile("owner", "repo", "/src/token.ts")).rejects.toThrow("Invalid GitHub repository path");
  });

  it("creates a fix tree commit, branch, and draft pull request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/branches/main")) {
        return new Response(JSON.stringify({ name: "main", commit: { sha: "a".repeat(40) } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return new Response(JSON.stringify({ sha: "a".repeat(40), tree: { sha: "b".repeat(40) } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith("/git/trees")) {
        return new Response(JSON.stringify({ sha: "c".repeat(40) }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith("/git/commits")) {
        return new Response(JSON.stringify({ sha: "d".repeat(40), tree: { sha: "c".repeat(40) } }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (String(url).endsWith("/pulls")) {
        return new Response(JSON.stringify({ number: 12, html_url: "https://github.test/pull/12" }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });
    const branch = await client.getBranch("owner", "repo", "main");
    const baseCommit = await client.getCommit("owner", "repo", branch.commit.sha);
    const tree = await client.createTree("owner", "repo", {
      baseTree: baseCommit.tree.sha,
      files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
    });
    const commit = await client.createCommit("owner", "repo", {
      message: "Squasher fix: trailing escape",
      tree: tree.sha,
      parents: [branch.commit.sha]
    });
    await client.createBranch("owner", "repo", "squasher/fix-17", commit.sha);
    const pullRequest = await client.createPullRequest("owner", "repo", {
      title: "Fix trailing escape",
      body: "Verified by Squasher.",
      head: "squasher/fix-17",
      base: "main"
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.test/repos/owner/repo/branches/main",
      `https://api.github.test/repos/owner/repo/git/commits/${"a".repeat(40)}`,
      "https://api.github.test/repos/owner/repo/git/trees",
      "https://api.github.test/repos/owner/repo/git/commits",
      "https://api.github.test/repos/owner/repo/git/refs",
      "https://api.github.test/repos/owner/repo/pulls"
    ]);
    expect(JSON.parse(calls[2]?.init.body as string)).toMatchObject({
      base_tree: "b".repeat(40),
      tree: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
    });
    expect(JSON.parse(calls[3]?.init.body as string)).toMatchObject({
      tree: "c".repeat(40),
      parents: ["a".repeat(40)]
    });
    expect(JSON.parse(calls[4]?.init.body as string)).toMatchObject({
      ref: "refs/heads/squasher/fix-17",
      sha: "d".repeat(40)
    });
    expect(JSON.parse(calls[5]?.init.body as string)).toMatchObject({ draft: true });
    expect(pullRequest.html_url).toBe("https://github.test/pull/12");
  });

  it("deletes created branches through the refs API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    await client.deleteBranch("owner", "repo", "squasher/fix-17");

    expect(calls[0]?.url).toBe("https://api.github.test/repos/owner/repo/git/refs/heads/squasher/fix-17");
    expect(calls[0]?.init.method).toBe("DELETE");
  });

  it("creates a verified label through the repository labels API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    await client.createLabel("owner", "repo", "squasher:verified", "8250df", "Issue verified by reproducible evidence");

    expect(calls[0]?.url).toBe("https://api.github.test/repos/owner/repo/labels");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      name: "squasher:verified",
      color: "8250df",
      description: "Issue verified by reproducible evidence"
    });
  });

  it("accepts a cross-fork head ref and keeps branch names colon-free", () => {
    expect(validateHeadRef("squasher/fix-17")).toBe("squasher/fix-17");
    expect(validateHeadRef("contributor:squasher/fix-17")).toBe("contributor:squasher/fix-17");

    // A second colon, an empty side, or a colon inside the owner must never reach the API.
    expect(() => validateHeadRef("a:b:c")).toThrow("Invalid GitHub pull request head ref");
    expect(() => validateHeadRef(":squasher/fix-17")).toThrow("Invalid GitHub pull request head ref");
    expect(() => validateHeadRef("contributor:")).toThrow("Invalid GitHub branch name");
    expect(() => validateHeadRef("owner/name:branch")).toThrow("Invalid GitHub pull request head ref");
  });

  it("refuses a colon in every ref-writing path", async () => {
    const client = new GitHubRestClient({
      token: "token",
      fetchImpl: (() => {
        throw new Error("fetch should not be called");
      }) as typeof fetch
    });

    // validateHeadRef must not have loosened the guards on ref creation and deletion.
    await expect(client.createBranch("owner", "repo", "fork:branch", "a".repeat(40))).rejects.toThrow(
      "Invalid GitHub branch name"
    );
    await expect(client.deleteBranch("owner", "repo", "fork:branch")).rejects.toThrow("Invalid GitHub branch name");
    await expect(client.getBranch("owner", "repo", "fork:branch")).rejects.toThrow("Invalid GitHub branch name");
  });

  it("sends maintainer_can_modify only for a cross-fork pull request", async () => {
    const crossRepo = jsonFetch(() => ({ number: 3, html_url: "https://github.test/pull/3" }), 201);
    const client = new GitHubRestClient({
      token: "token",
      apiBaseUrl: "https://api.github.test",
      fetchImpl: crossRepo.fetchImpl
    });

    await client.createPullRequest("upstream", "repo", {
      title: "Fix",
      body: "Body",
      head: "contributor:squasher/fix-1",
      base: "main"
    });
    await client.createPullRequest("upstream", "repo", {
      title: "Fix",
      body: "Body",
      head: "squasher/fix-1",
      base: "main"
    });

    const crossBody = JSON.parse(crossRepo.calls[0]?.init.body as string);
    const sameBody = JSON.parse(crossRepo.calls[1]?.init.body as string);
    expect(crossBody).toMatchObject({ head: "contributor:squasher/fix-1", draft: true, maintainer_can_modify: true });
    expect(sameBody.maintainer_can_modify).toBeUndefined();
  });

  it("reads repository metadata, the authenticated account, and starts a fork", async () => {
    const { calls, fetchImpl } = jsonFetch((url) => {
      if (url.endsWith("/user")) return { login: "contributor" };
      if (url.endsWith("/forks")) return { full_name: "contributor/repo", owner: { login: "contributor" }, html_url: "https://github.test/contributor/repo" };
      return { full_name: "upstream/repo", default_branch: "main", private: false, fork: false, permissions: { push: false }, owner: { login: "upstream" }, html_url: "https://github.test/upstream/repo" };
    });
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    const repository = await client.getRepository("upstream", "repo");
    const user = await client.getAuthenticatedUser();
    const fork = await client.forkRepository("upstream", "repo");

    expect(repository.permissions?.push).toBe(false);
    expect(user.login).toBe("contributor");
    expect(fork.owner.login).toBe("contributor");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.test/repos/upstream/repo",
      "https://api.github.test/user",
      "https://api.github.test/repos/upstream/repo/forks"
    ]);
    expect(calls[2]?.init.method).toBe("POST");
  });

  it("lists open pull requests with a cross-fork head filter", async () => {
    const { calls, fetchImpl } = jsonFetch(() => []);
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    await client.listPullRequests("upstream", "repo", { state: "open", head: "contributor:squasher/fix-1" });

    expect(calls[0]?.url).toBe(
      "https://api.github.test/repos/upstream/repo/pulls?state=open&per_page=100&head=contributor%3Asquasher%2Ffix-1"
    );
  });

  it("carries the HTTP status on a failure so a missing fork is distinguishable", async () => {
    const fetchImpl = (async () => new Response("Not Found", { status: 404, statusText: "Not Found" })) as typeof fetch;
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    // A not-yet-created fork answers 404, which the fork poll must tell apart from a 403.
    await expect(client.getRepository("contributor", "repo")).rejects.toMatchObject({
      name: "GitHubApiError",
      status: 404
    });
    await expect(client.getRepository("contributor", "repo")).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("reads collaborator permissions and removes issue labels", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ permission: "maintain" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new GitHubRestClient({ token: "token", apiBaseUrl: "https://api.github.test", fetchImpl });

    await expect(client.getCollaboratorPermission("owner", "repo", "maintainer-name")).resolves.toEqual({ permission: "maintain" });
    await client.removeLabel("owner", "repo", 17, "squasher:awaiting-approval");

    expect(calls[0]?.url).toBe("https://api.github.test/repos/owner/repo/collaborators/maintainer-name/permission");
    expect(calls[1]?.url).toBe("https://api.github.test/repos/owner/repo/issues/17/labels/squasher%3Aawaiting-approval");
    expect(calls[1]?.init.method).toBe("DELETE");
  });
});
