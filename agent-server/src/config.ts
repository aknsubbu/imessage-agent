import { resolve } from "node:path";
import type { IntegrationConfig } from "./integrations/sync.ts";
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
  /** Minutes before one follow-up to a reminder nobody acknowledged. 0 turns nudges off. */
  nudgeAfterMinutes: number;
  /** Local hours [from, to) in which the agent does not nudge. */
  quietHours: [number, number];
  ownerIds: string[];
  /** Outside apps that reminders and list items are copied into. Empty unless switched on with INTEGRATIONS. */
  integrations: IntegrationConfig;
  /** Integrations that were named but could not start, for a startup warning. */
  integrationProblems: string[];
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
  // Groq's built-in web search runs only on these models. The small one goes
  // first: a search can cost several thousand tokens, and this keeps that off
  // the large model's budget.
  search: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
};

/** An integration runs only when it is named in INTEGRATIONS and has its credentials. */
function loadIntegrations(env: NodeJS.ProcessEnv): { integrations: IntegrationConfig; problems: string[] } {
  const wanted = new Set(list(env.INTEGRATIONS).map((name) => name.toLowerCase()));
  const integrations: IntegrationConfig = {};
  const problems: string[] = [];
  if (wanted.has("todoist")) {
    if (env.TODOIST_TOKEN) integrations.todoist = { token: env.TODOIST_TOKEN };
    else problems.push("todoist is listed in INTEGRATIONS but TODOIST_TOKEN is not set");
  }
  if (wanted.has("notion")) {
    if (env.NOTION_TOKEN && env.NOTION_DATABASE_ID) {
      integrations.notion = {
        token: env.NOTION_TOKEN,
        databaseId: env.NOTION_DATABASE_ID,
        titleProperty: env.NOTION_TITLE_PROPERTY ?? "Name",
        dateProperty: env.NOTION_DATE_PROPERTY || undefined,
        version: env.NOTION_VERSION ?? "2022-06-28",
      };
    } else problems.push("notion is listed in INTEGRATIONS but NOTION_TOKEN or NOTION_DATABASE_ID is not set");
  }
  for (const name of wanted) if (name !== "todoist" && name !== "notion") problems.push(`unknown integration "${name}" in INTEGRATIONS`);
  return { integrations, problems };
}

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
  const { integrations, problems } = loadIntegrations(env);
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8787),
    sharedSecret,
    dbPath: resolve(dataDir, "agent.db"),
    mediaDir: resolve(dataDir, "media"),
    agentName: env.AGENT_NAME ?? "Sage",
    timezone: env.TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    debounceMs: Number(env.DEBOUNCE_MS ?? 2500),
    nudgeAfterMinutes: Number(env.REMINDER_NUDGE_MINUTES ?? 30),
    quietHours: [Number(env.QUIET_FROM ?? 22), Number(env.QUIET_TO ?? 8)],
    ownerIds: list(env.OWNER_IDS),
    integrations,
    integrationProblems: problems,
    llmMode: env.LLM_MODE === "fake" || slots.length === 0 ? "fake" : "groq",
    slots,
    models: {
      chat: models("MODELS_CHAT", DEFAULT_MODELS.chat),
      tools: models("MODELS_TOOLS", DEFAULT_MODELS.tools),
      vision: models("MODELS_VISION", DEFAULT_MODELS.vision),
      summary: models("MODELS_SUMMARY", DEFAULT_MODELS.summary),
      search: models("MODELS_SEARCH", DEFAULT_MODELS.search),
    },
  };
}
