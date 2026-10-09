// Wires the pieces together. Split from index.ts so tests can build the same
// runtime against an in-memory database and a fake model.
import type { CommandDeps } from "./agent/commands.ts";
import { createRunTurn, createSummariser, type TurnDeps } from "./agent/turn.ts";
import type { Config } from "./config.ts";
import { ActionHub, type HubOptions } from "./core/hub.ts";
import { createIntake } from "./core/intake.ts";
import { Lanes } from "./core/lanes.ts";
import { createReminders } from "./core/reminders.ts";
import { createScheduler } from "./core/scheduler.ts";
import { type DB, openDb } from "./db.ts";
import { createApp } from "./http.ts";
import { createTranscriber, type Transcriber } from "./llm/audio.ts";
import { FakeLLM } from "./llm/fake.ts";
import { createGuard } from "./llm/guard.ts";
import type { FetchLike } from "./llm/openai.ts";
import { PoolLLM } from "./llm/pool.ts";
import type { LLM } from "./llm/types.ts";
import { allow } from "./store.ts";
import { createWeb, type Web } from "./web/web.ts";

export type RuntimeOverrides = {
  db?: DB;
  llm?: LLM;
  fetchImpl?: FetchLike;
  now?: () => number;
  hub?: Partial<HubOptions>;
  transcribe?: Transcriber;
  convert?: TurnDeps["convert"];
  web?: Web;
  log?: (message: string) => void;
};

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}) {
  const now = overrides.now ?? Date.now;
  const log = overrides.log ?? ((message: string) => console.log(`[agent] ${message}`));
  const db = overrides.db ?? openDb(config.dbPath);
  const startedAt = now();

  const pool =
    config.llmMode === "groq"
      ? new PoolLLM({ slots: config.slots, models: config.models, db, fetchImpl: overrides.fetchImpl, now, log })
      : undefined;
  const llm: LLM = overrides.llm ?? pool ?? new FakeLLM();

  for (const id of config.ownerIds) allow(db, id, "owner", now());

  const hub = new ActionHub(db, { now, ...overrides.hub });
  const transcribe: Transcriber =
    overrides.transcribe ??
    (config.llmMode === "groq"
      ? createTranscriber({ slots: config.slots, db, fetchImpl: overrides.fetchImpl, now })
      : async () => "(voice memos cannot be transcribed on the fake model)");
  const web =
    overrides.web ??
    createWeb({
      llm,
      // The injection classifier is a Groq model; without keys, pages are still
      // labelled as untrusted and still cannot trigger a change.
      guard: config.llmMode === "groq" ? createGuard({ slots: config.slots, db, fetchImpl: overrides.fetchImpl, now, log }) : undefined,
      log,
    });
  const runTurn = createRunTurn({
    db,
    llm,
    transcribe,
    web,
    agentName: config.agentName,
    timezone: config.timezone,
    mediaDir: config.mediaDir,
    now,
    log,
    convert: overrides.convert,
  });
  const summarise = createSummariser({ db, llm, log });
  const lanes = new Lanes({
    db,
    hub,
    runTurn,
    debounceMs: config.debounceMs,
    mediaDir: config.mediaDir,
    afterTurn: (chatId) => void summarise(chatId),
    now,
    log,
  });
  const reminders = createReminders({
    db,
    lanes,
    timezone: config.timezone,
    nudgeAfterMinutes: config.nudgeAfterMinutes,
    quietHours: config.quietHours,
    now,
    log,
  });
  const scheduler = createScheduler({ reminders });
  const commands: CommandDeps = {
    db,
    timezone: config.timezone,
    llmMode: config.llmMode,
    slotStatus: () => pool?.status() ?? [],
    now,
    startedAt,
  };
  const handleEvent = createIntake({
    db,
    lanes,
    reminders,
    commands,
    claimable: config.ownerIds.length === 0,
    mediaDir: config.mediaDir,
    now,
    log,
  });
  const app = createApp({
    sharedSecret: config.sharedSecret,
    hub,
    handleEvent,
    health: () => ({ uptimeSeconds: Math.round((now() - startedAt) / 1000), model: config.llmMode }),
    now,
  });

  return {
    app,
    db,
    hub,
    lanes,
    llm,
    scheduler,
    summarise,
    handleEvent,
    stop() {
      scheduler.stop();
      lanes.stop();
      hub.close();
    },
  };
}
