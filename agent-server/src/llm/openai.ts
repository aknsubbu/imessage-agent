// One request to an OpenAI-compatible /chat/completions endpoint, with the
// failure classified so the pool can decide what to do next. Written against
// fetch directly because the pool needs the rate-limit headers and error body
// on every response, success or failure.
import type { ChatMessage, LLMRequest, LLMUsage, Slot, ToolCall } from "./types.ts";

export type ErrorKind =
  | "rate_limit" // 429: wait, or use another slot
  | "too_large" // request over the size limit: shrink it
  | "bad_tool_call" // the model produced an invalid tool call: retry
  | "auth" // key rejected: drop the slot
  | "server" // 5xx or similar: try elsewhere
  | "network"
  | "bad_request";

export class LLMHttpError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LLMHttpError";
  }
}

export type HttpCompletion = {
  text: string;
  toolCalls: ToolCall[];
  usage: LLMUsage;
  /** "length" means the output allowance ran out, possibly on hidden reasoning. */
  finishReason?: string;
  /** Remaining requests today and tokens this minute, when the provider reports them. */
  remaining: { requests?: number; tokens?: number };
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Per-model request fields. Reasoning controls differ by model family on Groq. */
export function modelParams(model: string): Record<string, unknown> {
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low", include_reasoning: false };
  if (model.startsWith("qwen/")) return { reasoning_effort: "none" };
  return {};
}

function toWire(message: ChatMessage): Record<string, unknown> {
  // Never set `name` on a message: Groq rejects it with a 400.
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/** Parses "retry-after: 12" or "Please try again in 1m5.2s" into milliseconds. */
export function parseRetryAfter(header: string | null, message: string): number | undefined {
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const match = /try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?/i.exec(message);
  if (!match || !match.slice(1).some(Boolean)) return undefined;
  const [, h, m, s, ms] = match;
  return Math.ceil(Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1000 + Number(ms ?? 0));
}

function classify(status: number, code: string, message: string): ErrorKind {
  if (status === 413 || /request too large/i.test(message)) return "too_large";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (code === "tool_use_failed" || /failed to call a function|tool call validation/i.test(message)) {
    return "bad_tool_call";
  }
  if (status >= 500 || status === 408 || status === 422 || status === 498) return "server";
  return "bad_request";
}

export async function chatCompletion(opts: {
  slot: Slot;
  model: string;
  req: LLMRequest;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<HttpCompletion> {
  const { slot, model, req } = opts;
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(toWire),
    max_completion_tokens: req.maxOutputTokens ?? 500,
    temperature: req.temperature ?? 0.7,
    ...modelParams(model),
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((tool) => ({ type: "function", function: tool }));
    body.parallel_tool_calls = false;
  }
  if (req.builtinTools?.length) {
    body.tools = [...((body.tools as unknown[]) ?? []), ...req.builtinTools.map((type) => ({ type }))];
  }

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${slot.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${slot.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // A caller abort must propagate as an abort; anything else is a transport failure.
    if (req.signal?.aborted) throw err;
    throw new LLMHttpError("network", err instanceof Error ? err.message : String(err));
  }

  const raw = await res.text();
  let json: any;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const message = String(json?.error?.message ?? raw.slice(0, 300) ?? res.statusText);
    const kind = classify(res.status, String(json?.error?.code ?? ""), message);
    const retryAfterMs = kind === "rate_limit" ? parseRetryAfter(res.headers.get("retry-after"), message) : undefined;
    throw new LLMHttpError(kind, message, res.status, retryAfterMs);
  }

  const message = json?.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter((call: any) => call?.function?.name)
        .map((call: any) => ({
          id: String(call.id ?? ""),
          name: String(call.function.name),
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
        }))
    : [];
  const num = (value: string | null) => (value === null || value === "" ? undefined : Number(value));
  return {
    // `message.reasoning` is deliberately ignored: reasoning never reaches the user.
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    finishReason: typeof json?.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : undefined,
    usage: {
      inputTokens: Number(json?.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json?.usage?.completion_tokens ?? 0),
      cachedTokens: Number(json?.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    },
    remaining: {
      requests: num(res.headers.get("x-ratelimit-remaining-requests")),
      tokens: num(res.headers.get("x-ratelimit-remaining-tokens")),
    },
  };
}
