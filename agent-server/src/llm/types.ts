export type ToolCall = { id: string; name: string; arguments: string };

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

/** What the call is for; the pool maps each purpose to an ordered list of models. */
export type Purpose = "chat" | "tools" | "vision" | "summary" | "search";

export type LLMRequest = {
  purpose: Purpose;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Tools the provider runs on its own side, by type name, e.g. Groq's "browser_search". */
  builtinTools?: string[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type LLMUsage = { inputTokens: number; outputTokens: number; cachedTokens: number };

export type LLMResponse = {
  text: string;
  toolCalls: ToolCall[];
  usage: LLMUsage;
  finishReason?: string;
  model: string;
  slot: string;
};

export interface LLM {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/** One provider account: a base URL and a key. Any OpenAI-compatible API fits. */
export type Slot = { name: string; baseUrl: string; apiKey: string };

/** Every slot and model is rate limited or unavailable right now. */
export class PoolExhaustedError extends Error {
  constructor(
    readonly retryAt: number,
    options?: ErrorOptions,
  ) {
    super("all model slots are rate limited or unavailable", options);
    this.name = "PoolExhaustedError";
  }
}

/** The request itself is over the provider's size limit; waiting will not help. */
export class RequestTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTooLargeError";
  }
}

export const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
