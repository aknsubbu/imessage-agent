// The bridge's normaliser, tested here because this package already has a test runner.
import { describe, expect, it } from "vitest";
import { type MessageLike, normalize, shapeOf } from "../../imessage-chatbot/src/normalize.ts";
import { inboundEventSchema } from "../../protocol/index.ts";
import { describe as describeForModel } from "../src/core/intake.ts";

const space = { id: "any;-;+15550001111", type: "dm", phone: "shared" };
const saved: { name?: string; mimeType: string; bytes: number }[] = [];
const opts = {
  saveMedia: async (bytes: Buffer, info: { eventId: string; index: number; name?: string; mimeType: string }) => {
    saved.push({ name: info.name, mimeType: info.mimeType, bytes: bytes.length });
    return `/media/${info.eventId}-${info.index}`;
  },
};
const msg = (content: MessageLike["content"], extra: Record<string, unknown> = {}): MessageLike => ({
  id: "spc-msg-1",
  platform: "imessage",
  content,
  sender: { id: "+15550001111", service: "iMessage" },
  timestamp: new Date("2026-10-08T12:00:00Z"),
  ...extra,
});
const file = (type: string, mimeType: string, name?: string) => ({
  type,
  id: "att-1",
  name,
  mimeType,
  size: 3,
  read: async () => Buffer.from("abc"),
});
const run = async (message: MessageLike, flags?: () => Record<string, unknown>) =>
  inboundEventSchema.parse(await normalize(message, space, { ...opts, flags }));

describe("normalize", () => {
  it("passes text through with chat and sender details", async () => {
    const ev = await run(msg({ type: "text", text: "hello" }));
    expect(ev).toMatchObject({
      eventId: "spc-msg-1",
      kind: "message",
      chat: { id: space.id, type: "dm", line: "shared" },
      sender: { id: "+15550001111", service: "iMessage" },
      parts: [{ type: "text", text: "hello" }],
    });
  });

  it("unwraps a threaded reply and keeps what it replies to", async () => {
    const ev = await run(
      msg({ type: "reply", content: { type: "text", text: "that one" }, target: { id: "spc-msg-0", content: { type: "text", text: "Pizza or sushi?" } } }),
    );
    expect(ev.kind).toBe("message");
    expect(ev.replyTo).toEqual({ messageId: "spc-msg-0", preview: "Pizza or sushi?" });
    expect(describeForModel(ev)).toBe('(replying to "Pizza or sushi?")\nthat one');
  });

  it("treats a photo with a caption as one message with two parts", async () => {
    const ev = await run(
      msg({
        type: "group",
        items: [{ id: "p:0/x", content: file("attachment", "image/heic", "IMG_1.heic") }, { id: "p:1/x", content: { type: "text", text: "what is this?" } }],
      }),
    );
    expect(ev.parts).toEqual([
      { type: "media", role: "image", path: "/media/spc-msg-1-0", mimeType: "image/heic", size: 3, name: "IMG_1.heic", attachmentId: "att-1" },
      { type: "text", text: "what is this?" },
    ]);
    expect(describeForModel(ev)).toBe("[photo]\nwhat is this?");
  });

  it("downloads a voice memo as audio", async () => {
    const ev = await run(msg(file("voice", "audio/x-caf")));
    expect(ev.parts[0]).toMatchObject({ type: "media", role: "audio", mimeType: "audio/x-caf" });
    expect(shapeOf(ev, "voice")).toBe("kind=message content=voice chat=dm line=shared text_parts=0 media=audio:audio/x-caf:3b");
  });

  it("does not download an attachment over the size limit", async () => {
    const before = saved.length;
    const ev = inboundEventSchema.parse(
      await normalize(msg({ ...file("attachment", "video/mp4", "clip.mp4"), size: 99 }), space, { ...opts, maxMediaBytes: 10 }),
    );
    expect(saved.length).toBe(before);
    expect(ev.parts).toEqual([{ type: "text", text: "[attachment too large to open: clip.mp4]" }]);
  });

  it("marks reactions, read receipts and poll votes as signals, not messages", async () => {
    const reaction = await run(msg({ type: "reaction", emoji: "👍", target: { id: "spc-msg-0" } }));
    expect(reaction).toMatchObject({ kind: "reaction", parts: [], reaction: { emoji: "👍", targetMessageId: "spc-msg-0" } });
    expect((await run(msg({ type: "read", target: { id: "spc-msg-0" } }))).kind).toBe("read");
    const vote = await run(
      msg({ type: "poll_option", title: "Sushi", option: { title: "Sushi" }, poll: { type: "poll", title: "Lunch?", options: [] }, selected: true }),
    );
    expect(vote).toMatchObject({ kind: "poll_vote", pollVote: { pollTitle: "Lunch?", option: "Sushi", selected: true } });
  });

  it("keeps the inner content of an effect and notes the effect", async () => {
    const ev = await run(msg({ type: "effect", effect: "com.apple.messages.effect.CKConfettiEffect", content: { type: "text", text: "I got the job" } }));
    expect(ev.parts).toEqual([{ type: "text", text: "I got the job" }]);
    expect(ev.flags).toEqual({ effect: "com.apple.messages.effect.CKConfettiEffect" });
  });

  it("carries auto-reply and spam flags, and omits flags when there are none", async () => {
    const flagged = await run(msg({ type: "text", text: "I'm driving" }), () => ({ autoReply: true, spam: undefined }));
    expect(flagged.flags).toEqual({ autoReply: true });
    expect((await run(msg({ type: "text", text: "hi" }), () => ({}))).flags).toBeUndefined();
  });

  it("reports content it does not understand as 'other' with no sender crash", async () => {
    const ev = await run(msg({ type: "custom", raw: {} }, { sender: undefined }));
    expect(ev).toMatchObject({ kind: "other", sender: null, parts: [] });
  });

  it("describes a contact card in words", async () => {
    const ev = await run(msg({ type: "contact", name: { first: "Ada", last: "Lovelace" }, phones: [{ value: "+15551234567" }] }));
    expect(ev.parts).toEqual([{ type: "text", text: "[contact card: Ada Lovelace — +15551234567]" }]);
  });
});
