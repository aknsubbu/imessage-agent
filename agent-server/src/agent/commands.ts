// Replies that never touch the model: slash commands and tapback
// acknowledgements. They cost no tokens and keep working when the pool is spent.
import { configureBriefing, describeBriefing } from "../core/briefing.ts";
import { describeGoal, goalStreak } from "../core/goals.ts";
import type { DB } from "../db.ts";
import type { Weather } from "../integrations/weather.ts";
import type { SlotStatus } from "../llm/pool.ts";
import {
  activeGoals,
  addGoal,
  allow,
  disallow,
  endGoal,
  ensureCheckins,
  failureCount,
  getBriefing,
  getCheckins,
  getProfile,
  listAllowed,
  listFacts,
  listNames,
  listNotes,
  logGoal,
  pendingReminders,
  removeFactById,
  removeFacts,
  resetChat,
  resetProfile,
  saveCheckins,
  saveProfile,
  streak,
  usageForDay,
  utcDay,
} from "../store.ts";
import { formatLocal, parseClock } from "../time.ts";
import { cleanName, cleanNote, isPreset, PRESET_NAMES } from "./persona.ts";

export type CommandDeps = {
  db: DB;
  timezone: string;
  llmMode: "groq" | "fake";
  slotStatus: () => SlotStatus[];
  weather: Weather;
  /** Names of the outside apps reminders are copied into; empty when none are on. */
  integrations: string[];
  now: () => number;
  startedAt: number;
};

export type CommandContext = { chatId: string; senderId: string; role: "owner" | "user" };

const HELP = [
  "/memory — what I've remembered about you",
  "/forget <number> or /forget all — remove what I've remembered",
  "/lists — your lists and notes; /lists shopping shows one",
  "/reminders — what's coming up. 👍 a reminder to mark it done; reply 1h to snooze it",
  "/goals — what you're working toward; /goals log 1, /goals done 1, /goals drop 1, /goals add <goal>",
  "/checkins — your evening check-in; /checkins off, /checkins 8pm",
  "/briefing — a morning message; /briefing 7:30am, /briefing city Chennai, /briefing off",
  "/persona — how I sound; /persona coach, /persona name Juno, /persona note <text>, /persona mirror on",
  "/check <claim> — I'll look into whether it's true (or just ask \"is this true?\")",
  "/usage — how much of today's model budget is used",
  "/reset — forget this conversation and start fresh (saved facts stay)",
  "/ping — check I'm alive",
];
const OWNER_HELP = [
  "/status — health of the agent",
  "/who — who may talk to me",
  "/allow <number or email> — let someone in",
  "/deny <number or email> — remove them",
];

/** " (daily, 5 in a row)" for a repeating reminder, nothing for a one-off. */
export function repeatLabel(db: DB, reminder: { id: number; repeat: string }): string {
  if (reminder.repeat === "none") return "";
  const count = streak(db, reminder.id);
  return ` (${reminder.repeat}${count >= 2 ? `, ${count} in a row` : ""})`;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const shortModel = (model: string) => model.split("/").pop() ?? model;

function usageReport(deps: CommandDeps): string[] {
  if (deps.llmMode === "fake") return ["I'm running on the built-in fake model, so nothing is being used."];
  const rows = usageForDay(deps.db, utcDay(deps.now()));
  const blocked = deps.slotStatus().filter((s) => s.blockedForMs > 0 || s.dead);
  const lines = rows.map(
    (r) =>
      `${r.slot} · ${shortModel(r.model)}: ${r.requests} requests, ${k(r.inputTokens + r.outputTokens)} tokens` +
      (r.cachedTokens ? ` (${k(r.cachedTokens)} cached)` : "") +
      (r.rateLimited ? `, limited ${r.rateLimited}×` : ""),
  );
  const out = [lines.length ? `Today so far (UTC):\n${lines.join("\n")}` : "Nothing used yet today."];
  if (blocked.length) {
    out.push(
      `Resting right now:\n${blocked
        .map((s) => `${s.slot} · ${shortModel(s.model)}: ${s.dead ? "key rejected" : `${Math.ceil(s.blockedForMs / 1000)}s`}`)
        .join("\n")}`,
    );
  }
  return out;
}

/** "/usage" for "/usage", "/Usage now"; null for ordinary text, including paths like "/Users/me". */
export function commandName(text: string): string | null {
  return /^\/[a-z]+(?=\s|$)/i.exec(text.trim())?.[0].toLowerCase() ?? null;
}

// --- persona, goals, briefing and check-ins ------------------------------------------

function personaCommand(deps: CommandDeps, ctx: CommandContext, arg: string): string[] {
  const { db, now } = deps;
  const lower = arg.toLowerCase();
  if (lower === "reset") {
    resetProfile(db, ctx.senderId);
    return ["Back to my default voice and name."];
  }
  if (isPreset(lower)) {
    saveProfile(db, ctx.senderId, { preset: lower }, now());
    return [`Voice set to ${lower}.`];
  }
  const rest = (word: string) => arg.slice(word.length).trim();
  if (/^name\b/i.test(arg)) {
    const name = cleanName(rest("name"));
    saveProfile(db, ctx.senderId, { agentName: name || null }, now());
    return [name ? `Okay, call me ${name}.` : "Back to my default name."];
  }
  if (/^note\b/i.test(arg)) {
    const note = /^clear$/i.test(rest("note")) ? "" : cleanNote(rest("note"));
    saveProfile(db, ctx.senderId, { note }, now());
    return [note ? "Noted. I'll keep that in mind." : "Cleared."];
  }
  if (/^mirror\b/i.test(arg)) {
    const on = /^(on|yes|true)$/i.test(rest("mirror"));
    saveProfile(db, ctx.senderId, { mirror: on }, now());
    return [on ? "I'll match how you text." : "I'll stop matching how you text."];
  }
  const profile = getProfile(db, ctx.senderId);
  return [
    [
      `Voice: ${profile.preset}`,
      profile.agentName ? `Name: ${profile.agentName}` : "",
      profile.note ? `Note: ${profile.note}` : "",
      `Matching your style: ${profile.mirror ? "on" : "off"}`,
    ]
      .filter(Boolean)
      .join("\n"),
    `Voices: ${PRESET_NAMES.join(", ")}.\n/persona <voice> · /persona name <name> · /persona note <text> · /persona mirror on · /persona reset`,
  ];
}

function goalsCommand(deps: CommandDeps, ctx: CommandContext, arg: string): string[] {
  const { db, now, timezone } = deps;
  const goals = activeGoals(db, ctx.senderId);
  const show = () =>
    goals.map((goal, i) => `${i + 1}. ${describeGoal(db, goal, timezone, now())}${goal.dueAt ? ` — ${formatLocal(goal.dueAt, timezone)}` : ""}`).join("\n");
  const [verb = "", ...words] = arg.split(/\s+/).filter(Boolean);
  const rest = words.join(" ");

  if (verb.toLowerCase() === "add") {
    if (!rest) return ["Which goal? /goals add Meditate"];
    if (goals.length >= 8) return ["Eight goals is the limit. Drop one first."];
    addGoal(db, { senderId: ctx.senderId, chatId: ctx.chatId, title: cleanNote(rest).slice(0, 120), cadence: "daily", dueAt: null }, now());
    ensureCheckins(db, ctx.senderId, ctx.chatId);
    return [`Added: ${rest}. I'll check in each evening at ${getCheckins(db, ctx.senderId)?.time ?? "19:00"}.`];
  }
  if (["log", "done", "drop"].includes(verb.toLowerCase())) {
    const goal = goals[Number(rest) - 1];
    if (!goal) return [goals.length ? `Which one? Send /goals to see the numbers.` : "No goals yet."];
    if (verb.toLowerCase() !== "drop") logGoal(db, goal.id, "", now());
    if (verb.toLowerCase() === "log") {
      const days = goalStreak(db, goal, timezone, now());
      return [`✔ ${goal.title}${days >= 2 ? `: ${days} days in a row` : ": logged"}`];
    }
    endGoal(db, goal.id, verb.toLowerCase() === "done" ? "done" : "dropped", now());
    return [`${verb.toLowerCase() === "done" ? "Finished" : "Dropped"}: ${goal.title}`];
  }
  return [goals.length ? show() : "No goals yet. Tell me what you're working on, or /goals add Meditate."];
}

async function briefingCommand(deps: CommandDeps, ctx: CommandContext, arg: string): Promise<string[]> {
  const lower = arg.toLowerCase();
  const who = { senderId: ctx.senderId, chatId: ctx.chatId };
  const run = async (input: Parameters<typeof configureBriefing>[2]) => {
    const result = await configureBriefing(deps, who, input);
    return [result.ok ? `Morning briefing: ${result.text}.` : `Couldn't do that: ${result.error}.`];
  };
  if (!arg) {
    const current = describeBriefing(getBriefing(deps.db, ctx.senderId));
    return [`Morning briefing: ${current}.`, "/briefing 7:30am · /briefing city Chennai · /briefing units f · /briefing off"];
  }
  if (lower === "off") return run({ enabled: false });
  if (lower === "on") return run({});
  if (/^city\b/.test(lower)) return run({ city: arg.slice(4).trim() });
  if (/^units\b/.test(lower)) return run({ fahrenheit: /\bf/.test(lower.slice(5)) });
  if (parseClock(arg)) return run({ time: arg });
  return ["Try /briefing 7:30am, /briefing city Chennai, or /briefing off."];
}

function checkinsCommand(deps: CommandDeps, ctx: CommandContext, arg: string): string[] {
  const current = getCheckins(deps.db, ctx.senderId);
  if (!current) return ["Check-ins start once you have a goal. Tell me one, or /goals add Meditate."];
  const lower = arg.toLowerCase();
  if (lower === "off" || lower === "on") {
    saveCheckins(deps.db, ctx.senderId, { enabled: lower === "on" });
    return [lower === "on" ? `Check-ins are on, at ${current.time}.` : "Check-ins are off."];
  }
  const time = arg ? parseClock(arg) : null;
  if (time) {
    saveCheckins(deps.db, ctx.senderId, { enabled: true, time });
    return [`Check-ins are on, at ${time}.`];
  }
  return [`Check-ins are ${current.enabled ? `on, at ${current.time}` : "off"}. /checkins off · /checkins 8pm`];
}

/**
 * Returns the reply bubbles for a slash command, or null when the text is not
 * a command. A few commands look something up on the internet, so the answer
 * may arrive as a promise.
 */
export function runCommand(deps: CommandDeps, ctx: CommandContext, text: string): string[] | Promise<string[]> | null {
  const name = commandName(text);
  if (!name) return null;
  const arg = text.trim().slice(name.length).trim();
  const owner = ctx.role === "owner";
  switch (name) {
    case "/persona":
      return personaCommand(deps, ctx, arg);
    case "/goals":
      return goalsCommand(deps, ctx, arg);
    case "/briefing":
      return briefingCommand(deps, ctx, arg);
    case "/checkins":
      return checkinsCommand(deps, ctx, arg);
    case "/help":
      return [(owner ? [...HELP, ...OWNER_HELP] : HELP).join("\n")];
    case "/ping":
      return ["pong"];
    case "/usage":
      return usageReport(deps);
    case "/reset":
      resetChat(deps.db, ctx.chatId, deps.now());
      return ["Fresh start. I've let go of what we were talking about."];
    case "/memory": {
      const facts = listFacts(deps.db, ctx.senderId);
      return [facts.length ? facts.map((fact, i) => `${i + 1}. ${fact.text}`).join("\n") : "I haven't saved anything about you yet."];
    }
    case "/forget": {
      if (arg.toLowerCase() === "all" || arg.toLowerCase() === "everything") {
        const removed = removeFacts(deps.db, ctx.senderId, "*");
        return [removed.length ? `Forgotten: all ${removed.length} things I'd saved.` : "There was nothing saved."];
      }
      // The number is the position shown by /memory, not a database id.
      const fact = listFacts(deps.db, ctx.senderId)[Number(arg) - 1];
      if (!fact) return ["Send /memory to see what I've saved, then /forget and its number, or /forget all."];
      removeFactById(deps.db, ctx.senderId, fact.id);
      return [`Forgotten: ${fact.text}`];
    }
    case "/lists": {
      if (arg) {
        const items = listNotes(deps.db, ctx.senderId, arg);
        return [items.length ? `${arg.toLowerCase()}:\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}` : `Nothing on "${arg}".`];
      }
      const names = listNames(deps.db, ctx.senderId);
      return [names.length ? names.map((n) => `${n.list} (${n.count})`).join("\n") : "No lists yet. Tell me to add something to one."];
    }
    case "/reminders": {
      const reminders = pendingReminders(deps.db, ctx.senderId);
      return [
        reminders.length
          ? reminders
              .map((r) => `${formatLocal(r.dueAt, deps.timezone)}${repeatLabel(deps.db, r)} — ${r.text}`)
              .join("\n")
          : "No reminders set.",
      ];
    }
  }
  if (!owner) return ["I don't know that one. /help lists what I understand."];
  switch (name) {
    case "/status": {
      const minutes = Math.round((deps.now() - deps.startedAt) / 60_000);
      const slots = deps.slotStatus();
      const names = new Set(slots.map((s) => s.slot));
      const dead = new Set(slots.filter((s) => s.dead).map((s) => s.slot));
      return [
        [
          `Up ${minutes} min`,
          deps.llmMode === "fake" ? "Model: fake (no Groq keys set)" : `Model keys: ${names.size - dead.size} of ${names.size} working`,
          `Failures in the last 24h: ${failureCount(deps.db, deps.now() - 86_400_000)}`,
          `Integrations: ${deps.integrations.length ? deps.integrations.join(", ") : "none on"}`,
        ].join("\n"),
      ];
    }
    case "/who":
      return [
        listAllowed(deps.db)
          .map((entry) => `${entry.senderId} (${entry.role})`)
          .join("\n") || "Nobody yet.",
      ];
    case "/allow":
      if (!arg) return ["Who? Send /allow followed by their number or email."];
      allow(deps.db, arg, "user", deps.now());
      return [`${arg} can talk to me now.`];
    case "/deny":
      if (!arg) return ["Who? Send /deny followed by their number or email."];
      return [disallow(deps.db, arg) ? `${arg} is removed.` : `${arg} wasn't on the list (owners can't be removed).`];
    default:
      return ["I don't know that one. /help lists what I understand."];
  }
}

const HEART = "❤️";
const ACKS: [RegExp, string][] = [
  [/^(thanks|thank you|thank u|thx|ty|tysm|cheers|appreciate it)(\s+(so much|a lot))?[\s!.]*$/i, HEART],
  [/^(ok|okay|k|kk|got it|cool|nice|great|perfect|sounds good|will do|noted|👍|👌)[\s!.]*$/i, "👍"],
  [/^(lol|lmao|haha+|hehe+|😂|🤣)[\s!.]*$/i, "😂"],
];

/**
 * Returns a tapback when a message is a plain acknowledgement that needs no
 * words back. Not when the assistant just asked something: then "ok" is an answer.
 */
export function ackFor(text: string, lastAssistantText: string | undefined): string | null {
  if (lastAssistantText?.trimEnd().endsWith("?")) return null;
  const trimmed = text.trim();
  for (const [pattern, emoji] of ACKS) if (pattern.test(trimmed)) return emoji;
  return null;
}
