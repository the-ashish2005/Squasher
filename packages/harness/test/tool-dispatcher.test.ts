import { describe, expect, it, vi } from "vitest";
import type { GitHubRestClientLike } from "@byter/github-mcp";
import { createToolDispatcher, sandboxToolName } from "../src/tool-dispatcher.js";
import { GuardValidationError } from "../src/structured-output-guard.js";
import type { SandboxClientLike } from "../src/sandbox-client.js";

function fakeSandbox(overrides: Partial<SandboxClientLike> = {}) {
  return {
    createSandbox: vi.fn().mockResolvedValue("sbx_1"),
    runCommand: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } satisfies SandboxClientLike;
}

function newDispatcher(
  clientOverrides: Partial<GitHubRestClientLike> = {},
  sandbox: SandboxClientLike = fakeSandbox()
) {
  const client = {
    getIssue: vi.fn().mockResolvedValue({
      number: 7,
      title: "Crash",
      body: "It crashes",
      html_url: "https://github.test/o/r/issues/7",
      state: "open"
    }),
    getFile: vi.fn().mockResolvedValue({ path: "src/a.ts", sha: "abc", encoding: "utf8", content: "code" }),
    ...clientOverrides
  } as unknown as GitHubRestClientLike;

  let sandboxId: string | undefined;
  const dispatcher = createToolDispatcher({
    client,
    sandbox,
    resolveSandboxId: async () => {
      sandboxId ??= await sandbox.createSandbox();
      return sandboxId;
    }
  });

  return { dispatcher, client, sandbox };
}

describe("tool dispatcher", () => {
  it("exposes the enabled GitHub tools plus the sandbox tool", () => {
    const { dispatcher } = newDispatcher();

    const names = dispatcher.tools().map((tool) => tool.function.name);

    expect(names).toEqual([
      "read_issue",
      "read_file",
      "submit_byter_result",
      "create_fix_pull_request",
      sandboxToolName
    ]);
  });

  it("names the sandbox tool run_command so the dashboard classifies it as sandbox activity", () => {
    expect(sandboxToolName).toBe("run_command");
  });

  it("requests strict schema adherence for the proof contract", () => {
    const { dispatcher } = newDispatcher();

    const submit = dispatcher.tools().find((tool) => tool.function.name === "submit_byter_result");

    expect(submit?.function.strict).toBe(true);
  });

  it("runs a successful GitHub tool call in-process", async () => {
    const { dispatcher, client } = newDispatcher();

    const result = await dispatcher.callTool("read_issue", { owner: "o", repo: "r", issueNumber: 7 });

    expect(client.getIssue).toHaveBeenCalledWith("o", "r", 7);
    expect(JSON.parse(result.content[0]!.text).title).toBe("Crash");
  });

  it("propagates a failed GitHub tool call", async () => {
    const { dispatcher } = newDispatcher({
      getIssue: vi.fn().mockRejectedValue(new Error("GitHub 404"))
    });

    await expect(dispatcher.callTool("read_issue", { owner: "o", repo: "r", issueNumber: 7 })).rejects.toThrow(
      "GitHub 404"
    );
  });

  it("rejects a disabled tool", async () => {
    const { dispatcher } = newDispatcher();

    await expect(dispatcher.callTool("comment_on_issue", { owner: "o", repo: "r", issueNumber: 7, body: "hi" })).rejects.toThrow(
      /not enabled/
    );
  });

  it("writes files then runs the command, shaping the result as sandbox output", async () => {
    const sandbox = fakeSandbox({
      runCommand: vi.fn().mockResolvedValue({ stdout: "3/3 failed", stderr: "trace", exitCode: 1 })
    });
    const { dispatcher } = newDispatcher({}, sandbox);

    const result = await dispatcher.callTool(sandboxToolName, {
      command: "node --experimental-strip-types repro.ts",
      files: [{ path: "repro.ts", content: "throw new Error('boom')" }]
    });

    expect(sandbox.writeFile).toHaveBeenCalledWith("sbx_1", "repro.ts", "throw new Error('boom')");
    expect(sandbox.runCommand).toHaveBeenCalledWith("sbx_1", "node --experimental-strip-types repro.ts", undefined);

    // parseToolResponse in the server keys off exitCode to classify sandbox events.
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload).toEqual({ exitCode: 1, stdout: "3/3 failed", stderr: "trace" });
  });

  it("reuses one sandbox across commands in a session", async () => {
    const sandbox = fakeSandbox();
    const { dispatcher } = newDispatcher({}, sandbox);

    await dispatcher.callTool(sandboxToolName, { command: "echo one" });
    await dispatcher.callTool(sandboxToolName, { command: "echo two" });

    expect(sandbox.createSandbox).toHaveBeenCalledTimes(1);
  });

  it("rejects a sandbox call with no command", async () => {
    const { dispatcher } = newDispatcher();

    await expect(dispatcher.callTool(sandboxToolName, {})).rejects.toThrow(/command/);
  });

  it("blocks a schema-violating proof contract before the tool logic runs", async () => {
    const { dispatcher } = newDispatcher();

    await expect(
      dispatcher.callTool("submit_byter_result", {
        kind: "byter.result",
        status: "patch-ready",
        summary: "too short",
        proof: { before: "b", after: "a", regressions: "r", attempts: "1/3" },
        candidatePatch: null
      })
    ).rejects.toBeInstanceOf(GuardValidationError);
  });

  it("accepts a valid proof contract and returns the patch-ready instruction", async () => {
    const { dispatcher } = newDispatcher();

    const result = await dispatcher.callTool("submit_byter_result", {
      kind: "byter.result",
      status: "patch-ready",
      summary: "The reported tokenizer failure was reproduced three times and then fixed.",
      proof: {
        before: "3/3 runs failed",
        after: "3/3 runs passed",
        regressions: "Focused regression passed",
        attempts: "3/3"
      },
      candidatePatch: {
        title: "Fix trailing escape crash",
        body: "Guards against a trailing backslash.",
        files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
      }
    });

    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.accepted).toBe(true);
    expect(payload.instruction).toContain("create_fix_pull_request");
  });

  it("refuses the GitHub write without an approval context", async () => {
    const { dispatcher } = newDispatcher();

    await expect(
      dispatcher.callTool("create_fix_pull_request", {
        owner: "o",
        repo: "r",
        baseBranch: "main",
        branchName: "byter/fix-7-abc",
        title: "Fix trailing escape crash",
        body: "Verified by Byter.",
        files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }]
      })
    ).rejects.toThrow(/approval is required/);
  });
});
