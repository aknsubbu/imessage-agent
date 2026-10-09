// Hands actions to the bridge and tracks each one to a final state.
//
//   queued -> dispatched (bridge polled it) -> sending (bridge is about to call
//   Spectrum) -> sent | skipped | failed
//
// An action that stays "dispatched" is handed out again, because the bridge
// never started on it. One that reached "sending" is never handed out again:
// it may already be on the user's phone.
import type { Ack, Action } from "../../../protocol/index.ts";
import type { DB } from "../db.ts";
import { recordFailure, setActionStatus } from "../store.ts";

export type Outcome = {
  status: "sent" | "skipped" | "failed" | "unknown" | "cancelled";
  messageId?: string;
  error?: string;
};

type Entry = {
  action: Action;
  platform: string;
  phase: "queued" | "dispatched" | "sending";
  resolve: (outcome: Outcome) => void;
  timer?: NodeJS.Timeout;
};

export type HubOptions = { redeliverMs: number; sendingTimeoutMs: number; now: () => number };

export class ActionHub {
  private ready: string[] = [];
  private readonly entries = new Map<string, Entry>();
  private readonly waiters = new Set<() => void>();
  private readonly opts: HubOptions;

  constructor(
    private readonly db: DB,
    opts: Partial<HubOptions> = {},
  ) {
    this.opts = { redeliverMs: 10_000, sendingTimeoutMs: 60_000, now: Date.now, ...opts };
  }

  /**
   * Queues an action for the bridge serving `platform` and resolves once it
   * reaches a final state. The action row must already exist.
   */
  emit(action: Action, platform: string): Promise<Outcome> {
    return new Promise((resolve) => {
      this.entries.set(action.id, { action, platform, phase: "queued", resolve });
      this.ready.push(action.id);
      this.wake();
    });
  }

  private queuedFor(platform: string): Entry[] {
    return this.ready.flatMap((id) => {
      const entry = this.entries.get(id);
      return entry && entry.platform === platform && entry.phase === "queued" ? [entry] : [];
    });
  }

  /** Long poll: returns this platform's queued actions at once, or waits up to `waitMs` for some. */
  async poll(waitMs: number, signal?: AbortSignal, platform = "imessage"): Promise<Action[]> {
    const deadline = performance.now() + waitMs;
    while (this.queuedFor(platform).length === 0 && !signal?.aborted) {
      const left = deadline - performance.now();
      if (left <= 0) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.waiters.add(done);
        signal?.addEventListener("abort", done);
      });
    }
    if (signal?.aborted) return [];
    const batch = this.queuedFor(platform);
    const taken = new Set(batch.map((entry) => entry.action.id));
    this.ready = this.ready.filter((id) => !taken.has(id));
    for (const entry of batch) {
      entry.phase = "dispatched";
      setActionStatus(this.db, entry.action.id, "dispatched", this.opts.now());
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.redeliver(entry.action.id), this.opts.redeliverMs);
    }
    return batch.map((entry) => entry.action);
  }

  ack(ack: Ack): void {
    const entry = this.entries.get(ack.actionId);
    if (!entry) return; // late or repeated ack
    clearTimeout(entry.timer);
    if (ack.status === "sending") {
      // The bridge may report this after the action was put back on offer; from
      // here on it must never be offered again.
      this.ready = this.ready.filter((id) => id !== ack.actionId);
      entry.phase = "sending";
      setActionStatus(this.db, ack.actionId, "sending", this.opts.now());
      entry.timer = setTimeout(() => {
        recordFailure(this.db, "action.unknown", ack.actionId, "bridge never reported the result of a send", this.opts.now());
        this.finish(ack.actionId, { status: "unknown", error: "no result from bridge" });
      }, this.opts.sendingTimeoutMs);
      return;
    }
    this.finish(ack.actionId, { status: ack.status, messageId: ack.messageId, error: ack.error?.message });
  }

  /** Withdraws an action the bridge has not picked up yet. Returns false once it is on its way. */
  cancel(actionId: string): boolean {
    const entry = this.entries.get(actionId);
    if (!entry || entry.phase !== "queued") return false;
    this.ready = this.ready.filter((id) => id !== actionId);
    this.finish(actionId, { status: "cancelled" });
    return true;
  }

  /** Stops timers and resolves everything outstanding; used on shutdown. */
  close(): void {
    for (const id of [...this.entries.keys()]) {
      const entry = this.entries.get(id)!;
      clearTimeout(entry.timer);
      this.entries.delete(id);
      entry.resolve({ status: "cancelled" });
    }
    this.ready = [];
    this.wake();
  }

  private redeliver(actionId: string): void {
    const entry = this.entries.get(actionId);
    if (!entry || entry.phase !== "dispatched") return;
    entry.phase = "queued";
    setActionStatus(this.db, actionId, "pending", this.opts.now());
    this.ready.push(actionId);
    this.wake();
  }

  private finish(actionId: string, outcome: Outcome): void {
    const entry = this.entries.get(actionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(actionId);
    setActionStatus(this.db, actionId, outcome.status, this.opts.now(), {
      platformId: outcome.messageId,
      error: outcome.error,
    });
    entry.resolve(outcome);
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
