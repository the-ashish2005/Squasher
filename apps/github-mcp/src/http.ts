import type { IncomingMessage, ServerResponse } from "node:http";
import {
  approvalPayloadHash,
  createGitHubMcpTools,
  listGitHubTools,
  type GitHubMcpToolName,
  type GitHubMcpToolResult,
  type GitHubMcpWriteToolName,
  type GitHubRestClientLike
} from "./tools.js";

const maxMcpRequestBytes = 2 * 1024 * 1024;
const protocolVersion = "2024-11-05";

export interface GitHubMcpHttpHandlerOptions {
  client: GitHubRestClientLike;
  authToken: string;
  readOnly?: boolean;
}

export function createGitHubMcpHttpHandler(
  options: GitHubMcpHttpHandlerOptions
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const tools = createGitHubMcpTools({ client: options.client });
  const exposedTools = listGitHubTools().filter((tool) => !options.readOnly || !tool.requiresApproval);

  return async (request, response) => {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "MCP endpoint accepts POST only" });
      return;
    }

    if (bearerToken(request) !== options.authToken) {
      sendJson(response, 401, { error: "MCP authentication required" });
      return;
    }

    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = parseJsonRpcRequest(await readRequestBody(request));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid MCP request" });
      return;
    }

    if (rpcRequest.method === "notifications/initialized") {
      response.statusCode = 202;
      response.end();
      return;
    }

    try {
      const result = await dispatchRequest(rpcRequest, tools, exposedTools);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 200, errorResponse(rpcRequest.id, -32602, error instanceof Error ? error.message : "Invalid MCP parameters"));
    }
  };
}

async function dispatchRequest(
  request: JsonRpcRequest,
  tools: ReturnType<typeof createGitHubMcpTools>,
  exposedTools: ReturnType<typeof listGitHubTools>
): Promise<JsonRpcResponse> {
  if (request.method === "initialize") {
    return successResponse(request.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "squasher-github", version: "0.1.0" }
    });
  }

  if (request.method === "tools/list") {
    return successResponse(request.id, {
      tools: exposedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchemaFor(tool.name),
        annotations: {
          readOnlyHint: !tool.requiresApproval,
          destructiveHint: tool.name === "create_fix_pull_request"
        }
      }))
    });
  }

  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    const name = expectToolName(params.name);
    if (!exposedTools.some((tool) => tool.name === name)) {
      return errorResponse(request.id, -32602, "Tool is not enabled for this MCP connection");
    }
    const args = asRecord(params.arguments);
    let result: GitHubMcpToolResult;

    try {
      // TrueForge enforces requireApprovalForTools on this authenticated MCP server.
      result = await tools.callTool({
        name,
        arguments: args,
        ...(isWriteTool(name)
          ? { approval: { approved: true, expectedPayloadHash: approvalPayloadHash(name, args) } }
          : {})
      });
    } catch (error) {
      return errorResponse(request.id, -32000, error instanceof Error ? error.message : "MCP tool failed");
    }

    return successResponse(request.id, result);
  }

  return errorResponse(request.id, -32601, "MCP method not found");
}

const codeEvidenceSchema = {
  type: "array",
  description: "Repository excerpts establishing the verdict. Each excerpt must occur verbatim (whitespace aside) in that file on the base branch; it is checked.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["path", "excerpt"],
    properties: {
      path: { type: "string" },
      excerpt: { type: "string", description: "At least 12 characters, quoted from the file." }
    }
  }
};

const executedCommandSchema = {
  type: "string",
  description: "A sandbox command you actually ran in this session whose output establishes the verdict; it is checked against what ran."
};

export function inputSchemaFor(name: GitHubMcpToolName) {
  switch (name) {
    case "read_issue":
    case "add_verified_label":
      return {
        type: "object",
        required: ["owner", "repo", "issueNumber"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "integer", minimum: 1 }
        }
      };
    case "read_repository_instructions":
      return {
        type: "object",
        required: ["owner", "repo"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          ref: { type: "string", description: "Branch or commit to read from. Defaults to the default branch." }
        }
      };
    case "read_file":
      return {
        type: "object",
        required: ["owner", "repo", "path"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string" },
          startLine: {
            type: "integer",
            minimum: 1,
            description: "First line to return, 1-based. Defaults to 1."
          },
          endLine: {
            type: "integer",
            minimum: 1,
            description: "Last line to return, inclusive. Defaults to the end of the file, subject to the byte cap."
          },
          maxBytes: {
            type: "integer",
            minimum: 1,
            description: "Byte ceiling for the returned window. Clamped to the server maximum."
          }
        }
      };
    case "submit_squasher_result":
      return {
        type: "object",
        additionalProperties: false,
        required: ["kind", "status", "summary", "proof", "candidatePatch"],
        properties: {
          kind: { type: "string", const: "squasher.result" },
          status: {
            type: "string",
            enum: [
              "patch-ready",
              "verified",
              "implemented-feature",
              "implemented-improvement",
              "not-reproduced",
              "not-actionable",
              "blocked",
              "failed"
            ]
          },
          summary: { type: "string" },
          rootCauseSummary: {
            type: "string",
            description:
              "One or two sentences naming the cause you established. Omit when no cause was established."
          },
          nextStep: {
            type: "string",
            description: "One sentence on what the maintainer should do next. Omit when nothing is needed."
          },
          findings: {
            type: "array",
            maxItems: 8,
            items: { type: "string" },
            description: "Short factual statements of what you checked and what you observed."
          },
          requirements: {
            type: "array",
            description:
              "Acceptance criteria taken from the issue and its discussion, one per concrete capability (split a broad claim such as 'sorting exists' into each column or behaviour), each with a verdict against the final code. Required for implemented-feature and implemented-improvement; recommended for every status.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["requirement", "verdict", "evidence"],
              properties: {
                requirement: { type: "string" },
                verdict: {
                  type: "string",
                  enum: ["pass", "fail", "already-implemented", "missing", "out-of-scope"],
                  description:
                    "Technical state only. pass: built and verified in this run. fail: attempted and not working. already-implemented: the repository already does it (needs codeEvidence or executedCommand). missing: the repository does not do it and this run did not build it. out-of-scope: not part of this issue."
                },
                evidence: {
                  type: "string",
                  description: "The observed behaviour or concrete code that establishes the verdict, not your own assurance."
                },
                codeEvidence: codeEvidenceSchema,
                executedCommand: executedCommandSchema,
                ownership: {
                  type: "object",
                  additionalProperties: false,
                  required: ["status", "by"],
                  description:
                    "Whose work this is per the discussion, separate from its technical state. reserved: the maintainer will do it or split it out. offered: the maintainer offered it to someone. claimed: someone said they will do it. Owned work is never built in this run.",
                  properties: {
                    status: { type: "string", enum: ["reserved", "offered", "claimed"] },
                    by: { type: "string", description: "Who holds it, for example @maintainer or @reporter." },
                    basis: { type: "string", description: "The comment that establishes it." }
                  }
                }
              }
            }
          },
          fileChanges: {
            type: "array",
            description:
              "One entry per file in candidatePatch: what changed in it, why, and which requirements (exact requirement text) it satisfies. Shown to the maintainer reviewing the patch.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "summary"],
              properties: {
                path: { type: "string" },
                summary: { type: "string", description: "What changed in this file and why." },
                requirements: { type: "array", items: { type: "string" }, description: "Exact texts of the requirements this change satisfies." }
              }
            }
          },
          testCommands: {
            type: "array",
            maxItems: 8,
            description:
              "Commands that re-verify this change from a FRESH clone of the repository with the patch applied, run from the repository root: include any setup (installing dependencies), and only commands that pass against the patch. Do not rely on files that exist only in your sandbox, such as a reproducer you did not add to the patch. The maintainer can re-run them later.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["command", "purpose"],
              properties: {
                command: { type: "string" },
                purpose: { type: "string", description: "What this command checks." }
              }
            }
          },
          discussionClaims: {
            type: "array",
            description:
              "Claims from the issue or its discussion that affect whether the work is needed (for example 'sorting already exists'), each checked against the repository. Comments are context, not proof: keep the claim and what the code shows side by side.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["claim", "verdict", "evidence"],
              properties: {
                claim: { type: "string", description: "What was claimed, and by whom." },
                verdict: {
                  type: "string",
                  enum: ["confirmed", "partly-confirmed", "contradicted", "unverified"],
                  description: "confirmed and partly-confirmed need codeEvidence or executedCommand."
                },
                evidence: { type: "string", description: "What the repository actually shows, including any part of the claim that does not hold." },
                codeEvidence: codeEvidenceSchema,
                executedCommand: executedCommandSchema
              }
            }
          },
          proof: {
            type: "object",
            additionalProperties: false,
            required: ["before", "after", "regressions", "attempts"],
            properties: {
              before: { type: "string" },
              after: { type: "string" },
              regressions: { type: "string" },
              attempts: { type: "string" }
            }
          },
          candidatePatch: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["title", "body", "files"],
                properties: {
                  title: { type: "string" },
                  body: { type: "string" },
                  files: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["path", "content"],
                      properties: {
                        path: { type: "string" },
                        content: { type: "string" }
                      }
                    }
                  }
                }
              },
              { type: "null" }
            ]
          }
        }
      };
    case "comment_on_issue":
      return {
        type: "object",
        required: ["owner", "repo", "issueNumber", "body"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "integer", minimum: 1 },
          body: { type: "string" }
        }
      };
    case "create_fix_pull_request":
      return {
        type: "object",
        required: ["owner", "repo", "baseBranch", "branchName", "title", "body", "files"],
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          baseBranch: { type: "string" },
          branchName: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          files: {
            type: "array",
            minItems: 1,
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
      };
  }
}

function isWriteTool(name: GitHubMcpToolName): name is GitHubMcpWriteToolName {
  return name === "add_verified_label" || name === "comment_on_issue" || name === "create_fix_pull_request";
}

function parseJsonRpcRequest(value: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Malformed JSON");
  }

  const request = asRecord(parsed);
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || request.method.length === 0) {
    throw new Error("Expected a JSON-RPC 2.0 request");
  }

  return {
    jsonrpc: "2.0",
    id: request.id as string | number | null | undefined,
    method: request.method,
    params: request.params
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxMcpRequestBytes) {
      throw new Error("MCP request body too large");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function expectToolName(value: unknown): GitHubMcpToolName {
  if (
    value === "read_issue" ||
    value === "read_file" ||
    value === "read_repository_instructions" ||
    value === "submit_squasher_result" ||
    value === "add_verified_label" ||
    value === "comment_on_issue" ||
    value === "create_fix_pull_request"
  ) {
    return value;
  }

  throw new Error("Unknown MCP tool");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }

  return value as Record<string, unknown>;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (Array.isArray(authorization) || !authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  return authorization.slice("Bearer ".length);
}

function successResponse(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), result };
}

function errorResponse(id: string | number | null | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), error: { code, message } };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}
