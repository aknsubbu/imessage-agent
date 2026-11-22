// Optional mirroring of reminders and list items into Todoist or Notion.
//
// Off unless an integration is both named in INTEGRATIONS and given a token
// (see config.ts); with neither, `noSync` is used and nothing leaves this
// server. Mirroring is best effort and never blocks or fails the tool that
// triggered it: a failed copy is logged and the local item stands.
import type { DB } from "../db.ts";
import type { FetchLike } from "../llm/openai.ts";
import { recordFailure, setRef, takeRefs } from "../store.ts";

export type SyncItem = {
  kind: "reminder" | "list_item";
  /** The local row id. */
  id: number;
  text: string;
  /** When a reminder is due, UTC ms. */
  dueAt?: number;
  /** The list a list item belongs to. */
  list?: string;
};

export type Sync = {
  /** Names of the integrations that are on. Empty when nothing is mirrored. */
  providers: string[];
  created: (item: SyncItem) => void;
  /** The local item was finished or removed; close its copy where the app supports it. */
  closed: (kind: SyncItem["kind"], id: number) => void;
};

export const noSync: Sync = { providers: [], created() {}, closed() {} };

type Provider = {
  name: string;
  /** Creates the copy and returns its id in the other app. */
  create: (item: SyncItem) => Promise<string>;
  /** Marks the copy done. Absent when the app has no such notion. */
  close?: (remoteId: string) => Promise<void>;
};

export type IntegrationConfig = {
  todoist?: { token: string };
  notion?: { token: string; databaseId: string; titleProperty: string; dateProperty?: string; version: string };
};

const isoNoMillis = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function check(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res;
}

function todoist(token: string, doFetch: FetchLike): Provider {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    name: "todoist",
    async create(item) {
      const body: Record<string, unknown> = { content: item.text };
      if (item.dueAt) body.due_datetime = isoNoMillis(item.dueAt);
      // A list item becomes an inbox task labelled with its list, so "shopping" stays together.
      if (item.list) body.labels = [item.list.replace(/\s+/g, "_")];
      const res = await check(await doFetch("https://api.todoist.com/api/v1/tasks", { method: "POST", headers, body: JSON.stringify(body) }), "todoist create");
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("todoist create: no task id in the response");
      return String(data.id);
    },
    async close(remoteId) {
      await check(await doFetch(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(remoteId)}/close`, { method: "POST", headers }), "todoist close");
    },
  };
}

function notion(cfg: NonNullable<IntegrationConfig["notion"]>, doFetch: FetchLike): Provider {
  return {
    name: "notion",
    async create(item) {
      const properties: Record<string, unknown> = {
        [cfg.titleProperty]: { title: [{ text: { content: (item.list ? `[${item.list}] ` : "") + item.text } }] },
      };
      if (cfg.dateProperty && item.dueAt) properties[cfg.dateProperty] = { date: { start: isoNoMillis(item.dueAt) } };
      const res = await check(
        await doFetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.token}`, "notion-version": cfg.version, "content-type": "application/json" },
          body: JSON.stringify({ parent: { database_id: cfg.databaseId }, properties }),
        }),
        "notion create",
      );
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("notion create: no page id in the response");
      return data.id;
    },
    // Notion pages have no universal "done"; the copy is left as it is.
  };
}

export function createSync(deps: {
  db: DB;
  integrations: IntegrationConfig;
  fetchImpl?: FetchLike;
  now: () => number;
  log: (message: string) => void;
}): Sync {
  const doFetch: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) }));
  const providers: Provider[] = [];
  if (deps.integrations.todoist) providers.push(todoist(deps.integrations.todoist.token, doFetch));
  if (deps.integrations.notion) providers.push(notion(deps.integrations.notion, doFetch));
  if (providers.length === 0) return noSync;

  const fail = (scope: string, ref: string, err: unknown) => {
    deps.log(`${scope} failed: ${err instanceof Error ? err.message : err}`);
    recordFailure(deps.db, scope, ref, err, deps.now());
  };

  return {
    providers: providers.map((p) => p.name),
    created(item) {
      for (const provider of providers) {
        provider
          .create(item)
          .then((remoteId) => setRef(deps.db, provider.name, item.kind, item.id, remoteId))
          .catch((err) => fail(`sync.${provider.name}.create`, `${item.kind}:${item.id}`, err));
      }
    },
    closed(kind, id) {
      for (const ref of takeRefs(deps.db, kind, id)) {
        const provider = providers.find((p) => p.name === ref.provider);
        provider?.close?.(ref.remoteId).catch((err) => fail(`sync.${ref.provider}.close`, `${kind}:${id}`, err));
      }
    },
  };
}
