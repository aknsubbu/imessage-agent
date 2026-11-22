import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ackSchema,
  inboundEventSchema,
  type InboundEvent,
  pollRequestSchema,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verify,
} from "../../protocol/index.ts";
import type { ActionHub } from "./core/hub.ts";

const MAX_BODY_BYTES = 1_000_000;

export type AppDeps = {
  sharedSecret: string;
  hub: ActionHub;
  handleEvent: (ev: InboundEvent) => string;
  health: () => Record<string, unknown>;
  now?: () => number;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { body: unknown; signed: boolean } }>();
  const now = deps.now ?? Date.now;

  app.get("/healthz", (c) => c.json({ ok: true, ...deps.health() }));

  // Events carry file paths, never file bytes, so a request this large is not the bridge. The limit
  // comes before anything reads the body, so an unauthenticated caller cannot make the server buffer it.
  app.use("/v1/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "request too large" }, 413) }));

  // Everything under /v1 must be signed by the bridge with the shared secret.
  app.use("/v1/*", async (c, next) => {
    const raw = await c.req.text();
    if (!verify(deps.sharedSecret, c.req.header(TIMESTAMP_HEADER), raw, c.req.header(SIGNATURE_HEADER), now())) {
      return c.json({ error: "bad signature" }, 401);
    }
    try {
      c.set("body", raw ? JSON.parse(raw) : {});
    } catch {
      return c.json({ error: "body is not JSON" }, 400);
    }
    c.set("signed", true);
    await next();
  });

  // The middleware above is the only gate, so each handler also refuses to run unless it passed.
  // Without this, a router quirk that skipped the middleware would leave the poll route open to
  // anyone, and a poll hands over the bridge's queued messages.
  const signedOnly = (c: { get: (key: "signed") => boolean; json: (body: unknown, status: 401) => Response }) =>
    c.get("signed") === true ? null : c.json({ error: "bad signature" }, 401);

  app.post("/v1/events", (c) => {
    const denied = signedOnly(c);
    if (denied) return denied;
    const parsed = inboundEventSchema.safeParse(c.get("body"));
    if (!parsed.success) return c.json({ error: "invalid event", issues: parsed.error.issues }, 400);
    return c.json({ ok: true, outcome: deps.handleEvent(parsed.data) }, 202);
  });

  app.post("/v1/actions/poll", async (c) => {
    const denied = signedOnly(c);
    if (denied) return denied;
    const parsed = pollRequestSchema.safeParse(c.get("body"));
    if (!parsed.success) return c.json({ error: "invalid poll request" }, 400);
    return c.json({ actions: await deps.hub.poll(parsed.data.waitMs, c.req.raw.signal, parsed.data.platform) });
  });

  app.post("/v1/actions/ack", (c) => {
    const denied = signedOnly(c);
    if (denied) return denied;
    const parsed = ackSchema.safeParse(c.get("body"));
    if (!parsed.success) return c.json({ error: "invalid ack" }, 400);
    deps.hub.ack(parsed.data);
    return c.json({ ok: true });
  });

  return app;
}
