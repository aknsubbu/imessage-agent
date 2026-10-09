import { resolve } from "node:path";
import type { Purpose, Slot } from "./llm/types.ts";

export type Config = {
  host: string;
  port: number;
  sharedSecret: string;
  dbPath: string;
  mediaDir: string;
  agentName: string;
  timezone: string;
  debounceMs: number;
  ownerIds: string[];
  llmMode: "groq" | "fake";
  slots: Slot[];
  models: Record<Purpose, string[]>;
};

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const DEFAULT_MODELS: Record<Purpose, string[]> = {
  // Plain chat starts on the small model so tool turns keep the large one's budget.
  chat: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
  tools: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
  vision: ["qwen/qwen3.8-27b"],
  summary: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sharedSecret = env.AGENT_SHARED_SECRET ?? "";
  if (!sharedSecret) {
    throw new Error("AGENT_SHARED_SECRET is not set. Copy .env.example to .env and fill it in.");
  }
  const dataDir = resolve(env.DATA_DIR ?? "../data");
  const baseUrl = env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
  // Slots are named by position so a key never appears in logs or the database.
  const slots = list(env.GROQ_API_KEYS).map((apiKey, i) => ({ name: `groq-${i + 1}`, baseUrl, apiKey }));
  const models = (name: string, fallback: string[]) => {
    const fromEnv = list(env[name]);
    return fromEnv.length ? fromEnv : fallback;
  };
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8787),
    sharedSecret,
    dbPath: resolve(dataDir, "agent.db"),
    mediaDir: resolve(dataDir, "media"),
    agentName: env.AGENT_NAME ?? "Sage",
    timezone: env.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    debounceMs: Number(env.DEBOUNCE_MS ?? 2500),
    ownerIds: list(env.OWNER_IDS),
    llmMode: env.LLM_MODE === "fake" || slots.length === 0 ? "fake" : "groq",
    slots,
    models: {
      chat: models("MODELS_CHAT", DEFAULT_MODELS.chat),
      tools: models("MODELS_TOOLS", DEFAULT_MODELS.tools),
      vision: models("MODELS_VISION", DEFAULT_MODELS.vision),
      summary: models("MODELS_SUMMARY", DEFAULT_MODELS.summary),
    },
  };
}
