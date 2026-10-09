// Asks your real Groq keys the questions the docs leave open. Run it once
// after putting keys in .env; it prints a report and never prints a key.
//
//   npm run probe                 models, limits, and whether keys share a budget (~1k tokens in total)
//   npm run probe -- --search     also test Groq's built-in web search
//   npm run probe -- --large      also send one oversized request to see how it is rejected
import { loadConfig } from "../src/config.ts";
import { modelParams } from "../src/llm/openai.ts";

const config = loadConfig();
const flags = new Set(process.argv.slice(2));
if (config.slots.length === 0) {
  console.error("No keys found. Set GROQ_API_KEYS in agent-server/.env first.");
  process.exit(1);
}

type Probe = { status: number; ok: boolean; message: string; headers: Record<string, string>; usage?: Record<string, number> };

async function chat(slot: (typeof config.slots)[number], model: string, body: Record<string, unknown>): Promise<Probe> {
  const res = await fetch(`${slot.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${slot.apiKey}` },
    body: JSON.stringify({ model, max_completion_tokens: 16, ...modelParams(model), ...body }),
    signal: AbortSignal.timeout(60_000),
  });
  const json: any = await res.json().catch(() => ({}));
  const headers: Record<string, string> = {};
  for (const [name, value] of res.headers) if (name.startsWith("x-ratelimit") || name === "retry-after") headers[name] = value;
  return {
    status: res.status,
    ok: res.ok,
    message: res.ok ? String(json?.choices?.[0]?.message?.content ?? "").slice(0, 60) : String(json?.error?.message ?? "").slice(0, 200),
    headers,
    usage: json?.usage,
  };
}

const say = (messages: string) => ({ messages: [{ role: "user", content: messages }] });
const chatModels = [...new Set([...config.models.chat, ...config.models.tools, ...config.models.vision])];

console.log(`Probing ${config.slots.length} key(s) against ${config.slots[0]!.baseUrl}\n`);

console.log("1. Which configured models does each key see?");
for (const slot of config.slots) {
  const res = await fetch(`${slot.baseUrl}/models`, { headers: { authorization: `Bearer ${slot.apiKey}` } });
  if (!res.ok) {
    console.log(`   ${slot.name}: key rejected (${res.status})`);
    continue;
  }
  const ids = new Set(((await res.json()) as any).data.map((m: any) => m.id as string));
  const missing = chatModels.filter((model) => !ids.has(model));
  console.log(`   ${slot.name}: ${ids.size} models available${missing.length ? ` — MISSING: ${missing.join(", ")}` : ", all configured models present"}`);
}

console.log("\n2. Real limits per key and model (requests per day, tokens per minute)");
const remainingRequests: Record<string, number[]> = {};
for (const model of chatModels) {
  for (const slot of config.slots) {
    const p = await chat(slot, model, say("Reply with the single word: ok"));
    const h = p.headers;
    console.log(
      `   ${slot.name} · ${model}: ${p.ok ? "ok" : `FAILED ${p.status} ${p.message}`}` +
        ` | requests ${h["x-ratelimit-remaining-requests"] ?? "?"}/${h["x-ratelimit-limit-requests"] ?? "?"}` +
        ` | tokens ${h["x-ratelimit-remaining-tokens"] ?? "?"}/${h["x-ratelimit-limit-tokens"] ?? "?"}` +
        (p.usage ? ` | used ${p.usage.total_tokens} (cached ${(p.usage as any).prompt_tokens_details?.cached_tokens ?? 0})` : ""),
    );
    if (p.ok) (remainingRequests[model] ??= []).push(Number(h["x-ratelimit-remaining-requests"]));
  }
}

console.log("\n3. Do the keys have separate budgets?");
for (const [model, counts] of Object.entries(remainingRequests)) {
  if (counts.length < 2) continue;
  // Keys in one organisation count down together: each call lowers the next key's remaining total.
  const countingDown = counts.every((n, i) => i === 0 || n === counts[i - 1]! - 1);
  console.log(
    `   ${model}: remaining requests ${counts.join(", ")} — ${
      countingDown ? "these count down together, so the keys probably SHARE one account's limits" : "independent, so the keys look like separate accounts"
    }`,
  );
}

console.log("\n4. Are the models' limits separate from each other on one key?");
{
  const slot = config.slots[0]!;
  const [a, b] = chatModels;
  if (a && b) {
    const before = await chat(slot, a, say("Reply with the single word: ok"));
    await chat(slot, b, say("Reply with the single word: ok"));
    const after = await chat(slot, a, say("Reply with the single word: ok"));
    const drop = Number(before.headers["x-ratelimit-remaining-requests"]) - Number(after.headers["x-ratelimit-remaining-requests"]);
    console.log(
      `   ${a} lost ${drop} request(s) across one call to itself and one to ${b}: ${
        drop === 1 ? "separate buckets per model" : drop === 2 ? "models SHARE one bucket" : "unclear, read the numbers above"
      }`,
    );
  }
}

if (flags.has("--search")) {
  console.log("\n5. Built-in web search on a free key");
  const model = chatModels.find((m) => m.startsWith("openai/gpt-oss")) ?? chatModels[0]!;
  const p = await chat(config.slots[0]!, model, {
    ...say("Search the web: what is the latest stable Node.js version? Answer in one line."),
    tools: [{ type: "browser_search" }],
    max_completion_tokens: 300,
  });
  console.log(`   ${model}: ${p.ok ? `works — "${p.message}" (used ${p.usage?.total_tokens} tokens)` : `not available: ${p.status} ${p.message}`}`);
}

if (flags.has("--large")) {
  console.log("\n6. How an oversized request is rejected");
  const model = chatModels[0]!;
  const p = await chat(config.slots[0]!, model, say(`Summarise in one word: ${"lorem ipsum dolor sit amet ".repeat(1600)}`));
  console.log(`   ${model}, ~10k tokens in: ${p.status} ${p.ok ? "ACCEPTED (no per-request ceiling at this size)" : p.message}`);
}

console.log("\nDone. Paste this report back if you want the plan's open questions updated.");
