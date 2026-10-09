import { afterEach, describe, expect, it } from "vitest";
import { FakeLLM, lastUserText } from "../src/llm/fake.ts";
import { PoolExhaustedError } from "../src/llm/types.ts";
import { history } from "../src/store.ts";
import { CHAT, drain, makeRuntime, post, sends, textEvent } from "./helpers.ts";

let runtime: ReturnType<typeof makeRuntime>;
afterEach(() => runtime?.stop());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("http", () => {
  it("rejects unsigned and wrongly signed requests", async () => {
    runtime = makeRuntime();
    const unsigned = await runtime.app.request("/v1/events", { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(401);
    const wrong = await post(runtime.app, "/v1/events", textEvent("hi"), "another-secret");
    expect(wrong.status).toBe(401);
  });

  it("rejects a malformed event", async () => {
    runtime = makeRuntime();
    const res = await post(runtime.app, "/v1/events", { v: 1, nope: true });
    expect(res.status).toBe(400);
  });

  it("answers a message end to end and records both sides", async () => {
    const llm = new FakeLLM(() => "Hello there.");
    runtime = makeRuntime(llm);
    const res = await post(runtime.app, "/v1/events", textEvent("hi"));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ outcome: "queued" });

    const actions = await drain(runtime);
    expect(actions.map((a) => a.type)).toEqual(["read", "typing", "send"]);
    expect(sends(actions)).toEqual(["Hello there."]);
    await runtime.lanes.idle();
    expect(history(runtime.db, CHAT, 10).map((m) => [m.role, m.text, m.state])).toEqual([
      ["user", "hi", "answered"],
      ["assistant", "Hello there.", "sent"],
    ]);
  });

  it("processes a repeated event only once", async () => {
    const llm = new FakeLLM();
    runtime = makeRuntime(llm);
    const ev = textEvent("hi");
    await post(runtime.app, "/v1/events", ev);
    const again = await post(runtime.app, "/v1/events", ev);
    expect(await again.json()).toMatchObject({ outcome: "duplicate" });
    await drain(runtime);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("intake", () => {
  it("never calls the model for reactions, read receipts or poll votes", async () => {
    const llm = new FakeLLM();
    runtime = makeRuntime(llm);
    expect(runtime.handleEvent(textEvent("", { kind: "read", parts: [] }))).toBe("signal");
    expect(
      runtime.handleEvent(
        textEvent("", { kind: "reaction", parts: [], reaction: { emoji: "👍", targetMessageId: "m1" } }),
      ),
    ).toBe("signal");
    expect(
      runtime.handleEvent(
        textEvent("", { kind: "poll_vote", parts: [], pollVote: { pollTitle: "Lunch?", option: "Pizza", selected: true } }),
      ),
    ).toBe("signal");
    await sleep(60);
    expect(await drain(runtime, { quietMs: 30 })).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("ignores auto-replies, strangers and group chats", async () => {
    const llm = new FakeLLM();
    runtime = makeRuntime(llm);
    expect(runtime.handleEvent(textEvent("I'm driving", { flags: { autoReply: true } }))).toBe("auto_reply");
    expect(runtime.handleEvent(textEvent("hi", { sender: { id: "+19990000000" } }))).toBe("not_allowed");
    expect(runtime.handleEvent(textEvent("hi", { chat: { id: "g;+;1", type: "group", line: "shared" } }))).toBe(
      "group_ignored",
    );
    await sleep(60);
    expect(llm.calls).toHaveLength(0);
  });

  it("makes the first sender the owner when none is configured", async () => {
    runtime = makeRuntime(new FakeLLM(), { ownerIds: [] });
    expect(runtime.handleEvent(textEvent("/who", { sender: { id: "+15557770000" } }))).toBe("command");
    expect(runtime.handleEvent(textEvent("hi", { sender: { id: "+15558880000" } }))).toBe("not_allowed");
    expect(sends(await drain(runtime))).toEqual(["+15557770000 (owner)"]);
  });

  it("answers slash commands without the model", async () => {
    const llm = new FakeLLM();
    runtime = makeRuntime(llm);
    expect(runtime.handleEvent(textEvent("/ping"))).toBe("command");
    expect(sends(await drain(runtime))).toEqual(["pong"]);
    expect(llm.calls).toHaveLength(0);
  });

  it("tapbacks a lone thanks instead of replying, unless it answers a question", async () => {
    const llm = new FakeLLM(() => "Want me to remember that?");
    runtime = makeRuntime(llm);
    const thanks = textEvent("thanks!");
    expect(runtime.handleEvent(thanks)).toBe("ack");
    const acked = await drain(runtime);
    expect(acked.find((a) => a.type === "react")).toMatchObject({ messageId: thanks.eventId, emoji: "❤️" });
    expect(llm.calls).toHaveLength(0);

    runtime.handleEvent(textEvent("my sister is Meera"));
    await drain(runtime);
    await runtime.lanes.idle();
    // The assistant just asked a question, so "ok" is an answer and goes to the model.
    expect(runtime.handleEvent(textEvent("ok"))).toBe("queued");
    await drain(runtime);
    expect(llm.calls).toHaveLength(2);
  });

  it("/reset drops earlier conversation from the model's context", async () => {
    const llm = new FakeLLM((req) => `echo: ${lastUserText(req.messages)}`);
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("my code word is pineapple"));
    await drain(runtime);
    await runtime.lanes.idle();
    await sleep(5);
    runtime.handleEvent(textEvent("/reset"));
    await drain(runtime);
    await sleep(5);
    runtime.handleEvent(textEvent("what was it?"));
    await drain(runtime);
    const prompt = JSON.stringify(llm.calls.at(-1)!.messages);
    expect(prompt).not.toContain("pineapple");
    expect(prompt).toContain("what was it?");
  });
});

describe("lanes", () => {
  it("answers a burst of messages with one model call", async () => {
    const llm = new FakeLLM((req) => `got: ${lastUserText(req.messages)}`);
    runtime = makeRuntime(llm);
    for (const text of ["hey", "wait", "does the train run on holidays"]) runtime.handleEvent(textEvent(text));
    const actions = await drain(runtime);
    expect(llm.calls).toHaveLength(1);
    expect(sends(actions)).toEqual(["got: hey\nwait\ndoes the train run on holidays"]);
  });

  it("drops a turn in flight when the person texts again, and answers everything together", async () => {
    const llm = new FakeLLM((req) => `got: ${lastUserText(req.messages)}`, 80);
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("book a table"));
    await sleep(50); // debounce has fired; the model is thinking
    runtime.handleEvent(textEvent("actually make it for four"));
    const actions = await drain(runtime, { quietMs: 300 });
    expect(llm.calls).toHaveLength(2);
    expect(sends(actions)).toEqual(["got: book a table\nactually make it for four"]);
    await runtime.lanes.idle();
    const turns = runtime.db.prepare("SELECT status FROM turns ORDER BY started_at").all() as { status: string }[];
    expect(turns.map((t) => t.status)).toEqual(["cancelled", "done"]);
  });

  it("splits a reply into bubbles and stops sending the rest when interrupted", async () => {
    let call = 0;
    const llm = new FakeLLM(() => (call++ === 0 ? "First thought.\n\nSecond thought.\n\nThird thought." : "Dropped it."));
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("tell me three things"));
    // Take the first bubble, then interrupt before the pause for the second ends.
    const first = await drain(runtime, { until: (seen) => sends(seen).length === 1 });
    expect(sends(first)).toEqual(["First thought."]);
    runtime.handleEvent(textEvent("never mind"));
    const rest = await drain(runtime, { quietMs: 300 });
    expect(sends(rest)).toEqual(["Dropped it."]);
    const statuses = runtime.db
      .prepare("SELECT status FROM actions WHERE body LIKE '%thought.%' ORDER BY seq")
      .all() as { status: string }[];
    expect(statuses.map((s) => s.status)).toEqual(["sent", "cancelled", "cancelled"]);
  });

  it("applies a tapback tag and stays silent when asked to", async () => {
    runtime = makeRuntime(new FakeLLM(() => "[[react:😂]]\n[[silent]]"));
    const ev = textEvent("why did the chicken cross the road");
    runtime.handleEvent(ev);
    const actions = await drain(runtime);
    expect(actions.find((a) => a.type === "react")).toMatchObject({ messageId: ev.eventId, emoji: "😂" });
    expect(sends(actions)).toEqual([]);
  });

  it("says once, honestly, when every model slot is rate limited, and keeps the messages", async () => {
    const llm = {
      complete: async () => {
        throw new PoolExhaustedError(Date.now() + 5 * 60_000);
      },
    };
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("hello?"));
    const first = sends(await drain(runtime));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/usage limit.*about 5 minutes/);
    runtime.handleEvent(textEvent("still there?"));
    expect(sends(await drain(runtime))).toEqual([]);
    const states = runtime.db.prepare("SELECT state FROM messages WHERE role = 'user'").all() as { state: string }[];
    expect(states.map((row) => row.state)).toEqual(["pending", "pending"]);
  });

  it("answers what it was holding once the rate limit clears", async () => {
    let limited = true;
    const llm = new FakeLLM((req) => `got: ${lastUserText(req.messages)}`);
    const flaky = {
      complete: async (req: Parameters<FakeLLM["complete"]>[0]) => {
        if (limited) {
          limited = false;
          throw new PoolExhaustedError(Date.now() + 120);
        }
        return llm.complete(req);
      },
    };
    runtime = makeRuntime(flaky);
    runtime.handleEvent(textEvent("what's 2+2"));
    const texts = sends(await drain(runtime, { quietMs: 900 }));
    expect(texts[0]).toMatch(/usage limit.*under a minute/);
    expect(texts[1]).toBe("got: what's 2+2");
  });

  it("tells the person when the model fails, and records the failure", async () => {
    const llm = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("hello"));
    expect(sends(await drain(runtime))).toEqual(["Something went wrong on my side. Try me again in a moment."]);
    await runtime.lanes.idle();
    const failures = runtime.db.prepare("SELECT scope FROM failures").all() as { scope: string }[];
    expect(failures.map((f) => f.scope)).toContain("turn.model");
  });
});

describe("outbox", () => {
  it("only gives a bridge the actions for its own platform", async () => {
    runtime = makeRuntime(new FakeLLM());
    const chat = { id: "terminal:dev", type: "dm" as const, line: "dev" };
    runtime.handleEvent(textEvent("/ping", { platform: "terminal", chat }));
    expect(await runtime.hub.poll(60, undefined, "imessage")).toEqual([]);
    const mine = await runtime.hub.poll(60, undefined, "terminal");
    expect(sends(mine)).toEqual(["pong"]);
    expect(mine[0]!.chatId).toBe("terminal:dev");
  });

  it("hands an action out again if the bridge never started on it", async () => {
    runtime = makeRuntime(new FakeLLM(() => "Hello."), {}, { hub: { redeliverMs: 40 } });
    runtime.handleEvent(textEvent("/ping"));
    const lost = await runtime.hub.poll(200); // the bridge takes it and dies before acking
    expect(sends(lost)).toEqual(["pong"]);
    const again = await drain(runtime, { quietMs: 200 });
    expect(sends(again)).toEqual(["pong"]);
    expect(again[0]!.id).toBe(lost[0]!.id);
  });

  it("never hands out an action again once the bridge has started sending it", async () => {
    runtime = makeRuntime(new FakeLLM(), {}, { hub: { redeliverMs: 30, sendingTimeoutMs: 80 } });
    runtime.handleEvent(textEvent("/ping"));
    const [action] = await runtime.hub.poll(200);
    runtime.hub.ack({ actionId: action!.id, status: "sending" }); // ...and then the bridge dies
    expect(sends(await drain(runtime, { quietMs: 200 }))).toEqual([]);
    const row = runtime.db.prepare("SELECT status FROM actions WHERE id = ?").get(action!.id) as { status: string };
    expect(row.status).toBe("unknown");
  });

  it("still sends the text when only the tapback fails", async () => {
    runtime = makeRuntime(new FakeLLM(() => "[[react:👍]]\nOn it."));
    runtime.handleEvent(textEvent("can you check"));
    const actions = await drain(runtime, { ack: (a) => (a.type === "react" ? "failed" : "sent"), quietMs: 300 });
    expect(sends(actions)).toEqual(["On it."]);
  });

  it("does not offer an action again when the bridge's 'sending' report arrives late", async () => {
    runtime = makeRuntime(new FakeLLM(), {}, { hub: { redeliverMs: 30 } });
    runtime.handleEvent(textEvent("/ping"));
    const [action] = await runtime.hub.poll(200);
    await sleep(70); // long enough for the server to put it back on offer
    runtime.hub.ack({ actionId: action!.id, status: "sending" });
    expect(await runtime.hub.poll(80)).toEqual([]);
    const row = runtime.db.prepare("SELECT status FROM actions WHERE id = ?").get(action!.id) as { status: string };
    expect(row.status).toBe("sending");
    runtime.hub.ack({ actionId: action!.id, status: "sent", messageId: "m1" });
    await runtime.lanes.idle();
    expect(history(runtime.db, CHAT, 10).at(-1)).toMatchObject({ role: "assistant", text: "pong", platformId: "m1" });
  });

  it("stops a reply when a bubble fails to send", async () => {
    runtime = makeRuntime(new FakeLLM(() => "One.\n\nTwo."));
    runtime.handleEvent(textEvent("go"));
    const actions = await drain(runtime, { ack: (a) => (a.type === "send" ? "failed" : "sent"), quietMs: 300 });
    expect(sends(actions)).toEqual(["One."]);
    await runtime.lanes.idle();
    expect(history(runtime.db, CHAT, 10).filter((m) => m.role === "assistant")).toEqual([]);
  });
});
