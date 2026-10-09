// Builds the message list for one model call inside a token budget. Groq's free
// tier rejects any single request over roughly 8,000 tokens, so history is
// trimmed from the oldest end until the estimate fits.
import type { ChatMessage } from "../llm/types.ts";
import type { MessageRow } from "../store.ts";

/** A deliberately high estimate: over-counting only costs a little history. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.2) + 4;

const TRIM_MARK = "\n[… trimmed …]\n";

/** Keeps the start and end of an over-long message; the middle is the least likely place for the ask. */
export function trimMiddle(text: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 3.2);
  if (text.length <= maxChars) return text;
  const half = Math.max(0, Math.floor((maxChars - TRIM_MARK.length) / 2));
  return `${text.slice(0, half)}${TRIM_MARK}${text.slice(text.length - half)}`;
}

export function buildMessages(opts: {
  system: string;
  /** Saved facts and the running summary; sent as a second system message when present. */
  memory?: string;
  contextLine: string;
  history: MessageRow[];
  /** Budget for the conversation itself; the system prompt and tool list are fixed costs on top. */
  budgetTokens: number;
}): ChatMessage[] {
  // Walk back from the newest message until the budget is spent.
  let left = opts.budgetTokens - estimateTokens(opts.memory ?? "") - estimateTokens(opts.contextLine);
  const kept: { role: "user" | "assistant"; text: string }[] = [];
  for (let i = opts.history.length - 1; i >= 0; i--) {
    const row = opts.history[i]!;
    let text = row.text;
    if (kept.length === 0) {
      // The newest message is always sent, cut down if it alone is too long.
      text = trimMiddle(text, Math.max(left - 8, 150));
    } else if (estimateTokens(text) > left) {
      break;
    }
    left -= estimateTokens(text);
    kept.unshift({ role: row.role, text });
  }
  // A conversation handed to the model should open with the person, not the assistant.
  while (kept.length > 1 && kept[0]!.role === "assistant") kept.shift();

  // Fold a burst of consecutive messages from one side into a single entry.
  const turns: typeof kept = [];
  for (const item of kept) {
    const last = turns.at(-1);
    if (last && last.role === item.role) last.text += `\n${item.text}`;
    else turns.push({ ...item });
  }

  const messages: ChatMessage[] = [{ role: "system", content: opts.system }];
  if (opts.memory) messages.push({ role: "system", content: opts.memory });
  turns.forEach((turn, i) => {
    if (i === turns.length - 1) messages.push({ role: "system", content: opts.contextLine });
    messages.push({ role: turn.role, content: turn.text });
  });
  return messages;
}
