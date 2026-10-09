// Turns one Spectrum message into the event the agent server understands.
// Kept free of Spectrum runtime imports so it can be tested with plain objects.
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { InboundEvent, Part } from "../../protocol/index.ts";

/** The parts of a Spectrum message this file reads. */
export type MessageLike = {
  id: string;
  platform: string;
  content: { type: string } & Record<string, any>;
  sender?: ({ id: string } & Record<string, any>) | undefined;
  timestamp?: Date;
};
export type SpaceLike = { id: string } & Record<string, any>;

export type Flags = NonNullable<InboundEvent["flags"]>;

export type NormalizeOptions = {
  /** Stores downloaded bytes and returns the path the server can read them from. */
  saveMedia: (bytes: Buffer, info: { eventId: string; index: number; name?: string; mimeType: string }) => Promise<string>;
  /** Provider-specific flags (auto-reply, spam, effect). */
  flags?: (message: MessageLike) => Flags;
  maxMediaBytes?: number;
};

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/gif": ".gif",
  "audio/x-caf": ".caf",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "application/pdf": ".pdf",
  "text/vcard": ".vcf",
};

/** Writes media under `dir`, named after the event so files are easy to trace and clean up. */
export function diskMediaStore(dir: string): NormalizeOptions["saveMedia"] {
  return async (bytes, info) => {
    await mkdir(dir, { recursive: true });
    const ext = (info.name && extname(info.name)) || EXTENSIONS[info.mimeType] || "";
    const path = join(dir, `${info.eventId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${info.index}${ext}`);
    await writeFile(path, bytes);
    return path;
  };
}

const roleFor = (mimeType: string): Extract<Part, { type: "media" }>["role"] => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.includes("vcard")) return "contact";
  return "file";
};

const previewOf = (content: MessageLike["content"] | undefined): string | undefined => {
  if (!content) return undefined;
  if (content.type === "text" && typeof content.text === "string") return content.text.slice(0, 200);
  if (content.type === "markdown" && typeof content.markdown === "string") return content.markdown.slice(0, 200);
  return undefined;
};

export async function normalize(
  message: MessageLike,
  space: SpaceLike,
  opts: NormalizeOptions,
): Promise<InboundEvent> {
  const parts: Part[] = [];
  const event: InboundEvent = {
    v: 1,
    eventId: message.id,
    receivedAt: (message.timestamp ?? new Date()).toISOString(),
    platform: message.platform,
    chat: {
      id: space.id,
      type: space.type === "group" ? "group" : "dm",
      line: typeof space.phone === "string" ? space.phone : "unknown",
    },
    sender: message.sender ? { id: message.sender.id, service: message.sender.service } : null,
    kind: "message",
    parts,
  };
  const flags: Flags = { ...opts.flags?.(message) };
  const maxBytes = opts.maxMediaBytes ?? 25 * 1024 * 1024;

  const addMedia = async (content: MessageLike["content"]) => {
    const mimeType = String(content.mimeType ?? "application/octet-stream");
    if (typeof content.size === "number" && content.size > maxBytes) {
      parts.push({ type: "text", text: `[attachment too large to open: ${content.name ?? mimeType}]` });
      return;
    }
    const bytes: Buffer = await content.read();
    const path = await opts.saveMedia(bytes, { eventId: message.id, index: parts.length, name: content.name, mimeType });
    parts.push({
      type: "media",
      role: content.type === "voice" ? "audio" : roleFor(mimeType),
      path,
      mimeType,
      size: bytes.length,
      name: content.name,
      attachmentId: content.id,
    });
  };

  // Adds what one piece of content contributes. Returns false for content that is not a message.
  const add = async (content: MessageLike["content"]): Promise<boolean> => {
    switch (content.type) {
      case "text":
        parts.push({ type: "text", text: String(content.text ?? "") });
        return true;
      case "markdown":
        parts.push({ type: "text", text: String(content.markdown ?? "") });
        return true;
      case "richlink":
        parts.push({ type: "text", text: String(content.url ?? "") });
        return true;
      case "attachment":
      case "voice":
        await addMedia(content);
        return true;
      case "contact": {
        const name = content.name?.formatted ?? [content.name?.first, content.name?.last].filter(Boolean).join(" ");
        const phones = (content.phones ?? []).map((phone: { value: string }) => phone.value).join(", ");
        parts.push({ type: "text", text: `[contact card: ${[name, phones].filter(Boolean).join(" — ") || "unnamed"}]` });
        return true;
      }
      case "effect":
        flags.effect = String(content.effect ?? "");
        return add(content.content);
      case "group":
        // A multi-part message, such as a photo with a caption: one turn, several parts.
        for (const item of content.items ?? []) await add(item.content);
        return true;
      case "reply":
        event.replyTo = { messageId: String(content.target?.id ?? ""), preview: previewOf(content.target?.content) };
        return add(content.content);
      default:
        return false;
    }
  };

  switch (message.content.type) {
    // Signals: recorded by the server, never answered.
    case "reaction":
      event.kind = "reaction";
      event.reaction = { emoji: String(message.content.emoji), targetMessageId: String(message.content.target?.id ?? "") };
      break;
    case "read":
      event.kind = "read";
      break;
    case "poll_option":
      event.kind = "poll_vote";
      event.pollVote = {
        pollTitle: String(message.content.poll?.title ?? ""),
        option: String(message.content.option?.title ?? message.content.title ?? ""),
        selected: Boolean(message.content.selected),
      };
      break;
    default:
      if (!(await add(message.content))) event.kind = "other";
  }

  if (Object.values(flags).some((value) => value !== undefined && value !== "")) event.flags = flags;
  return event;
}

/** A log line that shows the shape of an event without any of its text. */
export function shapeOf(event: InboundEvent, contentType: string): string {
  const media = event.parts.flatMap((part) => (part.type === "media" ? [`${part.role}:${part.mimeType}:${part.size ?? "?"}b`] : []));
  const textParts = event.parts.filter((part) => part.type === "text").length;
  return [
    `kind=${event.kind}`,
    `content=${contentType}`,
    `chat=${event.chat.type}`,
    `line=${event.chat.line === "shared" ? "shared" : "dedicated"}`,
    `text_parts=${textParts}`,
    media.length ? `media=${media.join(",")}` : "",
    event.replyTo ? "reply" : "",
    event.flags ? `flags=${Object.keys(event.flags).join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
