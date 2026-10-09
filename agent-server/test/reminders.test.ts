import { afterEach, describe, expect, it } from "vitest";
import { parseSnooze } from "../src/core/reminders.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { addReminder, pendingReminders, recordEvent } from "../src/store.ts";
import { CHAT, drain, makeRuntime, OWNER, sends, textEvent } from "./helpers.ts";

let runtime: ReturnType<typeof makeRuntime>;
afterEach(() => runtime?.stop());

const MIN = 60_000;
const NOON = Date.UTC(2026, 9, 9, 12, 0); // midday UTC: outside quiet hours

/** Starts a runtime on a hand-wound clock and delivers one reminder. Returns the delivered bubble's id. */
async function deliver(opts: { repeat?: string; llm?: FakeLLM; start?: number } = {}) {
  const clock = { now: opts.start ?? NOON };
  const llm = opts.llm ?? new FakeLLM(() => "model reply");
  runtime = makeRuntime(llm, { timezone: "UTC" }, { now: () => clock.now });
  recordEvent(runtime.db, textEvent("seed"), clock.now - 1000);
  addReminder(runtime.db, { chatId: CHAT, senderId: OWNER, text: "Stretch", dueAt: clock.now, repeat: opts.repeat ?? "none" }, clock.now - 500);
  runtime.scheduler.tick();
  expect(sends(await drain(runtime))).toEqual(["⏰ Stretch"]);
  const { message_id: messageId } = runtime.db.prepare("SELECT message_id FROM reminder_runs ORDER BY id DESC").get() as { message_id: string };
  return { clock, llm, messageId };
}
const run = () => runtime.db.prepare("SELECT done_at, snoozed_at, nudged_at FROM reminder_runs ORDER BY id DESC").get() as Record<string, number | null>;
const thumbsUp = (messageId: string, patch = {}) =>
  textEvent("", { kind: "reaction", parts: [], reaction: { emoji: "👍", targetMessageId: messageId }, ...patch });

describe("reminder follow-through", () => {
  it("marks a reminder done on a thumbs-up, quietly, and never nudges about it", async () => {
    const { clock, llm, messageId } = await deliver();
    expect(runtime.handleEvent(thumbsUp(messageId))).toBe("reminder_done");
    expect(run().done_at).toBe(clock.now);
    clock.now += 45 * MIN;
    expect(runtime.scheduler.tick()).toBe(0);
    expect(sends(await drain(runtime, { quietMs: 40 }))).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("matches a tapback that names the bubble as a message part", async () => {
    const { messageId } = await deliver();
    expect(runtime.handleEvent(thumbsUp(`p:0/${messageId}`))).toBe("reminder_done");
  });

  it("ignores tapbacks from strangers, other emoji, and other messages", async () => {
    const { messageId } = await deliver();
    expect(runtime.handleEvent(thumbsUp(messageId, { sender: { id: "+19990000000" } }))).toBe("signal");
    expect(runtime.handleEvent(textEvent("", { kind: "reaction", parts: [], reaction: { emoji: "😂", targetMessageId: messageId } }))).toBe("signal");
    expect(runtime.handleEvent(thumbsUp("some-other-message"))).toBe("signal");
    expect(run().done_at).toBeNull();
  });

  it("counts a streak for a repeating reminder", async () => {
    const { clock, messageId } = await deliver({ repeat: "daily" });
    runtime.handleEvent(thumbsUp(messageId));
    expect(sends(await drain(runtime))).toEqual(["✔ Logged"]);

    clock.now += 24 * 60 * MIN; // the next day's reminder
    runtime.scheduler.tick();
    await drain(runtime);
    const next = runtime.db.prepare("SELECT message_id FROM reminder_runs ORDER BY id DESC").get() as { message_id: string };
    runtime.handleEvent(thumbsUp(next.message_id));
    expect(sends(await drain(runtime))).toEqual(["✔ 2 in a row"]);

    runtime.handleEvent(textEvent("/reminders"));
    expect(sends(await drain(runtime))[0]).toMatch(/\(daily, 2 in a row\) — Stretch$/);
  });

  it("snoozes on a threaded reply and brings the reminder back later", async () => {
    const { clock, llm, messageId } = await deliver();
    expect(runtime.handleEvent(textEvent("1h", { replyTo: { messageId } }))).toBe("reminder_snoozed");
    expect(sends(await drain(runtime))).toEqual(["Snoozed until Fri 9 Oct, 13:00."]);
    expect(pendingReminders(runtime.db, OWNER)).toMatchObject([{ text: "Stretch", dueAt: clock.now + 60 * MIN, repeat: "none" }]);
    expect(run().snoozed_at).toBe(clock.now);

    clock.now += 61 * MIN;
    expect(runtime.scheduler.tick()).toBe(1); // the snoozed reminder itself, not a nudge
    expect(sends(await drain(runtime))).toEqual(["⏰ Stretch"]);
    expect(llm.calls).toHaveLength(0);
  });

  it("snoozes on a plain reply when the reminder was the last thing said", async () => {
    await deliver();
    expect(runtime.handleEvent(textEvent("snooze 30 min"))).toBe("reminder_snoozed");
    expect(sends(await drain(runtime))).toEqual(["Snoozed until Fri 9 Oct, 12:30."]);
  });

  it("marks done on a reply of 'done' and acknowledges with a tapback", async () => {
    await deliver();
    const reply = textEvent("Done!");
    expect(runtime.handleEvent(reply)).toBe("reminder_done");
    const actions = await drain(runtime);
    expect(actions.find((a) => a.type === "react")).toMatchObject({ messageId: reply.eventId, emoji: "👍" });
    expect(run().done_at).not.toBeNull();
  });

  it("sends any other reply to the model as usual", async () => {
    const { llm } = await deliver();
    expect(runtime.handleEvent(textEvent("why are you reminding me of this?"))).toBe("queued");
    expect(sends(await drain(runtime))).toEqual(["model reply"]);
    expect(llm.calls).toHaveLength(1);
    // Having talked since, the person has plainly seen it: no nudge.
    await runtime.lanes.idle();
    expect(run().done_at).toBeNull();
  });

  it("does not treat a later 'done' as being about an old reminder", async () => {
    const { clock, llm } = await deliver();
    clock.now += 13 * 60 * MIN;
    runtime.scheduler.tick(); // nudges once; drain it
    await drain(runtime);
    clock.now += 13 * 60 * MIN;
    expect(runtime.handleEvent(textEvent("done"))).toBe("queued");
    await drain(runtime);
    expect(llm.calls).toHaveLength(1);
  });
});

describe("nudges", () => {
  it("nudges once after half an hour of silence, and a thumbs-up on the nudge still counts", async () => {
    const { clock, messageId } = await deliver();
    clock.now += 29 * MIN;
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now += 2 * MIN;
    expect(runtime.scheduler.tick()).toBe(1);
    expect(sends(await drain(runtime))).toEqual(["Still on your list: Stretch"]);
    clock.now += 60 * MIN;
    expect(runtime.scheduler.tick()).toBe(0); // never a second nudge

    const { nudge_message_id: nudgeId } = runtime.db.prepare("SELECT nudge_message_id FROM reminder_runs").get() as { nudge_message_id: string };
    expect(nudgeId).not.toBe(messageId);
    expect(runtime.handleEvent(thumbsUp(nudgeId))).toBe("reminder_done");
  });

  it("does not nudge someone who has written since the reminder", async () => {
    const { clock } = await deliver();
    clock.now += MIN;
    runtime.handleEvent(textEvent("/ping"));
    await drain(runtime);
    clock.now += 31 * MIN;
    expect(runtime.scheduler.tick()).toBe(0);
    expect(run().nudged_at).not.toBeNull(); // settled, so it is not reconsidered
  });

  it("does not nudge during quiet hours", async () => {
    const { clock } = await deliver({ start: Date.UTC(2026, 9, 9, 21, 45) });
    clock.now += 31 * MIN; // 22:16 local
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now += 12 * 60 * MIN;
    expect(runtime.scheduler.tick()).toBe(0); // and not the next morning either
  });
});

describe("parseSnooze", () => {
  it("reads the ways people say 'later'", () => {
    expect(parseSnooze("1h")).toBe(60 * MIN);
    expect(parseSnooze("Snooze 30 min")).toBe(30 * MIN);
    expect(parseSnooze("in 2 hours")).toBe(120 * MIN);
    expect(parseSnooze("remind me again in 45 minutes.")).toBe(45 * MIN);
    expect(parseSnooze("1.5h")).toBe(90 * MIN);
    expect(parseSnooze("snooze")).toBe(60 * MIN);
    expect(parseSnooze("tomorrow")).toBe(24 * 60 * MIN);
  });

  it("leaves everything else for the model", () => {
    for (const text of ["5", "1h ago I already did", "what does 1h mean", "30 days", "0m", "ok"]) expect(parseSnooze(text), text).toBeNull();
  });
});
