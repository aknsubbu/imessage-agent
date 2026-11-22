// Runs the clock for everything the server says on its own: reminders and
// their nudges, the morning briefing, goal check-ins and follow-ups. No model
// call is involved: each message's text was fixed or assembled from stored data.
import type { Proactive } from "./proactive.ts";
import type { Reminders } from "./reminders.ts";

export function createScheduler(deps: { reminders: Reminders; proactive?: Proactive; intervalMs?: number }) {
  let timer: NodeJS.Timeout | undefined;
  const tick = () => deps.reminders.tick() + (deps.proactive?.tick() ?? 0);
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
