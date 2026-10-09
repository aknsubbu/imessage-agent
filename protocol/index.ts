// The contract between the bridge (imessage-chatbot) and the agent server.
// Both sides import this file directly; it must stay free of Spectrum and
// server dependencies.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const SIGNATURE_HEADER = "x-agent-signature";
export const TIMESTAMP_HEADER = "x-agent-timestamp";

// ---------------------------------------------------------------------------
// Bridge -> server: one inbound event per Spectrum message.
// ---------------------------------------------------------------------------

export const partSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("media"),
    role: z.enum(["image", "audio", "file", "contact"]),
    // Path on the disk both processes share; the bridge downloads the bytes.
    path: z.string(),
    mimeType: z.string(),
    size: z.number().optional(),
    name: z.string().optional(),
    attachmentId: z.string().optional(),
  }),
]);
export type Part = z.infer<typeof partSchema>;

export const inboundEventSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  // Spectrum's message id, treated as opaque. The server dedupes on it.
  eventId: z.string().min(1),
  receivedAt: z.string(),
  platform: z.string(),
  chat: z.object({
    id: z.string().min(1),
    type: z.enum(["dm", "group"]),
    // "shared" on a shared-pool line, otherwise the dedicated number.
    line: z.string(),
  }),
  sender: z.object({ id: z.string().min(1), service: z.string().optional() }).nullable(),
  // Only "message" can start a turn. The rest are signals and never reach the LLM.
  kind: z.enum(["message", "reaction", "read", "poll_vote", "other"]),
  parts: z.array(partSchema),
  replyTo: z.object({ messageId: z.string(), preview: z.string().optional() }).optional(),
  reaction: z.object({ emoji: z.string(), targetMessageId: z.string() }).optional(),
  pollVote: z.object({ pollTitle: z.string(), option: z.string(), selected: z.boolean() }).optional(),
  flags: z
    .object({
      autoReply: z.boolean().optional(),
      spam: z.boolean().optional(),
      effect: z.string().optional(),
    })
    .optional(),
});
export type InboundEvent = z.infer<typeof inboundEventSchema>;

// ---------------------------------------------------------------------------
// Server -> bridge: actions. The server paces and orders them; the bridge
// executes each one as soon as it arrives.
// ---------------------------------------------------------------------------

export const outContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }),
  z.object({ type: z.literal("markdown"), markdown: z.string().min(1) }),
  z.object({
    type: z.literal("attachment"),
    path: z.string(),
    mimeType: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({ type: z.literal("voice"), path: z.string(), mimeType: z.string().optional() }),
  z.object({ type: z.literal("richlink"), url: z.string() }),
  z.object({ type: z.literal("poll"), title: z.string(), options: z.array(z.string()).min(2) }),
]);
export type OutContent = z.infer<typeof outContentSchema>;

const actionBase = { id: z.string().min(1), chatId: z.string().min(1), turnId: z.string().optional() };

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ ...actionBase, type: z.literal("typing"), state: z.enum(["start", "stop"]) }),
  z.object({ ...actionBase, type: z.literal("read"), messageId: z.string() }),
  z.object({
    ...actionBase,
    type: z.literal("send"),
    content: outContentSchema,
    replyTo: z.string().optional(),
    effect: z.string().optional(),
  }),
  z.object({ ...actionBase, type: z.literal("react"), messageId: z.string(), emoji: z.string() }),
  z.object({ ...actionBase, type: z.literal("edit"), messageId: z.string(), text: z.string() }),
  z.object({ ...actionBase, type: z.literal("unsend"), messageId: z.string() }),
]);
export type Action = z.infer<typeof actionSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An action before the server has assigned its id and chat. */
export type ActionBody = DistributiveOmit<Action, "id" | "chatId" | "turnId">;

// The bridge acks "sending" before it calls Spectrum and a terminal status
// after. The server never re-delivers an action that reached "sending", which
// is what keeps a crash from producing a duplicate bubble.
export const ackSchema = z.object({
  actionId: z.string().min(1),
  status: z.enum(["sending", "sent", "skipped", "failed"]),
  messageId: z.string().optional(),
  error: z
    .object({ message: z.string(), code: z.string().optional(), retryable: z.boolean().optional() })
    .optional(),
});
export type Ack = z.infer<typeof ackSchema>;

export const pollRequestSchema = z.object({
  waitMs: z.number().int().min(0).max(30_000).default(25_000),
  // Each bridge only receives actions for chats on its own platform.
  platform: z.string().min(1).default("imessage"),
});

// ---------------------------------------------------------------------------
// Request signing — the same scheme Spectrum uses for its webhooks.
// ---------------------------------------------------------------------------

export function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

export function verify(
  secret: string,
  timestamp: string | undefined,
  body: string,
  signature: string | undefined,
  nowMs: number = Date.now(),
  windowMs: number = 5 * 60_000,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > windowMs) return false;
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function signedHeaders(secret: string, body: string, nowMs: number = Date.now()): Record<string, string> {
  const timestamp = String(nowMs);
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: sign(secret, timestamp, body),
  };
}
