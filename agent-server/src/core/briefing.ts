// The morning briefing: its settings, and the message itself. The message is
// put together from what the server already knows (weather from Open-Meteo,
// reminders due today, goals still open), so a briefing costs no model tokens.
import type { DB } from "../db.ts";
import { linesFor } from "../agent/persona.ts";
import type { Weather } from "../integrations/weather.ts";
import { type Briefing, activeGoals, getBriefing, getProfile, pendingReminders, saveBriefing } from "../store.ts";
import { clockMinutes, formatLocal, localDayKey, minutesOfDay, parseClock } from "../time.ts";
import { goalStreak, loggedToday } from "./goals.ts";

export type BriefingDeps = { db: DB; weather: Weather; timezone: string; now: () => number };

export type BriefingInput = { enabled?: boolean; time?: string; city?: string; fahrenheit?: boolean };

export function describeBriefing(b: Briefing | undefined): string {
  if (!b || !b.enabled) return "off";
  return `on at ${b.time}${b.city ? `, with the weather for ${b.city}` : ", without weather"}${b.fahrenheit ? " (°F)" : ""}`;
}

/**
 * Applies a change to someone's briefing. Giving any setting turns it on,
 * unless `enabled: false` says otherwise. A time that has already passed today
 * starts tomorrow, so setting it up at 11am never sends a stale 8am message;
 * a time still ahead goes out today.
 */
export async function configureBriefing(
  deps: BriefingDeps,
  who: { senderId: string; chatId: string },
  input: BriefingInput,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const { db, now, timezone } = deps;
  const patch: Partial<Omit<Briefing, "senderId" | "chatId">> = {};

  if (input.time !== undefined) {
    const time = parseClock(input.time);
    if (!time) return { ok: false, error: "that time is not clear; use something like 08:00 or 7:30am" };
    patch.time = time;
  }
  if (input.city !== undefined) {
    const city = input.city.trim();
    if (city === "") Object.assign(patch, { city: null, lat: null, lon: null });
    else {
      const place = await deps.weather.geocode(city, signal);
      if (!place) return { ok: false, error: `could not find a place called "${city}"` };
      Object.assign(patch, { city: place.name, lat: place.lat, lon: place.lon });
    }
  }
  if (input.fahrenheit !== undefined) patch.fahrenheit = input.fahrenheit;
  patch.enabled = input.enabled ?? true;

  // "Already sent today" is worked out afresh from the new time: one that has passed starts tomorrow,
  // and one still ahead goes out today even if an earlier setting had already used today up.
  const time = patch.time ?? getBriefing(db, who.senderId)?.time ?? "08:00";
  if (patch.enabled) patch.lastSentDay = minutesOfDay(now(), timezone) >= clockMinutes(time) ? localDayKey(now(), timezone) : null;
  return { ok: true, text: describeBriefing(saveBriefing(db, who.senderId, who.chatId, patch)) };
}

/** The briefing text for one person, as a single bubble. */
export async function composeBriefing(deps: BriefingDeps, b: Briefing, signal?: AbortSignal): Promise<string> {
  const { db, now, timezone } = deps;
  const lines = linesFor(getProfile(db, b.senderId));
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(new Date(now()));
  const out = [lines.hello(date)];

  if (b.lat !== null && b.lon !== null) {
    // The weather is a nicety: if the lookup fails, the rest of the briefing still goes out.
    const forecast = await deps.weather.forecast({ lat: b.lat, lon: b.lon }, b.fahrenheit, signal).catch(() => null);
    if (forecast) out.push(`${b.city ? `${b.city.split(",")[0]}: ` : ""}${forecast}`);
  }

  // Reminders due before local midnight tonight.
  const today = localDayKey(now(), timezone);
  const due = pendingReminders(db, b.senderId).filter((r) => localDayKey(r.dueAt, timezone) === today);
  if (due.length) {
    const time = (ms: number) => formatLocal(ms, timezone).replace(/^\w+ \d+ \w+, /, "");
    out.push(`Today:\n${due.slice(0, 5).map((r) => `· ${time(r.dueAt)} ${r.text}`).join("\n")}${due.length > 5 ? `\n· and ${due.length - 5} more` : ""}`);
  }

  // Daily goals not yet done today, with the streak they would extend.
  const open = activeGoals(db, b.senderId).filter((g) => g.cadence === "daily" && !loggedToday(db, g, timezone, now()));
  if (open.length) {
    const label = (g: (typeof open)[number]) => {
      const streak = goalStreak(db, g, timezone, now());
      return `· ${g.title}${streak >= 2 ? ` (${streak} days so far)` : ""}`;
    };
    out.push(`Still to do:\n${open.slice(0, 4).map(label).join("\n")}`);
  }
  return out.join("\n\n");
}
