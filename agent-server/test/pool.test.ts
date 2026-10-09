import { describe, expect, it } from "vitest";
import { createRunTurn } from "../src/agent/turn.ts";
import { openDb } from "../src/db.ts";
import type { FetchLike } from "../src/llm/openai.ts";
import { PoolLLM } from "../src/llm/pool.ts";
import { type LLMRequest, PoolExhaustedError, RequestTooLargeError } from "../src/llm/types.ts";
import { addUserMessage, recordEvent, usageForDay, utcDay } from "../src/store.ts";
import { textEvent } from "./helpers.ts";

type Call = { key: string; model: string; body: any };
type Reply = { status?: number; headers?: Record<string, string>; json: unknown };

const ok = (text: string, usage = { prompt_tokens: 100, completion_tokens: 20 }): Reply => ({
  json: { choices: [{ message: { content: text } }], usage },
});
const limited = (retryAfter = "30"): Reply => ({
  status: 429,
  headers: { "retry-after": retryAfter },
  json: { error: { message: "Rate limit reached", code: "rate_limit_exceeded" } },
});

function setup(respond: (call: Call, n: number) => Reply, keys = ["k1", "k2", "k3"]) {
  const calls: Call[] = [];
  let clock = 1_700_000_000_000;
  const fetchImpl: FetchLike = async (_url, init) => {
    const call: Call = {
      key: String((init.headers as Record<string, string>).authorization).replace("Bearer ", ""),
      body: JSON.parse(String(init.body)),
      model: "",
    };
    call.model = call.body.model;
    calls.push(call);
    const reply = respond(call, calls.length);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: reply.headers });
  };
  const db = openDb(":memory:");
  const pool = new PoolLLM({
    slots: keys.map((apiKey, i) => ({ name: `slot-${i + 1}`, baseUrl: "http://llm.test/v1", apiKey })),
    models: { chat: ["small", "large"], tools: ["large"], vision: ["vision"], summary: ["small"] },
    db,
    fetchImpl,
    now: () => clock,
  });
  return { pool, calls, db, advance: (ms: number) => (clock += ms), now: () => clock };
}

const req: LLMRequest = { purpose: "chat", messages: [{ role: "user", content: "hi" }] };
const route = (calls: Call[]) => calls.map((c) => `${c.key}/${c.model}`);

describe("key pool", () => {
  it("fails over to the next key on the same model, then stays on the key that worked", async () => {
    const t = setup((call) => (call.key === "k1" ? limited() : ok("hello")));
    const first = await t.pool.complete(req);
    expect(first).toMatchObject({ text: "hello", slot: "slot-2", model: "small" });
    await t.pool.complete(req);
    expect(route(t.calls)).toEqual(["k1/small", "k2/small", "k2/small"]);
  });

  it("drops to the next model only when every key is limited for the first", async () => {
    const t = setup((call) => (call.model === "small" ? limited() : ok("from large")));
    const res = await t.pool.complete(req);
    expect(res).toMatchObject({ text: "from large", model: "large", slot: "slot-1" });
    expect(route(t.calls)).toEqual(["k1/small", "k2/small", "k3/small", "k1/large"]);
  });

  it("reports when it can next answer once everything is limited, and recovers after that", async () => {
    let healthy = false;
    const t = setup(() => (healthy ? ok("back") : limited("45")));
    const err = await t.pool.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(PoolExhaustedError);
    expect(err.retryAt - t.now()).toBe(45_000);
    // While blocked, nothing is sent to the provider at all.
    const before = t.calls.length;
    await t.pool.complete(req).catch(() => {});
    expect(t.calls.length).toBe(before);
    healthy = true;
    t.advance(46_000);
    expect((await t.pool.complete(req)).text).toBe("back");
  });

  it("drops a key the provider rejects and carries on with the rest", async () => {
    const t = setup((call) => (call.key === "k1" ? { status: 401, json: { error: { message: "Invalid API Key" } } } : ok("fine")));
    await t.pool.complete(req);
    await t.pool.complete(req);
    expect(route(t.calls)).toEqual(["k1/small", "k2/small", "k2/small"]);
    expect(t.pool.status().find((s) => s.slot === "slot-1")?.dead).toBe(true);
  });

  it("does not retry elsewhere when the request itself is too large", async () => {
    const t = setup(() => ({ status: 413, json: { error: { message: "Request too large for model: Limit 8000, Requested 9000" } } }));
    await expect(t.pool.complete(req)).rejects.toBeInstanceOf(RequestTooLargeError);
    expect(t.calls).toHaveLength(1);
  });

  it("retries an invalid tool call cooler, then without tools", async () => {
    const toolReq: LLMRequest = { ...req, tools: [{ name: "now", description: "time", parameters: { type: "object" } }] };
    const t = setup((call) =>
      call.body.tools
        ? { status: 400, json: { error: { message: "Failed to call a function", code: "tool_use_failed", failed_generation: "x" } } }
        : ok("answered without tools"),
    );
    expect((await t.pool.complete(toolReq)).text).toBe("answered without tools");
    expect(t.calls.map((c) => [Boolean(c.body.tools), c.body.temperature])).toEqual([
      [true, 0.7],
      [true, 0.2],
      [false, 0.2],
    ]);
  });

  it("keeps a per-key, per-model ledger including cached tokens and rate limits", async () => {
    const t = setup((call) =>
      call.key === "k1"
        ? limited()
        : ok("hi", { prompt_tokens: 900, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 } } as any),
    );
    await t.pool.complete(req);
    expect(usageForDay(t.db, utcDay(t.now()))).toEqual([
      { slot: "slot-1", model: "small", requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, rateLimited: 1 },
      { slot: "slot-2", model: "small", requests: 1, inputTokens: 900, outputTokens: 50, cachedTokens: 600, rateLimited: 0 },
    ]);
  });

  it("sends Groq's per-model reasoning fields and never a message name", async () => {
    const t = setup(() => ok("x"));
    const pool = new PoolLLM({
      slots: [{ name: "s", baseUrl: "http://llm.test/v1", apiKey: "k1" }],
      models: { chat: ["openai/gpt-oss-20b"], tools: [], vision: ["qwen/qwen3.8-27b"], summary: [] },
      db: t.db,
      fetchImpl: async (url, init) => {
        t.calls.push({ key: "k1", model: "", body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(ok("x").json));
      },
    });
    await pool.complete(req);
    await pool.complete({ ...req, purpose: "vision" });
    expect(t.calls[0]!.body).toMatchObject({ reasoning_effort: "low", include_reasoning: false, max_completion_tokens: 500 });
    expect(t.calls[1]!.body).toMatchObject({ reasoning_effort: "none" });
    expect(JSON.stringify(t.calls)).not.toContain('"name"');
  });
});

describe("runTurn", () => {
  it("retries with less history when the provider says the request is too large", async () => {
    const db = openDb(":memory:");
    const ev = textEvent("hello");
    recordEvent(db, ev, 1);
    for (let i = 0; i < 12; i++) {
      addUserMessage(db, { chatId: ev.chat.id, senderId: "u", text: `message ${i} ${"z".repeat(600)}`, platformId: `p${i}`, state: "pending" }, 10 + i);
    }
    const sizes: number[] = [];
    const runTurn = createRunTurn({
      db,
      agentName: "Sage",
      timezone: "UTC",
      now: () => 100,
      transcribe: async () => "",
      mediaDir: "/tmp/unused",
      log: () => {},
      llm: {
        complete: async (r) => {
          sizes.push(JSON.stringify(r.messages).length);
          if (sizes.length === 1) throw new RequestTooLargeError("too large");
          return { text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, model: "m", slot: "s" };
        },
      },
    });
    const result = await runTurn({ chatId: ev.chat.id, signal: new AbortController().signal, onCommit: () => {} });
    expect(result.plan.bubbles).toEqual(["ok"]);
    expect(result.llmCalls).toBe(2);
    expect(sizes[1]!).toBeLessThan(sizes[0]! * 0.7);
  });
});
