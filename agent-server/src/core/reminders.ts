// Everything a reminder does after it is set, none of it through the model:
// delivery, a thumbs-up to mark it done, a reply to snooze it, one nudge if it
// goes unacknowledged, and a streak count for the ones that repeat.
import type { InboundEvent } from "../../../protocol/index.ts";
import { linesFor } from "../agent/persona.ts";
import type { DB } from "../db.ts";
import { noSync, type Sync } from "../integrations/sync.ts";
import {
  addReminder,
  getProfile,
  createRun,
  dueReminders,
  lastAssistantMessage,
  markRun,
  type Run,
  runByMessage,
  runsAwaitingNudge,
  setRunMessage,
  settleReminder,
  streak,
  userMessagedSince,
} from "../store.ts";
import { formatLocal, localParts, nextOccurrence, type Repeat } from "../time.ts";
import type { Lanes } from "./lanes.ts";

export const DONE_TAPBACKS = new Set(["👍", "\u2764\uFE0F", "\u2764"]);
const DONE_WORDS = /^(done|did it|did that|finished|completed|all done|✅|☑️|✔️|✔)[\s!.]*$/iu;
// A reply only counts as being about a reminder for this long after it was delivered.
const REPLY_WINDOW_MS = 12 * 60 * 60_000;

const MINUTE = 60_000;
const UNITS: Record<string, number> = {
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: 60 * MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE,
  d: 1440 * MINUTE, day: 1440 * MINUTE, days: 1440 * MINUTE,
};

/** "1h", "snooze 30 min", "in 2 hours", "tomorrow", or just "snooze" (an hour). Milliseconds, or null. */
export function parseSnooze(text: string): number | null {
  const clean = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (clean === "snooze" || clean === "later") return 60 * MINUTE;
  const rest = clean.replace(/^(snooze|remind me( again)?|again)\s*/, "").replace(/^(in|for)\s+/, "");
  if (rest === "tomorrow") return 1440 * MINUTE;
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(rest);
  const unit = match ? UNITS[match[2]!] : undefined;
  if (!match || !unit) return null;
  const ms = Math.round(Number(match[1]) * unit);
  return ms >= MINUTE && ms <= 7 * 1440 * MINUTE ? ms : null;
}

export type ReminderOutcome = "reminder_done" | "reminder_snoozed";

export function createReminders(deps: {
  db: DB;
  lanes: Lanes;
  timezone: string;
  nudgeAfterMinutes: number;
  quietHours: [number, number];
  /** Closes a reminder's copy in Todoist when it is marked done; absent when no integration is on. */
  sync?: Sync;
  now: () => number;
  log: (message: string) => void;
}) {
  const { db, lanes, now } = deps;
  const sync = deps.sync ?? noSync;
  const linesOf = (senderId: string) => linesFor(getProfile(db, senderId));

  const isQuiet = (): boolean => {
    const [from, to] = deps.quietHours;
    const hour = localParts(now(), deps.timezone).hour;
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  };

  function finish(run: Run): void {
    markRun(db, run.id, "done", now());
    // A repeating reminder is a habit: say how the streak stands. A one-off needs no reply.
    if (run.repeat !== "none") {
      void lanes.say(run.chatId, [linesOf(run.senderId).logged(streak(db, run.reminderId))]);
    } else {
      // A repeating reminder's copy stays open; it is the same task every day.
      sync.closed("reminder", run.reminderId);
    }
  }

  /** The delivery a message is about: the one it replies to, or the one that was the last thing said. */
  function runFor(ev: InboundEvent): Run | undefined {
    const target = ev.replyTo?.messageId ?? lastAssistantMessage(db, ev.chat.id)?.platformId;
    const run = target ? runByMessage(db, ev.chat.id, target) : undefined;
    if (!run || run.doneAt !== null || run.snoozedAt !== null) return undefined;
    return now() - run.sentAt <= REPLY_WINDOW_MS ? run : undefined;
  }

  return {
    /** A tapback arrived. A thumbs-up or heart on a reminder marks it done. */
    onReaction(ev: InboundEvent): ReminderOutcome | null {
      if (!ev.reaction || !DONE_TAPBACKS.has(ev.reaction.emoji)) return null;
      const run = runByMessage(db, ev.chat.id, ev.reaction.targetMessageId);
      if (!run || run.doneAt !== null) return null;
      finish(run);
      return "reminder_done";
    },

    /** A text arrived. "done" finishes the reminder it answers; "1h" or "snooze" puts it off. */
    onMessage(ev: InboundEvent, text: string): ReminderOutcome | null {
      const run = runFor(ev);
      if (!run) return null;
      if (DONE_WORDS.test(text.trim())) {
        finish(run);
        lanes.fire(ev.chat.id, null, { type: "react", messageId: ev.eventId, emoji: "👍" });
        return "reminder_done";
      }
      const delay = parseSnooze(text);
      if (delay === null) return null;
      const dueAt = now() + delay;
      markRun(db, run.id, "snoozed", now());
      addReminder(db, { chatId: run.chatId, senderId: run.senderId, text: run.text, dueAt, repeat: "none" }, now());
      void lanes.say(ev.chat.id, [`Snoozed until ${formatLocal(dueAt, deps.timezone)}.`]);
      return "reminder_snoozed";
    },

    /** Delivers what is due and nudges what was ignored. Returns how many messages it started. */
    tick(): number {
      let sent = 0;
      for (const reminder of dueReminders(db, now())) {
        // Settled before sending: a crash here loses one reminder rather than repeating it forever.
        const runId = createRun(db, reminder, now());
        settleReminder(db, reminder.id, now(), nextOccurrence(reminder.dueAt, reminder.repeat as Repeat, deps.timezone, now()));
        void lanes.say(reminder.chatId, [`⏰ ${reminder.text}`], (messageId) => setRunMessage(db, runId, messageId, "reminder"));
        sent++;
      }

      if (deps.nudgeAfterMinutes > 0) {
        for (const run of runsAwaitingNudge(db, now() - deps.nudgeAfterMinutes * MINUTE)) {
          // One nudge at most, and none at all if they have been talking since (they saw it) or it is late.
          markRun(db, run.id, "nudged", now());
          if (userMessagedSince(db, run.chatId, run.sentAt) || isQuiet()) continue;
          void lanes.say(run.chatId, [linesOf(run.senderId).nudge(run.text)], (messageId) => setRunMessage(db, run.id, messageId, "nudge"));
          sent++;
        }
      }
      if (sent) deps.log(`sent ${sent} reminder message(s)`);
      return sent;
    },
  };
}

export type Reminders = ReturnType<typeof createReminders>;
