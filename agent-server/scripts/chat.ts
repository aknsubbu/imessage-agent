// A stand-in for the bridge, for development: type messages here and see what
// the agent does, with no iMessage involved. It talks to a running server on
// its own "terminal" platform, so it never crosses wires with the real bridge.
//
//   npm run chat                 interactive
//   npm run chat -- "hello"      send one message, print the reply, exit
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { type Action, type InboundEvent, signedHeaders } from "../../protocol/index.ts";

const url = process.env.AGENT_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`;
const secret = process.env.AGENT_SHARED_SECRET ?? "";
const sender = process.env.CHAT_SENDER ?? (process.env.OWNER_IDS ?? "").split(",")[0]?.trim() ?? "";
if (!secret || !sender) {
  console.error("Set AGENT_SHARED_SECRET, and OWNER_IDS (or CHAT_SENDER), in agent-server/.env first.");
  process.exit(1);
}
const chat = { id: `terminal:${sender}`, type: "dm" as const, line: "terminal" };

async function call<T>(path: string, body: unknown): Promise<T> {
  const raw = JSON.stringify(body);
  const res = await fetch(url + path, { method: "POST", headers: signedHeaders(secret, raw), body: raw });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function say(text: string): Promise<void> {
  const ev: InboundEvent = {
    v: 1,
    eventId: randomUUID(),
    receivedAt: new Date().toISOString(),
    platform: "terminal",
    chat,
    sender: { id: sender },
    kind: "message",
    parts: [{ type: "text", text }],
  };
  const { outcome } = await call<{ outcome: string }>("/v1/events", ev);
  if (outcome !== "queued" && outcome !== "command" && outcome !== "ack") console.log(`  (server: ${outcome})`);
}

function show(action: Action): void {
  if (action.type === "send") {
    const c = action.content;
    console.log(`agent> ${c.type === "text" ? c.text : c.type === "markdown" ? c.markdown : `[${c.type}]`}`);
  } else if (action.type === "react") console.log(`agent reacted ${action.emoji}`);
  else if (action.type === "typing" && action.state === "start") console.log("  (typing…)");
  else if (action.type === "read") console.log("  (read)");
}

/** Receives and acknowledges actions until nothing has arrived for `quietMs` (forever when undefined). */
async function pump(quietMs?: number): Promise<void> {
  let lastSeen = Date.now();
  for (;;) {
    const { actions } = await call<{ actions: Action[] }>("/v1/actions/poll", { waitMs: 1000, platform: "terminal" });
    for (const action of actions) {
      await call("/v1/actions/ack", { actionId: action.id, status: "sending" });
      show(action);
      await call("/v1/actions/ack", { actionId: action.id, status: "sent", messageId: `terminal-${randomUUID()}` });
      lastSeen = Date.now();
    }
    if (quietMs !== undefined && Date.now() - lastSeen > quietMs) return;
  }
}

const oneShot = process.argv.slice(2);
if (oneShot.length > 0) {
  for (const text of oneShot) await say(text);
  await pump(Number(process.env.CHAT_QUIET_MS ?? 6000));
} else {
  console.log(`Chatting as ${sender} with ${url}. Ctrl+C to quit.`);
  void pump().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim()) await say(line.trim());
  }
}
