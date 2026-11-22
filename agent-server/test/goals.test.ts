import { afterEach, describe, expect, it } from "vitest";
import { dayStreak } from "../src/core/goals.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { activeGoals, addGoal, allow, ensureCheckins, getCheckins, getGoal, goalLogTimes, logGoal, recordEvent, saveProfile } from "../src/store.ts";
import { CHAT, drain, makeRuntime, OWNER, sends, textEvent } from "./helpers.ts";

let runtime: ReturnType<typeof makeRuntime>;
afterEach(() => runtime?.stop());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FRI = Date.UTC(2026, 9, 9); // Friday 9 October 2026, 00:00 UTC
const at = (day: number, hour: number, minute = 0) => FRI + day * DAY + hour * HOUR + minute * 60_000;
const clock = { now: at(0, 12) };

/** A runtime on a hand-wound UTC clock with the owner's chat on record. */
function start(llm: FakeLLM = new FakeLLM(() => "model reply"), when = at(0, 12)) {
  clock.now = when;
  runtime = makeRuntime(llm, { timezone: "UTC" }, { now: () => clock.now });
  recordEvent(runtime.db, textEvent("seed"), when - 1000);
  return llm;
}
const newGoal = (title = "Meditate", patch: Partial<Parameters<typeof addGoal>[1]> = {}) => {
  const id = addGoal(runtime.db, { senderId: OWNER, chatId: CHAT, title, cadence: "daily", dueAt: null, ...patch }, clock.now - DAY);
  ensureCheckins(runtime.db, OWNER, CHAT);
  return id;
};
const lastCheckin = () =>
  runtime.db.prepare("SELECT id, goal_id, message_id, answered_at FROM goal_checkins ORDER BY id DESC").get() as {
    id: number;
    goal_id: number;
    message_id: string;
    answered_at: number | null;
  };
const thumbsUp = (messageId: string) => textEvent("", { kind: "reaction", parts: [], reaction: { emoji: "👍", targetMessageId: messageId } });

describe("the goal tool", () => {
  it("adds a goal, turns check-ins on, and tells the model when they arrive", async () => {
    const results: string[] = [];
    const llm = new FakeLLM((req, call) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      return call === 1 ? { toolCalls: [{ name: "goal", arguments: { action: "add", title: "Meditate" } }] } : "Added.";
    });
    start(llm);
    runtime.handleEvent(textEvent("I want to meditate every day"));
    expect(sends(await drain(runtime))).toEqual(["Added."]);
    expect(results[0]).toMatch(/^goal 1 added: Meditate \(daily\); check-ins at 19:00$/);
    expect(activeGoals(runtime.db, OWNER)).toHaveLength(1);
    expect(getCheckins(runtime.db, OWNER)).toMatchObject({ enabled: true, time: "19:00" });
  });

  it("treats a goal with a date as a one-off and promises to ask how it went", async () => {
    const results: string[] = [];
    const llm = new FakeLLM((req, call) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      if (call === 1) return { toolCalls: [{ name: "goal", arguments: { action: "add", title: "Interview at Acme", due: "2026-10-15T10:00" } }] };
      if (call === 2) return { toolCalls: [{ name: "goal", arguments: { action: "add", title: "Old news", due: "2026-10-01T10:00" } }] };
      return "ok";
    });
    start(llm);
    runtime.handleEvent(textEvent("interview thursday"));
    await drain(runtime);
    expect(results[0]).toMatch(/\(once\); will ask how it went after Thu 15 Oct, 10:00/);
    expect(results[0]).not.toContain("check-ins at");
    expect(getCheckins(runtime.db, OWNER)).toBeUndefined();
    expect(results[1]).toMatch(/^error: .* is in the past/);
  });

  it("logs, finishes and drops goals by words, and asks which when it cannot tell", async () => {
    const results: string[] = [];
    const tool = (args: Record<string, unknown>) => ({ toolCalls: [{ name: "goal", arguments: args }] });
    // A turn runs at most three tool calls, so the script spans two turns.
    const script = [
      tool({ action: "log", about: "read", note: "20 pages" }),
      tool({ action: "log", about: "m" }), // only Meditate has an m
      tool({ action: "log", about: "e" }), // both titles have an e
      "ok",
      tool({ action: "done", about: "Read" }),
      tool({ action: "drop", about: "nothing like this" }),
      "ok",
    ];
    const llm = new FakeLLM((req, call) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      return script[call - 1] ?? "ok";
    });
    start(llm);
    newGoal("Meditate");
    newGoal("Read");
    runtime.handleEvent(textEvent("update"));
    await drain(runtime);
    expect(results[0]).toBe("logged Read");
    expect(goalLogTimes(runtime.db, 2, 0)).toHaveLength(1);
    expect(results[1]).toBe("logged Meditate");
    expect(results[2]).toMatch(/^error: several goals match \(Meditate, Read\); ask which one/);

    runtime.handleEvent(textEvent("more"));
    await drain(runtime);
    expect(results[3]).toBe("finished: Read");
    expect(getGoal(runtime.db, 2)!.status).toBe("done");
    expect(results[4]).toMatch(/^error: no goal matched; the goals are Meditate/);
  });

  it("does not add a duplicate or a ninth goal", async () => {
    const results: string[] = [];
    const llm = new FakeLLM((req, call) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      if (call === 1) return { toolCalls: [{ name: "goal", arguments: { action: "add", title: "meditate" } }] };
      if (call === 2) return { toolCalls: [{ name: "goal", arguments: { action: "add", title: "Ninth" } }] };
      return "ok";
    });
    start(llm);
    newGoal("Meditate");
    for (let i = 0; i < 7; i++) newGoal(`Goal ${i}`);
    runtime.handleEvent(textEvent("add"));
    await drain(runtime);
    expect(results[0]).toBe('already tracking "meditate"');
    expect(results[1]).toMatch(/^error: eight goals is the limit/);
  });
});

describe("evening check-ins", () => {
  it("send one bubble per goal at the chosen time, once a day, without the model", async () => {
    const llm = start();
    newGoal("Meditate");
    newGoal("Read");
    clock.now = at(0, 18, 59);
    expect(runtime.scheduler.tick()).toBe(0);

    clock.now = at(0, 19, 0);
    expect(runtime.scheduler.tick()).toBe(2);
    expect(sends(await drain(runtime))).toEqual([
      "Evening check-in: Meditate? 👍 if you did, or tell me how it went.",
      "Evening check-in: Read? 👍 if you did, or tell me how it went.",
    ]);
    clock.now = at(0, 19, 30);
    expect(runtime.scheduler.tick()).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("log the goal on a thumbs-up, and count the streak", async () => {
    const llm = start();
    const id = newGoal("Meditate");
    logGoal(runtime.db, id, "", at(-1, 8)); // yesterday
    clock.now = at(0, 19, 0);
    runtime.scheduler.tick();
    await drain(runtime);
    expect(runtime.handleEvent(thumbsUp(lastCheckin().message_id))).toBe("goal_logged");
    expect(sends(await drain(runtime))).toEqual(["✔ Meditate: 2 days in a row"]);
    expect(lastCheckin().answered_at).toBe(clock.now);
    expect(goalLogTimes(runtime.db, id, at(0, 0))).toHaveLength(1);
    // The same tapback again does nothing.
    expect(runtime.handleEvent(thumbsUp(lastCheckin().message_id))).toBe("signal");
    expect(llm.calls).toHaveLength(0);
  });

  it("log the goal on a plain yes, record a no kindly, and pass anything else to the model", async () => {
    const llm = start();
    newGoal("Meditate");
    newGoal("Read");
    clock.now = at(0, 19, 0);
    runtime.scheduler.tick();
    await drain(runtime);

    // The last bubble is the one a bare reply is about.
    expect(runtime.handleEvent(textEvent("yep!"))).toBe("goal_logged");
    expect(sends(await drain(runtime))).toEqual(["✔ Read: logged"]);

    // A swipe-reply to the first bubble answers that goal instead.
    const first = runtime.db.prepare("SELECT message_id FROM goal_checkins ORDER BY id").get() as { message_id: string };
    expect(runtime.handleEvent(textEvent("nope", { replyTo: { messageId: first.message_id } }))).toBe("goal_missed");
    expect(sends(await drain(runtime))).toEqual(["No worries. Meditate is still there tomorrow."]);
    expect(goalLogTimes(runtime.db, 1, 0)).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);

    // Anything longer is a conversation, so the model answers it.
    runtime.handleEvent(textEvent("did ten minutes, felt good"));
    await drain(runtime);
    expect(llm.calls).toHaveLength(1);
  });

  it("ignore a reply to a check-in that came too long ago", async () => {
    start();
    newGoal("Meditate");
    clock.now = at(0, 19, 0);
    runtime.scheduler.tick();
    await drain(runtime);
    clock.now = at(1, 9, 0); // next morning, 14 hours on
    expect(runtime.handleEvent(textEvent("yes"))).toBe("queued");
  });

  it("skip a goal already logged today, and a one-off goal", async () => {
    start();
    const id = newGoal("Meditate");
    newGoal("Interview", { cadence: "once" });
    logGoal(runtime.db, id, "", at(0, 7));
    clock.now = at(0, 19, 0);
    expect(runtime.scheduler.tick()).toBe(0);
  });

  it("are skipped for the day when the server was down through the whole window", async () => {
    start();
    newGoal("Meditate");
    clock.now = at(0, 23, 0); // 4 hours late
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(1, 19, 0);
    expect(runtime.scheduler.tick()).toBe(1);
  });

  it("go out a little late when the server was down only briefly", async () => {
    start();
    newGoal("Meditate");
    clock.now = at(0, 20, 30);
    expect(runtime.scheduler.tick()).toBe(1);
  });

  it("can be switched off, moved, and are never sent to someone who is no longer allowed", async () => {
    start();
    newGoal("Meditate");
    runtime.handleEvent(textEvent("/checkins 8pm"));
    expect(sends(await drain(runtime))).toEqual(["Check-ins are on, at 20:00."]);
    clock.now = at(0, 19, 30);
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(0, 20, 0);
    expect(runtime.scheduler.tick()).toBe(1);
    await drain(runtime);

    runtime.handleEvent(textEvent("/checkins off"));
    expect(sends(await drain(runtime))).toEqual(["Check-ins are off."]);
    clock.now = at(1, 20, 0);
    expect(runtime.scheduler.tick()).toBe(0);

    runtime.handleEvent(textEvent("/checkins on"));
    await drain(runtime);
    runtime.db.prepare("DELETE FROM allowlist WHERE sender_id = ?").run(OWNER);
    expect(runtime.scheduler.tick()).toBe(0);
  });

  it("speak in the chosen voice", async () => {
    start();
    saveProfile(runtime.db, OWNER, { preset: "terse" }, 1);
    newGoal("Meditate");
    clock.now = at(0, 19, 0);
    runtime.scheduler.tick();
    expect(sends(await drain(runtime))).toEqual(["Meditate? 👍 or reply."]);
  });

  it("send at most three bubbles however many goals are open", async () => {
    start();
    for (let i = 1; i <= 5; i++) newGoal(`Goal ${i}`);
    clock.now = at(0, 19, 0);
    expect(runtime.scheduler.tick()).toBe(3);
  });
});

describe("the Sunday review", () => {
  const SUNDAY = 2; // 11 October 2026

  it("summarises the week from the logs, then checks in", async () => {
    start();
    const meditate = addGoal(runtime.db, { senderId: OWNER, chatId: CHAT, title: "Meditate", cadence: "daily", dueAt: null }, at(-6, 9));
    const call = addGoal(runtime.db, { senderId: OWNER, chatId: CHAT, title: "Call Mum", cadence: "weekly", dueAt: null }, at(-6, 9));
    ensureCheckins(runtime.db, OWNER, CHAT);
    for (const day of [-4, -3, -2, 0]) logGoal(runtime.db, meditate, "", at(SUNDAY + day, 8));
    logGoal(runtime.db, call, "", at(SUNDAY - 1, 18));
    clock.now = at(SUNDAY, 19, 0);
    runtime.scheduler.tick();
    const out = sends(await drain(runtime));
    // 5 of 8 possible goal-days is under the line for a "good week".
    expect(out[0]).toBe("Week in review:\n· Meditate: 4/7 days\n· Call Mum: done this week\nA bit of a quiet week. Fresh one starts tomorrow.");
    // Meditate is already logged today and Call Mum was done this week, so there is nothing left to check in on.
    expect(out).toHaveLength(1);
  });

  it("only counts the days a new goal has existed", async () => {
    start();
    const id = addGoal(runtime.db, { senderId: OWNER, chatId: CHAT, title: "Read", cadence: "daily", dueAt: null }, at(SUNDAY - 1, 9));
    ensureCheckins(runtime.db, OWNER, CHAT);
    logGoal(runtime.db, id, "", at(SUNDAY - 1, 20)); // Saturday evening
    logGoal(runtime.db, id, "", at(SUNDAY, 7)); // Sunday morning
    clock.now = at(SUNDAY, 19, 0);
    runtime.scheduler.tick();
    const out = sends(await drain(runtime));
    expect(out[0]).toContain("· Read: 2/2 days");
    expect(out[0]).toContain("Good week.");
  });

  it("is not sent on other days, or twice", async () => {
    start();
    newGoal("Meditate");
    clock.now = at(1, 19, 0); // Saturday
    runtime.scheduler.tick();
    expect(sends(await drain(runtime)).join("\n")).not.toContain("Week in review");

    clock.now = at(SUNDAY, 19, 0);
    runtime.scheduler.tick();
    expect(sends(await drain(runtime)).join("\n")).toContain("Week in review");
    clock.now = at(SUNDAY, 19, 45);
    expect(runtime.scheduler.tick()).toBe(0);
  });
});

describe("follow-ups on an event", () => {
  const interview = () => newGoal("Interview at Acme", { cadence: "once", dueAt: at(1, 10) });

  it("ask how it went a few hours after, once, in the chosen voice", async () => {
    const llm = start();
    saveProfile(runtime.db, OWNER, { preset: "coach" }, 1);
    interview();
    clock.now = at(1, 12, 59);
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(1, 13, 0);
    expect(runtime.scheduler.tick()).toBe(1);
    expect(sends(await drain(runtime))).toEqual(["You showed up for Interview at Acme. How did it go?"]);
    clock.now = at(1, 14, 0);
    expect(runtime.scheduler.tick()).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("wait for the morning when the event ended in the night", async () => {
    start();
    newGoal("Late show", { cadence: "once", dueAt: at(1, 20) });
    clock.now = at(1, 23, 30); // quiet hours
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(2, 8, 0);
    expect(runtime.scheduler.tick()).toBe(1);
  });

  it("do not ask about an event that is long over", async () => {
    start();
    interview();
    clock.now = at(5, 12, 0);
    expect(runtime.scheduler.tick()).toBe(0);
    expect(sends(await drain(runtime, { quietMs: 40 }))).toEqual([]);
  });

  it("retire an event goal a week after it was asked about", async () => {
    start();
    const id = interview();
    clock.now = at(1, 13, 0);
    runtime.scheduler.tick();
    await drain(runtime);
    expect(getGoal(runtime.db, id)!.status).toBe("active");
    clock.now = at(9, 12, 0);
    runtime.scheduler.tick();
    expect(getGoal(runtime.db, id)!.status).toBe("dropped");
  });
});

describe("/goals", () => {
  it("adds, lists, logs, finishes and drops goals", async () => {
    start();
    runtime.handleEvent(textEvent("/goals"));
    expect(sends(await drain(runtime))[0]).toMatch(/^No goals yet/);

    runtime.handleEvent(textEvent("/goals add Meditate"));
    expect(sends(await drain(runtime))).toEqual(["Added: Meditate. I'll check in each evening at 19:00."]);
    runtime.handleEvent(textEvent("/goals add Read 10 pages"));
    await drain(runtime);

    runtime.handleEvent(textEvent("/goals log 1"));
    expect(sends(await drain(runtime))).toEqual(["✔ Meditate: logged"]);
    runtime.handleEvent(textEvent("/goals"));
    expect(sends(await drain(runtime))).toEqual(["1. Meditate (daily, done today)\n2. Read 10 pages (daily)"]);

    runtime.handleEvent(textEvent("/goals done 2"));
    expect(sends(await drain(runtime))).toEqual(["Finished: Read 10 pages"]);
    runtime.handleEvent(textEvent("/goals drop 1"));
    expect(sends(await drain(runtime))).toEqual(["Dropped: Meditate"]);
    runtime.handleEvent(textEvent("/goals log 1"));
    expect(sends(await drain(runtime))[0]).toBe("No goals yet.");
  });

  it("says so when the number is wrong", async () => {
    start();
    newGoal("Meditate");
    runtime.handleEvent(textEvent("/goals log 7"));
    expect(sends(await drain(runtime))).toEqual(["Which one? Send /goals to see the numbers."]);
  });

  it("keeps each person's goals to themselves", async () => {
    start();
    newGoal("Meditate");
    const friend = "+15550003333";
    allow(runtime.db, friend, "user", 1);
    runtime.handleEvent(textEvent("/goals", { chat: { id: `any;-;${friend}`, type: "dm", line: "shared" }, sender: { id: friend } }));
    expect(sends(await drain(runtime))[0]).toMatch(/^No goals yet/);
  });
});

describe("day streaks", () => {
  const log = (...days: number[]) => days.map((d) => at(d, 9));

  it("count consecutive days back from today", () => {
    expect(dayStreak(log(0, -1, -2), "UTC", at(0, 20))).toBe(3);
  });

  it("do not break just because today is not logged yet", () => {
    expect(dayStreak(log(-1, -2), "UTC", at(0, 8))).toBe(2);
  });

  it("break on a missed day", () => {
    expect(dayStreak(log(0, -2, -3), "UTC", at(0, 20))).toBe(1);
    expect(dayStreak(log(-2, -3), "UTC", at(0, 20))).toBe(0);
  });

  it("count a day once however many times it is logged, and read days in the person's zone", () => {
    expect(dayStreak([...log(0), at(0, 10), at(0, 11)], "UTC", at(0, 20))).toBe(1);
    // Midnight in Kolkata is 18:30 UTC, so two logs two minutes apart either side of it are on different days there.
    expect(dayStreak([at(0, 18, 29), at(0, 18, 31)], "Asia/Kolkata", at(1, 6))).toBe(2);
    // In UTC both are the same day, which is yesterday: a streak of one, still alive.
    expect(dayStreak([at(0, 18, 29), at(0, 18, 31)], "UTC", at(1, 6))).toBe(1);
  });

  it("do not skip a day across a clock change", () => {
    // New York leaves summer time on 1 November 2026, a 25-hour day.
    const times = [Date.UTC(2026, 10, 1, 12), Date.UTC(2026, 9, 31, 12), Date.UTC(2026, 9, 30, 12)];
    expect(dayStreak(times, "America/New_York", Date.UTC(2026, 10, 1, 20))).toBe(3);
  });
});
