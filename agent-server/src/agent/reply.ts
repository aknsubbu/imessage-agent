// Turns the model's raw text into a reply plan: an optional tapback and up to
// three short bubbles. The inline tags are parsed here so the model never
// needs a second, structured request.

// Exact glyphs iMessage maps to native tapbacks. ❤️ and ‼️ carry U+FE0F; without
// it the reaction goes out as a custom emoji instead.
export const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;

const bare = (glyph: string) => glyph.replace(/️/g, "");

export function toTapback(input: string): string | undefined {
  const wanted = bare(input.trim());
  return TAPBACKS.find((glyph) => bare(glyph) === wanted);
}

export type ReplyPlan = { react?: string; bubbles: string[] };

export function parseReply(raw: string, maxBubbles = 3): ReplyPlan {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  let react: string | undefined;
  let silent = false;
  text = text.replace(/\[\[\s*([a-z]+)\s*(?::\s*([^\]]*?))?\s*\]\]/gi, (_match, name: string, value?: string) => {
    if (name.toLowerCase() === "react" && value) react = toTapback(value) ?? react;
    if (name.toLowerCase() === "silent") silent = true;
    return ""; // unknown tags are dropped, never shown
  });

  // Bubbles are plain text for now: strip the emphasis markers models add from habit.
  text = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "");

  let bubbles = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (bubbles.length > maxBubbles) {
    bubbles = [...bubbles.slice(0, maxBubbles - 1), bubbles.slice(maxBubbles - 1).join("\n\n")];
  }
  // "Silent" only holds when a reaction carries the reply.
  if (silent && react) bubbles = [];
  return { react, bubbles };
}

/** Pause before a bubble that follows another, scaled to its length. */
export const pauseBefore = (bubble: string): number => Math.min(2200, Math.max(700, 400 + bubble.length * 25));
