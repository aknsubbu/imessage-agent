// Scores text for prompt injection with Groq's Prompt Guard classifier, which
// has its own allowance separate from the chat models. It reads at most 512
// tokens at a time, so longer text is scored in pieces.
import type { DB } from "../db.ts";
import { addUsage } from "../store.ts";
import type { FetchLike } from "./openai.ts";
import type { Slot } from "./types.ts";

/** Returns the highest injection score found, from 0 (benign) to 1. */
export type Guard = (text: string, signal?: AbortSignal) => Promise<number>;

const CHUNK_CHARS = 1400;
const MAX_CHUNKS = 6;

export function createGuard(opts: {
  slots: Slot[];
  db: DB;
  model?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
}): Guard {
  const model = opts.model ?? "meta-llama/llama-prompt-guard-2-86m";
  const now = opts.now ?? Date.now;

  async function score(chunk: string, signal?: AbortSignal): Promise<number> {
    for (const slot of opts.slots) {
      const timeout = AbortSignal.timeout(15_000);
      const res = await (opts.fetchImpl ?? fetch)(`${slot.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${slot.apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: chunk }] }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) {
        addUsage(opts.db, now(), slot.name, model, { requests: 1 });
        const json = (await res.json()) as any;
        const value = Number(json?.choices?.[0]?.message?.content);
        return Number.isFinite(value) ? value : 0;
      }
      if (res.status !== 429 && res.status < 500) break;
    }
    // The classifier being unavailable must not block reading. The turn still
    // withholds every tool that changes something once web content is in it.
    opts.log?.("injection classifier unavailable; continuing without a score");
    return 0;
  }

  return async (text, signal) => {
    let worst = 0;
    for (let i = 0; i < MAX_CHUNKS && i * CHUNK_CHARS < text.length; i++) {
      worst = Math.max(worst, await score(text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS), signal));
      if (worst > 0.9) break;
    }
    return worst;
  };
}
