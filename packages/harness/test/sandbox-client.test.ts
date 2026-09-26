import { beforeEach, describe, expect, it, vi } from "vitest";

const kill = vi.fn().mockResolvedValue(true);
const run = vi.fn();
const write = vi.fn().mockResolvedValue(undefined);
const create = vi.fn();

class FakeCommandExitError extends Error {
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number
  ) {
    super("exit");
  }
}

vi.mock("e2b", () => ({
  CommandExitError: FakeCommandExitError,
  Sandbox: {
    create: (...args: unknown[]) => create(...args)
  }
}));

const { E2bSandboxClient, defaultCommandTimeoutMs } = await import("../src/sandbox-client.js");

beforeEach(() => {
  vi.clearAllMocks();
  kill.mockResolvedValue(true);
  write.mockResolvedValue(undefined);
  create.mockImplementation(async () => ({
    sandboxId: "sbx_test",
    commands: { run },
    files: { write },
    kill
  }));
});

describe("e2b sandbox client", () => {
  it("creates a sandbox and returns its id", async () => {
    const client = new E2bSandboxClient({ apiKey: "key" });

    await expect(client.createSandbox()).resolves.toBe("sbx_test");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "key" }));
  });

  it("applies the default 60 second per-command timeout", async () => {
    run.mockResolvedValue({ stdout: "hi", stderr: "", exitCode: 0 });
    const client = new E2bSandboxClient({ apiKey: "key" });
    const sandboxId = await client.createSandbox();

    await client.runCommand(sandboxId, "echo hi");

    expect(run).toHaveBeenCalledWith("echo hi", { timeoutMs: defaultCommandTimeoutMs });
    expect(defaultCommandTimeoutMs).toBe(60_000);
  });

  it("honours an explicit per-command timeout", async () => {
    run.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const client = new E2bSandboxClient({ apiKey: "key" });
    const sandboxId = await client.createSandbox();

    await client.runCommand(sandboxId, "sleep 1", 5_000);

    expect(run).toHaveBeenCalledWith("sleep 1", { timeoutMs: 5_000 });
  });

  it("treats a non-zero exit as evidence rather than a harness failure", async () => {
    run.mockRejectedValue(new FakeCommandExitError("partial", "boom", 1));
    const client = new E2bSandboxClient({ apiKey: "key" });
    const sandboxId = await client.createSandbox();

    await expect(client.runCommand(sandboxId, "node repro.ts")).resolves.toEqual({
      stdout: "partial",
      stderr: "boom",
      exitCode: 1
    });
  });

  it("reports an infrastructure failure as a non-zero exit without throwing", async () => {
    run.mockRejectedValue(new Error("sandbox unreachable"));
    const client = new E2bSandboxClient({ apiKey: "key" });
    const sandboxId = await client.createSandbox();

    await expect(client.runCommand(sandboxId, "echo hi")).resolves.toEqual({
      stdout: "",
      stderr: "sandbox unreachable",
      exitCode: 1
    });
  });

  it("writes files into the sandbox", async () => {
    const client = new E2bSandboxClient({ apiKey: "key" });
    const sandboxId = await client.createSandbox();

    await client.writeFile(sandboxId, "repro.ts", "throw new Error('x')");

    expect(write).toHaveBeenCalledWith("repro.ts", "throw new Error('x')");
  });

  it("kills the sandbox on close and forgets it", async () => {
    const client = new E2bSandboxClient({ apiKey: "key" });
    const sandboxId = await client.createSandbox();

    await client.closeSandbox(sandboxId);

    expect(kill).toHaveBeenCalledTimes(1);
    await expect(client.runCommand(sandboxId, "echo hi")).rejects.toThrow(/Unknown sandbox/);
  });

  it("swallows a teardown failure so cleanup never masks the original error", async () => {
    kill.mockRejectedValue(new Error("already gone"));
    const client = new E2bSandboxClient({ apiKey: "key" });
    const sandboxId = await client.createSandbox();

    await expect(client.closeSandbox(sandboxId)).resolves.toBeUndefined();
  });

  it("ignores closing an unknown sandbox", async () => {
    const client = new E2bSandboxClient({ apiKey: "key" });

    await expect(client.closeSandbox("sbx_missing")).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });

  it("requires an api key when built from the environment", () => {
    const previous = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      expect(() => E2bSandboxClient.fromEnv()).toThrow(/E2B_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.E2B_API_KEY = previous;
    }
  });
});
