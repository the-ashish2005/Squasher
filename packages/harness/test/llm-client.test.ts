import { describe, expect, it, vi } from "vitest";
import { LlmClient, LlmRateLimitError, LlmRequestError } from "../src/llm-client.js";

interface FakeCompletions {
  create: ReturnType<typeof vi.fn>;
}

function withFakeTransport(client: LlmClient, create: FakeCompletions["create"]): LlmClient {
  const internals = client as unknown as { client: { chat: { completions: FakeCompletions } } };
  internals.client = { chat: { completions: { create } } };
  return client;
}

function statusError(status: number, message = "boom"): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function newClient(create: FakeCompletions["create"], sleep = vi.fn().mockResolvedValue(undefined)) {
  const client = new LlmClient({
    apiKey: "key",
    baseUrl: "https://api.deepseek.test",
    model: "deepseek-v4-pro",
    sleep
  });
  return { client: withFakeTransport(client, create), sleep };
}

describe("llm client", () => {
  it("returns final text when the model stops without tool calls", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "all done", tool_calls: [] }, finish_reason: "stop" }]
    });
    const { client } = newClient(create);

    const response = await client.complete([{ role: "user", content: "go" }], []);

    expect(response.text).toBe("all done");
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe("stop");
  });

  it("returns function tool calls in the standard shape", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_issue", arguments: '{"issueNumber":1}' } },
              { id: "call_2", type: "custom", custom: { name: "ignored", input: "x" } }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    });
    const { client } = newClient(create);

    const response = await client.complete([{ role: "user", content: "go" }], []);

    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "read_issue", arguments: '{"issueNumber":1}' }
    ]);
  });

  it("retries a 429 with exponential backoff and succeeds", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(statusError(429, "slow down"))
      .mockRejectedValueOnce(statusError(429, "slow down"))
      .mockResolvedValue({ choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }] });
    const { client, sleep } = newClient(create);

    const response = await client.complete([{ role: "user", content: "go" }], []);

    expect(response.text).toBe("ok");
    expect(create).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it("surfaces an exhausted rate limit distinctly from other failures", async () => {
    const create = vi.fn().mockRejectedValue(statusError(429, "slow down"));
    const { client } = newClient(create);

    await expect(client.complete([{ role: "user", content: "go" }], [])).rejects.toBeInstanceOf(LlmRateLimitError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 400 and reports it as a request error", async () => {
    const create = vi.fn().mockRejectedValue(statusError(400, "bad tool schema"));
    const { client } = newClient(create);

    await expect(client.complete([{ role: "user", content: "go" }], [])).rejects.toMatchObject({
      name: "LlmRequestError",
      status: 400
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a 500 before giving up", async () => {
    const create = vi.fn().mockRejectedValue(statusError(503, "unavailable"));
    const { client } = newClient(create);

    await expect(client.complete([{ role: "user", content: "go" }], [])).rejects.toBeInstanceOf(LlmRequestError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("retries a timed-out request and succeeds", async () => {
    // A timeout carries no HTTP status. A status-only retry rule skipped it entirely, so a
    // single transient timeout ended a live run that had already done its work.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("Request timed out."))
      .mockResolvedValue({ choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] });
    const { client, sleep } = newClient(create);

    const response = await client.complete([{ role: "user", content: "hi" }], []);

    expect(response.text).toBe("recovered");
    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries a dropped connection", async () => {
    for (const message of ["socket hang up", "ECONNRESET", "ETIMEDOUT", "getaddrinfo EAI_AGAIN api.deepseek.com"]) {
      const create = vi
        .fn()
        .mockRejectedValueOnce(new Error(message))
        .mockResolvedValue({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      const { client } = newClient(create);

      await expect(client.complete([{ role: "user", content: "hi" }], []), message).resolves.toMatchObject({ text: "ok" });
      expect(create, message).toHaveBeenCalledTimes(2);
    }
  });

  it("gives up after the attempt limit when every request times out", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Request timed out."));
    const { client } = newClient(create);

    // Retried, not retried for ever: the turn still fails once the budget is spent.
    await expect(client.complete([{ role: "user", content: "hi" }], [])).rejects.toBeInstanceOf(LlmRequestError);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("never sends tool_choice, which DeepSeek's models reject", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }]
    });
    const { client } = newClient(create);

    await client.complete([{ role: "user", content: "go" }], [
      { type: "function", function: { name: "read_issue", parameters: { type: "object" } } }
    ]);

    const request = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).not.toHaveProperty("tool_choice");
    expect(request.model).toBe("deepseek-v4-pro");
    expect(Array.isArray(request.tools)).toBe(true);
  });

  it("does not retry permanent failures", async () => {
    // Retrying a bad key or a malformed request cannot help, and hides the real cause
    // behind a delay.
    for (const status of [400, 401, 403, 404, 422]) {
      const create = vi.fn().mockRejectedValue(statusError(status, `permanent ${status}`));
      const { client, sleep } = newClient(create);

      await expect(client.complete([{ role: "user", content: "hi" }], []), String(status)).rejects.toBeInstanceOf(
        LlmRequestError
      );
      expect(create, String(status)).toHaveBeenCalledTimes(1);
      expect(sleep, String(status)).not.toHaveBeenCalled();
    }
  });

  it("keeps retrying 429 and 5xx, and stops at the attempt limit", async () => {
    for (const status of [429, 500, 502, 503]) {
      const create = vi.fn().mockRejectedValue(statusError(status, `transient ${status}`));
      const { client } = newClient(create);

      await expect(client.complete([{ role: "user", content: "hi" }], []), String(status)).rejects.toBeInstanceOf(Error);
      // Finite: three attempts, never an unbounded loop.
      expect(create, String(status)).toHaveBeenCalledTimes(3);
    }
  });

  it("preserves the final error detail after the budget is spent", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Request timed out."));
    const { client } = newClient(create);

    await expect(client.complete([{ role: "user", content: "hi" }], [])).rejects.toThrow("Request timed out.");
  });

  it("backs off between attempts rather than retrying immediately", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(statusError(503, "unavailable"))
      .mockResolvedValue({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    const { client, sleep } = newClient(create);

    await client.complete([{ role: "user", content: "hi" }], []);

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it("requires an api key when built from the environment", () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(() => LlmClient.fromEnv()).toThrow(/DEEPSEEK_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});
