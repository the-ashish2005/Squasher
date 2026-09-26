import { describe, expect, it, vi } from "vitest";
import {
  ByterTrueForgeRuntime,
  TrueForgeInitialTurnError,
  buildInitialUserMessage,
  buildProofContractRecoveryMessage,
  buildByterAgentSpec
} from "../src/index.js";

const config = {
  baseUrl: "https://trueforge.example",
  token: "token",
  modelName: "glm-5.3",
  modelProvider: "agentrouter"
};

describe("Byter TrueForge runtime", () => {
  it("sends the CLINE user agent required by the TrueForge deployment", () => {
    const runtime = new ByterTrueForgeRuntime(config);
    const client = (runtime as unknown as { client: { _options: { headers: Record<string, string> } } }).client;

    expect(client._options.headers["user-agent"]).toBe("CLINE");
  });

  it("builds an inline agent spec with sandbox and subagents enabled", () => {
    const spec = buildByterAgentSpec(config);

    expect(spec.model.name).toBe("agentrouter/glm-5.3");
    expect(spec).not.toHaveProperty("responseFormat");
    expect(spec.config.askUserQuestions.enabled).toBe(false);
    expect(spec.config.generativeUi.enabled).toBe(false);
    expect(spec.config.dynamicSubAgents.enabled).toBe(true);
    expect(spec.config.sandbox.enabled).toBe(true);
    expect(spec.mcpServers).toEqual([
      {
        name: "byter-github",
        preload: true,
        enableTools: ["read_issue", "read_file", "submit_byter_result", "create_fix_pull_request"],
        requireApprovalForTools: ["create_fix_pull_request"]
      }
    ]);
  });

  it("builds the initial issue analysis prompt", () => {
    const message = buildInitialUserMessage({
      issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
      issueTitle: "Trailing escape crash",
      issueBody: "Tokenizer throws on a single backslash.",
      repository: "MAYANK-MAHAUR/Byter",
      baseBranch: "main",
      branchName: "byter/fix-1-test",
      baseSha: "abc123"
    });

    expect(message).toContain("Repository: MAYANK-MAHAUR/Byter");
    expect(message).toContain("Base SHA: abc123");
    expect(message).toContain("Reserved fix branch: byter/fix-1-test");
    expect(message).toContain("Require the same target failure 3/3");
    expect(buildByterAgentSpec(config).instructions).toContain("node-v22.14.0-linux-x64.tar.gz");
    expect(buildByterAgentSpec(config).instructions).toContain("submit_byter_result");
    expect(buildByterAgentSpec(config).instructions).toContain("never paste repository source or test contents into base64 blobs");
    expect(buildByterAgentSpec(config).instructions).toContain("concise GitHub-flavored Markdown");
    expect(buildByterAgentSpec(config).instructions).toContain("opening and closing $$ delimiters on their own lines");
    expect(buildByterAgentSpec(config).instructions).toContain("Do not use raw HTML");
    expect(buildByterAgentSpec(config).instructions).toContain("immediately run that exact command two more times");
    expect(message).toContain("public-safe GitHub-flavored Markdown");
    expect(message).toContain("repeat the exact command immediately until 3/3 attempts");
  });

  it("creates a session and first turn through the TrueForge SDK shape", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "session_1", title: null } }),
        createTurn: vi.fn().mockResolvedValue({
          data: {
            id: "turn_1",
            sessionId: "session_1",
            state: { status: "running" }
          }
        }),
        listEvents: vi.fn()
      }
    };
    const runtime = new ByterTrueForgeRuntime(config, client);

    const result = await runtime.startSession({
      issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
      issueTitle: "Bug",
      issueBody: "Breaks",
      repository: "MAYANK-MAHAUR/Byter",
      baseBranch: "main",
      branchName: "byter/fix-1-test"
    });

    expect(result.session.id).toBe("session_1");
    expect(result.turn.status).toBe("running");
    expect(client.sessions.create).toHaveBeenCalledWith({
      agent: { spec: expect.objectContaining({ model: { name: "agentrouter/glm-5.3" } }) }
    });
    expect(client.sessions.createTurn).toHaveBeenCalledWith(
      "session_1",
      expect.objectContaining({
        input: [expect.objectContaining({ type: "user.message" })]
      })
    );
  });

  it("requests a bounded proof contract recovery turn", async () => {
    const client = {
      sessions: {
        create: vi.fn(),
        createTurn: vi.fn().mockResolvedValue({
          data: {
            id: "turn_recovery",
            sessionId: "session_1",
            state: { status: "running" }
          }
        }),
        listEvents: vi.fn()
      }
    };
    const runtime = new ByterTrueForgeRuntime(config, client);

    await expect(runtime.requestProofContract("session_1")).resolves.toEqual({
      id: "turn_recovery",
      sessionId: "session_1",
      status: "running"
    });
    expect(buildProofContractRecoveryMessage()).toContain("immediately use the sandbox exec tool");
    expect(buildProofContractRecoveryMessage()).toContain("Do not reread repository files");
    expect(buildProofContractRecoveryMessage()).toContain("Do not report blocked merely because the previous turn ended");
    expect(client.sessions.createTurn).toHaveBeenCalledWith(
      "session_1",
      expect.objectContaining({
        input: [expect.objectContaining({
          type: "user.message",
          content: expect.stringContaining("valid byter.result object")
        })]
      })
    );
  });

  it("resumes an exact TrueForge tool approval", async () => {
    const client = {
      sessions: {
        create: vi.fn(),
        createTurn: vi.fn().mockResolvedValue({
          data: {
            id: "turn_approval",
            sessionId: "session_1",
            state: { status: "running" }
          }
        }),
        listEvents: vi.fn()
      }
    };
    const runtime = new ByterTrueForgeRuntime(config, client);

    await runtime.resolveToolApproval({
      sessionId: "session_1",
      previousTurnId: "turn_1",
      threadId: "thread_1",
      toolCallId: "call_1",
      decision: "allow"
    });

    expect(client.sessions.createTurn).toHaveBeenCalledWith("session_1", {
      previousTurnId: "turn_1",
      input: [{
        type: "user.tool_approval",
        threadId: "thread_1",
        toolCallId: "call_1",
        approval: { status: "allow" }
      }]
    });
  });

  it("normalizes stored session events", async () => {
    const client = {
      sessions: {
        create: vi.fn(),
        createTurn: vi.fn(),
        listEvents: vi.fn().mockResolvedValue({
          data: [{ sequenceNumber: 2, event: { type: "sandbox.created" } }]
        })
      }
    };
    const runtime = new ByterTrueForgeRuntime(config, client);

    await expect(runtime.listSessionEvents("session_1")).resolves.toEqual([
      { sequenceNumber: 2, type: "sandbox.created", raw: { sequenceNumber: 2, event: { type: "sandbox.created" } } }
    ]);
  });

  it("bounds oversized TrueForge event payloads before returning them", async () => {
    const oversizedOutput = "x".repeat(2 * 1024 * 1024);
    const client = {
      sessions: {
        create: vi.fn(),
        createTurn: vi.fn(),
        listEvents: vi.fn().mockResolvedValue({
          data: [{ sequenceNumber: 2, event: { type: "model.message", content: oversizedOutput } }]
        })
      }
    };
    const runtime = new ByterTrueForgeRuntime(config, client);

    const events = await runtime.listSessionEvents("session_1");

    expect(JSON.stringify(events).length).toBeLessThan(600_000);
    expect(events[0].type).toBe("model.message");
  });

  it("deletes the created session if initial turn creation fails", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "session_1", title: null }),
        createTurn: vi.fn().mockRejectedValue(new Error("turn failed")),
        delete: vi.fn().mockResolvedValue(undefined),
        listEvents: vi.fn()
      }
    };
    const runtime = new ByterTrueForgeRuntime(config, client);

    await expect(
      runtime.startSession({
        issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
        issueTitle: "Bug",
        issueBody: "Breaks",
        repository: "MAYANK-MAHAUR/Byter",
        baseBranch: "main",
        branchName: "byter/fix-1-test"
      })
    ).rejects.toMatchObject({
      name: "TrueForgeInitialTurnError",
      details: {
        session: { id: "session_1", title: null },
        cleanupAttempted: true,
        cleanupSucceeded: true
      }
    });

    expect(client.sessions.delete).toHaveBeenCalledWith("session_1");
  });

  it("exposes the created session when cleanup is unavailable", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ id: "session_1", title: "Recovered" }),
        createTurn: vi.fn().mockRejectedValue(new Error("turn failed")),
        listEvents: vi.fn()
      }
    };
    const runtime = new ByterTrueForgeRuntime(config, client);

    try {
      await runtime.startSession({
        issueUrl: "https://github.com/MAYANK-MAHAUR/Byter/issues/1",
        issueTitle: "Bug",
        issueBody: "Breaks",
        repository: "MAYANK-MAHAUR/Byter",
        baseBranch: "main",
        branchName: "byter/fix-1-test"
      });
      throw new Error("Expected startSession to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TrueForgeInitialTurnError);
      expect((error as TrueForgeInitialTurnError).details).toMatchObject({
        session: { id: "session_1", title: "Recovered" },
        cleanupAttempted: false,
        cleanupSucceeded: false
      });
    }
  });
});
