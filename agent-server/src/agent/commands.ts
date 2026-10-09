// Replies that never touch the model: slash commands and tapback
// acknowledgements. They cost no tokens and keep working when the pool is spent.
import type { DB } from "../db.ts";
import type { SlotStatus } from "../llm/pool.ts";
import {
  allow,
  disallow,
  failureCount,
  listAllowed,
  listFacts,
  listNames,
  listNotes,
  pendingReminders,
  removeFactById,
  removeFacts,
  resetChat,
  usageForDay,
  utcDay,
} from "../store.ts";
import { formatLocal } from "../time.ts";

export type CommandDeps = {
  db: DB;
  timezone: string;
  llmMode: "groq" | "fake";
  slotStatus: () => SlotStatus[];
  now: () => number;
  startedAt: number;
};

export type CommandContext = { chatId: string; senderId: string; role: "owner" | "user" };

const HELP = [
  "/memory — what I've remembered about you",
  "/forget <number> or /forget all — remove what I've remembered",
  "/lists — your lists and notes; /lists shopping shows one",
  "/reminders — what's coming up",
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

/** Returns the reply bubbles for a slash command, or null when the text is not a command. */
export function runCommand(deps: CommandDeps, ctx: CommandContext, text: string): string[] | null {
  const name = commandName(text);
  if (!name) return null;
  const arg = text.trim().slice(name.length).trim();
  const owner = ctx.role === "owner";
  switch (name) {
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
              .map((r) => `${formatLocal(r.dueAt, deps.timezone)}${r.repeat === "none" ? "" : ` (${r.repeat})`} — ${r.text}`)
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
