// One turn: prepare what the person sent, run the model with its tools until
// it has an answer, and return a reply plan.
import type { Part } from "../../../protocol/index.ts";
import type { DB } from "../db.ts";
import type { Transcriber } from "../llm/audio.ts";
import { type ChatMessage, type ContentPart, type LLM, type LLMResponse, type LLMUsage, RequestTooLargeError } from "../llm/types.ts";
import { audioForWhisper, discard, imageAsJpeg } from "../media.ts";
import { chatSummary, history, listFacts, type MessageRow, pendingMessages, saveSummary, setMessageText, unsummarised } from "../store.ts";
import { buildMessages } from "./context.ts";
import { contextLine, memoryBlock, systemPrompt } from "./prompt.ts";
import { parseReply, type ReplyPlan } from "./reply.ts";
import type { ToolDef } from "../llm/types.ts";
import type { Web } from "../web/web.ts";
import { afterWebToolDefs, linksIn, runTool, toolDefs } from "./tools.ts";

export type TurnResult = {
  plan: ReplyPlan;
  model: string;
  slot: string;
  llmCalls: number;
  usage: LLMUsage;
  /** Media files this turn has finished with; deleted once the reply is committed. */
  consumedMedia: string[];
};

export type RunTurn = (input: {
  chatId: string;
  signal: AbortSignal;
  /** Called once a tool has changed something, after which the turn must run to completion. */
  onCommit: () => void;
}) => Promise<TurnResult>;

export type TurnDeps = {
  db: DB;
  llm: LLM;
  transcribe: Transcriber;
  web: Web;
  agentName: string;
  timezone: string;
  mediaDir: string;
  now: () => number;
  log: (message: string) => void;
  /** Replaceable in tests, where ffmpeg and real media files are not available. */
  convert?: { audio: (path: string) => Promise<string>; image: (path: string) => Promise<Buffer> };
};

// Budget for the conversation text in one request. Groq's free tier caps a
// request near 8,000 tokens including the prompt, tool list, images and reply.
const HISTORY_BUDGET = 2200;
// A photo costs about 2,000 tokens on its own, so a turn with photos carries
// far less history, and never more than two of them.
const HISTORY_BUDGET_WITH_PHOTOS = 700;
const MAX_IMAGES = 2;
const MAX_OUTPUT_TOKENS = 700;
const MAX_STEPS = 4;

const isMedia = (part: Part): part is Extract<Part, { type: "media" }> => part.type === "media";

export function createRunTurn(deps: TurnDeps): RunTurn {
  const convert = deps.convert ?? { audio: audioForWhisper, image: imageAsJpeg };

  /** Replaces each voice memo with its transcript, so every later step sees plain text. */
  async function transcribeVoice(rows: MessageRow[], signal: AbortSignal): Promise<void> {
    for (const row of rows) {
      const audio = row.parts.filter(isMedia).filter((part) => part.role === "audio");
      if (audio.length === 0) continue;
      let text = row.text;
      for (const part of audio) {
        let transcript: string | null = null;
        let flac: string | undefined;
        try {
          flac = await convert.audio(part.path);
          transcript = await deps.transcribe(flac, signal);
        } catch (err) {
          if (signal.aborted) throw err;
          deps.log(`could not transcribe a voice memo: ${err}`);
        }
        text = text.replace("[voice memo]", transcript ? `[voice memo] ${transcript}` : "[a voice memo that could not be transcribed]");
        await discard(deps.mediaDir, [part.path, ...(flac ? [flac] : [])]);
      }
      const rest = row.parts.filter((part) => !(isMedia(part) && part.role === "audio"));
      setMessageText(deps.db, row.id, text, rest);
    }
  }

  return async ({ chatId, signal, onCommit }) => {
    await transcribeVoice(pendingMessages(deps.db, chatId), signal);
    const pending = pendingMessages(deps.db, chatId);
    const senderId = pending.at(-1)?.senderId ?? "";

    // Photos in the messages being answered are shown to the model; older ones stay as "[photo]".
    const photos = pending.flatMap((row) => row.parts.filter(isMedia).filter((part) => part.role === "image"));
    const images: ContentPart[] = [];
    for (const photo of photos.slice(-MAX_IMAGES)) {
      try {
        const jpeg = await convert.image(photo.path);
        images.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } });
      } catch (err) {
        deps.log(`could not open a photo: ${err}`);
      }
    }

    const rows = history(deps.db, chatId, 60);
    const base = (budgetTokens: number, imageCount: number): ChatMessage[] => {
      const shown = images.slice(images.length - imageCount);
      const hidden = photos.length - shown.length;
      const messages = buildMessages({
        system: systemPrompt(deps.agentName),
        memory: memoryBlock(listFacts(deps.db, senderId), chatSummary(deps.db, chatId)),
        contextLine: contextLine(deps.now(), deps.timezone),
        history: rows,
        budgetTokens,
      });
      const last = messages.at(-1);
      if (last?.role === "user" && typeof last.content === "string" && photos.length > 0) {
        // The model must know when it is not seeing everything that was sent.
        const note = hidden > 0 ? `\n(${hidden} of the ${photos.length} photos could not be shown to you.)` : "";
        last.content = shown.length ? [{ type: "text", text: last.content + note }, ...shown] : last.content + note;
      }
      return messages;
    };

    const purpose = images.length > 0 ? "vision" : "tools";
    const usage: LLMUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let llmCalls = 0;
    const ask = async (messages: ChatMessage[], tools: ToolDef[] | undefined, maxOutputTokens = MAX_OUTPUT_TOKENS): Promise<LLMResponse> => {
      llmCalls++;
      const res = await deps.llm.complete({ purpose, messages, tools, maxOutputTokens, signal });
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.cachedTokens += res.usage.cachedTokens;
      return res;
    };

    const budget = images.length > 0 ? HISTORY_BUDGET_WITH_PHOTOS : HISTORY_BUDGET;
    let messages = base(budget, images.length);
    let res: LLMResponse;
    try {
      res = await ask(messages, toolDefs);
    } catch (err) {
      if (!(err instanceof RequestTooLargeError)) throw err;
      // Waiting will not help an oversized request; send less history and at most one photo.
      messages = base(Math.floor(budget / 3), Math.min(images.length, 1));
      res = await ask(messages, toolDefs);
    }

    const userLinks = rows.filter((row) => row.role === "user").flatMap((row) => linksIn(row.text));
    const context = { db: deps.db, chatId, senderId, timezone: deps.timezone, now: deps.now, web: deps.web, userLinks, signal };
    // Once text from the web is in the turn, nothing it says can cause a change
    // or send anything out: tools that save, schedule, delete, search or open a
    // link are withheld and refused until the turn ends. A poisoned page can
    // then mislead an answer, but it cannot act and cannot leak what the agent knows.
    let tainted = false;
    for (let step = 1; res.toolCalls.length > 0 && step < MAX_STEPS; step++) {
      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const out = await runTool(call, context, !tainted);
        if (out.wrote) onCommit();
        if (out.untrusted) tainted = true;
        messages.push({ role: "tool", toolCallId: call.id, content: out.text });
      }
      // On the last allowed step the tools are withheld, so the model has to answer in words.
      res = await ask(messages, step < MAX_STEPS - 1 ? (tainted ? afterWebToolDefs : toolDefs) : undefined);
    }

    // Hidden reasoning counts against the output allowance and can use all of it,
    // leaving no reply. Give that one more try with room to spare.
    if (res.finishReason === "length" && !res.text.trim() && res.toolCalls.length === 0) {
      res = await ask(messages, undefined, MAX_OUTPUT_TOKENS * 3);
    }

    return {
      plan: parseReply(res.text),
      model: res.model,
      slot: res.slot,
      llmCalls,
      usage,
      consumedMedia: pending.flatMap((row) => row.parts.filter(isMedia).map((part) => part.path)),
    };
  };
}

// --- rolling summary ---------------------------------------------------------

const SUMMARISE_AFTER = 40; // messages outside the summary before it is updated
const KEEP_VERBATIM = 16; // most recent messages always left as they are

const SUMMARY_PROMPT = `You keep a running summary of a text conversation between a person and their assistant.
Merge the earlier summary and the new messages into one updated summary of at most 120 words.
Keep names, facts, decisions, plans and open questions. Drop pleasantries. Write plain sentences, no lists.`;

/**
 * Folds the oldest part of a long conversation into the chat's summary, so the
 * prompt stays small without the agent forgetting what was said. Runs after a
 * turn, never in its way.
 */
export function createSummariser(deps: { db: DB; llm: LLM; log: (message: string) => void }): (chatId: string) => Promise<void> {
  const busy = new Set<string>();
  return async (chatId) => {
    if (busy.has(chatId)) return;
    const rows = unsummarised(deps.db, chatId);
    if (rows.length < SUMMARISE_AFTER) return;
    const fold = rows.slice(0, rows.length - KEEP_VERBATIM);
    busy.add(chatId);
    try {
      const transcript = fold
        .map((row) => `${row.role === "user" ? "Person" : "Assistant"}: ${row.text}`)
        .join("\n")
        .slice(-9000);
      const res = await deps.llm.complete({
        purpose: "summary",
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: `Earlier summary:\n${chatSummary(deps.db, chatId) || "(none)"}\n\nNew messages:\n${transcript}` },
        ],
        maxOutputTokens: 500,
        temperature: 0.2,
      });
      const summary = res.text.trim();
      if (summary) saveSummary(deps.db, chatId, summary, fold.at(-1)!.id);
    } catch (err) {
      // Not urgent: the next turn will try again, and the history is still intact.
      deps.log(`could not update the summary for a chat: ${err}`);
    } finally {
      busy.delete(chatId);
    }
  };
}
