// Everything the agent says on its own besides reminders, none of it through
// the model: the morning briefing, the evening goal check-ins, the Sunday
// review, and the day-after follow-up on an event someone was working toward.
// It also reads the answers: a thumbs-up or "yes" on a check-in logs the goal.
import type { InboundEvent } from "../../../protocol/index.ts";
import { linesFor } from "../agent/persona.ts";
import type { DB } from "../db.ts";
import type { Weather } from "../integrations/weather.ts";
import {
  activeGoals,
  answerGoalCheckin,
  createGoalCheckin,
  endGoal,
  enabledBriefings,
  enabledCheckins,
  getGoal,
  getProfile,
  goalCheckinByMessage,
  goalsAwaitingFollowup,
  isDirectChat,
  lastAssistantMessage,
  logGoal,
  markBriefingSent,
  markCheckinDay,
  markFollowedUp,
  recordFailure,
  roleOf,
  staleEventGoals,
  setGoalCheckinMessage,
  type Checkins,
  type Goal,
} from "../store.ts";
import { clockMinutes, localDayKey, localParts, minutesOfDay } from "../time.ts";
import { composeBriefing } from "./briefing.ts";
import { daysLoggedThisWeek, goalStreak, loggedToday } from "./goals.ts";
import type { Lanes } from "./lanes.ts";
import { DONE_TAPBACKS } from "./reminders.ts";

export type GoalOutcome = "goal_logged" | "goal_missed";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A scheduled message that is more than this late (the server was down, say) is skipped for the day, not sent stale.
const LATE_WINDOW_MIN = 180;
// A reply only counts as being about a check-in for this long after it was sent.
const REPLY_WINDOW_MS = 12 * HOUR;
// An event more than this far in the past is no longer worth asking about.
const FOLLOWUP_STALE_MS = 2 * DAY;
const MAX_CHECKIN_BUBBLES = 3;

const YES = /^(yes|yep|yeah|yup|y|did it|done|finished|completed|✅|✔️?|👍)[\s!.]*$/iu;
const NO = /^(no|nope|nah|not today|skipped|missed|didn'?t|didn'?t get to it)[\s!.]*$/iu;

export function createProactive(deps: {
  db: DB;
  lanes: Lanes;
  weather: Weather;
  timezone: string;
  quietHours: [number, number];
  now: () => number;
  log: (message: string) => void;
}) {
  const { db, lanes, now, timezone } = deps;

  const isQuiet = (): boolean => {
    const [from, to] = deps.quietHours;
    const hour = localParts(now(), timezone).hour;
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  };

  /** True from the chosen time until three hours after it, on a day when it has not gone out. */
  const inWindow = (clock: string): boolean => {
    const minutes = minutesOfDay(now(), timezone);
    const at = clockMinutes(clock);
    return minutes >= at && minutes < at + LATE_WINDOW_MIN;
  };

  const linesOf = (senderId: string) => linesFor(getProfile(db, senderId));

  // Briefings, check-ins, the review and follow-ups name a person's own goals and reminders, so each
  // loop below skips any chat that is not one-on-one, whatever chat the goal or setting came from.
  function sendBriefings(today: string): number {
    let sent = 0;
    for (const b of enabledBriefings(db)) {
      if (b.lastSentDay === today || !inWindow(b.time) || !roleOf(db, b.senderId) || !isDirectChat(db, b.chatId)) continue;
      // Marked before it is built, so a crash loses one briefing instead of repeating it.
      markBriefingSent(db, b.senderId, today);
      composeBriefing({ db, weather: deps.weather, timezone, now }, b)
        .then((text) => lanes.say(b.chatId, [text]))
        .catch((err) => {
          deps.log(`briefing failed: ${err}`);
          recordFailure(db, "briefing", b.senderId, err, now());
        });
      sent++;
    }
    return sent;
  }

  /** Days a goal has existed, from 1 to 7: a goal set on Friday is not marked down for Monday to Thursday. */
  const daysActive = (goal: Goal) => Math.min(7, Math.max(1, Math.ceil((now() - goal.createdAt) / DAY)));

  function reviewText(senderId: string, goals: Goal[]): string {
    const lines = linesOf(senderId);
    const rows: string[] = [];
    let hit = 0;
    let possible = 0;
    for (const goal of goals) {
      const days = daysLoggedThisWeek(db, goal, timezone, now());
      if (goal.cadence === "daily") {
        hit += days;
        possible += daysActive(goal);
        rows.push(`· ${goal.title}: ${days}/${daysActive(goal)} days`);
      } else {
        hit += days > 0 ? 1 : 0;
        possible += 1;
        rows.push(`· ${goal.title}: ${days > 0 ? "done this week" : "not yet"}`);
      }
    }
    return ["Week in review:", ...rows, lines.reviewClose(hit, possible)].filter(Boolean).join("\n");
  }

  function sendCheckins(today: string): number {
    let sent = 0;
    const sunday = localParts(now(), timezone).weekday === 0;
    for (const c of enabledCheckins(db) as Checkins[]) {
      if (c.lastDay === today || !inWindow(c.time) || !roleOf(db, c.senderId) || !isDirectChat(db, c.chatId)) continue;
      markCheckinDay(db, c.senderId, "last_day", today);
      const lines = linesOf(c.senderId);
      const goals = activeGoals(db, c.senderId).filter((g) => g.cadence !== "once");

      if (sunday && c.lastReviewDay !== today && goals.length > 0) {
        markCheckinDay(db, c.senderId, "last_review_day", today);
        void lanes.say(c.chatId, [reviewText(c.senderId, goals)]);
        sent++;
      }

      const open = goals.filter((g) =>
        g.cadence === "daily" ? !loggedToday(db, g, timezone, now()) : sunday && daysLoggedThisWeek(db, g, timezone, now()) === 0,
      );
      for (const goal of open.slice(0, MAX_CHECKIN_BUBBLES)) {
        // One bubble per goal, so a thumbs-up on it means exactly that goal.
        const id = createGoalCheckin(db, goal.id, c.chatId, now());
        const text = lines.checkin(goal.title, goalStreak(db, goal, timezone, now()));
        void lanes.say(c.chatId, [text], (messageId) => setGoalCheckinMessage(db, id, messageId));
        sent++;
      }
    }
    return sent;
  }

  function sendFollowups(): number {
    let sent = 0;
    // Give a person a few hours after the event before asking how it went.
    for (const goal of goalsAwaitingFollowup(db, now() - 3 * HOUR)) {
      const stale = now() - goal.dueAt! > FOLLOWUP_STALE_MS;
      // Not at night: it waits for the morning, and is dropped only if it has gone stale by then.
      if (!stale && isQuiet()) continue;
      markFollowedUp(db, goal.id, now());
      if (stale || !roleOf(db, goal.senderId) || !isDirectChat(db, goal.chatId)) continue;
      void lanes.say(goal.chatId, [linesOf(goal.senderId).followup(goal.title)]);
      sent++;
    }
    return sent;
  }

  /** An event goal that was asked about and never closed does not stay on the list forever. */
  function expireOldEvents(): void {
    for (const goal of staleEventGoals(db, now() - 7 * DAY)) endGoal(db, goal.id, "dropped", now());
  }

  function answerYes(checkinId: number, goalId: number, chatId: string): GoalOutcome | null {
    const goal = getGoal(db, goalId);
    if (!goal || goal.status !== "active") return null;
    answerGoalCheckin(db, checkinId, now());
    logGoal(db, goal.id, "", now());
    void lanes.say(chatId, [linesOf(goal.senderId).goalLogged(goal.title, goalStreak(db, goal, timezone, now()))]);
    return "goal_logged";
  }

  return {
    /** A tapback arrived. A thumbs-up or heart on a check-in logs that goal. */
    onReaction(ev: InboundEvent): GoalOutcome | null {
      if (!ev.reaction || !DONE_TAPBACKS.has(ev.reaction.emoji)) return null;
      const c = goalCheckinByMessage(db, ev.chat.id, ev.reaction.targetMessageId);
      if (!c || c.answeredAt !== null) return null;
      return answerYes(c.id, c.goalId, c.chatId);
    },

    /** A text arrived. A plain "yes" or "no" to a check-in is handled here; anything else goes to the model. */
    onMessage(ev: InboundEvent, text: string): GoalOutcome | null {
      const target = ev.replyTo?.messageId ?? lastAssistantMessage(db, ev.chat.id)?.platformId;
      const c = target ? goalCheckinByMessage(db, ev.chat.id, target) : undefined;
      if (!c || c.answeredAt !== null || now() - c.sentAt > REPLY_WINDOW_MS) return null;
      if (YES.test(text.trim())) return answerYes(c.id, c.goalId, c.chatId);
      if (NO.test(text.trim())) {
        const goal = getGoal(db, c.goalId);
        if (!goal || goal.status !== "active") return null;
        answerGoalCheckin(db, c.id, now());
        void lanes.say(c.chatId, [linesOf(goal.senderId).goalMissed(goal.title)]);
        return "goal_missed";
      }
      return null;
    },

    /** Sends whatever is due. Returns how many messages it started. */
    tick(): number {
      const today = localDayKey(now(), timezone);
      expireOldEvents();
      const sent = sendBriefings(today) + sendCheckins(today) + sendFollowups();
      if (sent) deps.log(`sent ${sent} briefing, check-in or follow-up message(s)`);
      return sent;
    },
  };
}

export type Proactive = ReturnType<typeof createProactive>;
