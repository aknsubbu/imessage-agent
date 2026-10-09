// The key pool: an ordered list of slots (provider account + key) and, per
// purpose, an ordered list of models. A request goes to the first slot and
// model that is not known to be blocked, and fails over on rate limits.
import type { DB } from "../db.ts";
import { addUsage, recordFailure } from "../store.ts";
import { chatCompletion, type FetchLike, type HttpCompletion, LLMHttpError } from "./openai.ts";
import {
  type LLM,
  type LLMRequest,
  type LLMResponse,
  PoolExhaustedError,
  type Purpose,
  RequestTooLargeError,
  type Slot,
} from "./types.ts";

export type PoolOptions = {
  slots: Slot[];
  models: Record<Purpose, string[]>;
  db: DB;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: (message: string) => void;
};

export type SlotStatus = {
  slot: string;
  model: string;
  blockedForMs: number;
  dead: boolean;
  remainingRequests?: number;
  remainingTokens?: number;
};

const DEFAULT_BLOCK_MS = 60_000;
const TRANSIENT_BLOCK_MS = 15_000;

export class PoolLLM implements LLM {
  private readonly blockedUntil = new Map<string, number>();
  private readonly remaining = new Map<string, HttpCompletion["remaining"]>();
  private readonly dead = new Set<string>();
  // The slot that last answered. Staying on it keeps the provider's prompt cache warm.
  private sticky = 0;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: PoolOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const { slots, models, db } = this.opts;
    let soonest = Number.POSITIVE_INFINITY;
    let lastError: unknown;

    // Same model on the next key first (same quality); the next model only
    // once every key is blocked for this one.
    for (const model of models[req.purpose]) {
      for (let offset = 0; offset < slots.length; offset++) {
        const index = (this.sticky + offset) % slots.length;
        const slot = slots[index]!;
        if (this.dead.has(slot.name)) continue;
        const key = `${slot.name}|${model}`;
        const until = this.blockedUntil.get(key) ?? 0;
        if (until > this.now()) {
          soonest = Math.min(soonest, until);
          continue;
        }

        try {
          const res = await this.callWithToolRetry(slot, model, req);
          this.sticky = index;
          this.remaining.set(key, res.remaining);
          addUsage(db, this.now(), slot.name, model, { requests: 1, ...res.usage });
          return { text: res.text, toolCalls: res.toolCalls, usage: res.usage, finishReason: res.finishReason, model, slot: slot.name };
        } catch (err) {
          if (!(err instanceof LLMHttpError)) throw err;
          lastError = err;
          switch (err.kind) {
            case "rate_limit": {
              // The provider's own retry-after is the authority; daily reset times are not documented.
              const until = this.now() + (err.retryAfterMs ?? DEFAULT_BLOCK_MS);
              this.blockedUntil.set(key, until);
              soonest = Math.min(soonest, until);
              addUsage(db, this.now(), slot.name, model, { rateLimited: 1 });
              this.log(`${key} rate limited for ${Math.round((until - this.now()) / 1000)}s`);
              continue;
            }
            case "auth":
              this.dead.add(slot.name);
              recordFailure(db, "llm.auth", slot.name, err, this.now());
              this.log(`${slot.name} rejected its key (${err.status}); dropped from the pool`);
              continue;
            case "server":
            case "network": {
              const until = this.now() + TRANSIENT_BLOCK_MS;
              this.blockedUntil.set(key, until);
              soonest = Math.min(soonest, until);
              this.log(`${key} unavailable (${err.kind}): ${err.message}`);
              continue;
            }
            case "too_large":
              throw new RequestTooLargeError(err.message);
            default:
              throw err;
          }
        }
      }
    }
    throw new PoolExhaustedError(Number.isFinite(soonest) ? soonest : this.now() + DEFAULT_BLOCK_MS, { cause: lastError });
  }

  // An invalid tool call comes back as an error, not a response. Retry it cooler,
  // then once more with no tools so the turn still gets an answer.
  private async callWithToolRetry(slot: Slot, model: string, req: LLMRequest): Promise<HttpCompletion> {
    const attempts: LLMRequest[] = [req];
    if (req.tools?.length) {
      attempts.push({ ...req, temperature: 0.2 }, { ...req, temperature: 0.2, tools: undefined });
    }
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        return await chatCompletion({ slot, model, req: attempt, fetchImpl: this.opts.fetchImpl });
      } catch (err) {
        if (!(err instanceof LLMHttpError) || err.kind !== "bad_tool_call") throw err;
        lastError = err;
        addUsage(this.opts.db, this.now(), slot.name, model, { requests: 1 });
      }
    }
    throw lastError;
  }

  status(): SlotStatus[] {
    const out: SlotStatus[] = [];
    const seen = new Set<string>();
    for (const models of Object.values(this.opts.models)) {
      for (const model of models) {
        for (const slot of this.opts.slots) {
          const key = `${slot.name}|${model}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const remaining = this.remaining.get(key);
          out.push({
            slot: slot.name,
            model,
            blockedForMs: Math.max(0, (this.blockedUntil.get(key) ?? 0) - this.now()),
            dead: this.dead.has(slot.name),
            remainingRequests: remaining?.requests,
            remainingTokens: remaining?.tokens,
          });
        }
      }
    }
    return out;
  }
}
