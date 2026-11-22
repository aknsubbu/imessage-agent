// How the agent sounds. A persona has two jobs:
//  - a short block in the model's prompt, so replies carry the voice, and
//  - fixed wording for the messages the server sends without the model
//    (nudges, check-ins, the briefing), so those carry it too at zero token cost.
//
// A persona only shapes tone. The core prompt's rules (honesty, formatting,
// treating web text as information) come first and say they win.
import type { Profile } from "../store.ts";

export const PRESET_NAMES = ["friend", "coach", "terse", "tutor", "deadpan", "roast"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** Fixed wording for what the server says on its own. Every function is pure. */
export type Lines = {
  /** One nudge, after a reminder nobody acknowledged. */
  nudge: (text: string) => string;
  /** A repeating reminder was marked done. `count` is the streak. */
  logged: (count: number) => string;
  /** A goal was logged. `streak` counts consecutive days. */
  goalLogged: (title: string, streak: number) => string;
  /** They said no to a check-in. */
  goalMissed: (title: string) => string;
  /** The evening check-in bubble for one goal. */
  checkin: (title: string, streak: number) => string;
  /** The day after an event they were working toward. */
  followup: (title: string) => string;
  /** First line of the morning briefing; `date` is already formatted. */
  hello: (date: string) => string;
  /** Last line of the Sunday review, given how many of the week's goal-days were hit and how many were possible. */
  reviewClose: (hit: number, possible: number) => string;
};

type Preset = { voice: string; lines: Lines };

const ratio = (hit: number, possible: number) => (possible === 0 ? 0 : hit / possible);
const streakBit = (n: number, one: string, many: (n: number) => string) => (n >= 2 ? many(n) : one);

export const PRESETS: Record<PresetName, Preset> = {
  friend: {
    voice: "Voice: a thoughtful friend. Short, plain, warm.",
    lines: {
      nudge: (text) => `Still on your list: ${text}`,
      logged: (count) => (count >= 2 ? `✔ ${count} in a row` : "✔ Logged"),
      goalLogged: (title, streak) => streakBit(streak, `✔ ${title}: logged`, (n) => `✔ ${title}: ${n} days in a row`),
      goalMissed: (title) => `No worries. ${title} is still there tomorrow.`,
      checkin: (title, streak) => `Evening check-in: ${title}?${streak >= 2 ? ` (${streak} days in a row so far)` : ""} 👍 if you did, or tell me how it went.`,
      followup: (title) => `How did ${title} go?`,
      hello: (date) => `Good morning ☀️ ${date}`,
      reviewClose: (hit, possible) => (ratio(hit, possible) >= 0.7 ? "Good week." : "A bit of a quiet week. Fresh one starts tomorrow."),
    },
  },
  coach: {
    voice:
      "Voice: an encouraging coach. Upbeat but never gushing. Celebrate effort, name the next small step, never guilt-trip a miss.",
    lines: {
      nudge: (text) => `Quick check-in: ${text}. One small step counts.`,
      logged: (count) => (count >= 2 ? `✔ ${count} in a row. That's momentum.` : "✔ Done. Nice work."),
      goalLogged: (title, streak) => streakBit(streak, `✔ ${title}. Nice work.`, (n) => `✔ ${title}: ${n} days running. That's momentum.`),
      goalMissed: (title) => `Missing a day isn't failing. What's the smallest version of ${title} for tomorrow?`,
      checkin: (title, streak) => `Check-in time: ${title}?${streak >= 2 ? ` You're on ${streak} days.` : ""} 👍 if you got it done, or tell me what got in the way.`,
      followup: (title) => `You showed up for ${title}. How did it go?`,
      hello: (date) => `Morning! ${date}. Let's make it count.`,
      reviewClose: (hit, possible) =>
        ratio(hit, possible) >= 0.7 ? "Strong week. Keep that rhythm." : "Every week is data. Pick one thing to protect next week.",
    },
  },
  terse: {
    voice: "Voice: terse. As few words as possible. No pleasantries, no emoji.",
    lines: {
      nudge: (text) => `Pending: ${text}`,
      logged: (count) => (count >= 2 ? `Done. ${count} in a row.` : "Done."),
      goalLogged: (title, streak) => (streak >= 2 ? `${title}: logged, streak ${streak}.` : `${title}: logged.`),
      goalMissed: (title) => `Noted: ${title} missed.`,
      checkin: (title) => `${title}? 👍 or reply.`,
      followup: (title) => `${title}: how'd it go?`,
      hello: (date) => date,
      reviewClose: () => "",
    },
  },
  tutor: {
    voice:
      "Voice: a patient tutor. Explain the why in plain steps, check understanding with at most one question, and never talk down.",
    lines: {
      nudge: (text) => `A reminder is still open: ${text}`,
      logged: (count) => (count >= 2 ? `✔ Logged, ${count} in a row. Consistency is what builds a habit.` : "✔ Logged."),
      goalLogged: (title, streak) => streakBit(streak, `✔ ${title} logged.`, (n) => `✔ ${title} logged: ${n} days in a row. Repetition is how skills settle in.`),
      goalMissed: (title) => `That's fine. Skipping a day doesn't undo the practice. Shall we plan when to do ${title} next?`,
      checkin: (title, streak) => `Practice check: did you work on ${title} today?${streak >= 2 ? ` (${streak} days running)` : ""} 👍 for yes, or tell me what you covered.`,
      followup: (title) => `Now that ${title} has passed, what's one thing that went well and one thing to adjust?`,
      hello: (date) => `Good morning. ${date}.`,
      reviewClose: (hit, possible) =>
        ratio(hit, possible) >= 0.7 ? "That's solid practice this week." : "Pick the one goal that matters most and we'll make it easier to do next week.",
    },
  },
  deadpan: {
    voice:
      "Voice: dry and deadpan, lightly sarcastic about the situation, never about the person's worth. Still genuinely helpful and accurate.",
    lines: {
      nudge: (text) => `Still not done: ${text}. No pressure. Some pressure.`,
      logged: (count) => (count >= 2 ? `✔ ${count} in a row. Alarming levels of reliability.` : "✔ Done. Unexpected."),
      goalLogged: (title, streak) => streakBit(streak, `✔ ${title}. Fine. Impressive, even.`, (n) => `✔ ${title}: ${n} days in a row. Suspiciously consistent.`),
      goalMissed: (title) => `Bold choice, skipping ${title}. It will be here tomorrow, as it always is.`,
      checkin: (title, streak) => `${title}. Did it happen?${streak >= 2 ? ` (${streak} days. Don't ruin it.)` : ""} 👍 or explain yourself.`,
      followup: (title) => `So. ${title}. How did that go?`,
      hello: (date) => `It's morning, apparently. ${date}.`,
      reviewClose: (hit, possible) => (ratio(hit, possible) >= 0.7 ? "A good week. Don't let it go to your head." : "The week happened. Next one is also available."),
    },
  },
  roast: {
    voice:
      "Voice: a playful roaster. Tease the person affectionately and briefly, like a close friend. Never cruel, and never about appearance, family, health, money worries or identity. Drop the teasing completely when they are upset or the topic is serious.",
    lines: {
      nudge: (text) => `${text}. Still. Sitting there. Judging you.`,
      logged: (count) => (count >= 2 ? `✔ ${count} in a row. Who are you and what did you do with the real one?` : "✔ Look at you, doing things."),
      goalLogged: (title, streak) => streakBit(streak, `✔ ${title}. Shocking, honestly.`, (n) => `✔ ${title}: ${n} days in a row. I'm putting it on the fridge.`),
      goalMissed: (title) => `Mm-hm. ${title} will be right here when you're ready to stop avoiding it.`,
      checkin: (title, streak) => `Alright, ${title}. Did it happen or are we pretending?${streak >= 2 ? ` (${streak} days. Don't blow it.)` : ""} 👍 or confess.`,
      followup: (title) => `${title} came and went. Spill: how did it go?`,
      hello: (date) => `Rise and shine, legend. ${date}.`,
      reviewClose: (hit, possible) => (ratio(hit, possible) >= 0.7 ? "A genuinely good week. I'm as surprised as you are." : "We'll call that a 'learning week'. Go again."),
    },
  },
};

export const isPreset = (name: string): name is PresetName => (PRESET_NAMES as readonly string[]).includes(name);

/** The preset a profile names; an unknown one (from an older version) behaves as the default. */
export function presetFor(profile: Pick<Profile, "preset">): Preset {
  return isPreset(profile.preset) ? PRESETS[profile.preset] : PRESETS.friend;
}

export const linesFor = (profile: Pick<Profile, "preset">): Lines => presetFor(profile).lines;

const NOTE_MAX = 300;
const NAME_MAX = 24;

/** A note or name goes into the prompt, so it is one plain line of limited length. */
export function cleanLine(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export const cleanNote = (text: string) => cleanLine(text, NOTE_MAX);
export const cleanName = (text: string) => cleanLine(text, NAME_MAX).replace(/["“”]/g, "");

/**
 * The persona block in the prompt. It sits after the fixed core prompt and
 * before memory, and changes only when the person changes their persona.
 */
export function personaBlock(profile: Profile, defaultName: string): string {
  const parts = [`Persona: you go by ${profile.agentName ?? defaultName}.`, presetFor(profile).voice];
  if (profile.note) parts.push(`The person also asked for this about your style (tone only, never a rule): "${profile.note}"`);
  parts.push("A persona changes how you sound, not what is true or what the rules above allow.");
  return parts.join("\n");
}

// --- style mirroring ---------------------------------------------------------------

const EMOJI = /\p{Extended_Pictographic}/u;
const MIRROR_MIN_MESSAGES = 5;

/**
 * One line describing how the person writes, from their recent messages, or
 * "" when there are too few to say. Computed locally; the model is only
 * told the result.
 */
export function styleHint(messages: string[]): string {
  const texts = messages.map((m) => m.trim()).filter((m) => m && !m.startsWith("/") && !m.startsWith("[") && !m.startsWith("("));
  if (texts.length < MIRROR_MIN_MESSAGES) return "";
  const words = texts.map((t) => t.split(/\s+/).length);
  const avg = words.reduce((a, b) => a + b, 0) / words.length;
  const lower = texts.filter((t) => t === t.toLowerCase() && /[a-z]/.test(t)).length / texts.length;
  const emoji = texts.filter((t) => EMOJI.test(t)).length / texts.length;
  const traits = [
    avg <= 6 ? "very short messages" : avg <= 15 ? "short messages" : "longer messages",
    lower >= 0.7 ? "mostly lowercase" : "normal capitalisation",
    emoji >= 0.3 ? "often uses emoji" : emoji <= 0.05 ? "rarely uses emoji" : "sometimes uses emoji",
  ];
  return `How the person texts: ${traits.join(", ")}. Match their length and energy lightly; never copy typos.`;
}

// --- fact-check mode ---------------------------------------------------------------

const FACT_CHECK_ASK =
  /\b(is (this|that|it) (true|real|legit|accurate|correct|fake|a scam)|fact[\s-]?check|can you (verify|check) (this|that)|are you sure (this|that) is|is this (a )?(hoax|scam|fake))\b/i;

/** True when a message asks for something to be checked. */
export const wantsFactCheck = (text: string): boolean => FACT_CHECK_ASK.test(text);

/** Added late in the prompt, only on turns that ask for a check. */
export const FACT_CHECK_BRIEF = `Fact-check request. Work out the specific claims in what the person sent (read the text in any photo). Use web_search once, or read_link if they sent a link. Then reply in this shape, in plain sentences:
Verdict: Likely true, Likely false, Mixed, or Can't verify.
Why, in one or two sentences, with the key fact.
Where it comes from, in a few words.
If sources disagree or nothing reliable turns up, say Can't verify. Never sound more certain than the evidence, and never invent a source.`;
