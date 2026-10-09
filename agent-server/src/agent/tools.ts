// The tools the model can call. All of them are local: they read and write
// this server's own database and need no outside account.
import type { DB } from "../db.ts";
import type { ToolCall, ToolDef } from "../llm/types.ts";
import {
  addFact,
  addNotes,
  addReminder,
  cancelReminders,
  listNames,
  listNotes,
  pendingReminders,
  removeFacts,
  removeNotes,
  searchMessages,
} from "../store.ts";
import { formatLocal, parseLocal, type Repeat } from "../time.ts";

export type ToolContext = { db: DB; chatId: string; senderId: string; timezone: string; now: () => number };

type Tool = ToolDef & {
  /** True when the tool changes something, so its turn must not be thrown away and run again. */
  writes: boolean;
  run: (args: Record<string, any>, ctx: ToolContext) => string;
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
      addNotes(ctx.db, ctx.senderId, String(list ?? "notes"), clean.slice(0, 30), ctx.now());
      return `added ${clean.length} to ${String(list ?? "notes").toLowerCase()}`;
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
      const removed = removeNotes(ctx.db, ctx.senderId, String(list ?? "notes"), String(item ?? "").trim() || "\u0000");
      return removed.length ? `removed: ${removed.join("; ")}` : "nothing matched";
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
      return cancelled.length ? `cancelled: ${cancelled.map((r) => r.text).join("; ")}` : "no reminder matched";
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

export const toolDefs: ToolDef[] = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

/** Runs one tool call. Never throws: a failure comes back as text the model can read. */
export function runTool(call: ToolCall, ctx: ToolContext): { text: string; wrote: boolean } {
  const tool = TOOLS.find((t) => t.name === call.name);
  if (!tool) return { text: `error: there is no tool called ${call.name}`, wrote: false };
  let args: Record<string, any>;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { text: "error: arguments were not valid JSON", wrote: false };
  }
  try {
    const text = tool.run(args ?? {}, ctx);
    return { text, wrote: tool.writes && !text.startsWith("error:") };
  } catch (err) {
    return { text: `error: ${err instanceof Error ? err.message : String(err)}`, wrote: false };
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
