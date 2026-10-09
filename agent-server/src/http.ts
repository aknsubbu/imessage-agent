import { Hono } from "hono";
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

export type AppDeps = {
  sharedSecret: string;
  hub: ActionHub;
  handleEvent: (ev: InboundEvent) => string;
  health: () => Record<string, unknown>;
  now?: () => number;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { body: unknown } }>();
  const now = deps.now ?? Date.now;

  app.get("/healthz", (c) => c.json({ ok: true, ...deps.health() }));

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
    await next();
  });

  app.post("/v1/events", (c) => {
    const parsed = inboundEventSchema.safeParse(c.get("body"));
    if (!parsed.success) return c.json({ error: "invalid event", issues: parsed.error.issues }, 400);
    return c.json({ ok: true, outcome: deps.handleEvent(parsed.data) }, 202);
  });

  app.post("/v1/actions/poll", async (c) => {
    const parsed = pollRequestSchema.safeParse(c.get("body"));
    if (!parsed.success) return c.json({ error: "invalid poll request" }, 400);
    return c.json({ actions: await deps.hub.poll(parsed.data.waitMs, c.req.raw.signal, parsed.data.platform) });
  });

  app.post("/v1/actions/ack", (c) => {
    const parsed = ackSchema.safeParse(c.get("body"));
    if (!parsed.success) return c.json({ error: "invalid ack" }, 400);
    deps.hub.ack(parsed.data);
    return c.json({ ok: true });
  });

  return app;
}
