// Runs the reminder clock. No model call is involved: a reminder's text was
// fixed when it was set.
import type { Reminders } from "./reminders.ts";

export function createScheduler(deps: { reminders: Reminders; intervalMs?: number }) {
  let timer: NodeJS.Timeout | undefined;
  return {
    tick: () => deps.reminders.tick(),
    start() {
      deps.reminders.tick(); // anything that fell due while the server was down goes out now, late
      timer = setInterval(() => deps.reminders.tick(), deps.intervalMs ?? 15_000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
