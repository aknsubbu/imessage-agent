import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { noSync } from "../src/integrations/sync.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { addReminder, recordEvent } from "../src/store.ts";
import { CHAT, drain, makeRuntime, OWNER, sends, textEvent } from "./helpers.ts";

let runtime: ReturnType<typeof makeRuntime>;
afterEach(() => runtime?.stop());

const NOON = Date.UTC(2026, 9, 9, 12, 0);
const clock = { now: NOON };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** Records every outside call, and answers like the real services do. */
function recorder(respond?: (url: string) => Response) {
  const calls: Call[] = [];
  let next = 0;
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (respond) return respond(url);
    if (url.endsWith("/close")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: `remote-${++next}` }), { status: 200 });
  };
  return { calls, fetchImpl };
}

const TODOIST = { todoist: { token: "todo-token" } };
const NOTION = { notion: { token: "notion-token", databaseId: "db1", titleProperty: "Task", dateProperty: "When", version: "2022-06-28" } };

function start(integrations: object, fetchImpl: ReturnType<typeof recorder>["fetchImpl"], llm: FakeLLM) {
  clock.now = NOON;
  runtime = makeRuntime(llm, { timezone: "UTC", integrations }, { now: () => clock.now, syncFetch: fetchImpl });
  recordEvent(runtime.db, textEvent("seed"), NOON - 1000);
}
const tool = (...calls: { name: string; arguments: Record<string, unknown> }[]) => ({ toolCalls: calls });
const refs = () => runtime.db.prepare("SELECT provider, kind, local_id, remote_id FROM external_refs ORDER BY rowid").all();
const thumbsUp = (messageId: string) => textEvent("", { kind: "reaction", parts: [], reaction: { emoji: "👍", targetMessageId: messageId } });

describe("integrations are off by default", () => {
  it("copy nothing anywhere and say so in /status", async () => {
    const { calls, fetchImpl } = recorder();
    start({}, fetchImpl, new FakeLLM((_r, call) => (call === 1 ? tool({ name: "set_reminder", arguments: { text: "Stretch", at: "2026-10-09T12:30" } }) : "Set.")));
    runtime.handleEvent(textEvent("remind me to stretch at 12:30"));
    expect(sends(await drain(runtime))).toEqual(["Set."]);
    runtime.handleEvent(textEvent("/status"));
    expect(sends(await drain(runtime))[0]).toContain("Integrations: none on");
    await sleep(30);
    expect(calls).toEqual([]);
    expect(refs()).toEqual([]);
  });

  it("use a do-nothing sync when no integration is configured", () => {
    expect(noSync.providers).toEqual([]);
    expect(() => {
      noSync.created({ kind: "reminder", id: 1, text: "x" });
      noSync.closed("reminder", 1);
    }).not.toThrow();
  });

  it("need both the name in INTEGRATIONS and the credentials", () => {
    expect(loadConfig({ AGENT_SHARED_SECRET: "s" }).integrations).toEqual({});
    // A token on its own does nothing.
    expect(loadConfig({ AGENT_SHARED_SECRET: "s", TODOIST_TOKEN: "t" }).integrations).toEqual({});
    const on = loadConfig({ AGENT_SHARED_SECRET: "s", INTEGRATIONS: "Todoist", TODOIST_TOKEN: "t" });
    expect(on.integrations).toEqual({ todoist: { token: "t" } });
    expect(on.integrationProblems).toEqual([]);
  });

  it("report an integration that was asked for but cannot start", () => {
    const cfg = loadConfig({ AGENT_SHARED_SECRET: "s", INTEGRATIONS: "todoist, notion, asana", NOTION_TOKEN: "n" });
    expect(cfg.integrations).toEqual({});
    expect(cfg.integrationProblems).toEqual([
      "todoist is listed in INTEGRATIONS but TODOIST_TOKEN is not set",
      "notion is listed in INTEGRATIONS but NOTION_TOKEN or NOTION_DATABASE_ID is not set",
      'unknown integration "asana" in INTEGRATIONS',
    ]);
  });

  it("read Notion's settings, with defaults", () => {
    const cfg = loadConfig({ AGENT_SHARED_SECRET: "s", INTEGRATIONS: "notion", NOTION_TOKEN: "n", NOTION_DATABASE_ID: "d" });
    expect(cfg.integrations.notion).toEqual({ token: "n", databaseId: "d", titleProperty: "Name", dateProperty: undefined, version: "2022-06-28" });
  });
});

describe("Todoist", () => {
  const setReminder = (at = "2026-10-09T12:30") =>
    new FakeLLM((_r, call) => (call === 1 ? tool({ name: "set_reminder", arguments: { text: "Call the bank", at } }) : "Set."));

  it("receives a task for each reminder, with its due time, and /status lists it", async () => {
    const { calls, fetchImpl } = recorder();
    start(TODOIST, fetchImpl, setReminder());
    runtime.handleEvent(textEvent("remind me to call the bank"));
    await drain(runtime);
    await sleep(30);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.todoist.com/api/v1/tasks",
      method: "POST",
      headers: { authorization: "Bearer todo-token", "content-type": "application/json" },
      body: { content: "Call the bank", due_datetime: "2026-10-09T12:30:00Z" },
    });
    expect(refs()).toEqual([{ provider: "todoist", kind: "reminder", local_id: 1, remote_id: "remote-1" }]);
    runtime.handleEvent(textEvent("/status"));
    expect(sends(await drain(runtime))[0]).toContain("Integrations: todoist");
  });

  it("closes the task when the reminder is marked done, and only then", async () => {
    const { calls, fetchImpl } = recorder();
    start(TODOIST, fetchImpl, setReminder());
    runtime.handleEvent(textEvent("remind me"));
    await drain(runtime);
    await sleep(30);
    clock.now = NOON + 31 * 60_000;
    runtime.scheduler.tick();
    await drain(runtime);
    await sleep(30);
    expect(calls).toHaveLength(1); // delivered, not done: still open in Todoist

    const { message_id } = runtime.db.prepare("SELECT message_id FROM reminder_runs").get() as { message_id: string };
    expect(runtime.handleEvent(thumbsUp(message_id))).toBe("reminder_done");
    await sleep(30);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: "https://api.todoist.com/api/v1/tasks/remote-1/close", method: "POST" });
    expect(refs()).toEqual([]);
  });

  it("closes the task when the reminder is cancelled", async () => {
    const { calls, fetchImpl } = recorder();
    const llm = new FakeLLM((_r, call) => {
      if (call === 1) return tool({ name: "set_reminder", arguments: { text: "Call the bank", at: "2026-10-09T12:30" } });
      if (call === 2) return "Set.";
      if (call === 3) return tool({ name: "cancel_reminder", arguments: { about: "bank" } });
      return "Cancelled.";
    });
    start(TODOIST, fetchImpl, llm);
    runtime.handleEvent(textEvent("remind me"));
    await drain(runtime);
    await sleep(30);
    runtime.handleEvent(textEvent("never mind that"));
    await drain(runtime);
    await sleep(30);
    expect(calls.map((c) => c.url)).toEqual(["https://api.todoist.com/api/v1/tasks", "https://api.todoist.com/api/v1/tasks/remote-1/close"]);
  });

  it("leaves a repeating reminder's task open when one occurrence is done", async () => {
    const { calls, fetchImpl } = recorder();
    start(TODOIST, fetchImpl, new FakeLLM(() => "ok"));
    // A repeating reminder made before the integration was switched on has no copy; one made after has.
    const id = addReminder(runtime.db, { chatId: CHAT, senderId: OWNER, text: "Stretch", dueAt: NOON, repeat: "daily" }, NOON - 500);
    runtime.db.prepare("INSERT INTO external_refs VALUES ('todoist', 'reminder', ?, 'remote-9')").run(id);
    runtime.scheduler.tick();
    await drain(runtime);
    const { message_id } = runtime.db.prepare("SELECT message_id FROM reminder_runs").get() as { message_id: string };
    runtime.handleEvent(thumbsUp(message_id));
    await sleep(30);
    expect(calls).toEqual([]);
  });

  it("gets list items as labelled tasks, and closes them when they are removed", async () => {
    const { calls, fetchImpl } = recorder();
    const llm = new FakeLLM((_r, call) => {
      if (call === 1) return tool({ name: "add_to_list", arguments: { list: "Shopping List", items: ["oat milk", "eggs"] } });
      if (call === 2) return "Added.";
      if (call === 3) return tool({ name: "remove_from_list", arguments: { list: "shopping list", item: "eggs" } });
      return "Removed.";
    });
    start(TODOIST, fetchImpl, llm);
    runtime.handleEvent(textEvent("add oat milk and eggs to shopping"));
    await drain(runtime);
    await sleep(30);
    expect(calls.map((c) => c.body)).toEqual([
      { content: "oat milk", labels: ["shopping_list"] },
      { content: "eggs", labels: ["shopping_list"] },
    ]);
    runtime.handleEvent(textEvent("got the eggs"));
    await drain(runtime);
    await sleep(30);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ url: "https://api.todoist.com/api/v1/tasks/remote-2/close" });
  });

  it("never lets a failing service break the reminder, and records the failure", async () => {
    const { calls, fetchImpl } = recorder(() => new Response("nope", { status: 500 }));
    start(TODOIST, fetchImpl, setReminder());
    runtime.handleEvent(textEvent("remind me"));
    expect(sends(await drain(runtime))).toEqual(["Set."]);
    await sleep(30);
    expect(calls).toHaveLength(1);
    expect(runtime.db.prepare("SELECT 1 FROM reminders WHERE text = 'Call the bank'").all()).toHaveLength(1);
    expect(refs()).toEqual([]);
    const failure = runtime.db.prepare("SELECT scope, error FROM failures WHERE scope = 'sync.todoist.create'").get() as { error: string };
    expect(failure.error).toContain("HTTP 500");
  });

  it("treats a reply without a task id as a failure, not a copy", async () => {
    const { fetchImpl } = recorder(() => new Response("{}", { status: 200 }));
    start(TODOIST, fetchImpl, setReminder());
    runtime.handleEvent(textEvent("remind me"));
    await drain(runtime);
    await sleep(30);
    expect(refs()).toEqual([]);
    expect(runtime.db.prepare("SELECT 1 FROM failures WHERE scope = 'sync.todoist.create'").all()).toHaveLength(1);
  });
});

describe("Notion", () => {
  it("receives a page for a reminder, in the configured columns, and is never asked to close it", async () => {
    const { calls, fetchImpl } = recorder();
    start(NOTION, fetchImpl, new FakeLLM((_r, call) => (call === 1 ? tool({ name: "set_reminder", arguments: { text: "Pay rent", at: "2026-10-09T12:30" } }) : "Set.")));
    runtime.handleEvent(textEvent("remind me to pay rent"));
    await drain(runtime);
    await sleep(30);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.notion.com/v1/pages",
      method: "POST",
      headers: { authorization: "Bearer notion-token", "notion-version": "2022-06-28" },
      body: {
        parent: { database_id: "db1" },
        properties: { Task: { title: [{ text: { content: "Pay rent" } }] }, When: { date: { start: "2026-10-09T12:30:00Z" } } },
      },
    });

    clock.now = NOON + 31 * 60_000;
    runtime.scheduler.tick();
    await drain(runtime);
    const { message_id } = runtime.db.prepare("SELECT message_id FROM reminder_runs").get() as { message_id: string };
    runtime.handleEvent(thumbsUp(message_id));
    await sleep(30);
    expect(calls).toHaveLength(1);
  });

  it("prefixes a list item with its list", async () => {
    const { calls, fetchImpl } = recorder();
    start(NOTION, fetchImpl, new FakeLLM((_r, call) => (call === 1 ? tool({ name: "add_to_list", arguments: { list: "packing", items: ["passport"] } }) : "Added.")));
    runtime.handleEvent(textEvent("add passport to packing"));
    await drain(runtime);
    await sleep(30);
    expect(calls[0]!.body.properties.Task.title[0].text.content).toBe("[packing] passport");
    expect(calls[0]!.body.properties.When).toBeUndefined();
  });

  it("can run alongside Todoist, each with its own copy", async () => {
    const { calls, fetchImpl } = recorder();
    start({ ...TODOIST, ...NOTION }, fetchImpl, new FakeLLM((_r, call) => (call === 1 ? tool({ name: "set_reminder", arguments: { text: "Both", at: "2026-10-09T12:30" } }) : "Set.")));
    runtime.handleEvent(textEvent("remind me"));
    await drain(runtime);
    await sleep(30);
    expect(calls.map((c) => new URL(c.url).host).sort()).toEqual(["api.notion.com", "api.todoist.com"]);
    expect(refs()).toHaveLength(2);
  });
});
