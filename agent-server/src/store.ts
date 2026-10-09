// All SQL lives here. Functions take the database first and stay synchronous.
import type { ActionBody, InboundEvent, Part } from "../../protocol/index.ts";
import type { DB } from "./db.ts";
import type { LLMUsage } from "./llm/types.ts";

type Row = Record<string, any>;
const all = (db: DB, sql: string, ...args: any[]): Row[] => db.prepare(sql).all(...args) as Row[];
const get = (db: DB, sql: string, ...args: any[]): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
const run = (db: DB, sql: string, ...args: any[]) => db.prepare(sql).run(...args);

// --- events and chats ------------------------------------------------------

/** Journals an inbound event. Returns false when it was already seen. */
export function recordEvent(db: DB, ev: InboundEvent, now: number): boolean {
  const result = run(
    db,
    "INSERT OR IGNORE INTO events (id, chat_id, sender_id, kind, payload, received_at) VALUES (?, ?, ?, ?, ?, ?)",
    ev.eventId,
    ev.chat.id,
    ev.sender?.id ?? null,
    ev.kind,
    JSON.stringify(ev),
    now,
  );
  if (result.changes === 0) return false;
  run(
    db,
    "INSERT OR IGNORE INTO chats (id, platform, type, line, created_at) VALUES (?, ?, ?, ?, ?)",
    ev.chat.id,
    ev.platform,
    ev.chat.type,
    ev.chat.line,
    now,
  );
  return true;
}

export function chatPlatform(db: DB, chatId: string): string {
  return get(db, "SELECT platform FROM chats WHERE id = ?", chatId)?.platform ?? "imessage";
}

export function setEventOutcome(db: DB, eventId: string, outcome: string): void {
  run(db, "UPDATE events SET outcome = ? WHERE id = ?", outcome, eventId);
}

export function resetChat(db: DB, chatId: string, now: number): void {
  run(db, "UPDATE chats SET reset_at = ?, summary = '' WHERE id = ?", now, chatId);
  run(db, "UPDATE messages SET state = 'handled' WHERE chat_id = ? AND state = 'pending'", chatId);
}

// --- messages --------------------------------------------------------------

export type MessageRow = {
  id: number;
  chatId: string;
  role: "user" | "assistant";
  senderId: string | null;
  text: string;
  parts: Part[];
  platformId: string | null;
  state: string;
  createdAt: number;
};

const toMessage = (row: Row): MessageRow => ({
  id: row.id,
  chatId: row.chat_id,
  role: row.role,
  senderId: row.sender_id,
  text: row.text,
  parts: row.parts ? (JSON.parse(row.parts) as Part[]) : [],
  platformId: row.platform_id,
  state: row.state,
  createdAt: row.created_at,
});

export function addUserMessage(
  db: DB,
  m: { chatId: string; senderId: string; text: string; parts?: Part[]; platformId: string; state: "pending" | "handled" },
  now: number,
): number {
  const result = run(
    db,
    "INSERT INTO messages (chat_id, role, sender_id, text, parts, platform_id, state, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?, ?)",
    m.chatId,
    m.senderId,
    m.text,
    m.parts?.length ? JSON.stringify(m.parts) : null,
    m.platformId,
    m.state,
    now,
  );
  return Number(result.lastInsertRowid);
}

export function addAssistantMessage(
  db: DB,
  m: { chatId: string; text: string; platformId?: string; turnId?: string },
  now: number,
): void {
  run(
    db,
    "INSERT INTO messages (chat_id, role, text, platform_id, state, turn_id, created_at) VALUES (?, 'assistant', ?, ?, 'sent', ?, ?)",
    m.chatId,
    m.text,
    m.platformId ?? null,
    m.turnId ?? null,
    now,
  );
}

export function pendingMessages(db: DB, chatId: string): MessageRow[] {
  return all(db, "SELECT * FROM messages WHERE chat_id = ? AND state = 'pending' ORDER BY id", chatId).map(toMessage);
}

export function chatsWithPending(db: DB): string[] {
  return all(db, "SELECT DISTINCT chat_id FROM messages WHERE state = 'pending'").map((row) => row.chat_id as string);
}

export function markMessages(db: DB, ids: number[], state: "answered" | "handled", turnId?: string): void {
  for (const id of ids) run(db, "UPDATE messages SET state = ?, turn_id = ? WHERE id = ?", state, turnId ?? null, id);
}

export function setMessageText(db: DB, id: number, text: string, parts: Part[]): void {
  run(db, "UPDATE messages SET text = ?, parts = ? WHERE id = ?", text, parts.length ? JSON.stringify(parts) : null, id);
}

/**
 * The most recent messages since the last /reset that are not yet folded into
 * the summary, oldest first. Messages still waiting for an answer always come
 * last: a reply that went out after they arrived must not end up after them.
 */
export function history(db: DB, chatId: string, limit: number): MessageRow[] {
  return all(
    db,
    `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.chat_id = ? AND m.created_at > c.reset_at AND m.id > c.summarised_upto
     ORDER BY (m.state = 'pending') DESC, m.id DESC LIMIT ?`,
    chatId,
    limit,
  )
    .map(toMessage)
    .reverse();
}

export function lastAssistantMessage(db: DB, chatId: string): MessageRow | undefined {
  const row = get(db, "SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", chatId);
  return row ? toMessage(row) : undefined;
}

// --- turns -----------------------------------------------------------------

export function createTurn(db: DB, id: string, chatId: string, now: number): void {
  run(db, "INSERT INTO turns (id, chat_id, status, started_at) VALUES (?, ?, 'running', ?)", id, chatId, now);
}

export function updateTurn(
  db: DB,
  id: string,
  patch: {
    status: "running" | "sending" | "done" | "cancelled" | "failed";
    model?: string;
    slot?: string;
    llmCalls?: number;
    usage?: LLMUsage;
    error?: string;
  },
  now: number,
): void {
  const finished = patch.status === "done" || patch.status === "cancelled" || patch.status === "failed";
  run(
    db,
    `UPDATE turns SET status = ?, model = COALESCE(?, model), slot = COALESCE(?, slot),
       llm_calls = COALESCE(?, llm_calls), input_tokens = COALESCE(?, input_tokens),
       output_tokens = COALESCE(?, output_tokens), cached_tokens = COALESCE(?, cached_tokens),
       error = COALESCE(?, error), finished_at = ? WHERE id = ?`,
    patch.status,
    patch.model ?? null,
    patch.slot ?? null,
    patch.llmCalls ?? null,
    patch.usage?.inputTokens ?? null,
    patch.usage?.outputTokens ?? null,
    patch.usage?.cachedTokens ?? null,
    patch.error ?? null,
    finished ? now : null,
    id,
  );
}

// --- actions ---------------------------------------------------------------

export type ActionRow = {
  id: string;
  chatId: string;
  turnId: string | null;
  seq: number;
  afterMs: number;
  body: ActionBody;
  status: string;
};

const toAction = (row: Row): ActionRow => ({
  id: row.id,
  chatId: row.chat_id,
  turnId: row.turn_id,
  seq: row.seq,
  afterMs: row.after_ms,
  body: JSON.parse(row.body) as ActionBody,
  status: row.status,
});

export function insertAction(db: DB, a: Omit<ActionRow, "status">, now: number): void {
  run(
    db,
    "INSERT INTO actions (id, chat_id, turn_id, seq, after_ms, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    a.id,
    a.chatId,
    a.turnId,
    a.seq,
    a.afterMs,
    JSON.stringify(a.body),
    now,
    now,
  );
}

export function setActionStatus(
  db: DB,
  id: string,
  status: string,
  now: number,
  extra: { platformId?: string; error?: string } = {},
): void {
  run(
    db,
    "UPDATE actions SET status = ?, platform_id = COALESCE(?, platform_id), error = COALESCE(?, error), updated_at = ? WHERE id = ?",
    status,
    extra.platformId ?? null,
    extra.error ?? null,
    now,
    id,
  );
}

export function cancelPendingActions(db: DB, turnId: string, now: number): void {
  run(db, "UPDATE actions SET status = 'cancelled', updated_at = ? WHERE turn_id = ? AND status = 'pending'", now, turnId);
}

export function cancelIfPending(db: DB, ids: string[], now: number): void {
  for (const id of ids) {
    run(db, "UPDATE actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'", now, id);
  }
}

/**
 * Brings the outbox back to a safe state after a restart and returns the
 * replies that were part-way through being sent, grouped by turn.
 */
export function recoverOutbox(db: DB, now: number): { unknown: number; resume: Map<string, ActionRow[]> } {
  // "sending" means the bridge had started the Spectrum call and never reported
  // back. It may or may not have gone out, so it is not sent again.
  const unknown = Number(
    run(db, "UPDATE actions SET status = 'unknown', updated_at = ? WHERE status = 'sending'", now).changes,
  );
  // "dispatched" never reached the Spectrum call; it is safe to hand out again.
  run(db, "UPDATE actions SET status = 'pending', updated_at = ? WHERE status = 'dispatched'", now);
  // A turn that was still thinking is abandoned; its messages are still pending and get a fresh turn.
  const interrupted = all(db, "SELECT id FROM turns WHERE status = 'running'");
  for (const row of interrupted) {
    cancelPendingActions(db, row.id as string, now);
    updateTurn(db, row.id as string, { status: "failed", error: "interrupted by restart" }, now);
  }
  const resume = new Map<string, ActionRow[]>();
  const rows = all(
    db,
    `SELECT a.* FROM actions a JOIN turns t ON t.id = a.turn_id
     WHERE a.status = 'pending' AND t.status = 'sending' ORDER BY a.turn_id, a.seq`,
  ).map(toAction);
  for (const row of rows) {
    const list = resume.get(row.turnId!) ?? [];
    list.push(row);
    resume.set(row.turnId!, list);
  }
  // A turn whose reply had fully gone out just never got marked as finished.
  run(
    db,
    `UPDATE turns SET status = 'done', finished_at = ? WHERE status = 'sending'
       AND id NOT IN (SELECT turn_id FROM actions WHERE status = 'pending' AND turn_id IS NOT NULL)`,
    now,
  );
  // Anything else still pending (typing, read receipts, command replies) is stale by now.
  run(
    db,
    `UPDATE actions SET status = 'cancelled', updated_at = ?
     WHERE status = 'pending' AND (turn_id IS NULL OR turn_id NOT IN (SELECT id FROM turns WHERE status = 'sending'))`,
    now,
  );
  return { unknown, resume };
}

// --- usage ledger ----------------------------------------------------------

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export function addUsage(
  db: DB,
  now: number,
  slot: string,
  model: string,
  delta: Partial<LLMUsage> & { requests?: number; rateLimited?: number },
): void {
  run(
    db,
    `INSERT INTO usage (day, slot, model, requests, input_tokens, output_tokens, cached_tokens, rate_limited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, slot, model) DO UPDATE SET
       requests = requests + excluded.requests,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cached_tokens = cached_tokens + excluded.cached_tokens,
       rate_limited = rate_limited + excluded.rate_limited`,
    utcDay(now),
    slot,
    model,
    delta.requests ?? 0,
    delta.inputTokens ?? 0,
    delta.outputTokens ?? 0,
    delta.cachedTokens ?? 0,
    delta.rateLimited ?? 0,
  );
}

export type UsageRow = {
  slot: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  rateLimited: number;
};

export function usageForDay(db: DB, day: string): UsageRow[] {
  return all(db, "SELECT * FROM usage WHERE day = ? ORDER BY slot, model", day).map((row) => ({
    slot: row.slot,
    model: row.model,
    requests: row.requests,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    rateLimited: row.rate_limited,
  }));
}

// --- access ----------------------------------------------------------------

export function roleOf(db: DB, senderId: string): "owner" | "user" | undefined {
  return get(db, "SELECT role FROM allowlist WHERE sender_id = ?", senderId)?.role;
}

export function ownerCount(db: DB): number {
  return Number(get(db, "SELECT COUNT(*) AS n FROM allowlist WHERE role = 'owner'")?.n ?? 0);
}

export function allow(db: DB, senderId: string, role: "owner" | "user", now: number): void {
  run(
    db,
    "INSERT INTO allowlist (sender_id, role, added_at) VALUES (?, ?, ?) ON CONFLICT (sender_id) DO UPDATE SET role = excluded.role",
    senderId,
    role,
    now,
  );
}

export function disallow(db: DB, senderId: string): boolean {
  return run(db, "DELETE FROM allowlist WHERE sender_id = ? AND role != 'owner'", senderId).changes > 0;
}

export function listAllowed(db: DB): { senderId: string; role: string }[] {
  return all(db, "SELECT sender_id, role FROM allowlist ORDER BY role, added_at").map((row) => ({
    senderId: row.sender_id,
    role: row.role,
  }));
}

// --- failures --------------------------------------------------------------

/** Never throws: a failure that cannot be recorded must not take the caller down with it. */
export function recordFailure(db: DB, scope: string, ref: string | undefined, error: unknown, now: number): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    run(db, "INSERT INTO failures (scope, ref, error, created_at) VALUES (?, ?, ?, ?)", scope, ref ?? null, message.slice(0, 2000), now);
  } catch (err) {
    console.error("[failures] could not record", scope, ref, message, err);
  }
}

export function failureCount(db: DB, since: number): number {
  return Number(get(db, "SELECT COUNT(*) AS n FROM failures WHERE created_at >= ?", since)?.n ?? 0);
}

// --- rolling summary ---------------------------------------------------------

export function chatSummary(db: DB, chatId: string): string {
  return get(db, "SELECT summary FROM chats WHERE id = ?", chatId)?.summary ?? "";
}

/** Oldest messages still outside the summary, excluding any that are waiting for an answer. */
export function unsummarised(db: DB, chatId: string): MessageRow[] {
  return all(
    db,
    `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.chat_id = ? AND m.created_at > c.reset_at AND m.id > c.summarised_upto AND m.state != 'pending'
     ORDER BY m.id`,
    chatId,
  ).map(toMessage);
}

export function saveSummary(db: DB, chatId: string, summary: string, upto: number): void {
  run(db, "UPDATE chats SET summary = ?, summarised_upto = ? WHERE id = ? AND summarised_upto < ?", summary, upto, chatId, upto);
}

// --- facts -------------------------------------------------------------------

export type Fact = { id: number; text: string };

export function listFacts(db: DB, senderId: string): Fact[] {
  return all(db, "SELECT id, text FROM facts WHERE sender_id = ? ORDER BY id", senderId) as Fact[];
}

export function addFact(db: DB, senderId: string, text: string, now: number): void {
  const exists = get(db, "SELECT 1 AS x FROM facts WHERE sender_id = ? AND lower(text) = lower(?)", senderId, text);
  if (!exists) run(db, "INSERT INTO facts (sender_id, text, created_at) VALUES (?, ?, ?)", senderId, text, now);
}

/** Deletes facts containing `about` (case-insensitive), or every fact when `about` is "*". Returns what was removed. */
export function removeFacts(db: DB, senderId: string, about: string): Fact[] {
  const matches =
    about === "*"
      ? listFacts(db, senderId)
      : (all(db, "SELECT id, text FROM facts WHERE sender_id = ? AND instr(lower(text), lower(?)) > 0", senderId, about) as Fact[]);
  for (const fact of matches) run(db, "DELETE FROM facts WHERE id = ?", fact.id);
  return matches;
}

export function removeFactById(db: DB, senderId: string, id: number): boolean {
  return run(db, "DELETE FROM facts WHERE id = ? AND sender_id = ?", id, senderId).changes > 0;
}

// --- notes and lists ---------------------------------------------------------

const listName = (name: string) => name.trim().toLowerCase() || "notes";

export function addNotes(db: DB, senderId: string, list: string, items: string[], now: number): void {
  for (const item of items) {
    run(db, "INSERT INTO notes (sender_id, list, text, created_at) VALUES (?, ?, ?, ?)", senderId, listName(list), item, now);
  }
}

export function listNotes(db: DB, senderId: string, list: string): string[] {
  return all(db, "SELECT text FROM notes WHERE sender_id = ? AND list = ? ORDER BY id", senderId, listName(list)).map(
    (row) => row.text as string,
  );
}

export function listNames(db: DB, senderId: string): { list: string; count: number }[] {
  return all(db, "SELECT list, COUNT(*) AS count FROM notes WHERE sender_id = ? GROUP BY list ORDER BY list", senderId) as {
    list: string;
    count: number;
  }[];
}

/** Removes items containing `item` from a list, or the whole list when `item` is "*". Returns what was removed. */
export function removeNotes(db: DB, senderId: string, list: string, item: string): string[] {
  const rows =
    item === "*"
      ? all(db, "SELECT id, text FROM notes WHERE sender_id = ? AND list = ?", senderId, listName(list))
      : all(
          db,
          "SELECT id, text FROM notes WHERE sender_id = ? AND list = ? AND instr(lower(text), lower(?)) > 0",
          senderId,
          listName(list),
          item,
        );
  for (const row of rows) run(db, "DELETE FROM notes WHERE id = ?", row.id);
  return rows.map((row) => row.text as string);
}

// --- reminders ---------------------------------------------------------------

export type Reminder = { id: number; chatId: string; senderId: string; text: string; dueAt: number; repeat: string };

const toReminder = (row: Row): Reminder => ({
  id: row.id,
  chatId: row.chat_id,
  senderId: row.sender_id,
  text: row.text,
  dueAt: row.due_at,
  repeat: row.repeat,
});

export function addReminder(
  db: DB,
  r: { chatId: string; senderId: string; text: string; dueAt: number; repeat: string },
  now: number,
): number {
  const result = run(
    db,
    "INSERT INTO reminders (chat_id, sender_id, text, due_at, repeat, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    r.chatId,
    r.senderId,
    r.text,
    r.dueAt,
    r.repeat,
    now,
  );
  return Number(result.lastInsertRowid);
}

export function pendingReminders(db: DB, senderId: string): Reminder[] {
  return all(db, "SELECT * FROM reminders WHERE sender_id = ? AND status = 'pending' ORDER BY due_at", senderId).map(toReminder);
}

export function dueReminders(db: DB, now: number): Reminder[] {
  return all(db, "SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 20", now).map(toReminder);
}

/** Marks a reminder delivered, or moves it to its next occurrence when it repeats. */
export function settleReminder(db: DB, id: number, now: number, nextDueAt: number | null): void {
  if (nextDueAt === null) run(db, "UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?", now, id);
  else run(db, "UPDATE reminders SET due_at = ?, sent_at = ? WHERE id = ?", nextDueAt, now, id);
}

/** Cancels pending reminders by id or by words in their text. Returns what was cancelled. */
export function cancelReminders(db: DB, senderId: string, by: { id?: number; about?: string }): Reminder[] {
  const matches = pendingReminders(db, senderId).filter((r) =>
    by.id !== undefined ? r.id === by.id : by.about ? r.text.toLowerCase().includes(by.about.toLowerCase()) : false,
  );
  for (const r of matches) run(db, "UPDATE reminders SET status = 'cancelled' WHERE id = ?", r.id);
  return matches;
}

// --- recall ------------------------------------------------------------------

/** Full-text search over one chat's messages. Returns the best matches, newest first. */
export function searchMessages(db: DB, chatId: string, query: string, limit: number): MessageRow[] {
  // Quote each word so punctuation in the query cannot be read as FTS syntax.
  const terms = query.match(/[\p{L}\p{N}]+/gu)?.map((term) => `"${term}"`) ?? [];
  if (terms.length === 0) return [];
  return all(
    db,
    `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? AND m.chat_id = ? ORDER BY m.id DESC LIMIT ?`,
    terms.join(" OR "),
    chatId,
    limit,
  ).map(toMessage);
}

// --- reminder deliveries -------------------------------------------------------

export type Run = {
  id: number;
  reminderId: number;
  chatId: string;
  senderId: string;
  text: string;
  dueAt: number;
  sentAt: number;
  repeat: string;
  doneAt: number | null;
  snoozedAt: number | null;
};

const RUN_COLUMNS = "r.*, COALESCE((SELECT repeat FROM reminders WHERE id = r.reminder_id), 'none') AS repeat";
const toRun = (row: Row): Run => ({
  id: row.id,
  reminderId: row.reminder_id,
  chatId: row.chat_id,
  senderId: row.sender_id,
  text: row.text,
  dueAt: row.due_at,
  sentAt: row.sent_at,
  repeat: row.repeat,
  doneAt: row.done_at,
  snoozedAt: row.snoozed_at,
});

export function createRun(db: DB, reminder: Reminder, now: number): number {
  const result = run(
    db,
    "INSERT INTO reminder_runs (reminder_id, chat_id, sender_id, text, due_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
    reminder.id,
    reminder.chatId,
    reminder.senderId,
    reminder.text,
    reminder.dueAt,
    now,
  );
  return Number(result.lastInsertRowid);
}

export function setRunMessage(db: DB, runId: number, messageId: string, kind: "reminder" | "nudge"): void {
  const column = kind === "nudge" ? "nudge_message_id" : "message_id";
  run(db, `UPDATE reminder_runs SET ${column} = ? WHERE id = ?`, messageId, runId);
}

/** A tapback on one part of a message names it "p:0/<id>"; the delivery was recorded under the bare id. */
const bareMessageId = (id: string): string => id.replace(/^p:\d+\//, "");

/** The delivery whose bubble (or nudge) is the given message. */
export function runByMessage(db: DB, chatId: string, messageId: string): Run | undefined {
  const ids = [messageId, bareMessageId(messageId)];
  const row = get(
    db,
    `SELECT ${RUN_COLUMNS} FROM reminder_runs r
     WHERE r.chat_id = ? AND (r.message_id IN (?, ?) OR r.nudge_message_id IN (?, ?)) ORDER BY r.id DESC LIMIT 1`,
    chatId,
    ...ids,
    ...ids,
  );
  return row ? toRun(row) : undefined;
}

export function markRun(db: DB, runId: number, field: "done" | "snoozed" | "nudged", now: number): void {
  run(db, `UPDATE reminder_runs SET ${field}_at = ? WHERE id = ?`, now, runId);
}

/** Deliveries old enough to nudge about that nobody has acknowledged, snoozed or been nudged for. */
export function runsAwaitingNudge(db: DB, sentBefore: number): Run[] {
  return all(
    db,
    `SELECT ${RUN_COLUMNS} FROM reminder_runs r
     WHERE r.done_at IS NULL AND r.snoozed_at IS NULL AND r.nudged_at IS NULL
       AND r.message_id IS NOT NULL AND r.sent_at <= ? ORDER BY r.sent_at LIMIT 20`,
    sentBefore,
  ).map(toRun);
}

export function userMessagedSince(db: DB, chatId: string, since: number): boolean {
  return Boolean(get(db, "SELECT 1 AS x FROM messages WHERE chat_id = ? AND role = 'user' AND created_at > ? LIMIT 1", chatId, since));
}

/** How many deliveries in a row, counting back from the latest, were marked done. */
export function streak(db: DB, reminderId: number): number {
  const rows = all(db, "SELECT done_at FROM reminder_runs WHERE reminder_id = ? ORDER BY due_at DESC, id DESC LIMIT 400", reminderId);
  let count = 0;
  for (const row of rows) {
    if (row.done_at === null) break;
    count++;
  }
  return count;
}
