// Speech-to-text through the same pool of slots. Whisper has its own, much
// larger allowance on Groq, so this does not compete with chat for budget.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { DB } from "../db.ts";
import { addUsage } from "../store.ts";
import type { FetchLike } from "./openai.ts";
import type { Slot } from "./types.ts";

export type Transcriber = (path: string, signal?: AbortSignal) => Promise<string>;

export function createTranscriber(opts: {
  slots: Slot[];
  db: DB;
  model?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Transcriber {
  const model = opts.model ?? "whisper-large-v3-turbo";
  const now = opts.now ?? Date.now;
  return async (path, signal) => {
    const bytes = await readFile(path);
    let lastError = "no model slots configured";
    for (const slot of opts.slots) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)]), basename(path));
      form.append("model", model);
      form.append("response_format", "json");
      form.append("temperature", "0");
      const timeout = AbortSignal.timeout(60_000);
      const res = await (opts.fetchImpl ?? fetch)(`${slot.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${slot.apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) {
        addUsage(opts.db, now(), slot.name, model, { requests: 1 });
        const json = (await res.json()) as { text?: string };
        return String(json.text ?? "").trim();
      }
      lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
      // Rate limited or unavailable on this key: the next one has its own allowance.
      if (res.status !== 429 && res.status < 500) break;
      addUsage(opts.db, now(), slot.name, model, { rateLimited: 1 });
    }
    throw new Error(`transcription failed: ${lastError}`);
  };
}
