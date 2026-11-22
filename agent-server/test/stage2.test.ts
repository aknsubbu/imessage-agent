import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundEvent } from "../../protocol/index.ts";
import { memoryBlock } from "../src/agent/prompt.ts";
import { calculate } from "../src/agent/tools.ts";
import { FakeLLM, lastUserText } from "../src/llm/fake.ts";
import { RequestTooLargeError } from "../src/llm/types.ts";
import { addUserMessage, history, listFacts, listNotes, pendingReminders, recordEvent } from "../src/store.ts";
import { formatLocal, nextOccurrence, parseLocal } from "../src/time.ts";
import { CHAT, drain, makeRuntime, OWNER, sends, textEvent } from "./helpers.ts";

let runtime: ReturnType<typeof makeRuntime>;
afterEach(() => runtime?.stop());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mediaDir = mkdtempSync(join(tmpdir(), "agent-media-"));
const mediaFile = (name: string) => {
  const path = join(mediaDir, name);
  writeFileSync(path, "bytes");
  return path;
};
const mediaEvent = (role: "image" | "audio", path: string, caption?: string, patch: Partial<InboundEvent> = {}) =>
  textEvent("", {
    parts: [
      { type: "media", role, path, mimeType: role === "image" ? "image/heic" : "audio/x-caf" },
      ...(caption ? [{ type: "text" as const, text: caption }] : []),
    ],
    ...patch,
  });

describe("tools", () => {
  it("carries out a tool call, feeds the result back, and uses what it saved on the next turn", async () => {
    const llm = new FakeLLM((req, call) =>
      call === 1 ? { toolCalls: [{ name: "remember", arguments: { facts: ["Sister is called Meera", "Vegetarian"] } }] } : "Noted.",
    );
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("my sister is Meera"));
    expect(sends(await drain(runtime))).toEqual(["Noted."]);
    expect(listFacts(runtime.db, OWNER).map((f) => f.text)).toEqual(["Sister is called Meera", "Vegetarian"]);
    // The second request carried the tool call and its result.
    expect(llm.calls[1]!.messages.slice(-2)).toMatchObject([
      { role: "assistant", toolCalls: [{ name: "remember" }] },
      { role: "tool", content: "saved 2" },
    ]);

    await runtime.lanes.idle();
    runtime.handleEvent(textEvent("who is my sister?"));
    await drain(runtime);
    expect(JSON.stringify(llm.calls.at(-1)!.messages[2])).toContain("What you know about this person:\\n- Sister is called Meera\\n- Vegetarian");
  });

  it("withholds tools on the last step so a looping model still has to answer", async () => {
    const llm = new FakeLLM((req) => (req.tools ? { toolCalls: [{ name: "show_list", arguments: {} }] } : "Here you go."));
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("what lists do I have"));
    expect(sends(await drain(runtime))).toEqual(["Here you go."]);
    expect(llm.calls.map((call) => Boolean(call.tools))).toEqual([true, true, true, false]);
  });

  it("reports a bad tool call back to the model instead of failing the turn", async () => {
    const llm = new FakeLLM((_req, call) =>
      call === 1 ? { toolCalls: [{ name: "set_reminder", arguments: { text: "call the bank", at: "tomorrow at five" } }] } : "What time exactly?",
    );
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("remind me to call the bank"));
    expect(sends(await drain(runtime))).toEqual(["What time exactly?"]);
    expect(String(llm.calls[1]!.messages.at(-1)!.content)).toMatch(/^error: `at` must look like/);
    expect(pendingReminders(runtime.db, OWNER)).toEqual([]);
  });

  it("does not start a turn over once it has saved something", async () => {
    // Step 1 adds to a list at once; step 2 is slow, and the person texts again during it.
    let calls = 0;
    const fake = new FakeLLM((req) => `got: ${lastUserText(req.messages)}`);
    const llm = {
      complete: async (req: Parameters<FakeLLM["complete"]>[0]) => {
        calls++;
        if (calls === 1) return new FakeLLM(() => ({ toolCalls: [{ name: "add_to_list", arguments: { list: "shopping", items: ["milk"] } }] })).complete(req);
        if (calls === 2) await sleep(120);
        return fake.complete(req);
      },
    };
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("add milk to shopping"));
    await sleep(60); // the list is written; the model is on its second step
    runtime.handleEvent(textEvent("and what's the weather"));
    const texts = sends(await drain(runtime, { quietMs: 500 }));
    expect(listNotes(runtime.db, OWNER, "shopping")).toEqual(["milk"]); // once, not twice
    expect(texts).toEqual(["got: add milk to shopping", "got: and what's the weather"]);
  });

  it("evaluates arithmetic without eval", () => {
    expect(calculate("(2340 * 18) / 100")).toBeCloseTo(421.2);
    expect(calculate("2^10 - 24 % 5")).toBe(1020);
    expect(calculate("-3 + 1,000.5")).toBe(997.5);
    expect(() => calculate("1/0")).toThrow(/division by zero/);
    expect(() => calculate("process.exit()")).toThrow();
  });
});

describe("reminders", () => {
  it("sets a reminder in the person's time zone and sends it when due, once", async () => {
    let clock = Date.UTC(2026, 9, 9, 14, 0); // 10:00 in New York
    const llm = new FakeLLM((_req, call) =>
      call === 1
        ? { toolCalls: [{ name: "set_reminder", arguments: { text: "Call the bank", at: "2026-10-09T17:00" } }] }
        : "Done, 5pm today.",
    );
    runtime = makeRuntime(llm, { timezone: "America/New_York" }, { now: () => clock });
    runtime.handleEvent(textEvent("remind me at 5 to call the bank"));
    await drain(runtime);
    const [reminder] = pendingReminders(runtime.db, OWNER);
    expect(reminder).toMatchObject({ text: "Call the bank", dueAt: Date.UTC(2026, 9, 9, 21, 0), repeat: "none" });
    expect(String(llm.calls[1]!.messages.at(-1)!.content)).toBe(`reminder ${reminder!.id} set for Fri 9 Oct, 17:00`);

    expect(runtime.scheduler.tick()).toBe(0); // not yet
    clock = Date.UTC(2026, 9, 9, 21, 0, 5);
    expect(runtime.scheduler.tick()).toBe(1);
    expect(sends(await drain(runtime))).toEqual(["⏰ Call the bank"]);
    expect(runtime.scheduler.tick()).toBe(0); // never twice
    expect(pendingReminders(runtime.db, OWNER)).toEqual([]);
  });

  it("refuses a time in the past", async () => {
    const clock = Date.UTC(2026, 9, 9, 14, 0);
    const llm = new FakeLLM((_req, call) =>
      call === 1 ? { toolCalls: [{ name: "set_reminder", arguments: { text: "x", at: "2026-10-08T09:00" } }] } : "Which day did you mean?",
    );
    runtime = makeRuntime(llm, { timezone: "UTC" }, { now: () => clock });
    runtime.handleEvent(textEvent("remind me yesterday"));
    await drain(runtime);
    expect(String(llm.calls[1]!.messages.at(-1)!.content)).toMatch(/is in the past/);
  });

  it("moves a repeating reminder to its next weekday at the same local time, across a clock change", () => {
    const tz = "America/New_York";
    const friday = parseLocal("2026-10-30T08:00", tz)!;
    expect(formatLocal(friday, tz)).toBe("Fri 30 Oct, 08:00");
    // Clocks go back on 1 November 2026; Monday 08:00 local is a different UTC offset.
    const monday = nextOccurrence(friday, "weekdays", tz, friday + 1000)!;
    expect(formatLocal(monday, tz)).toBe("Mon 2 Nov, 08:00");
    expect(monday - friday).toBe(3 * 86_400_000 + 3_600_000);
    expect(formatLocal(nextOccurrence(friday, "weekly", tz, friday)!, tz)).toBe("Fri 6 Nov, 08:00");
    expect(nextOccurrence(friday, "none", tz, friday)).toBeNull();
  });
});

describe("voice and photos", () => {
  it("replaces a voice memo with its transcript and deletes the audio", async () => {
    const llm = new FakeLLM((req) => `heard: ${lastUserText(req.messages)}`);
    const audio = mediaFile("memo.caf");
    runtime = makeRuntime(llm, { mediaDir }, {
      transcribe: async (path) => (path.endsWith(".flac") ? "buy oat milk" : "wrong file"),
      convert: { audio: async (path) => `${path}.flac`, image: async () => Buffer.from("") },
    });
    runtime.handleEvent(mediaEvent("audio", audio));
    expect(sends(await drain(runtime))).toEqual(["heard: [voice memo] buy oat milk"]);
    expect(llm.calls[0]!.purpose).toBe("tools");
    expect(history(runtime.db, CHAT, 5)[0]).toMatchObject({ text: "[voice memo] buy oat milk", parts: [] });
    await sleep(20);
    expect(existsSync(audio)).toBe(false);
  });

  it("says so when a voice memo cannot be transcribed", async () => {
    const llm = new FakeLLM((req) => lastUserText(req.messages));
    runtime = makeRuntime(llm, { mediaDir }, {
      transcribe: async () => {
        throw new Error("whisper is down");
      },
      convert: { audio: async (path) => path, image: async () => Buffer.from("") },
    });
    runtime.handleEvent(mediaEvent("audio", mediaFile("memo2.caf")));
    expect(sends(await drain(runtime))).toEqual(["[a voice memo that could not be transcribed]"]);
  });

  it("shows a photo to the vision model with its caption, then deletes it", async () => {
    const llm = new FakeLLM(() => "That's a menu.");
    const photo = mediaFile("IMG_1.heic");
    runtime = makeRuntime(llm, { mediaDir }, {
      convert: { audio: async (path) => path, image: async () => Buffer.from("jpeg-bytes") },
    });
    runtime.handleEvent(mediaEvent("image", photo, "what is this?"));
    expect(sends(await drain(runtime))).toEqual(["That's a menu."]);
    const request = llm.calls[0]!;
    expect(request.purpose).toBe("vision");
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[photo]\nwhat is this?" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}` } },
      ],
    });
    await runtime.lanes.idle();
    await sleep(20);
    expect(existsSync(photo)).toBe(false);
  });

  it("shows at most two photos, and falls back to one when the request is too large", async () => {
    const imagesIn = (req: Parameters<FakeLLM["complete"]>[0]) => {
      const last = req.messages.at(-1)!;
      return Array.isArray(last.content) ? last.content.filter((part) => part.type === "image_url").length : 0;
    };
    const seen: number[] = [];
    const fake = new FakeLLM((req) => lastUserText(req.messages));
    const llm = {
      complete: async (req: Parameters<FakeLLM["complete"]>[0]) => {
        seen.push(imagesIn(req));
        if (imagesIn(req) > 1) throw new RequestTooLargeError("Request too large");
        return fake.complete(req);
      },
    };
    runtime = makeRuntime(llm, { mediaDir }, {
      convert: { audio: async (path) => path, image: async () => Buffer.from("jpeg") },
    });
    const paths = ["a.heic", "b.heic", "c.heic"].map(mediaFile);
    runtime.handleEvent(
      textEvent("", {
        parts: [
          ...paths.map((path) => ({ type: "media" as const, role: "image" as const, path, mimeType: "image/heic" })),
          { type: "text" as const, text: "which is best?" },
        ],
      }),
    );
    const texts = sends(await drain(runtime));
    expect(seen).toEqual([2, 1]);
    expect(texts).toEqual(["[photo]\n[photo]\n[photo]\nwhich is best?\n(2 of the 3 photos could not be shown to you.)"]);
    await runtime.lanes.idle();
    await sleep(20);
    expect(paths.map((path) => existsSync(path))).toEqual([false, false, false]);
  });

  it("deletes media from people it will not answer", async () => {
    const photo = mediaFile("stranger.heic");
    runtime = makeRuntime(new FakeLLM(), { mediaDir });
    expect(runtime.handleEvent(mediaEvent("image", photo, "hi", { sender: { id: "+19990000000" } }))).toBe("not_allowed");
    await sleep(20);
    expect(existsSync(photo)).toBe(false);
  });
});

describe("memory", () => {
  it("folds old messages into a summary and keeps the recent ones verbatim", async () => {
    const llm = new FakeLLM((req) => (req.purpose === "summary" ? "They are planning a trip to Goa in December." : "ok"));
    runtime = makeRuntime(llm);
    recordEvent(runtime.db, textEvent("seed"), 1);
    for (let i = 0; i < 44; i++) {
      addUserMessage(runtime.db, { chatId: CHAT, senderId: OWNER, text: `old message ${i}`, platformId: `p${i}`, state: "handled" }, 10 + i);
    }
    await runtime.summarise(CHAT);
    expect(llm.calls).toHaveLength(1);
    expect(String(llm.calls[0]!.messages[1]!.content)).toContain("old message 27");
    expect(history(runtime.db, CHAT, 100).map((m) => m.text)).toEqual(Array.from({ length: 16 }, (_, i) => `old message ${28 + i}`));

    runtime.handleEvent(textEvent("where were we?"));
    await drain(runtime);
    const prompt = llm.calls.at(-1)!.messages;
    expect(String(prompt[2]!.content)).toBe("Earlier in this conversation:\nThey are planning a trip to Goa in December.");
    expect(JSON.stringify(prompt)).not.toContain("old message 5\"");
  });

  it("leaves the oldest facts out of the prompt once the list outgrows its cap", () => {
    const facts = Array.from({ length: 60 }, (_, i) => ({ id: i, text: `Fact number ${i} ${"x".repeat(60)}` }));
    const block = memoryBlock(facts, "");
    expect(block.length).toBeLessThan(2200);
    expect(block).toContain("Fact number 59");
    expect(block).not.toContain("Fact number 0 ");
  });

  it("lists and forgets saved facts by command, and shows lists and reminders", async () => {
    const llm = new FakeLLM((_req, call) =>
      call === 1
        ? { toolCalls: [{ name: "remember", arguments: { facts: ["Vegetarian"] } }] }
        : call === 2
          ? { toolCalls: [{ name: "add_to_list", arguments: { list: "Shopping", items: ["oat milk", "rice"] } }] }
          : "Saved both.",
    );
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("I'm vegetarian, add oat milk and rice to shopping"));
    await drain(runtime);
    await runtime.lanes.idle();

    runtime.handleEvent(textEvent("/memory"));
    runtime.handleEvent(textEvent("/lists shopping"));
    runtime.handleEvent(textEvent("/forget 1"));
    runtime.handleEvent(textEvent("/memory"));
    runtime.handleEvent(textEvent("/reminders"));
    expect(sends(await drain(runtime))).toEqual([
      "1. Vegetarian",
      "shopping:\n1. oat milk\n2. rice",
      "Forgotten: Vegetarian",
      "I haven't saved anything about you yet.",
      "No reminders set.",
    ]);
  });

  it("finds earlier messages by their words", async () => {
    const llm = new FakeLLM((_req, call) =>
      call === 1 ? "Sounds good." : call === 2 ? { toolCalls: [{ name: "search_history", arguments: { query: "ramen place" } }] } : "Ichiran.",
    );
    runtime = makeRuntime(llm);
    runtime.handleEvent(textEvent("we should try that ramen place Ichiran"));
    await drain(runtime);
    await runtime.lanes.idle();
    runtime.handleEvent(textEvent("what was that noodle spot?"));
    await drain(runtime);
    expect(String(llm.calls.at(-1)!.messages.at(-1)!.content)).toMatch(/they said: we should try that ramen place Ichiran/);
  });
});
