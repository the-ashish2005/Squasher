import OpenAI from "openai";
import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";

export const defaultLlmBaseUrl = "https://api.deepseek.com";
export const defaultLlmModel = "deepseek-v4-pro";

export interface LlmClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Total attempts per request, including the first. */
  maxAttempts?: number;
  /** Injected in tests to avoid real backoff delays. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  finishReason: string;
}

export class LlmRateLimitError extends Error {
  readonly status = 429;

  constructor(message: string) {
    super(message);
    this.name = "LlmRateLimitError";
  }
}

export class LlmRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmRequestError";
    this.status = status;
  }
}

/**
 * OpenAI-compatible chat client. Base URL, key and model all come from config so the
 * same class can target any compatible provider without a code change.
 *
 * `tool_choice` is deliberately never sent: DeepSeek's current models reject named and
 * required tool choices, returning 400 in thinking mode.
 */
export class LlmClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: LlmClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      // Retries are handled here so 429s can be surfaced distinctly.
      maxRetries: 0
    });
    this.model = config.model;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  }

  static fromEnv(overrides: Partial<LlmClientConfig> = {}): LlmClient {
    const apiKey = overrides.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required to start the Byter harness");
    }

    return new LlmClient({
      apiKey,
      baseUrl: overrides.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? defaultLlmBaseUrl,
      model: overrides.model ?? process.env.DEEPSEEK_MODEL ?? defaultLlmModel,
      ...(overrides.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {}),
      ...(overrides.sleep ? { sleep: overrides.sleep } : {})
    });
  }

  async complete(messages: ChatCompletionMessageParam[], tools: ChatCompletionFunctionTool[]): Promise<LlmResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          ...(tools.length > 0 ? { tools } : {})
        });

        const choice = completion.choices[0];
        if (!choice) {
          throw new LlmRequestError("The model returned no choices");
        }

        const toolCalls = (choice.message.tool_calls ?? []).flatMap((toolCall) =>
          toolCall.type === "function"
            ? [{ id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments }]
            : []
        );

        return {
          text: typeof choice.message.content === "string" ? choice.message.content : "",
          toolCalls,
          finishReason: choice.finish_reason ?? "stop"
        };
      } catch (error) {
        lastError = error;
        const status = statusOf(error);
        const retryable = status === 429 || (status !== undefined && status >= 500);
        if (!retryable || attempt === this.maxAttempts) break;
        await this.sleep(2 ** (attempt - 1) * 1000);
      }
    }

    const status = statusOf(lastError);
    const detail = lastError instanceof Error ? lastError.message : "Unknown model error";
    if (status === 429) {
      throw new LlmRateLimitError(`Model rate limit exceeded after ${this.maxAttempts} attempts: ${detail}`);
    }
    throw new LlmRequestError(detail, status);
  }
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof OpenAI.APIError && typeof error.status === "number") {
    return error.status;
  }
  if (typeof error === "object" && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}
