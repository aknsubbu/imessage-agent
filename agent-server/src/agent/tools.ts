// The tools the model can call. All of them are local: they read and write
// this server's own database and need no outside account.
import { configureBriefing } from "../core/briefing.ts";
import { describeGoal, goalStreak } from "../core/goals.ts";
import type { DB } from "../db.ts";
import type { Sync } from "../integrations/sync.ts";
import type { Weather } from "../integrations/weather.ts";
import type { ToolCall, ToolDef } from "../llm/types.ts";
import {
  activeGoals,
  addFact,
  addGoal,
  addNotes,
  addReminder,
  cancelReminders,
  endGoal,
  ensureCheckins,
  getCheckins,
  listNames,
  listNotes,
  logGoal,
  matchGoals,
  pendingReminders,
  removeFacts,
  removeNoteRows,
  saveProfile,
  searchMessages,
} from "../store.ts";
import { formatLocal, parseLocal, type Repeat } from "../time.ts";
import type { Web } from "../web/web.ts";
import { cleanName, cleanNote, isPreset, PRESET_NAMES } from "./persona.ts";

export type ToolContext = {
  db: DB;
  chatId: string;
  senderId: string;
  timezone: string;
  now: () => number;
  web: Web;
  weather: Weather;
  /** Copies reminders and list items into Todoist or Notion; does nothing unless those are switched on. */
  sync: Sync;
  /** The name used when this person has not given the agent one. */
  defaultName: string;
  /** Links found in the person's own messages. `read_link` opens nothing else. */
  userLinks: string[];
  signal?: AbortSignal;
};

type Tool = ToolDef & {
  /** True when the tool changes something, so its turn must not be thrown away and run again. */
  writes: boolean;
  /** True when the result is text written by someone else (a web page, a search result). */
  untrusted?: boolean;
  /** True when the tool sends something out to the internet, which could carry private data with it. */
  egress?: boolean;
  run: (args: Record<string, any>, ctx: ToolContext) => string | Promise<string>;
};

const str = (description: string) => ({ type: "string", description });
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const REPEATS: Repeat[] = ["none", "daily", "weekdays", "weekly"];

// Order and wording are part of the cached prompt prefix: change them deliberately.
const TOOLS: Tool[] = [
  {
    name: "remember",
    description: "Save lasting facts about the person: their name, people in their life, preferences, plans. Pass every new fact in one call.",
    parameters: schema(
      { facts: { type: "array", items: { type: "string" }, description: "Short sentences, e.g. 'Sister is called Meera'." } },
      ["facts"],
    ),
    writes: true,
    run: ({ facts, fact }, ctx) => {
      // gpt-oss makes one tool call per step, so several facts have to fit in one call.
      const list = (Array.isArray(facts) ? facts : [facts ?? fact]).map((item) => String(item ?? "").trim()).filter(Boolean);
      if (list.length === 0) return "error: no facts given";
      for (const text of list.slice(0, 10)) addFact(ctx.db, ctx.senderId, text.slice(0, 300), ctx.now());
      return `saved ${list.length}`;
    },
  },
  {
    name: "forget",
    description: "Delete saved facts that mention some words.",
    parameters: schema({ about: str("Words the facts to delete contain.") }, ["about"]),
    writes: true,
    run: ({ about }, ctx) => {
      const removed = removeFacts(ctx.db, ctx.senderId, String(about ?? "").trim() || "\u0000");
      return removed.length ? `deleted: ${removed.map((f) => f.text).join("; ")}` : "nothing matched";
    },
  },
  {
    name: "add_to_list",
    description: "Add items to one of the person's lists or notes, e.g. 'shopping', 'packing', 'notes'.",
    parameters: schema(
      { list: str("List name."), items: { type: "array", items: { type: "string" }, description: "Items to add." } },
      ["list", "items"],
    ),
    writes: true,
    run: ({ list, items }, ctx) => {
      const clean = (Array.isArray(items) ? items : [items]).map((item) => String(item ?? "").trim()).filter(Boolean);
      if (clean.length === 0) return "error: no items";
      const name = String(list ?? "notes").trim().toLowerCase() || "notes";
      const added = clean.slice(0, 30);
      const ids = addNotes(ctx.db, ctx.senderId, name, added, ctx.now());
      ids.forEach((id, i) => ctx.sync.created({ kind: "list_item", id, text: added[i]!, list: name }));
      return `added ${clean.length} to ${name}`;
    },
  },
  {
    name: "show_list",
    description: "Read one list, or leave `list` out to see which lists exist.",
    parameters: schema({ list: str("List name. Omit to see all list names.") }, []),
    writes: false,
    run: ({ list }, ctx) => {
      if (!list) {
        const names = listNames(ctx.db, ctx.senderId);
        return names.length ? names.map((n) => `${n.list} (${n.count})`).join(", ") : "no lists yet";
      }
      const items = listNotes(ctx.db, ctx.senderId, String(list));
      return items.length ? items.map((item, i) => `${i + 1}. ${item}`).join("\n") : "that list is empty";
    },
  },
  {
    name: "remove_from_list",
    description: "Remove items containing some words from a list. Use item '*' to clear the whole list.",
    parameters: schema({ list: str("List name."), item: str("Words the item contains, or '*'.") }, ["list", "item"]),
    writes: true,
    run: ({ list, item }, ctx) => {
      const removed = removeNoteRows(ctx.db, ctx.senderId, String(list ?? "notes"), String(item ?? "").trim() || "\u0000");
      for (const row of removed) ctx.sync.closed("list_item", row.id);
      return removed.length ? `removed: ${removed.map((row) => row.text).join("; ")}` : "nothing matched";
    },
  },
  {
    name: "set_reminder",
    description: "Schedule a message to the person at a set time. Work the time out from the current date and time.",
    parameters: schema(
      {
        text: str("What to remind them of, phrased as the reminder itself."),
        at: str("Local date and time as YYYY-MM-DDTHH:MM (24-hour)."),
        repeat: { type: "string", enum: REPEATS, description: "How it repeats. Default none." },
      },
      ["text", "at"],
    ),
    writes: true,
    run: ({ text, at, repeat }, ctx) => {
      const dueAt = parseLocal(String(at ?? ""), ctx.timezone);
      if (dueAt === null) return "error: `at` must look like 2026-10-09T17:00";
      if (dueAt <= ctx.now()) return `error: ${formatLocal(dueAt, ctx.timezone)} is in the past; ask what time they meant`;
      const body = String(text ?? "").trim();
      if (!body) return "error: text is empty";
      const how: Repeat = REPEATS.includes(repeat) ? repeat : "none";
      const id = addReminder(ctx.db, { chatId: ctx.chatId, senderId: ctx.senderId, text: body.slice(0, 300), dueAt, repeat: how }, ctx.now());
      ctx.sync.created({ kind: "reminder", id, text: body.slice(0, 300), dueAt });
      return `reminder ${id} set for ${formatLocal(dueAt, ctx.timezone)}${how === "none" ? "" : `, repeating ${how}`}`;
    },
  },
  {
    name: "list_reminders",
    description: "List the person's upcoming reminders.",
    parameters: schema({}, []),
    writes: false,
    run: (_args, ctx) => {
      const reminders = pendingReminders(ctx.db, ctx.senderId);
      if (reminders.length === 0) return "no reminders set";
      return reminders
        .map((r) => `${r.id}. ${formatLocal(r.dueAt, ctx.timezone)}${r.repeat === "none" ? "" : ` (${r.repeat})`} — ${r.text}`)
        .join("\n");
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel reminders by their number or by words in their text.",
    parameters: schema({ id: { type: "integer", description: "Reminder number." }, about: str("Words the reminder contains.") }, []),
    writes: true,
    run: ({ id, about }, ctx) => {
      const cancelled = cancelReminders(ctx.db, ctx.senderId, {
        id: Number.isInteger(id) ? id : undefined,
        about: about ? String(about) : undefined,
      });
      for (const r of cancelled) ctx.sync.closed("reminder", r.id);
      return cancelled.length ? `cancelled: ${cancelled.map((r) => r.text).join("; ")}` : "no reminder matched";
    },
  },
  {
    name: "set_persona",
    description: "Change how you sound for this person, or what they call you. Pass only what they asked to change.",
    parameters: schema(
      {
        preset: { type: "string", enum: [...PRESET_NAMES] },
        name: str("What they want to call you."),
        note: str("Their words about your style; empty clears it."),
        mirror: { type: "boolean", description: "Match how they text." },
      },
      [],
    ),
    writes: true,
    run: ({ preset, name, note, mirror }, ctx) => {
      const patch: Parameters<typeof saveProfile>[2] = {};
      if (preset !== undefined) {
        if (!isPreset(String(preset))) return `error: the voices are ${PRESET_NAMES.join(", ")}`;
        patch.preset = String(preset);
      }
      if (name !== undefined) patch.agentName = cleanName(String(name)) || null;
      if (note !== undefined) patch.note = cleanNote(String(note));
      if (typeof mirror === "boolean") patch.mirror = mirror;
      if (Object.keys(patch).length === 0) return "error: nothing to change was given";
      const now = saveProfile(ctx.db, ctx.senderId, patch, ctx.now());
      return `persona now: voice ${now.preset}, name ${now.agentName ?? ctx.defaultName}${now.note ? `, note "${now.note}"` : ""}${now.mirror ? ", matching their texting style" : ""}`;
    },
  },
  {
    name: "goal",
    description: "Track the person's goals and habits: add (daily, weekly or once; `due` for an event), log (they did it today), done, drop, list.",
    parameters: schema(
      {
        action: { type: "string", enum: ["add", "log", "done", "drop", "list"] },
        title: str("For add: the goal, e.g. 'Meditate'."),
        about: str("Words in the goal's title."),
        id: { type: "integer", description: "Goal number." },
        cadence: { type: "string", enum: ["daily", "weekly", "once"] },
        due: str("Event time, local YYYY-MM-DDTHH:MM."),
        note: str("How it went."),
      },
      ["action"],
    ),
    writes: true,
    run: ({ action, title, about, id, cadence, due, note }, ctx) => {
      const goals = activeGoals(ctx.db, ctx.senderId);
      if (action === "list") {
        return goals.length ? goals.map((g, i) => `${i + 1}. ${describeGoal(ctx.db, g, ctx.timezone, ctx.now())}`).join("\n") : "no goals yet";
      }
      if (action === "add") {
        const text = String(title ?? "").trim().slice(0, 120);
        if (!text) return "error: a title is needed";
        if (goals.some((g) => g.title.toLowerCase() === text.toLowerCase())) return `already tracking "${text}"`;
        if (goals.length >= 8) return "error: eight goals is the limit; ask which one to drop first";
        let dueAt: number | null = null;
        if (due) {
          dueAt = parseLocal(String(due), ctx.timezone);
          if (dueAt === null) return "error: `due` must look like 2026-10-09T17:00";
          if (dueAt <= ctx.now()) return `error: ${formatLocal(dueAt, ctx.timezone)} is in the past; ask when they meant`;
        }
        const how: "daily" | "weekly" | "once" = cadence === "weekly" || cadence === "once" ? cadence : dueAt ? "once" : "daily";
        const goalId = addGoal(ctx.db, { senderId: ctx.senderId, chatId: ctx.chatId, title: text, cadence: how, dueAt }, ctx.now());
        if (how !== "once") ensureCheckins(ctx.db, ctx.senderId, ctx.chatId);
        const checkins = getCheckins(ctx.db, ctx.senderId);
        const when = how !== "once" && checkins?.enabled ? `; check-ins at ${checkins.time}` : "";
        const asks = dueAt ? `; will ask how it went after ${formatLocal(dueAt, ctx.timezone)}` : "";
        return `goal ${goalId} added: ${text} (${how})${when}${asks}`;
      }
      if (action !== "log" && action !== "done" && action !== "drop") return "error: action must be add, log, done, drop or list";
      const found = matchGoals(ctx.db, ctx.senderId, { id: Number.isInteger(id) ? id : undefined, about: about ? String(about) : undefined });
      const target = found.length ? found : goals.length === 1 && !about && !Number.isInteger(id) ? goals : [];
      if (target.length === 0) return goals.length ? `error: no goal matched; the goals are ${goals.map((g) => g.title).join(", ")}` : "error: there are no goals yet";
      if (target.length > 1) return `error: several goals match (${target.map((g) => g.title).join(", ")}); ask which one`;
      const goal = target[0]!;
      if (action === "log" || action === "done") logGoal(ctx.db, goal.id, String(note ?? "").trim().slice(0, 200), ctx.now());
      if (action === "log") {
        const streak = goalStreak(ctx.db, goal, ctx.timezone, ctx.now());
        return `logged ${goal.title}${streak >= 2 ? `; ${streak} days in a row` : ""}`;
      }
      endGoal(ctx.db, goal.id, action === "done" ? "done" : "dropped", ctx.now());
      return `${action === "done" ? "finished" : "dropped"}: ${goal.title}`;
    },
  },
  {
    name: "set_briefing",
    description: "Set up, change or stop a daily morning message (weather, today's reminders, open goals). Any setting turns it on.",
    parameters: schema(
      {
        enabled: { type: "boolean", description: "False stops it." },
        time: str("Local time, e.g. 08:00 or 7:30am."),
        city: str("City for the weather; empty removes it."),
        fahrenheit: { type: "boolean" },
      },
      [],
    ),
    writes: true,
    // The city name goes to Open-Meteo to be turned into a place.
    egress: true,
    run: async ({ enabled, time, city, fahrenheit }, ctx) => {
      const given = [enabled, time, city, fahrenheit].some((value) => value !== undefined);
      if (!given) return "error: nothing to change was given";
      const result = await configureBriefing(
        { db: ctx.db, weather: ctx.weather, timezone: ctx.timezone, now: ctx.now },
        { senderId: ctx.senderId, chatId: ctx.chatId },
        {
          enabled: typeof enabled === "boolean" ? enabled : undefined,
          time: time === undefined ? undefined : String(time),
          city: city === undefined ? undefined : String(city),
          fahrenheit: typeof fahrenheit === "boolean" ? fahrenheit : undefined,
        },
        ctx.signal,
      );
      return result.ok ? `briefing ${result.text}` : `error: ${result.error}`;
    },
  },
  {
    name: "search_history",
    description: "Search earlier messages in this conversation for some words. Use for things said a while ago.",
    parameters: schema({ query: str("A few key words.") }, ["query"]),
    writes: false,
    run: ({ query }, ctx) => {
      const hits = searchMessages(ctx.db, ctx.chatId, String(query ?? ""), 5);
      if (hits.length === 0) return "nothing found";
      return hits
        .map((m) => `${formatLocal(m.createdAt, ctx.timezone)} — ${m.role === "user" ? "they" : "you"} said: ${m.text.slice(0, 240)}`)
        .join("\n");
    },
  },
  {
    name: "web_search",
    description: "Search the web for current or specific facts: news, scores, prices, opening hours, anything you are not sure of.",
    parameters: schema({ query: str("What to look up, written as a full question.") }, ["query"]),
    writes: false,
    untrusted: true,
    egress: true,
    run: ({ query }, ctx) => {
      const text = String(query ?? "").trim();
      return text ? ctx.web.search(text, ctx.signal) : "error: query is empty";
    },
  },
  {
    name: "read_link",
    description: "Open a web link the person sent and read the page.",
    parameters: schema({ url: str("The full http(s) link.") }, ["url"]),
    writes: false,
    untrusted: true,
    egress: true,
    run: ({ url }, ctx) => {
      // The address must be one the person typed. A link the model made up, or was
      // told about by a page, could carry private details away in its path or query.
      const wanted = normaliseLink(String(url ?? ""));
      if (!wanted || !ctx.userLinks.includes(wanted)) {
        return "error: only a link the person sent can be opened. Ask them to send the link.";
      }
      return ctx.web.read(String(url), ctx.signal);
    },
  },
  {
    name: "calculate",
    description: "Evaluate arithmetic exactly. Supports + - * / % ^ and parentheses.",
    parameters: schema({ expression: str("e.g. (2340 * 18) / 100") }, ["expression"]),
    writes: false,
    run: ({ expression }) => {
      try {
        return String(Number(calculate(String(expression ?? "")).toPrecision(12)));
      } catch (err) {
        return `error: ${err instanceof Error ? err.message : "could not evaluate"}`;
      }
    },
  },
];

const toDef = ({ name, description, parameters }: Tool): ToolDef => ({ name, description, parameters });

export const toolDefs: ToolDef[] = TOOLS.map(toDef);
/** What is offered once web content is in the turn: nothing that changes anything or reaches the internet. */
export const afterWebToolDefs: ToolDef[] = TOOLS.filter((tool) => !tool.writes && !tool.egress).map(toDef);

/** A link reduced to host, path and query, so "Example.com/a/" and "https://www.example.com/a" compare equal. */
export function normaliseLink(link: string): string | null {
  try {
    const text = link.trim().replace(/[.,!?;:)\]]+$/, "");
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

/** Every link in a piece of text the person wrote, normalised. */
export function linksIn(text: string): string[] {
  const found = text.match(/\bhttps?:\/\/[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi) ?? [];
  return found.flatMap((link) => normaliseLink(link) ?? []);
}

export type ToolOutcome = { text: string; wrote: boolean; untrusted: boolean };

/**
 * Runs one tool call. Never throws except when the turn is cancelled: any other
 * failure comes back as text the model can read. Once web content is in the
 * turn (`clean` false), a tool that changes something or reaches the internet
 * is refused whatever the model asked for.
 */
export async function runTool(call: ToolCall, ctx: ToolContext, clean: boolean): Promise<ToolOutcome> {
  const fail = (text: string): ToolOutcome => ({ text, wrote: false, untrusted: false });
  const tool = TOOLS.find((t) => t.name === call.name);
  if (!tool) return fail(`error: there is no tool called ${call.name}`);
  if (tool.writes && !clean) {
    return fail("error: nothing can be saved, scheduled or deleted in the same turn as reading web content. Tell the person, and they can ask again.");
  }
  if (tool.egress && !clean) {
    return fail("error: only one search or link can be opened per message. Answer from what you have, and the person can ask for more.");
  }
  let args: Record<string, any>;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return fail("error: arguments were not valid JSON");
  }
  try {
    const text = await tool.run(args ?? {}, ctx);
    // A refusal written by this server is not web content, so it does not lock the turn down.
    const ok = !text.startsWith("error:");
    return { text, wrote: tool.writes && ok, untrusted: Boolean(tool.untrusted) && ok };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return fail(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A small recursive-descent evaluator, so arithmetic never goes through `eval`. */
export function calculate(input: string): number {
  const text = input.replace(/[,\s]/g, "").replace(/×/g, "*").replace(/÷/g, "/");
  let pos = 0;
  const peek = () => text[pos];
  const expect = (ch: string) => {
    if (text[pos] !== ch) throw new Error(`expected ${ch}`);
    pos++;
  };
  const atom = (): number => {
    if (peek() === "(") {
      pos++;
      const value = sum();
      expect(")");
      return value;
    }
    if (peek() === "-") {
      pos++;
      return -atom();
    }
    const match = /^\d+(\.\d+)?|^\.\d+/.exec(text.slice(pos));
    if (!match) throw new Error("expected a number");
    pos += match[0].length;
    return Number(match[0]);
  };
  const power = (): number => {
    const base = atom();
    if (peek() === "^") {
      pos++;
      return base ** power();
    }
    return base;
  };
  const product = (): number => {
    let value = power();
    for (;;) {
      const op = peek();
      if (op !== "*" && op !== "/" && op !== "%") return value;
      pos++;
      const right = power();
      if ((op === "/" || op === "%") && right === 0) throw new Error("division by zero");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
  };
  const sum = (): number => {
    let value = product();
    for (;;) {
      const op = peek();
      if (op !== "+" && op !== "-") return value;
      pos++;
      value = op === "+" ? value + product() : value - product();
    }
  };
  const result = sum();
  if (pos !== text.length) throw new Error("unexpected text in expression");
  if (!Number.isFinite(result)) throw new Error("result is not a finite number");
  return result;
}
