import { describe, expect, it, vi } from "vitest";
import { approvalPayloadHash, createGitHubMcpTools, listGitHubTools } from "../src/index.js";

describe("GitHub MCP tools", () => {
  it("exposes read and approved write tools", () => {
    expect(listGitHubTools()).toEqual([
      expect.objectContaining({ name: "read_issue", requiresApproval: false }),
      expect.objectContaining({ name: "read_file", requiresApproval: false }),
      expect.objectContaining({ name: "submit_byter_result", requiresApproval: false }),
      expect.objectContaining({ name: "add_verified_label", requiresApproval: true }),
      expect.objectContaining({ name: "comment_on_issue", requiresApproval: true }),
      expect.objectContaining({ name: "create_fix_pull_request", requiresApproval: true })
    ]);
  });

  it("reads issues through the GitHub client", async () => {
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        number: 3,
        title: "Bug",
        body: "Breaks",
        state: "open",
        html_url: "https://github.test/issue/3"
      })
    };
    const tools = createGitHubMcpTools({ client: client as never });

    const result = await tools.callTool({
      name: "read_issue",
      arguments: { owner: "o", repo: "r", issueNumber: 3 }
    });

    expect(client.getIssue).toHaveBeenCalledWith("o", "r", 3);
    expect(result.content[0]?.text).toContain("\"title\": \"Bug\"");
  });

  it("accepts a proof contract without calling GitHub", async () => {
    const client = { createIssueComment: vi.fn(), addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    const result = await tools.callTool({
      name: "submit_byter_result",
      arguments: {
        kind: "byter.result",
        status: "blocked",
        summary: "The sandbox runtime was unavailable.",
        proof: { before: "not run", after: "not run", regressions: "not run", attempts: "0/3" },
        candidatePatch: null
      }
    });

    expect(result.content[0]?.text).toContain("\"accepted\":true");
    expect(client.createIssueComment).not.toHaveBeenCalled();
    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("rejects placeholder proof before it can reach approval", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    await expect(tools.callTool({
      name: "submit_byter_result",
      arguments: {
        kind: "byter.result",
        status: "patch-ready",
        summary: "...",
        proof: { before: "...", after: "...", regressions: "...", attempts: "3/3" },
        candidatePatch: {
          title: "...",
          body: "...",
          files: [{ path: "src/file.ts", content: "full file content" }]
        }
      }
    })).rejects.toThrow("concrete non-placeholder text argument: summary");
  });

  it("blocks writes without approval", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 3 }
      })
    ).rejects.toThrow("approval is required");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("blocks writes without a payload-specific approval hash", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 3 },
        approval: { approved: true }
      })
    ).rejects.toThrow("approval payload hash is required");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("blocks writes when approval was for a different payload", async () => {
    const client = { addLabels: vi.fn() };
    const tools = createGitHubMcpTools({ client: client as never });
    const hashForIssueThree = approvalPayloadHash("add_verified_label", {
      owner: "o",
      repo: "r",
      issueNumber: 3
    });

    await expect(
      tools.callTool({
        name: "add_verified_label",
        arguments: { owner: "o", repo: "r", issueNumber: 4 },
        approval: { approved: true, expectedPayloadHash: hashForIssueThree }
      })
    ).rejects.toThrow("approval payload hash mismatch");

    expect(client.addLabels).not.toHaveBeenCalled();
  });

  it("allows writes with a matching payload-specific approval hash", async () => {
    const client = { addLabels: vi.fn().mockResolvedValue(undefined) };
    const tools = createGitHubMcpTools({ client: client as never });
    const args = { owner: "o", repo: "r", issueNumber: 3 };

    await tools.callTool({
      name: "add_verified_label",
      arguments: args,
      approval: { approved: true, expectedPayloadHash: approvalPayloadHash("add_verified_label", args) }
    });

    expect(client.addLabels).toHaveBeenCalledWith("o", "r", 3, ["byter:verified"]);
  });

  it("creates a draft fix pull request only with matching approval", async () => {
    const client = {
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "a".repeat(40) } }),
      getCommit: vi.fn().mockResolvedValue({ tree: { sha: "b".repeat(40) } }),
      createTree: vi.fn().mockResolvedValue({ sha: "c".repeat(40) }),
      createCommit: vi.fn().mockResolvedValue({ sha: "d".repeat(40) }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({ number: 9, html_url: "https://github.test/pull/9" })
    };
    const tools = createGitHubMcpTools({ client: client as never });
    const args = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: "byter/fix-9",
      title: "Fix parser crash",
      body: "Verified by Byter.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };

    const result = await tools.callTool({
      name: "create_fix_pull_request",
      arguments: args,
      approval: { approved: true, expectedPayloadHash: approvalPayloadHash("create_fix_pull_request", args) }
    });

    expect(client.getBranch).toHaveBeenCalledWith("o", "r", "main");
    expect(client.getCommit).toHaveBeenCalledWith("o", "r", "a".repeat(40));
    expect(client.createTree).toHaveBeenCalledWith(
      "o",
      "r",
      expect.objectContaining({
        baseTree: "b".repeat(40),
        files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
      })
    );
    expect(client.createCommit).toHaveBeenCalledWith(
      "o",
      "r",
      expect.objectContaining({ tree: "c".repeat(40), parents: ["a".repeat(40)] })
    );
    expect(client.createBranch).toHaveBeenCalledWith("o", "r", "byter/fix-9", "d".repeat(40));
    expect(client.createPullRequest).toHaveBeenCalledWith(
      "o",
      "r",
      expect.objectContaining({ draft: true, head: "byter/fix-9" })
    );
    expect(client.deleteBranch).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain("https://github.test/pull/9");
  });

  it("deletes the fix branch when draft pull request creation fails", async () => {
    const client = {
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "a".repeat(40) } }),
      getCommit: vi.fn().mockResolvedValue({ tree: { sha: "b".repeat(40) } }),
      createTree: vi.fn().mockResolvedValue({ sha: "c".repeat(40) }),
      createCommit: vi.fn().mockResolvedValue({ sha: "d".repeat(40) }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockRejectedValue(new Error("pull request failed"))
    };
    const tools = createGitHubMcpTools({ client: client as never });
    const args = {
      owner: "o",
      repo: "r",
      baseBranch: "main",
      branchName: "byter/fix-9",
      title: "Fix parser crash",
      body: "Verified by Byter.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };

    await expect(
      tools.callTool({
        name: "create_fix_pull_request",
        arguments: args,
        approval: { approved: true, expectedPayloadHash: approvalPayloadHash("create_fix_pull_request", args) }
      })
    ).rejects.toThrow("pull request failed");

    expect(client.deleteBranch).toHaveBeenCalledWith("o", "r", "byter/fix-9");
  });
});

describe("fork-based pull requests", () => {
  const upstream = { owner: "upstream", repo: "project" };
  const forkArgs = {
    ...upstream,
    headOwner: "contributor",
    baseBranch: "main",
    branchName: "byter/fix-42",
    title: "Fix trailing slash handling",
    body: "Verified by Byter.",
    files: [{ path: "src/paths.ts", content: "export const fixed = true;\n" }]
  };

  function forkClient(overrides: Record<string, unknown> = {}) {
    return {
      getRepository: vi.fn().mockResolvedValue({ full_name: "contributor/project", default_branch: "main" }),
      getBranch: vi.fn().mockResolvedValue({ commit: { sha: "a".repeat(40) } }),
      getCommit: vi.fn().mockResolvedValue({ tree: { sha: "b".repeat(40) } }),
      createTree: vi.fn().mockResolvedValue({ sha: "c".repeat(40) }),
      createCommit: vi.fn().mockResolvedValue({ sha: "d".repeat(40) }),
      createBranch: vi.fn().mockResolvedValue(undefined),
      deleteBranch: vi.fn().mockResolvedValue(undefined),
      createPullRequest: vi.fn().mockResolvedValue({ number: 7, html_url: "https://github.test/pull/7" }),
      ...overrides
    };
  }

  function approvalFor(args: Record<string, unknown>) {
    return { approved: true, expectedPayloadHash: approvalPayloadHash("create_fix_pull_request", args) };
  }

  it("writes the branch into the fork and opens the pull request upstream", async () => {
    const client = forkClient();
    const tools = createGitHubMcpTools({ client: client as never, sleep: async () => {} });

    const result = await tools.callTool({
      name: "create_fix_pull_request",
      arguments: forkArgs,
      approval: approvalFor(forkArgs)
    });

    // The base is read from upstream so a stale fork cannot widen the diff.
    expect(client.getBranch).toHaveBeenCalledWith("upstream", "project", "main");
    expect(client.getCommit).toHaveBeenCalledWith("upstream", "project", "a".repeat(40));

    // Every write lands in the fork.
    expect(client.createTree).toHaveBeenCalledWith("contributor", "project", expect.objectContaining({ baseTree: "b".repeat(40) }));
    expect(client.createCommit).toHaveBeenCalledWith("contributor", "project", expect.objectContaining({ parents: ["a".repeat(40)] }));
    expect(client.createBranch).toHaveBeenCalledWith("contributor", "project", "byter/fix-42", "d".repeat(40));

    // Only the pull request itself touches upstream, and it crosses the fork boundary.
    expect(client.createPullRequest).toHaveBeenCalledWith(
      "upstream",
      "project",
      expect.objectContaining({ head: "contributor:byter/fix-42", base: "main", draft: true, maintainerCanModify: true })
    );
    expect(result.content[0]?.text).toContain('"crossRepo": true');
  });

  it("rolls back the branch in the fork, never in the upstream repository", async () => {
    const client = forkClient({ createPullRequest: vi.fn().mockRejectedValue(new Error("pull request failed")) });
    const tools = createGitHubMcpTools({ client: client as never, sleep: async () => {} });

    await expect(
      tools.callTool({ name: "create_fix_pull_request", arguments: forkArgs, approval: approvalFor(forkArgs) })
    ).rejects.toThrow("pull request failed");

    expect(client.deleteBranch).toHaveBeenCalledTimes(1);
    expect(client.deleteBranch).toHaveBeenCalledWith("contributor", "project", "byter/fix-42");
  });

  it("covers the write destination with the approval hash", async () => {
    const client = forkClient();
    const tools = createGitHubMcpTools({ client: client as never, sleep: async () => {} });
    const { headOwner: _ignored, ...sameRepoArgs } = forkArgs;

    // An approval granted for a same-repository write cannot be replayed to push into
    // another account: headOwner is part of the canonical payload.
    await expect(
      tools.callTool({
        name: "create_fix_pull_request",
        arguments: forkArgs,
        approval: approvalFor(sameRepoArgs)
      })
    ).rejects.toThrow("approval payload hash mismatch");

    expect(client.createBranch).not.toHaveBeenCalled();
  });

  it("treats an omitted headOwner as the upstream owner for hashing", () => {
    const { headOwner: _ignored, ...withoutHeadOwner } = forkArgs;
    const explicitUpstream = { ...withoutHeadOwner, headOwner: upstream.owner };

    // Same meaning, so the same hash: existing approvals keep working unchanged.
    expect(approvalPayloadHash("create_fix_pull_request", withoutHeadOwner)).toBe(
      approvalPayloadHash("create_fix_pull_request", explicitUpstream)
    );
  });

  it("waits for a fork that GitHub has not finished creating", async () => {
    let probes = 0;
    const client = forkClient({
      getRepository: vi.fn().mockImplementation(async () => {
        probes += 1;
        if (probes < 3) {
          throw Object.assign(new Error("GitHub API 404 Not Found"), { status: 404 });
        }
        return { full_name: "contributor/project", default_branch: "main" };
      })
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const tools = createGitHubMcpTools({ client: client as never, sleep });

    await tools.callTool({ name: "create_fix_pull_request", arguments: forkArgs, approval: approvalFor(forkArgs) });

    expect(probes).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(client.createBranch).toHaveBeenCalled();
  });

  it("gives up when the fork never becomes ready", async () => {
    const client = forkClient({
      getRepository: vi.fn().mockRejectedValue(Object.assign(new Error("GitHub API 404 Not Found"), { status: 404 }))
    });
    let clock = 0;
    const tools = createGitHubMcpTools({
      client: client as never,
      now: () => clock,
      sleep: async () => {
        clock += 5_000;
      }
    });

    await expect(
      tools.callTool({ name: "create_fix_pull_request", arguments: forkArgs, approval: approvalFor(forkArgs) })
    ).rejects.toThrow("was not ready within 30s");

    expect(client.createBranch).not.toHaveBeenCalled();
  });

  it("does not retry a fork probe failure that is not a missing repository", async () => {
    const client = forkClient({
      getRepository: vi.fn().mockRejectedValue(Object.assign(new Error("GitHub API 403 Forbidden"), { status: 403 }))
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const tools = createGitHubMcpTools({ client: client as never, sleep });

    await expect(
      tools.callTool({ name: "create_fix_pull_request", arguments: forkArgs, approval: approvalFor(forkArgs) })
    ).rejects.toThrow("403 Forbidden");

    expect(sleep).not.toHaveBeenCalled();
  });
});
