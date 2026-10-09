import { describe, expect, it } from "vitest";
import { sign, signedHeaders, SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "../../protocol/index.ts";
import { ackFor, commandName } from "../src/agent/commands.ts";
import { buildMessages } from "../src/agent/context.ts";
import { parseReply, toTapback } from "../src/agent/reply.ts";
import { parseRetryAfter } from "../src/llm/openai.ts";
import type { MessageRow } from "../src/store.ts";

describe("signing", () => {
  it("accepts its own signature and rejects tampering, the wrong secret and stale timestamps", () => {
    const headers = signedHeaders("s3cret", '{"a":1}', 1_000_000);
    const ts = headers[TIMESTAMP_HEADER];
    const sig = headers[SIGNATURE_HEADER];
    expect(verify("s3cret", ts, '{"a":1}', sig, 1_000_000)).toBe(true);
    expect(verify("s3cret", ts, '{"a":2}', sig, 1_000_000)).toBe(false);
    expect(verify("other", ts, '{"a":1}', sig, 1_000_000)).toBe(false);
    expect(verify("s3cret", ts, '{"a":1}', sig, 1_000_000 + 6 * 60_000)).toBe(false);
    expect(verify("s3cret", undefined, '{"a":1}', sig, 1_000_000)).toBe(false);
    expect(sign("s3cret", "1", "x")).toMatch(/^v0=[0-9a-f]{64}$/);
  });
});

describe("parseReply", () => {
  it("splits on blank lines and folds extra bubbles into the last", () => {
    expect(parseReply("One.\n\nTwo.\n\n\nThree.\n\nFour.").bubbles).toEqual(["One.", "Two.", "Three.\n\nFour."]);
  });

  it("extracts a tapback, normalising the heart to the exact native glyph", () => {
    expect(parseReply("[[react:\u2764]]\nLove that.")).toEqual({ react: "\u2764\uFE0F", bubbles: ["Love that."] });
    expect(toTapback("‼")).toBe("\u203C\uFE0F");
    expect(toTapback("🎉")).toBeUndefined();
  });

  it("drops unknown tags, reasoning blocks and bold markers", () => {
    expect(parseReply("<think>hmm</think>[[effect:confetti]]**Done** — all set.").bubbles).toEqual(["Done — all set."]);
  });

  it("only stays silent when a reaction carries the reply", () => {
    expect(parseReply("[[silent]]\nStill here.").bubbles).toEqual(["Still here."]);
    expect(parseReply("[[react:👍]][[silent]]\nignored")).toEqual({ react: "👍", bubbles: [] });
  });
});

describe("buildMessages", () => {
  const row = (role: "user" | "assistant", text: string): MessageRow => ({
    id: 0,
    chatId: "c",
    role,
    senderId: null,
    text,
    parts: [],
    platformId: null,
    state: "",
    createdAt: 0,
  });

  it("merges bursts, keeps the newest messages within budget and puts the time line last", () => {
    const history = [
      row("user", "x".repeat(4000)),
      row("assistant", "old answer"),
      row("user", "hey"),
      row("user", "one more thing"),
    ];
    const messages = buildMessages({ system: "SYS", contextLine: "NOW", history, budgetTokens: 200 });
    expect(messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "system", content: "NOW" },
      { role: "user", content: "hey\none more thing" },
    ]);
  });

  it("always sends the newest message, cutting its middle when it alone is over budget", () => {
    const long = `START ${"y".repeat(9000)} END`;
    const messages = buildMessages({ system: "SYS", contextLine: "NOW", history: [row("user", long)], budgetTokens: 400 });
    const content = String(messages.at(-1)!.content);
    expect(content.length).toBeLessThan(400 * 3.2);
    expect(content.startsWith("START")).toBe(true);
    expect(content.endsWith("END")).toBe(true);
    expect(content).toContain("trimmed");
  });
});

describe("small parsers", () => {
  it("reads retry-after from the header or from Groq's message", () => {
    expect(parseRetryAfter("12", "")).toBe(12_000);
    expect(parseRetryAfter(null, "Please try again in 5.289s.")).toBe(5289);
    expect(parseRetryAfter(null, "Please try again in 1m5.2s.")).toBe(65_200);
    expect(parseRetryAfter(null, "Please try again in 350ms.")).toBe(350);
    expect(parseRetryAfter(null, "no hint here")).toBeUndefined();
  });

  it("recognises commands but not paths or prose", () => {
    expect(commandName("/Usage now")).toBe("/usage");
    expect(commandName("/Users/me/file.txt")).toBeNull();
    expect(commandName("use /help please")).toBeNull();
  });

  it("acknowledges plain thanks, not thanks with a request attached", () => {
    expect(ackFor("Thanks!", undefined)).toBe("\u2764\uFE0F");
    expect(ackFor("ok", "Shall I go ahead?")).toBeNull();
    expect(ackFor("thanks, and what about tomorrow", undefined)).toBeNull();
  });
});
