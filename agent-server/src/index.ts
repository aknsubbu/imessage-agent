import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";

const config = loadConfig();
const runtime = createRuntime(config);

// Finish replies that were part-way out before the last shutdown, then answer
// anything that was still waiting.
runtime.lanes.recover();
runtime.scheduler.start();

// Media is deleted as soon as a turn has used it; this catches anything left
// behind by a crash.
void (async () => {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const name of await readdir(config.mediaDir).catch(() => [])) {
    const path = join(config.mediaDir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
  }
})();

const server = serve({ fetch: runtime.app.fetch, hostname: config.host, port: config.port }, (info) => {
  const model =
    config.llmMode === "fake"
      ? "fake model (set GROQ_API_KEYS in .env to use Groq)"
      : `Groq, ${config.slots.length} key${config.slots.length === 1 ? "" : "s"}`;
  console.log(`[agent] listening on http://${info.address}:${info.port} — ${model}`);
  if (config.ownerIds.length === 0) console.log("[agent] no OWNER_IDS set: the first person to text becomes the owner");
  const on = Object.keys(config.integrations);
  console.log(`[agent] integrations: ${on.length ? `${on.join(", ")} (reminders and list items are copied there)` : "none on"}`);
  for (const problem of config.integrationProblems) console.warn(`[agent] ${problem}`);
});

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[agent] ${signal} received, shutting down`);
  runtime.stop();
  server.close(() => {
    runtime.db.close();
    process.exit(0);
  });
  // Long polls from the bridge can hold the listener open; do not wait on them forever.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
