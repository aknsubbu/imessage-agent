// The bridge's side of the protocol: signed requests to the agent server.
import { type Ack, type Action, actionSchema, type InboundEvent, signedHeaders } from "../../protocol/index.ts";

export const PLATFORM = "imessage";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createServerClient(opts: { url: string; secret: string; log: (message: string) => void }) {
  const stop = new AbortController();

  async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const raw = JSON.stringify(body);
    const res = await fetch(opts.url + path, {
      method: "POST",
      headers: signedHeaders(opts.secret, raw),
      body: raw,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  return {
    /**
     * Delivers an event, retrying while the server is restarting. The server
     * dedupes on the event id, so a retry after a lost response is harmless.
     */
    async postEvent(event: InboundEvent): Promise<void> {
      const deadline = Date.now() + 10 * 60_000;
      for (let attempt = 0; ; attempt++) {
        try {
          await call("/v1/events", event, 10_000);
          return;
        } catch (err) {
          if (stop.signal.aborted) return;
          if (Date.now() > deadline) {
            opts.log(`gave up delivering event ${event.eventId}: ${err}`);
            return;
          }
          if (attempt === 0) opts.log(`agent server unreachable, holding event ${event.eventId}: ${err}`);
          await sleep(Math.min(30_000, 500 * 2 ** attempt));
        }
      }
    },

    async poll(waitMs: number): Promise<Action[]> {
      const { actions } = await call<{ actions: unknown[] }>("/v1/actions/poll", { waitMs, platform: PLATFORM }, waitMs + 10_000);
      return actions.flatMap((item) => {
        const parsed = actionSchema.safeParse(item);
        if (!parsed.success) opts.log(`ignored an action the bridge does not understand`);
        return parsed.success ? [parsed.data] : [];
      });
    },

    /** Reports progress on an action. Returns false if the server could not be told. */
    async ack(ack: Ack, attempts = 1): Promise<boolean> {
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await call("/v1/actions/ack", ack, 10_000);
          return true;
        } catch (err) {
          if (stop.signal.aborted) return false;
          if (attempt === attempts - 1) opts.log(`could not ack ${ack.actionId} as ${ack.status}: ${err}`);
          else await sleep(500 * 2 ** attempt);
        }
      }
      return false;
    },

    close: () => stop.abort(),
    closed: () => stop.signal.aborted,
  };
}

export type ServerClient = ReturnType<typeof createServerClient>;
