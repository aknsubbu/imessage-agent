// Time-zone arithmetic with Intl only. Reminders are stored in UTC and spoken
// about in the person's zone.

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(utcMs: number, timezone: string): Parts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second")),
    weekday: WEEKDAYS.indexOf(value("weekday")),
  };
}

/** UTC instant for a wall-clock time in `timezone`. Handles daylight-saving shifts. */
export function wallTimeToUtc(p: Omit<Parts, "weekday">, timezone: string): number {
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetAt = (utcMs: number) => {
    const l = localParts(utcMs, timezone);
    return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - Math.floor(utcMs / 1000) * 1000;
  };
  const first = asIfUtc - offsetAt(asIfUtc);
  // The offset at the guess can differ from the offset at the answer near a clock change.
  return asIfUtc - offsetAt(first);
}

/** Parses "2026-10-09T17:00" as a wall-clock time in `timezone`; a time with an explicit offset is taken as is. */
export function parseLocal(input: string, timezone: string): number | null {
  const text = input.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (m) {
    return wallTimeToUtc(
      { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: +(m[6] ?? 0) },
      timezone,
    );
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatLocal(utcMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(utcMs));
}

export type Repeat = "none" | "daily" | "weekdays" | "weekly";

/** The next time a repeating reminder is due after `afterMs`, at the same wall-clock time. */
export function nextOccurrence(dueMs: number, repeat: Repeat, timezone: string, afterMs: number): number | null {
  if (repeat === "none") return null;
  const start = localParts(dueMs, timezone);
  let next = dueMs;
  const step = repeat === "weekly" ? 7 : 1;
  for (let days = step; days <= 3700 && next <= afterMs; days += step) {
    // Date.UTC normalises an overflowing day, which walks the calendar correctly.
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + days));
    const weekday = date.getUTCDay();
    if (repeat === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    next = wallTimeToUtc(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: start.hour, minute: start.minute, second: 0 },
      timezone,
    );
  }
  return next > afterMs ? next : null;
}
