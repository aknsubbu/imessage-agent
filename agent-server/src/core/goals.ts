// What the server works out about a goal without the model: streaks, whether
// today is already logged, and the last week at a glance.
import type { DB } from "../db.ts";
import { type Goal, goalLogTimes } from "../store.ts";
import { dayKey, localDayKey, localParts } from "../time.ts";

const DAY = 86_400_000;

/** Consecutive local days, counting back from today (or yesterday, if today is still open), with at least one log. */
export function dayStreak(times: number[], timezone: string, now: number): number {
  const days = new Set(times.map((t) => localDayKey(t, timezone)));
  const today = localParts(now, timezone);
  // Walk the calendar by date, not by 24-hour steps, so a clock change cannot skip or repeat a day.
  const at = (back: number) => dayKey(today.year, today.month, today.day - back);
  let back = days.has(at(0)) ? 0 : 1;
  let count = 0;
  while (days.has(at(back))) {
    count++;
    back++;
  }
  return count;
}

/** Streak in days for a daily goal; other goals have no streak. */
export function goalStreak(db: DB, goal: Goal, timezone: string, now: number): number {
  if (goal.cadence !== "daily") return 0;
  return dayStreak(goalLogTimes(db, goal.id, now - 400 * DAY), timezone, now);
}

export function loggedToday(db: DB, goal: Goal, timezone: string, now: number): boolean {
  const today = localDayKey(now, timezone);
  return goalLogTimes(db, goal.id, now - 2 * DAY).some((t) => localDayKey(t, timezone) === today);
}

/** How many of the last seven local days (today included) a goal was logged on. */
export function daysLoggedThisWeek(db: DB, goal: Goal, timezone: string, now: number): number {
  const today = localParts(now, timezone);
  const week = new Set(Array.from({ length: 7 }, (_, back) => dayKey(today.year, today.month, today.day - back)));
  const days = new Set(goalLogTimes(db, goal.id, now - 9 * DAY).map((t) => localDayKey(t, timezone)));
  return [...days].filter((day) => week.has(day)).length;
}

/** "Meditate (daily, 3 days in a row)" */
export function describeGoal(db: DB, goal: Goal, timezone: string, now: number): string {
  const streak = goalStreak(db, goal, timezone, now);
  const bits: string[] = [goal.cadence];
  if (streak >= 2) bits.push(`${streak} days in a row`);
  if (goal.cadence === "daily" && loggedToday(db, goal, timezone, now)) bits.push("done today");
  return `${goal.title} (${bits.join(", ")})`;
}
