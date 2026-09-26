import { CommandExitError, Sandbox } from "e2b";

export const defaultCommandTimeoutMs = 60_000;

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxClientLike {
  createSandbox(): Promise<string>;
  runCommand(sandboxId: string, command: string, timeoutMs?: number): Promise<SandboxRunResult>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  closeSandbox(sandboxId: string): Promise<void>;
}

export interface SandboxClientConfig {
  apiKey: string;
  /** Per-command wall clock limit. */
  commandTimeoutMs?: number;
  /** Sandbox lifetime; E2B reclaims it even if this process dies mid-run. */
  sandboxTimeoutMs?: number;
}

/**
 * E2B-backed sandbox. One sandbox is reused for a whole session because the
 * reproduction workflow is stateful: it bootstraps a toolchain, writes files, then
 * re-runs the same command to collect the 3/3 proof. Teardown is the caller's job via
 * `closeSandbox`, which the agent loop runs in a `finally`.
 */
export class E2bSandboxClient implements SandboxClientLike {
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly apiKey: string;
  private readonly commandTimeoutMs: number;
  private readonly sandboxTimeoutMs: number;

  constructor(config: SandboxClientConfig) {
    this.apiKey = config.apiKey;
    this.commandTimeoutMs = config.commandTimeoutMs ?? defaultCommandTimeoutMs;
    this.sandboxTimeoutMs = config.sandboxTimeoutMs ?? 10 * 60_000;
  }

  static fromEnv(overrides: Partial<SandboxClientConfig> = {}): E2bSandboxClient {
    const apiKey = overrides.apiKey ?? process.env.E2B_API_KEY;
    if (!apiKey) {
      throw new Error("E2B_API_KEY is required to start the Byter harness");
    }
    return new E2bSandboxClient({
      apiKey,
      ...(overrides.commandTimeoutMs !== undefined ? { commandTimeoutMs: overrides.commandTimeoutMs } : {}),
      ...(overrides.sandboxTimeoutMs !== undefined ? { sandboxTimeoutMs: overrides.sandboxTimeoutMs } : {})
    });
  }

  async createSandbox(): Promise<string> {
    const sandbox = await Sandbox.create({ apiKey: this.apiKey, timeoutMs: this.sandboxTimeoutMs });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return sandbox.sandboxId;
  }

  async runCommand(sandboxId: string, command: string, timeoutMs?: number): Promise<SandboxRunResult> {
    const sandbox = this.expect(sandboxId);
    try {
      const result = await sandbox.commands.run(command, { timeoutMs: timeoutMs ?? this.commandTimeoutMs });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (error) {
      // A non-zero exit is evidence, not a harness failure: the reproduction step
      // depends on observing the failing command.
      if (error instanceof CommandExitError) {
        return { stdout: error.stdout, stderr: error.stderr, exitCode: error.exitCode };
      }
      const message = error instanceof Error ? error.message : "Sandbox command failed";
      return { stdout: "", stderr: message, exitCode: 1 };
    }
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    await this.expect(sandboxId).files.write(path, content);
  }

  async closeSandbox(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) return;
    this.sandboxes.delete(sandboxId);
    try {
      await sandbox.kill();
    } catch (error) {
      console.warn(`Sandbox ${sandboxId} teardown failed`, error);
    }
  }

  private expect(sandboxId: string): Sandbox {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Unknown sandbox: ${sandboxId}`);
    }
    return sandbox;
  }
}
