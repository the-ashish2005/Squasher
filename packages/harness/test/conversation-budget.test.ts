import { describe, expect, it, vi } from "vitest";
import { maxToolOutputBudgetBytes } from "../src/agent-loop.js";
import { SquasherHarness } from "../src/harness-runtime.js";
import { SessionStore } from "../src/session-store.js";
import { buildSquasherAgentSpec } from "@squasher/agent";
import type { LlmClient, LlmResponse } from "../src/llm-client.js";
import type { SandboxClientLike } from "../src/sandbox-client.js";

/**
 * Bounding one tool response is not enough. After read_file was capped at 32 KB, a live run
 * made 36 paged reads that together came to 179 KB -- close to the 215 KB that had timed the
 * model request out before the cap existed -- and each retry resent the same conversation.
 * The budget has to be on the conversation, not the message.
 */

function fakeSandbox(): SandboxClientLike {
  return {
    createSandbox: vi.fn().mockResolvedValue("sbx_budget"),
    // Every command answers with a large body, standing in for many paged reads.
    runCommand: vi.fn().mockResolvedValue({ stdout: "x".repeat(24 * 1024), stderr: "", exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    closeSandbox: vi.fn().mockResolvedValue(undefined)
  };
}

describe("conversation size budget", () => {
  it("keeps the conversation bounded however many tool results accumulate", async () => {
    const sent: Array<Array<{ role: string; content?: unknown }>> = [];
    const responses: LlmResponse[] = [];
    for (let index = 0; index < 12; index += 1) {
      responses.push({
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: `call_${index}`, name: "run_command", arguments: JSON.stringify({ command: `echo ${index}` }) }]
      });
    }
    responses.push({ text: "done", finishReason: "stop", toolCalls: [] });

    const complete = vi.fn(async (messages: Array<{ role: string; content?: unknown }>) => {
      sent.push(messages);
      const next = responses.shift();
      if (!next) throw new Error("ran out of scripted responses");
      return next;
    });

    const store = new SessionStore({});
    const harness = new SquasherHarness({
      client: {} as never,
      llm: { complete } as unknown as LlmClient,
      sandbox: fakeSandbox(),
      store
    });

    const created = (await harness.sessions.create({
      agent: { spec: buildSquasherAgentSpec({ modelName: "m" }) }
    })) as { data: { id: string } };
    const turn = (await harness.sessions.createTurn(created.data.id, {
      input: [{ type: "user.message", content: "Investigate." }]
    })) as { data: { id: string } };
    for await (const _event of await harness.sessions.subscribeToTurn(created.data.id, turn.data.id)) {
      // drain
    }

    // Raw history keeps everything; what goes to the model is what must stay bounded.
    const rawToolBytes = store
      .messages(created.data.id)
      .filter((message) => message.role === "tool")
      .reduce((total, message) => total + Buffer.byteLength(message.content ?? "", "utf8"), 0);
    expect(rawToolBytes).toBeGreaterThan(maxToolOutputBudgetBytes);

    const lastRequest = sent.at(-1)!;
    const sentToolBytes = lastRequest
      .filter((message) => message.role === "tool")
      .reduce((total, message) => total + Buffer.byteLength(String(message.content ?? ""), "utf8"), 0);

    expect(sentToolBytes).toBeLessThanOrEqual(maxToolOutputBudgetBytes);
    // Never unbounded growth: the request does not scale with the number of reads.
    expect(sentToolBytes).toBeLessThan(rawToolBytes);
  });

  it("elides oldest first and keeps the newest results verbatim", async () => {
    const sent: Array<Array<{ role: string; content?: unknown }>> = [];
    const responses: LlmResponse[] = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push({
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: `call_${index}`, name: "run_command", arguments: JSON.stringify({ command: `echo ${index}` }) }]
      });
    }
    responses.push({ text: "done", finishReason: "stop", toolCalls: [] });

    const complete = vi.fn(async (messages: Array<{ role: string; content?: unknown }>) => {
      sent.push(messages);
      const next = responses.shift();
      if (!next) throw new Error("ran out of scripted responses");
      return next;
    });

    const store = new SessionStore({});
    const harness = new SquasherHarness({
      client: {} as never,
      llm: { complete } as unknown as LlmClient,
      sandbox: fakeSandbox(),
      store
    });
    const created = (await harness.sessions.create({
      agent: { spec: buildSquasherAgentSpec({ modelName: "m" }) }
    })) as { data: { id: string } };
    const turn = (await harness.sessions.createTurn(created.data.id, {
      input: [{ type: "user.message", content: "Investigate." }]
    })) as { data: { id: string } };
    for await (const _event of await harness.sessions.subscribeToTurn(created.data.id, turn.data.id)) {
      // drain
    }

    const lastRequest = sent.at(-1)!;
    const toolMessages = lastRequest.filter((message) => message.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(1);

    // Newest survives intact; oldest is replaced by a stub that says what happened.
    expect(String(toolMessages.at(-1)!.content)).not.toContain("elided");
    expect(String(toolMessages[0]!.content)).toContain("elided");

    // Every tool message is still present, so each still answers its assistant tool call.
    const toolCallIds = lastRequest.filter((m) => m.role === "tool").length;
    expect(toolCallIds).toBe(6);
  });
});
