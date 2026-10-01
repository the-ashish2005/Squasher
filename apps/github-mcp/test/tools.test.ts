import { describe, expect, it, vi } from "vitest";
import {
  approvalPayloadHash,
  createGitHubMcpTools,
  formatIssueDiscussion,
  listGitHubTools,
  maxReadFileBytes,
  readRepositoryInstructions,
  selectIssueDiscussion
} from "../src/index.js";

describe("GitHub MCP tools", () => {
  it("exposes read and approved write tools", () => {
    expect(listGitHubTools()).toEqual([
      expect.objectContaining({ name: "read_issue", requiresApproval: false }),
      expect.objectContaining({ name: "read_file", requiresApproval: false }),
      expect.objectContaining({ name: "read_repository_instructions", requiresApproval: false }),
      expect.objectContaining({ name: "submit_squasher_result", requiresApproval: false }),
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
      name: "submit_squasher_result",
      arguments: {
        kind: "squasher.result",
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

  it("accepts the optional explanation fields and rejects malformed ones", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });
    const base = {
      kind: "squasher.result",
      status: "not-reproduced",
      summary: "The reported error does not occur on main.",
      proof: { before: "not run", after: "not run", regressions: "not run", attempts: "3/3 clean runs" },
      candidatePatch: null
    };

    const accepted = await tools.callTool({
      name: "submit_squasher_result",
      arguments: {
        ...base,
        rootCauseSummary: "The reporter ran a release that predates the fix.",
        nextStep: "Ask the reporter to upgrade.",
        findings: ["analyze() calls the helper on main."]
      }
    });
    expect(accepted.content[0]?.text).toContain("\"accepted\":true");

    await expect(
      tools.callTool({ name: "submit_squasher_result", arguments: { ...base, findings: "one long string" } })
    ).rejects.toThrow("findings to be an array of strings");
    await expect(
      tools.callTool({ name: "submit_squasher_result", arguments: { ...base, nextStep: "" } })
    ).rejects.toThrow("nextStep");
  });

  it("rejects placeholder proof before it can reach approval", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    await expect(tools.callTool({
      name: "submit_squasher_result",
      arguments: {
        kind: "squasher.result",
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

    expect(client.addLabels).toHaveBeenCalledWith("o", "r", 3, ["squasher:verified"]);
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
      branchName: "squasher/fix-9",
      title: "Fix parser crash",
      body: "Verified by Squasher.",
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
    expect(client.createBranch).toHaveBeenCalledWith("o", "r", "squasher/fix-9", "d".repeat(40));
    expect(client.createPullRequest).toHaveBeenCalledWith(
      "o",
      "r",
      expect.objectContaining({ draft: true, head: "squasher/fix-9" })
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
      branchName: "squasher/fix-9",
      title: "Fix parser crash",
      body: "Verified by Squasher.",
      files: [{ path: "src/parser.ts", content: "export const fixed = true;\n" }]
    };

    await expect(
      tools.callTool({
        name: "create_fix_pull_request",
        arguments: args,
        approval: { approved: true, expectedPayloadHash: approvalPayloadHash("create_fix_pull_request", args) }
      })
    ).rejects.toThrow("pull request failed");

    expect(client.deleteBranch).toHaveBeenCalledWith("o", "r", "squasher/fix-9");
  });
});

describe("fork-based pull requests", () => {
  const upstream = { owner: "upstream", repo: "project" };
  const forkArgs = {
    ...upstream,
    headOwner: "contributor",
    baseBranch: "main",
    branchName: "squasher/fix-42",
    title: "Fix trailing slash handling",
    body: "Verified by Squasher.",
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
    expect(client.createBranch).toHaveBeenCalledWith("contributor", "project", "squasher/fix-42", "d".repeat(40));

    // Only the pull request itself touches upstream, and it crosses the fork boundary.
    expect(client.createPullRequest).toHaveBeenCalledWith(
      "upstream",
      "project",
      expect.objectContaining({ head: "contributor:squasher/fix-42", base: "main", draft: true, maintainerCanModify: true })
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
    expect(client.deleteBranch).toHaveBeenCalledWith("contributor", "project", "squasher/fix-42");
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

describe("result statuses for implemented changes", () => {
  const implementedProof = {
    kind: "squasher.result",
    status: "implemented-feature",
    summary: "Added the requested Cancel button and verified it renders beside Save.",
    proof: {
      before: "The new acceptance test failed 3/3 against the unchanged page: no Cancel button present.",
      after: "The same test passed 3/3 after the change.",
      regressions: "The existing suite passed 3/3 alongside it.",
      attempts: "3/3 matching executions before and after"
    },
    candidatePatch: {
      title: "Add a Cancel button beside Save",
      body: "Adds the requested Cancel button to index.html.",
      files: [{ path: "index.html", content: "<button>Cancel</button>\n" }]
    },
    requirements: [
      {
        requirement: "A green Cancel button appears beside Save",
        verdict: "pass",
        evidence: "The acceptance test found #cancel with background #16a34a next to #save, 3/3 runs."
      }
    ]
  };

  it("accepts implemented-feature and implemented-improvement", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    for (const status of ["implemented-feature", "implemented-improvement"]) {
      const result = await tools.callTool({
        name: "submit_squasher_result",
        arguments: { ...implementedProof, status }
      });
      expect(result.content[0]?.text, status).toContain('"accepted":true');
    }
  });

  it("holds an implemented change to the same evidence bar as a defect", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    // Implementing without running anything three times is not evidence.
    await expect(
      tools.callTool({
        name: "submit_squasher_result",
        arguments: { ...implementedProof, proof: { ...implementedProof.proof, attempts: "ran it once" } }
      })
    ).rejects.toThrow("at least 3/3 matching executions");

    // Placeholder text is rejected here exactly as it is for a defect.
    await expect(
      tools.callTool({
        name: "submit_squasher_result",
        arguments: { ...implementedProof, proof: { ...implementedProof.proof, after: "..." } }
      })
    ).rejects.toThrow("proof.after");
  });

  it("accepts not-actionable without demanding proof, and rejects an unknown status", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    const accepted = await tools.callTool({
      name: "submit_squasher_result",
      arguments: {
        kind: "squasher.result",
        status: "not-actionable",
        summary: "The request names a service this repository does not contain.",
        proof: { before: "n/a", after: "n/a", regressions: "n/a", attempts: "0/0" },
        candidatePatch: null
      }
    });
    expect(accepted.content[0]?.text).toContain('"accepted":true');

    await expect(
      tools.callTool({
        name: "submit_squasher_result",
        arguments: { ...implementedProof, status: "implemented-whatever" }
      })
    ).rejects.toThrow("valid Squasher result status");
  });
});

describe("proof contract across the rename", () => {
  const proof = {
    status: "blocked",
    summary: "The sandbox runtime was unavailable.",
    proof: { before: "not run", after: "not run", regressions: "not run", attempts: "0/3" },
    candidatePatch: null
  };

  it("accepts the current kind and tool name", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });
    const result = await tools.callTool({
      name: "submit_squasher_result",
      arguments: { kind: "squasher.result", ...proof }
    });
    expect(result.content[0]?.text).toContain('"accepted":true');
  });

  it("still accepts the pre-rename kind", async () => {
    // A session paused before the rename carries byter.result in its message history and
    // will submit it again on resume.
    const tools = createGitHubMcpTools({ client: {} as never });
    const result = await tools.callTool({
      name: "submit_squasher_result",
      arguments: { kind: "byter.result", ...proof }
    });
    expect(result.content[0]?.text).toContain('"accepted":true');
  });

  it("still accepts the pre-rename tool name", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });
    const result = await tools.callTool({
      name: "submit_byter_result" as never,
      arguments: { kind: "byter.result", ...proof }
    });
    expect(result.content[0]?.text).toContain('"accepted":true');
  });

  it("rejects a kind that is neither", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });
    await expect(
      tools.callTool({ name: "submit_squasher_result", arguments: { kind: "other.result", ...proof } })
    ).rejects.toThrow("kind=squasher.result");
  });
});

describe("read_file bounding and progressive inspection", () => {
  // Stands in for the file that ended a live run: ~42 KB of real-looking source.
  const largeSource = Array.from({ length: 1200 }, (_, index) => `export const value${index} = ${index}; // padding to widen the line`).join("\n");

  function fileOf(text: string, encoding = "base64", path = "web/app.js") {
    const raw = Buffer.from(text, "utf8");
    return {
      path,
      sha: "8d5e12f688b326cb0f60059e2ff4d4256871b6c1",
      size: raw.byteLength,
      encoding,
      content: encoding === "base64" ? raw.toString("base64") : text
    };
  }

  async function read(file: unknown, args: Record<string, unknown> = {}) {
    const getFile = vi.fn().mockResolvedValue(file);
    const tools = createGitHubMcpTools({ client: { getFile } as never });
    const result = await tools.callTool({
      name: "read_file",
      arguments: { owner: "o", repo: "r", path: "web/app.js", ...args }
    });
    return { body: JSON.parse(result.content[0]!.text), payloadBytes: Buffer.byteLength(result.content[0]!.text, "utf8"), getFile };
  }

  it("does not return a whole large file, and says the result is incomplete", async () => {
    const { body, payloadBytes } = await read(fileOf(largeSource));

    expect(body.content).not.toBe(largeSource);
    expect(body.complete).toBe(false);
    expect(body.truncated).toBe(true);
    expect(body.totalLines).toBe(1200);
    // The whole point: the payload is bounded, where it used to be ~60 KB of base64.
    expect(payloadBytes).toBeLessThan(maxReadFileBytes + 2048);
    expect(body.returnedBytes).toBeLessThanOrEqual(maxReadFileBytes);
  });

  it("returns only the requested line range", async () => {
    const { body } = await read(fileOf(largeSource), { startLine: 1, endLine: 250 });

    expect(body.startLine).toBe(1);
    expect(body.endLine).toBe(250);
    // Each line keeps its newline, so a 250-line window ends with one.
    expect(body.content.split("\n").filter((line: string) => line.length > 0)).toHaveLength(250);
    expect(body.content).toContain("value0 =");
    expect(body.content).toContain("value249 =");
    expect(body.content).not.toContain("value250 =");
  });

  it("retrieves a later section through a second request", async () => {
    const first = await read(fileOf(largeSource), { startLine: 1, endLine: 250 });
    const second = await read(fileOf(largeSource), { startLine: 251, endLine: 500 });

    expect(second.body.startLine).toBe(251);
    expect(second.body.content).toContain("value250 =");
    expect(second.body.content).not.toContain("value249 =");
    // The two windows are disjoint and adjoining, so paging loses nothing.
    expect(first.body.content.endsWith("\n")).toBe(true);
  });

  it("names the line to continue from, and reaching the end reports complete", async () => {
    const { body } = await read(fileOf(largeSource), { startLine: 1, endLine: 10 });
    expect(body.complete).toBe(false);
    expect(body.nextStartLine).toBe(11);
    expect(body.notice).toContain("startLine 11");

    const tail = await read(fileOf(largeSource), { startLine: 1190 });
    expect(tail.body.complete).toBe(true);
    expect(tail.body.truncated).toBeUndefined();
    expect(tail.body.nextStartLine).toBeUndefined();
    expect(tail.body.notice).toBeUndefined();
  });

  it("returns a small file whole, decoded, with no truncation flags", async () => {
    const { body } = await read(fileOf("export const fixed = true;\n"));

    expect(body.encoding).toBe("utf8");
    expect(body.content).toBe("export const fixed = true;\n");
    expect(body.complete).toBe(true);
    expect(body.truncated).toBeUndefined();
    expect(body.totalLines).toBe(1);
  });

  it("bounds a single enormous line by bytes", async () => {
    // A minified bundle is one line; a line-only bound would return all of it.
    const { body, payloadBytes } = await read(fileOf(`const a=${"x".repeat(80 * 1024)};`));

    expect(body.returnedBytes).toBeLessThanOrEqual(maxReadFileBytes);
    expect(payloadBytes).toBeLessThan(maxReadFileBytes + 2048);
    expect(body.complete).toBe(false);
    // The cut line must be re-read, not skipped past.
    expect(body.nextStartLine).toBe(1);
  });

  it("clamps a caller asking for more than the server maximum", async () => {
    const { body } = await read(fileOf(largeSource), { maxBytes: 10 * 1024 * 1024 });

    expect(body.returnedBytes).toBeLessThanOrEqual(maxReadFileBytes);
  });

  it("honours a smaller maxBytes than the default", async () => {
    const { body } = await read(fileOf(largeSource), { maxBytes: 2048 });

    expect(body.returnedBytes).toBeLessThanOrEqual(2048);
    expect(body.complete).toBe(false);
  });

  it("rejects a malformed range instead of reading somewhere else", async () => {
    await expect(read(fileOf(largeSource), { startLine: 0 })).rejects.toThrow("positive whole number");
    await expect(read(fileOf(largeSource), { startLine: 2.5 })).rejects.toThrow("positive whole number");
    await expect(read(fileOf(largeSource), { endLine: -1 })).rejects.toThrow("positive whole number");
  });

  it("reports an empty range rather than guessing", async () => {
    const { body } = await read(fileOf(largeSource), { startLine: 900, endLine: 800 });

    expect(body.content).toBe("");
    expect(body.returnedBytes).toBe(0);
    expect(body.notice).toContain("1200 lines");
  });

  it("still refuses a traversal path before any read happens", async () => {
    // The path guard lives in the GitHub client and must not have been bypassed.
    const client = {
      getFile: vi.fn().mockImplementation(async (_o: string, _r: string, path: string) => {
        if (path.includes("..")) throw new Error("Invalid GitHub repository path");
        return fileOf("ok");
      })
    };
    const tools = createGitHubMcpTools({ client: client as never });

    await expect(
      tools.callTool({ name: "read_file", arguments: { owner: "o", repo: "r", path: "../secrets" } })
    ).rejects.toThrow("Invalid GitHub repository path");
  });

  it("returns no content for a binary file", async () => {
    const binary = { path: "logo.png", sha: "abc", size: 4, encoding: "base64", content: Buffer.from([0, 1, 2, 3]).toString("base64") };
    const { body } = await read(binary);

    expect(body.content).toBe("");
    expect(body.encoding).toBe("none");
    expect(body.notice).toContain("Binary file");
  });

  it("does not split a multi-byte character at the cut", async () => {
    const { body } = await read(fileOf("é".repeat(40 * 1024)));

    expect(body.content).not.toContain("\uFFFD");
  });
});

describe("issue discussion", () => {
  function comment(login: string, association: string, body: string, index: number) {
    return {
      id: index,
      body,
      created_at: `2026-09-${String(10 + (index % 18)).padStart(2, "0")}T00:00:00Z`,
      user: { login },
      author_association: association
    };
  }

  it("returns the comment thread with read_issue, marking maintainers", async () => {
    // A live run once re-implemented sorting the owner had said in the thread already existed,
    // because read_issue returned the body alone.
    const client = {
      getIssue: vi.fn().mockResolvedValue({
        number: 164,
        title: "UI/UX improvements",
        body: "Add cards, badges, sorting and filtering.",
        html_url: "https://github.test/o/r/issues/164",
        state: "open",
        labels: [{ name: "enhancement" }]
      }),
      listIssueComments: vi.fn().mockResolvedValue([
        comment("owner-login", "OWNER", "Sorting by any column and the language filter already exist. I will split the rest.", 1),
        comment("newcomer", "NONE", "/assign", 2)
      ])
    };
    const tools = createGitHubMcpTools({ client: client as never });

    const result = await tools.callTool({ name: "read_issue", arguments: { owner: "o", repo: "r", issueNumber: 164 } });
    const issue = JSON.parse(result.content[0]!.text);

    expect(client.listIssueComments).toHaveBeenCalledWith("o", "r", 164, { limit: 200 });
    expect(issue.labels).toEqual(["enhancement"]);
    expect(issue.commentCount).toBe(2);
    expect(issue.comments[0]).toMatchObject({ author: "owner-login", association: "OWNER", maintainer: true });
    expect(issue.comments[0].body).toContain("already exist");
    expect(issue.comments[1]).toMatchObject({ author: "newcomer", maintainer: false });
  });

  it("reports unreadable comments instead of presenting the issue as undiscussed", async () => {
    const client = {
      getIssue: vi.fn().mockResolvedValue({ number: 1, title: "t", body: "b", html_url: "u", state: "open" }),
      listIssueComments: vi.fn().mockRejectedValue(new Error("GitHub API 502 Bad Gateway"))
    };
    const tools = createGitHubMcpTools({ client: client as never });

    const issue = JSON.parse((await tools.callTool({ name: "read_issue", arguments: { owner: "o", repo: "r", issueNumber: 1 } })).content[0]!.text);

    expect(issue.commentsError).toContain("502");
    expect(issue.comments).toEqual([]);
  });

  it("bounds a long thread but keeps its opening, its latest comments, and every maintainer comment", () => {
    const raw = Array.from({ length: 120 }, (_, index) =>
      comment(index === 60 ? "maintainer" : `user${index}`, index === 60 ? "MEMBER" : "NONE", `comment ${index}`, index)
    );

    const discussion = selectIssueDiscussion(raw);

    expect(discussion.total).toBe(120);
    expect(discussion.omitted).toBe(120 - discussion.comments.length);
    expect(discussion.comments[0]?.body).toBe("comment 0");
    expect(discussion.comments.at(-1)?.body).toBe("comment 119");
    // From the dropped middle, but kept: a maintainer's word is what changes the requirement.
    expect(discussion.comments.some((entry) => entry.author === "maintainer")).toBe(true);
    expect(formatIssueDiscussion(discussion)).toContain("further comment(s) were omitted");
  });

  it("formats the thread with roles so the agent can weigh maintainer direction", () => {
    const text = formatIssueDiscussion(selectIssueDiscussion([comment("owner-login", "OWNER", "Please split this.", 1)]));

    expect(text).toContain("@owner-login (OWNER, maintainer)");
    expect(text).toContain("Please split this.");
    expect(formatIssueDiscussion(selectIssueDiscussion([]))).toBe("(no comments)");
  });
});

describe("repository instructions", () => {
  it("reads the repository's contributor and agent guidance and lists what is missing", async () => {
    const files: Record<string, string> = {
      "AGENTS.md": "Run `pnpm test` before submitting. Use tabs.",
      "CONTRIBUTING.md": "Disclose AI assistance in the pull request body."
    };
    const client = {
      getFile: vi.fn().mockImplementation(async (_owner: string, _repo: string, path: string) => {
        const content = files[path];
        if (content === undefined) throw Object.assign(new Error("GitHub API 404 Not Found"), { status: 404 });
        return { path, sha: "sha", encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") };
      })
    };
    const tools = createGitHubMcpTools({ client: client as never });

    const result = JSON.parse(
      (await tools.callTool({ name: "read_repository_instructions", arguments: { owner: "o", repo: "r" } })).content[0]!.text
    );

    expect(result.found.map((file: { path: string }) => file.path)).toEqual(["AGENTS.md", "CONTRIBUTING.md"]);
    expect(result.found[0].content).toContain("pnpm test");
    expect(result.missing).toContain("CLAUDE.md");
    expect(result.unreadable).toEqual([]);
    expect(result.notice).toContain("Do not invent rules");
  });

  it("bounds a huge document and marks it truncated", async () => {
    const client = {
      getFile: vi.fn().mockImplementation(async (_owner: string, _repo: string, path: string) => {
        if (path !== "CONTRIBUTING.md") throw Object.assign(new Error("404"), { status: 404 });
        return { path, sha: "sha", encoding: "utf8", content: "x".repeat(100_000) };
      })
    };

    const result = await readRepositoryInstructions(client as never, "o", "r");

    expect(result.found[0]).toMatchObject({ path: "CONTRIBUTING.md", truncated: true, totalChars: 100_000 });
    expect(result.found[0]!.content.length).toBeLessThan(100_000);
  });
});

describe("requirement verification", () => {
  const base = {
    kind: "squasher.result",
    status: "implemented-feature",
    summary: "Added the requested sort dropdown alongside the existing sortable headers.",
    proof: {
      before: "The new dropdown test failed 3/3 before the change.",
      after: "The same test passed 3/3 after it.",
      regressions: "The existing 83 tests still pass; no pre-existing failures.",
      attempts: "3/3 matching executions"
    },
    candidatePatch: {
      title: "Add a sort dropdown",
      body: "Adds a sort dropdown for small screens.",
      files: [{ path: "index.html", content: "<select id=\"sort\"></select>\n" }]
    }
  };

  it("requires an implemented change to list its requirements", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    await expect(tools.callTool({ name: "submit_squasher_result", arguments: base })).rejects.toThrow("Expected requirements");
  });

  it("refuses a proven status when any requirement failed", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    await expect(
      tools.callTool({
        name: "submit_squasher_result",
        arguments: {
          ...base,
          requirements: [
            { requirement: "A sort dropdown exists", verdict: "pass", evidence: "Test found #sort 3/3." },
            { requirement: "Sorting persists across reloads", verdict: "fail", evidence: "Reloading reset the order in 3/3 runs." }
          ]
        }
      })
    ).rejects.toThrow("A requirement failed verification");
  });

  it("accepts requirements already met by existing code, with their evidence", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    const result = await tools.callTool({
      name: "submit_squasher_result",
      arguments: {
        ...base,
        requirements: [
          {
            requirement: "Sort by created date",
            verdict: "already-implemented",
            evidence: "COLUMNS marks created_at sortable and handleSort toggles direction.",
            codeEvidence: [{ path: "index.html", excerpt: '{ key: "created_at", label: "Created",  sortable: true }' }]
          },
          { requirement: "A sort control usable on small screens", verdict: "pass", evidence: "The dropdown test selected each option 3/3 at 390px." },
          { requirement: "Rewrite the layout as cards", verdict: "out-of-scope" }
        ]
      }
    });

    expect(result.content[0]?.text).toContain('"accepted":true');
  });

  it("rejects a requirement verdict that is not one of the four", async () => {
    const tools = createGitHubMcpTools({ client: {} as never });

    await expect(
      tools.callTool({
        name: "submit_squasher_result",
        arguments: { ...base, requirements: [{ requirement: "Something", verdict: "probably", evidence: "trust me" }] }
      })
    ).rejects.toThrow("verdict to be one of");
  });
});
