// The bridge: the only process that talks to Spectrum. It forwards every
// inbound message to the agent server and carries out the actions the server
// sends back. It holds no conversation logic, so it rarely needs a restart —
// which matters, because texts that arrive while it is down are not replayed.
import { resolve } from "node:path";
import { type Message, type Space, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createActionRunner } from "./actions.ts";
import { createExecutor } from "./execute.ts";
import { Recent } from "./recent.ts";
import { diskMediaStore, type Flags, type MessageLike, normalize, shapeOf } from "./normalize.ts";
import { createServerClient, PLATFORM } from "./server-client.ts";

const log = (message: string) => console.log(`[bridge] ${message}`);

const secret = process.env.AGENT_SHARED_SECRET;
if (!secret) {
  console.error("AGENT_SHARED_SECRET is not set. Put it in .env.local; it must match agent-server/.env.");
  process.exit(1);
}
const client = createServerClient({ url: process.env.AGENT_SERVER_URL ?? "http://127.0.0.1:8787", secret, log });
const saveMedia = diskMediaStore(resolve(process.env.MEDIA_DIR ?? "../data/media"));

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  telemetry: true,
  providers: [imessage.config()],
});
const im = imessage(app);

const spaces = new Recent<Space>(500);
const messages = new Recent<Message>(2000);
const execute = createExecutor({
  messages,
  resolveSpace: async (chatId) => spaces.get(chatId) ?? (await im.space.get(chatId)),
});

// iMessage-only metadata the server uses to ignore auto-replies and spam.
const flagsOf = (message: MessageLike): Flags => {
  const extra = message as { isAutoReply?: boolean; isSpam?: boolean; expressiveSendStyleId?: string };
  return { autoReply: extra.isAutoReply || undefined, spam: extra.isSpam || undefined, effect: extra.expressiveSendStyleId || undefined };
};

// Work for one chat runs in order; different chats never wait on each other.
const chains = new Map<string, Promise<void>>();
function inOrder(chatId: string, work: () => Promise<void>): void {
  const next = (chains.get(chatId) ?? Promise.resolve()).then(work).catch((err) => log(`work for a chat failed: ${err}`));
  chains.set(chatId, next);
  void next.finally(() => {
    if (chains.get(chatId) === next) chains.delete(chatId);
  });
}

async function forward(space: Space, message: Message): Promise<void> {
  const event = await normalize(message, space, { saveMedia, flags: flagsOf });
  // Shape only, never the text: enough to see what a real voice memo or photo looks like.
  log(`in  ${shapeOf(event, message.content.type)}`);
  await client.postEvent(event);
}

const runner = createActionRunner({ ack: client.ack, execute, log });

async function pollLoop(): Promise<void> {
  let failures = 0;
  while (!client.closed()) {
    try {
      for (const action of await client.poll(25_000)) {
        if (runner.claim(action)) inOrder(`out:${action.chatId}`, () => runner.carryOut(action));
      }
      failures = 0;
    } catch (err) {
      if (client.closed()) return;
      if (failures++ === 0) log(`cannot reach the agent server: ${err}`);
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** failures)));
    }
  }
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, shutting down`);
  // Let work already in hand finish, briefly, then close the Spectrum connection.
  await Promise.race([Promise.allSettled([...chains.values()]), new Promise((r) => setTimeout(r, 5000))]);
  client.close();
  await app.stop();
  process.exit(0);
}
// Spectrum 12.10 no longer handles these itself.
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void pollLoop();
log(`connected to Spectrum as platform "${PLATFORM}"; waiting for messages`);

// Do not await slow work in this loop: delivery is serial, so one slow chat
// would stall every other. A throw here would also end the stream for good.
for await (const [space, message] of app.messages) {
  try {
    spaces.set(space.id, space);
    messages.set(message.id, message);
    inOrder(`in:${space.id}`, () => forward(space, message));
  } catch (err) {
    log(`could not queue an inbound message: ${err}`);
  }
}
