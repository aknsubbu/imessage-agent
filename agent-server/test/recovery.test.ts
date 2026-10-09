import { afterEach, describe, expect, it } from "vitest";
import { createActionRunner } from "../../imessage-chatbot/src/actions.ts";
import type { Ack, Action } from "../../protocol/index.ts";
import { openDb } from "../src/db.ts";
import { FakeLLM, lastUserText } from "../src/llm/fake.ts";
import { history } from "../src/store.ts";
import { CHAT, drain, makeRuntime, sends, textEvent } from "./helpers.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runtimes: ReturnType<typeof makeRuntime>[] = [];
const start = (...args: Parameters<typeof makeRuntime>) => {
  const runtime = makeRuntime(...args);
  runtimes.push(runtime);
  return runtime;
};
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
});

describe("server restart", () => {
  it("resumes a reply that was part-way out, without repeating the bubble already sent", async () => {
    const db = openDb(":memory:");
    const llm = new FakeLLM(() => "First.\n\nSecond.");
    const before = start(llm, {}, { db });
    before.handleEvent(textEvent("go"));
    const seen = await drain(before, { until: (actions) => sends(actions).length === 1 });
    expect(sends(seen)).toEqual(["First."]);
    before.stop(); // goes down during the pause before the second bubble

    const after = start(llm, {}, { db });
    after.lanes.recover();
    expect(sends(await drain(after, { quietMs: 700 }))).toEqual(["Second."]);
    await after.lanes.idle();
    expect(llm.calls).toHaveLength(1); // the model was not asked again
    expect(history(db, CHAT, 10).map((m) => m.text)).toEqual(["go", "First.", "Second."]);
    const turn = db.prepare("SELECT status FROM turns").get() as { status: string };
    expect(turn.status).toBe("done");
  });

  it("does not re-send a bubble whose result was never confirmed", async () => {
    const db = openDb(":memory:");
    const before = start(new FakeLLM(() => "Only bubble."), {}, { db });
    before.handleEvent(textEvent("go"));
    const seen = await drain(before, {
      until: (actions) => sends(actions).length === 1,
      ack: (action) => (action.type === "send" ? "none" : "sent"),
    });
    const bubble = seen.find((action) => action.type === "send")!;
    before.hub.ack({ actionId: bubble.id, status: "sending" }); // the bridge started the send; then everything stopped
    before.stop();

    const after = start(new FakeLLM(), {}, { db });
    after.lanes.recover();
    expect(sends(await drain(after, { quietMs: 200 }))).toEqual([]);
    const row = db.prepare("SELECT status FROM actions WHERE id = ?").get(bubble.id) as { status: string };
    expect(row.status).toBe("unknown");
  });

  it("answers a message whose turn was still thinking when the server stopped", async () => {
    const db = openDb(":memory:");
    const slow = new FakeLLM(() => "never delivered", 500);
    const before = start(slow, {}, { db });
    before.handleEvent(textEvent("are you there"));
    await sleep(60); // debounce fired; the model is mid-call
    before.stop();
    await sleep(20);

    const llm = new FakeLLM((req) => `got: ${lastUserText(req.messages)}`);
    const after = start(llm, {}, { db });
    after.lanes.recover();
    expect(sends(await drain(after, { quietMs: 300 }))).toEqual(["got: are you there"]);
    const turns = db.prepare("SELECT status FROM turns ORDER BY started_at").all() as { status: string }[];
    expect(turns.map((t) => t.status)).toEqual(["failed", "done"]);
  });
});

describe("bridge action runner", () => {
  const action: Action = { id: "a1", chatId: "c1", type: "send", content: { type: "text", text: "hi" } };

  it("accepts the server's next offer when it could not say 'sending' the first time", async () => {
    const acks: Ack[] = [];
    let reachable = false;
    let executed = 0;
    const runner = createActionRunner({
      ack: async (ack) => {
        if (reachable) acks.push(ack);
        return reachable;
      },
      execute: async () => {
        executed++;
        return { status: "sent", messageId: "m1" };
      },
      log: () => {},
    });

    expect(runner.claim(action)).toBe(true);
    await runner.carryOut(action); // server unreachable: nothing is sent
    expect(executed).toBe(0);

    reachable = true;
    expect(runner.claim(action)).toBe(true); // the re-offer is accepted, not ignored
    await runner.carryOut(action);
    expect(executed).toBe(1);
    expect(acks.map((ack) => ack.status)).toEqual(["sending", "sent"]);
  });

  it("ignores a second offer of an action it is already carrying out", async () => {
    let executed = 0;
    const runner = createActionRunner({
      ack: async () => true,
      execute: async () => {
        executed++;
        await sleep(30);
        return { status: "sent" };
      },
      log: () => {},
    });
    expect(runner.claim(action)).toBe(true);
    const first = runner.carryOut(action);
    expect(runner.claim(action)).toBe(false);
    await first;
    expect(executed).toBe(1);
  });

  it("carries out typing without the 'sending' handshake", async () => {
    const acks: Ack[] = [];
    const runner = createActionRunner({
      ack: async (ack) => (acks.push(ack), true),
      execute: async () => ({ status: "sent" }),
      log: () => {},
    });
    await runner.carryOut({ id: "t1", chatId: "c1", type: "typing", state: "start" });
    expect(acks.map((ack) => ack.status)).toEqual(["sent"]);
  });
});
