// A stand-in model for development and tests: no network, no quota.
import type { ChatMessage, LLM, LLMRequest, LLMResponse } from "./types.ts";

export const lastUserText = (messages: ChatMessage[]): string => {
  const last = messages.findLast((message) => message.role === "user");
  if (!last || last.role !== "user") return "";
  return typeof last.content === "string" ? last.content : last.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
};

/** A scripted reply: plain text, or tool calls for the agent loop to carry out. */
export type FakeReply = string | { text?: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] };

export class FakeLLM implements LLM {
  readonly calls: LLMRequest[] = [];

  constructor(
    private readonly reply: (req: LLMRequest, call: number) => FakeReply = (req) =>
      `(fake model) You said: ${lastUserText(req.messages)}`,
    private readonly delayMs = 0,
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(req.signal!.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    }
    req.signal?.throwIfAborted();
    const reply = this.reply(req, this.calls.length);
    const scripted = typeof reply === "string" ? { text: reply } : reply;
    return {
      text: scripted.text ?? "",
      toolCalls: (scripted.toolCalls ?? []).map((call, i) => ({
        id: `call_${this.calls.length}_${i}`,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      model: "fake",
      slot: "fake",
    };
  }
}
