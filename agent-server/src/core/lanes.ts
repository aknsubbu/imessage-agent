// One lane per chat. A lane debounces bursts of messages into a single turn,
// cancels a turn when the person texts again, and sends the reply's bubbles in
// order with small pauses.
import { randomUUID } from "node:crypto";
import type { Action, ActionBody } from "../../../protocol/index.ts";
import { pauseBefore, type ReplyPlan } from "../agent/reply.ts";
import type { RunTurn, TurnResult } from "../agent/turn.ts";
import { type DB, tx } from "../db.ts";
import { PoolExhaustedError } from "../llm/types.ts";
import { discard } from "../media.ts";
import {
  type ActionRow,
  addAssistantMessage,
  cancelIfPending,
  cancelPendingActions,
  chatPlatform,
  chatsWithPending,
  createTurn,
  insertAction,
  markMessages,
  pendingMessages,
  recordFailure,
  recoverOutbox,
  updateTurn,
} from "../store.ts";
import type { ActionHub } from "./hub.ts";

type Turn = {
  id: string;
  abort: AbortController;
  cancelled: boolean;
  phase: "thinking" | "sending";
  /** Set once a tool has changed something; from then on the turn is not thrown away. */
  committed: boolean;
  /** False for fixed replies (commands), which have no row in `turns` and are never cancelled. */
  recorded: boolean;
  inflight?: string;
};

type Lane = { platform: string; timer?: NodeJS.Timeout; current?: Turn; chain: Promise<void>; lastNoticeAt: number };

export type LanesDeps = {
  db: DB;
  hub: ActionHub;
  runTurn: RunTurn;
  debounceMs: number;
  mediaDir: string;
  /** Runs after a reply has gone out; used to keep the conversation summary up to date. */
  afterTurn?: (chatId: string) => void;
  now: () => number;
  log: (message: string) => void;
};

const NOTICE_INTERVAL_MS = 10 * 60_000;

const newTurn = (id: string): Turn => ({
  id,
  abort: new AbortController(),
  cancelled: false,
  phase: "thinking",
  committed: false,
  recorded: true,
});

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const textOf = (body: ActionBody): string | undefined => {
  if (body.type !== "send") return undefined;
  if (body.content.type === "text") return body.content.text;
  if (body.content.type === "markdown") return body.content.markdown;
  if (body.content.type === "poll") return `[poll: ${body.content.title}]`;
  return `[${body.content.type}]`;
};

export class Lanes {
  private readonly lanes = new Map<string, Lane>();
  private stopped = false;

  constructor(private readonly deps: LanesDeps) {}

  private lane(chatId: string): Lane {
    let lane = this.lanes.get(chatId);
    if (!lane) {
      lane = { platform: chatPlatform(this.deps.db, chatId), chain: Promise.resolve(), lastNoticeAt: 0 };
      this.lanes.set(chatId, lane);
    }
    return lane;
  }

  isBusy(chatId: string): boolean {
    const lane = this.lanes.get(chatId);
    return Boolean(lane?.timer || lane?.current);
  }

  /** A new message was stored as pending. Restarts the debounce window and drops any turn in flight. */
  notify(chatId: string): void {
    if (this.stopped) return;
    const lane = this.lane(chatId);
    if (lane.current) this.cancel(lane);
    clearTimeout(lane.timer);
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      this.flush(chatId).catch((err) => {
        this.deps.log(`turn for ${chatId} crashed: ${err}`);
        recordFailure(this.deps.db, "turn.crash", chatId, err, this.deps.now());
      });
    }, this.deps.debounceMs);
  }

  /** Sends fixed text without the model, in order with anything already being sent. */
  say(chatId: string, bubbles: string[]): Promise<void> {
    const turn: Turn = { ...newTurn(randomUUID()), recorded: false, phase: "sending" };
    const rows = bubbles.map((text, i) =>
      this.persist(chatId, null, i + 1, 0, { type: "send", content: { type: "text", text } }),
    );
    return this.dispatch(chatId, this.lane(chatId), turn, rows);
  }

  /** Fire-and-forget action: typing, read receipts, tapbacks. */
  fire(chatId: string, turnId: string | null, body: ActionBody): void {
    const row = this.persist(chatId, turnId, 0, 0, body);
    void this.deps.hub.emit(this.toAction(row), this.lane(chatId).platform);
  }

  private cancel(lane: Lane): void {
    const turn = lane.current;
    if (!turn) return;
    // A turn that has already set a reminder or saved a note runs to the end:
    // starting it over would do that a second time. The new message waits its turn.
    if (turn.committed && turn.phase === "thinking") return;
    lane.current = undefined;
    turn.cancelled = true;
    turn.abort.abort();
    // If the next bubble has not been picked up by the bridge yet, withdraw it.
    if (turn.inflight) this.deps.hub.cancel(turn.inflight);
  }

  private persist(chatId: string, turnId: string | null, seq: number, afterMs: number, body: ActionBody): ActionRow {
    const row = { id: randomUUID(), chatId, turnId, seq, afterMs, body };
    insertAction(this.deps.db, row, this.deps.now());
    return { ...row, status: "pending" };
  }

  private toAction(row: ActionRow): Action {
    return { ...row.body, id: row.id, chatId: row.chatId, ...(row.turnId ? { turnId: row.turnId } : {}) } as Action;
  }

  private async flush(chatId: string): Promise<void> {
    const { db, now } = this.deps;
    const lane = this.lane(chatId);
    if (lane.current || this.stopped) return;
    const pending = pendingMessages(db, chatId);
    if (pending.length === 0) return;

    const turn = newTurn(randomUUID());
    lane.current = turn;
    createTurn(db, turn.id, chatId, now());
    const replyTarget = pending.at(-1)!.platformId;
    if (replyTarget) this.fire(chatId, turn.id, { type: "read", messageId: replyTarget });
    this.fire(chatId, turn.id, { type: "typing", state: "start" });

    let plan: ReplyPlan;
    let result: TurnResult | undefined;
    let error: string | undefined;
    try {
      result = await this.deps.runTurn({
        chatId,
        signal: turn.abort.signal,
        onCommit: () => {
          turn.committed = true;
        },
      });
      plan = result.plan;
      if (plan.bubbles.length === 0 && !plan.react) {
        error = "model returned an empty reply";
        plan = { bubbles: ["Sorry, I lost my train of thought. Say that again?"] };
      }
    } catch (err) {
      // Shutting down: the turn stays "running" and its messages pending; the next start redoes it.
      if (this.stopped) return;
      if (turn.cancelled) return this.abandon(chatId, turn);
      if (err instanceof PoolExhaustedError) return this.waitForBudget(chatId, lane, turn, err);
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      plan = { bubbles: ["Something went wrong on my side. Try me again in a moment."] };
      recordFailure(db, "turn.model", turn.id, err, now());
    }
    if (this.stopped) return;
    // The person texted again while the model was thinking: their messages are
    // still pending and the next turn answers everything together.
    if (turn.cancelled) return this.abandon(chatId, turn);

    const bodies: { body: ActionBody; afterMs: number }[] = [];
    if (plan.react && replyTarget) {
      bodies.push({ body: { type: "react", messageId: replyTarget, emoji: plan.react }, afterMs: 0 });
    }
    plan.bubbles.forEach((text, i) => {
      bodies.push({
        body: { type: "send", content: { type: "text", text } },
        afterMs: i === 0 ? 0 : pauseBefore(text),
      });
    });

    // The reply plan and "these messages are answered" commit together, so a
    // crash either re-runs the turn or resumes sending, never both.
    const rows = tx(db, () => {
      markMessages(
        db,
        pending.map((message) => message.id),
        "answered",
        turn.id,
      );
      updateTurn(
        db,
        turn.id,
        { status: "sending", model: result?.model, slot: result?.slot, llmCalls: result?.llmCalls, usage: result?.usage, error },
        now(),
      );
      return bodies.map((item, i) => this.persist(chatId, turn.id, i + 1, item.afterMs, item.body));
    });
    turn.phase = "sending";
    if (result?.consumedMedia.length) void discard(this.deps.mediaDir, result.consumedMedia);
    await this.dispatch(chatId, lane, turn, rows);
  }

  private abandon(chatId: string, turn: Turn): void {
    cancelPendingActions(this.deps.db, turn.id, this.deps.now());
    updateTurn(this.deps.db, turn.id, { status: "cancelled" }, this.deps.now());
    this.fire(chatId, null, { type: "typing", state: "stop" });
  }

  /**
   * Every model slot is rate limited. The messages stay pending and the turn is
   * retried when the pool says it can answer again; the person is told once.
   */
  private waitForBudget(chatId: string, lane: Lane, turn: Turn, err: PoolExhaustedError): void {
    const { db, now } = this.deps;
    cancelPendingActions(db, turn.id, now());
    updateTurn(db, turn.id, { status: "failed", error: "all model slots rate limited" }, now());
    lane.current = undefined;
    this.fire(chatId, null, { type: "typing", state: "stop" });
    if (now() - lane.lastNoticeAt >= NOTICE_INTERVAL_MS) {
      lane.lastNoticeAt = now();
      const minutes = Math.ceil((err.retryAt - now()) / 60_000);
      const when = minutes <= 1 ? "in under a minute" : `in about ${minutes} minutes`;
      void this.say(chatId, [`I've hit my usage limit for the moment. I'll pick this up ${when}.`]);
    }
    // A new message in the meantime simply restarts the debounce timer instead.
    if (!lane.timer && !this.stopped) {
      lane.timer = setTimeout(() => {
        lane.timer = undefined;
        this.flush(chatId).catch((error) => recordFailure(db, "turn.crash", chatId, error, now()));
      }, Math.max(0, err.retryAt - now()) + 250);
    }
  }

  private dispatch(chatId: string, lane: Lane, turn: Turn, rows: ActionRow[]): Promise<void> {
    const { db, hub, now } = this.deps;
    const run = async () => {
      let failed = false;
      let lastWasSend = false;
      for (const row of rows) {
        if (turn.cancelled || failed) break;
        if (row.afterMs > 0) {
          this.fire(chatId, turn.recorded ? turn.id : null, { type: "typing", state: "start" });
          await sleep(row.afterMs, turn.abort.signal);
          if (turn.cancelled) break;
        }
        // Shutting down: leave the rest pending so the next start resumes this reply.
        if (this.stopped) return;
        turn.inflight = row.id;
        const outcome = await hub.emit(this.toAction(row), lane.platform);
        turn.inflight = undefined;
        if (this.stopped && outcome.status === "cancelled") return;
        lastWasSend = false;
        if (outcome.status === "sent") {
          const text = textOf(row.body);
          if (text !== undefined) {
            addAssistantMessage(db, { chatId, text, platformId: outcome.messageId, turnId: turn.recorded ? turn.id : undefined }, now());
            lastWasSend = true;
          }
        } else if (outcome.status === "failed" || outcome.status === "unknown") {
          recordFailure(db, `action.${outcome.status}`, row.id, outcome.error ?? outcome.status, now());
          // A lost bubble ends the reply: later ones would read oddly without it.
          // A lost tapback is only a nicety, so the text still goes out.
          if (row.body.type === "send") failed = true;
        }
      }
      // Anything not handed out by now will not be sent.
      cancelIfPending(
        db,
        rows.map((row) => row.id),
        now(),
      );
      if (turn.recorded) {
        updateTurn(db, turn.id, { status: failed ? "failed" : turn.cancelled ? "cancelled" : "done" }, now());
      }
      if (lane.current === turn) lane.current = undefined;
      // A delivered message clears the typing indicator by itself; otherwise clear it.
      if (!lastWasSend) this.fire(chatId, null, { type: "typing", state: "stop" });
      if (turn.recorded && !failed && !turn.cancelled) this.deps.afterTurn?.(chatId);
      // Messages that arrived while a turn could not be interrupted are answered next.
      if (!this.stopped && !lane.current && !lane.timer && pendingMessages(db, chatId).length > 0) this.notify(chatId);
    };
    const next = lane.chain.then(run).catch((err) => {
      this.deps.log(`sending to ${chatId} crashed: ${err}`);
      recordFailure(db, "dispatch.crash", turn.id, err, now());
      if (lane.current === turn) lane.current = undefined;
    });
    lane.chain = next;
    return next;
  }

  /** After a restart: finish replies that were part-way out, then answer anything still waiting. */
  recover(): void {
    const { db, now } = this.deps;
    const { unknown, resume } = recoverOutbox(db, now());
    if (unknown > 0) this.deps.log(`${unknown} send(s) had no confirmed result before the restart; not re-sent`);
    for (const [turnId, rows] of resume) {
      const chatId = rows[0]!.chatId;
      const lane = this.lane(chatId);
      const turn: Turn = { ...newTurn(turnId), phase: "sending" };
      lane.current = turn;
      // Typing and read receipts from before the restart are stale; only the reply itself resumes.
      // The reply is already late, so the pauses between its bubbles are kept short.
      const sendable = rows
        .filter((row) => row.body.type === "send" || row.body.type === "react")
        .map((row) => ({ ...row, afterMs: Math.min(row.afterMs, 300) }));
      cancelIfPending(
        db,
        rows.filter((row) => row.body.type !== "send" && row.body.type !== "react").map((row) => row.id),
        now(),
      );
      void this.dispatch(chatId, lane, turn, sendable);
    }
    for (const chatId of chatsWithPending(db)) this.notify(chatId);
  }

  /** Resolves once no chat has a timer, a turn or a send in progress. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.all([...this.lanes.values()].map((lane) => lane.chain));
      if (![...this.lanes.values()].some((lane) => lane.timer || lane.current)) return;
      await sleep(5);
    }
  }

  /** Stops taking work. Messages not yet answered stay pending and are picked up on the next start. */
  stop(): void {
    this.stopped = true;
    for (const lane of this.lanes.values()) {
      clearTimeout(lane.timer);
      lane.timer = undefined;
      // Abort the model call, but do not mark anything cancelled: recovery picks it up.
      lane.current?.abort.abort();
    }
  }
}
