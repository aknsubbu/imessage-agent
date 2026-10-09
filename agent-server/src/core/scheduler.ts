// Sends reminders when they fall due. No model call is involved: the text was
// fixed when the reminder was set.
import type { DB } from "../db.ts";
import { dueReminders, settleReminder } from "../store.ts";
import { nextOccurrence, type Repeat } from "../time.ts";
import type { Lanes } from "./lanes.ts";

export function createScheduler(deps: {
  db: DB;
  lanes: Lanes;
  timezone: string;
  now: () => number;
  log: (message: string) => void;
  intervalMs?: number;
}) {
  let timer: NodeJS.Timeout | undefined;

  function tick(): number {
    const due = dueReminders(deps.db, deps.now());
    for (const reminder of due) {
      // Settled before sending: a crash here loses one reminder rather than repeating it forever.
      settleReminder(deps.db, reminder.id, deps.now(), nextOccurrence(reminder.dueAt, reminder.repeat as Repeat, deps.timezone, deps.now()));
      void deps.lanes.say(reminder.chatId, [`⏰ ${reminder.text}`]);
    }
    if (due.length) deps.log(`sent ${due.length} reminder(s)`);
    return due.length;
  }

  return {
    tick,
    start() {
      tick(); // anything that fell due while the server was down goes out now, late
      timer = setInterval(tick, deps.intervalMs ?? 15_000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
