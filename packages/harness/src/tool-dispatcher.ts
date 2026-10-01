import {
  createGitHubMcpTools,
  inputSchemaFor,
  type ApprovalContext,
  type GitHubMcpToolName,
  type GitHubMcpToolResult,
  type GitHubRestClientLike
} from "@squasher/github-mcp";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { SandboxClientLike } from "./sandbox-client.js";
import {
  squasherResultSchema,
  createFixPullRequestSchema,
  GuardValidationError,
  validateAndParse,
  type GuardSchema
} from "./structured-output-guard.js";

/**
 * Sandbox execution tool. Named `run_command` because the dashboard's
 * `categoryForTool` in apps/server/src/server.ts classifies only `exec`, `shell` and
 * `run_command` as sandbox activity, and `hasExecutableProof` force-fails any
 * patch-ready run whose trace shows no sandbox command.
 */
export const sandboxToolName = "run_command";

/** Tools whose arguments are validated by the structured-output guard before running. */
const guardedSchemas: Record<string, GuardSchema> = {
  submit_squasher_result: squasherResultSchema,
  create_fix_pull_request: createFixPullRequestSchema
};

export interface ToolDispatcherOptions {
  client: GitHubRestClientLike;
  sandbox: SandboxClientLike;
  /** Resolves the session's sandbox, creating it on first use. */
  resolveSandboxId: () => Promise<string>;
  enabledTools?: string[];
  commandTimeoutMs?: number;
}

export interface ToolDispatcher {
  tools(): ChatCompletionFunctionTool[];
  callTool(name: string, args: Record<string, unknown>, approval?: ApprovalContext): Promise<GitHubMcpToolResult>;
}

/**
 * Calls the real GitHub tool logic in-process — no MCP JSON-RPC, no HTTP — and adds
 * sandbox execution.
 */
export function createToolDispatcher(options: ToolDispatcherOptions): ToolDispatcher {
  const githubTools = createGitHubMcpTools({ client: options.client });
  const enabled = new Set(
    options.enabledTools ?? [
      "read_issue",
      "read_file",
      "read_repository_instructions",
      "submit_squasher_result",
      "create_fix_pull_request"
    ]
  );
  enabled.add(sandboxToolName);

  return {
    tools() {
      const definitions: ChatCompletionFunctionTool[] = [];

      for (const name of [
        "read_issue",
        "read_file",
        "read_repository_instructions",
        "submit_squasher_result",
        "create_fix_pull_request"
      ] as const) {
        if (!enabled.has(name)) continue;
        definitions.push({
          type: "function",
          function: {
            name,
            description: describeGitHubTool(name),
            parameters: inputSchemaFor(name) as Record<string, unknown>,
            // Server-validated strict mode; the guard still re-checks the semantic rules
            // that a JSON Schema cannot express.
            strict: name === "submit_squasher_result"
          }
        });
      }

      definitions.push({
        type: "function",
        function: {
          name: sandboxToolName,
          description:
            "Run a shell command in the disposable sandbox, optionally writing files first. " +
            "Use this to bootstrap a toolchain, write a reproducer, and execute it repeatedly.",
          parameters: {
            type: "object",
            required: ["command"],
            properties: {
              command: { type: "string", description: "Shell command to execute in the sandbox." },
              files: {
                type: "array",
                description: "Files to write before running the command.",
                items: {
                  type: "object",
                  required: ["path", "content"],
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" }
                  }
                }
              }
            }
          }
        }
      });

      return definitions;
    },

    async callTool(name, args, approval) {
      if (!enabled.has(name)) {
        throw new Error(`Tool is not enabled for this harness session: ${name}`);
      }

      if (name === sandboxToolName) {
        return runInSandbox(options, args);
      }

      const schema = guardedSchemas[name];
      const validated = schema ? guard(name, schema, args) : args;

      return githubTools.callTool({
        name: name as GitHubMcpToolName,
        arguments: validated,
        ...(approval ? { approval } : {})
      });
    }
  };
}

/**
 * Re-validates already-parsed arguments through the guard. Arguments arrive here as an
 * object, so this catches schema violations that survived JSON parsing.
 */
function guard(name: string, schema: GuardSchema, args: Record<string, unknown>): Record<string, unknown> {
  const result = validateAndParse(JSON.stringify(args), schema);
  if (!result.valid) {
    throw new GuardValidationError(name, result.rawText, result.error);
  }
  return result.value;
}

async function runInSandbox(options: ToolDispatcherOptions, args: Record<string, unknown>): Promise<GitHubMcpToolResult> {
  const command = args.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error('Expected non-empty string argument: command');
  }

  const sandboxId = await options.resolveSandboxId();

  if (Array.isArray(args.files)) {
    for (const [index, file] of args.files.entries()) {
      if (typeof file !== "object" || file === null || Array.isArray(file)) {
        throw new Error(`Expected file object at index ${index}`);
      }
      const record = file as Record<string, unknown>;
      if (typeof record.path !== "string" || record.path.length === 0) {
        throw new Error(`Expected non-empty string argument: files[${index}].path`);
      }
      if (typeof record.content !== "string") {
        throw new Error(`Expected string argument: files[${index}].content`);
      }
      await options.sandbox.writeFile(sandboxId, record.path, record.content);
    }
  }

  const result = await options.sandbox.runCommand(sandboxId, command, options.commandTimeoutMs);

  // Shaped so the server's parseToolResponse classifies this as sandbox activity:
  // it keys off exitCode being present.
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr
        })
      }
    ]
  };
}

function describeGitHubTool(name: GitHubMcpToolName): string {
  switch (name) {
    case "read_issue":
      return "Read a GitHub issue by owner, repo, and number, including its comment discussion. Maintainer comments can change or narrow what the issue asks for.";
    case "read_file":
      return "Read a repository file at an optional ref.";
    case "read_repository_instructions":
      return "Read the repository's contributor and agent guidance (AGENTS.md, CLAUDE.md, CONTRIBUTING, PR template, README) for build, test, style and contribution rules.";
    case "submit_squasher_result":
      return "Submit the final Squasher proof contract without mutating GitHub.";
    case "create_fix_pull_request":
      return "Create a fix branch with explicit file contents and open a draft pull request. Requires maintainer approval.";
    default:
      return name;
  }
}
