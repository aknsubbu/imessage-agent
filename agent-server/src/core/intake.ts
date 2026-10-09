// Decides what to do with one inbound event. Everything up to "queued" happens
// without the model, and most events never reach it at all.
import type { InboundEvent, Part } from "../../../protocol/index.ts";
import { ackFor, type CommandDeps, commandName, runCommand } from "../agent/commands.ts";
import type { DB } from "../db.ts";
import { discard } from "../media.ts";
import {
  addUserMessage,
  allow,
  lastAssistantMessage,
  ownerCount,
  pendingMessages,
  recordEvent,
  roleOf,
  setEventOutcome,
} from "../store.ts";
import type { Lanes } from "./lanes.ts";

export type Outcome =
  | "duplicate"
  | "signal" // reaction, read receipt, poll vote: recorded, never a turn
  | "auto_reply"
  | "no_sender"
  | "group_ignored"
  | "not_allowed"
  | "empty"
  | "command"
  | "ack"
  | "queued";

export type IntakeDeps = {
  db: DB;
  lanes: Lanes;
  commands: CommandDeps;
  /** True when no owner was configured: the first person to text becomes the owner. */
  claimable: boolean;
  mediaDir: string;
  now: () => number;
  log: (message: string) => void;
};

const MEDIA_LABEL: Record<string, string> = {
  image: "[photo]",
  audio: "[voice memo]",
  contact: "[contact card]",
};

/** The text the model sees for a message. Media is described, not attached, until it is supported. */
export function describe(ev: InboundEvent): string {
  const lines = ev.parts.map((part: Part) => {
    if (part.type === "text") return part.text.trim();
    return MEDIA_LABEL[part.role] ?? `[file: ${part.name ?? part.mimeType}]`;
  });
  const body = lines.filter(Boolean).join("\n");
  if (!body) return "";
  return ev.replyTo?.preview ? `(replying to "${ev.replyTo.preview.slice(0, 120)}")\n${body}` : body;
}

export function createIntake(deps: IntakeDeps): (ev: InboundEvent) => Outcome {
  const { db, lanes, now, log } = deps;

  const decide = (ev: InboundEvent): Outcome => {
    if (ev.kind !== "message") return "signal";
    // Focus and Driving auto-replies, and spam-flagged messages, never get an answer.
    if (ev.flags?.autoReply || ev.flags?.spam) return "auto_reply";
    if (!ev.sender) return "no_sender";
    if (ev.chat.type === "group") return "group_ignored";

    let role = roleOf(db, ev.sender.id);
    if (!role && deps.claimable && ownerCount(db) === 0) {
      allow(db, ev.sender.id, "owner", now());
      role = "owner";
      log(`no owner was configured: ${ev.sender.id} is now the owner`);
    }
    if (!role) {
      log(`ignored a message from ${ev.sender.id}: not on the allowlist`);
      return "not_allowed";
    }

    const text = describe(ev);
    if (!text) return "empty";
    const message = { chatId: ev.chat.id, senderId: ev.sender.id, text, platformId: ev.eventId };
    const media = ev.parts.filter((part) => part.type === "media");

    if (commandName(text)) {
      // Stored before the command runs, so /reset also clears its own message.
      addUserMessage(db, { ...message, state: "handled" }, now());
      void lanes.say(ev.chat.id, runCommand(deps.commands, { chatId: ev.chat.id, senderId: ev.sender.id, role }, text) ?? []);
      return "command";
    }

    // A lone "thanks" or "ok" gets a tapback. Inside a burst it is part of the turn instead.
    const quiet = !lanes.isBusy(ev.chat.id) && pendingMessages(db, ev.chat.id).length === 0;
    const emoji = quiet && media.length === 0 ? ackFor(text, lastAssistantMessage(db, ev.chat.id)?.text) : null;
    if (emoji) {
      addUserMessage(db, { ...message, state: "handled" }, now());
      lanes.fire(ev.chat.id, null, { type: "read", messageId: ev.eventId });
      lanes.fire(ev.chat.id, null, { type: "react", messageId: ev.eventId, emoji });
      return "ack";
    }

    addUserMessage(db, { ...message, parts: media, state: "pending" }, now());
    lanes.notify(ev.chat.id);
    return "queued";
  };

  return (ev) => {
    if (!recordEvent(db, ev, now())) return "duplicate";
    const outcome = decide(ev);
    setEventOutcome(db, ev.eventId, outcome);
    // The bridge downloads attachments before anyone decides whether to answer.
    // Whatever is not going to a turn is deleted straight away.
    if (outcome !== "queued") {
      void discard(
        deps.mediaDir,
        ev.parts.flatMap((part) => (part.type === "media" ? [part.path] : [])),
      );
    }
    return outcome;
  };
}
