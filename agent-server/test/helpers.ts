import { randomUUID } from "node:crypto";
import { type Action, type InboundEvent, signedHeaders } from "../../protocol/index.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { LLM } from "../src/llm/types.ts";
import { createRuntime, type RuntimeOverrides } from "../src/runtime.ts";

export const SECRET = "test-secret";
export const OWNER = "+15550001111";
export const CHAT = `any;-;${OWNER}`;

export function testConfig(patch: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    sharedSecret: SECRET,
    dbPath: ":memory:",
    mediaDir: "/tmp/unused",
    agentName: "Sage",
    timezone: "UTC",
    debounceMs: 20,
    ownerIds: [OWNER],
    llmMode: "fake",
    slots: [],
    models: { chat: ["m-small", "m-large"], tools: ["m-large"], vision: ["m-vision"], summary: ["m-small"] },
    ...patch,
  };
}

export function makeRuntime(llm?: LLM, patch: Partial<Config> = {}, overrides: RuntimeOverrides = {}) {
  return createRuntime(testConfig(patch), { db: openDb(":memory:"), llm, log: () => {}, ...overrides });
}

export function textEvent(text: string, patch: Partial<InboundEvent> = {}): InboundEvent {
  return {
    v: 1,
    eventId: randomUUID(),
    receivedAt: new Date().toISOString(),
    platform: "imessage",
    chat: { id: CHAT, type: "dm", line: "shared" },
    sender: { id: OWNER, service: "iMessage" },
    kind: "message",
    parts: [{ type: "text", text }],
    ...patch,
  };
}

export const post = (app: ReturnType<typeof createRuntime>["app"], path: string, body: unknown, secret = SECRET) => {
  const raw = JSON.stringify(body);
  return app.request(path, { method: "POST", headers: signedHeaders(secret, raw), body: raw });
};

/**
 * Stands in for the bridge: polls for actions and acknowledges each one as
 * sent, until `until` says enough has been seen or nothing arrives for a while.
 */
export async function drain(
  runtime: ReturnType<typeof createRuntime>,
  opts: { until?: (seen: Action[]) => boolean; quietMs?: number; ack?: (action: Action) => "sent" | "failed" | "none" } = {},
): Promise<Action[]> {
  const seen: Action[] = [];
  for (;;) {
    const batch = await runtime.hub.poll(opts.quietMs ?? 150);
    if (batch.length === 0) return seen;
    for (const action of batch) {
      seen.push(action);
      const verdict = opts.ack?.(action) ?? "sent";
      if (verdict === "none") continue;
      runtime.hub.ack({ actionId: action.id, status: "sending" });
      runtime.hub.ack({ actionId: action.id, status: verdict, messageId: `sent-${seen.length}` });
    }
    if (opts.until?.(seen)) return seen;
  }
}

export const sends = (actions: Action[]): string[] =>
  actions.flatMap((a) => (a.type === "send" && a.content.type === "text" ? [a.content.text] : []));
