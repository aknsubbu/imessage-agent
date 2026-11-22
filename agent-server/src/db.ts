// SQLite through Node's built-in driver. Calls are synchronous, which keeps the
// per-chat turn logic free of interleaving between a read and the write that
// depends on it.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

// Append only. Each entry runs once, in order; `PRAGMA user_version` records how far a database has got.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    type TEXT NOT NULL,
    line TEXT NOT NULL,
    -- Messages older than this are left out of the model's context (/reset).
    reset_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Inbox journal: every inbound event exactly once.
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT,
    kind TEXT NOT NULL,
    outcome TEXT,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  -- Conversation history, both sides.
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,              -- user | assistant
    sender_id TEXT,
    text TEXT NOT NULL,
    parts TEXT,                      -- JSON media parts, when the message carried any
    platform_id TEXT,                -- Spectrum message id
    state TEXT NOT NULL,             -- user: pending | answered | handled   assistant: sent
    turn_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_chat ON messages (chat_id, id);
  CREATE INDEX messages_pending ON messages (state) WHERE state = 'pending';

  -- Turn ledger: one row per attempt to answer.
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    status TEXT NOT NULL,            -- running | sending | done | cancelled | failed
    model TEXT,
    slot TEXT,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );

  -- Outbox: everything the bridge is asked to do.
  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    turn_id TEXT,
    seq INTEGER NOT NULL,
    after_ms INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    status TEXT NOT NULL,            -- pending | dispatched | sending | sent | skipped | failed | cancelled | unknown
    platform_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX actions_turn ON actions (turn_id, seq);
  CREATE INDEX actions_status ON actions (status);

  -- Usage ledger: Groq reports no daily token count, so the server keeps its own.
  CREATE TABLE usage (
    day TEXT NOT NULL,               -- UTC date
    slot TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    rate_limited INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, slot, model)
  );

  CREATE TABLE allowlist (
    sender_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,              -- owner | user
    added_at INTEGER NOT NULL
  );

  CREATE TABLE failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    ref TEXT,
    error TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- Rolling summary of the part of a conversation that no longer fits in the prompt.
  ALTER TABLE chats ADD COLUMN summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE chats ADD COLUMN summarised_upto INTEGER NOT NULL DEFAULT 0;

  -- Lasting facts about a person. Scoped to the person, not the chat.
  CREATE TABLE facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX facts_sender ON facts (sender_id);

  -- Notes and lists ("shopping", "packing", "notes").
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    list TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notes_sender ON notes (sender_id, list);

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,           -- UTC ms
    repeat TEXT NOT NULL DEFAULT 'none', -- none | daily | weekdays | weekly
    status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | cancelled
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE INDEX reminders_due ON reminders (status, due_at);

  -- Full-text index over the conversation, for "what was that place I mentioned".
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  INSERT INTO messages_fts (rowid, text) SELECT id, text FROM messages;
  `,
  `
  -- One row each time a reminder is delivered, so it can be marked done,
  -- snoozed or nudged, and so a repeating reminder has a history to count streaks from.
  CREATE TABLE reminder_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    message_id TEXT,                 -- the delivered bubble, once the bridge confirms it
    nudge_message_id TEXT,
    done_at INTEGER,
    snoozed_at INTEGER,
    nudged_at INTEGER
  );
  CREATE INDEX reminder_runs_chat ON reminder_runs (chat_id, sent_at);
  CREATE INDEX reminder_runs_reminder ON reminder_runs (reminder_id, due_at);
  `,
  `
  -- How the agent talks to one person: a preset voice, an optional name of its
  -- own, a short note in their words, and whether it drifts toward their style.
  CREATE TABLE profiles (
    sender_id TEXT PRIMARY KEY,
    agent_name TEXT,
    preset TEXT NOT NULL DEFAULT 'friend',
    note TEXT NOT NULL DEFAULT '',
    mirror INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  -- An opt-in message each morning. last_sent_day is the local date it last went out.
  CREATE TABLE briefings (
    sender_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    time TEXT NOT NULL DEFAULT '08:00',
    city TEXT,
    lat REAL,
    lon REAL,
    fahrenheit INTEGER NOT NULL DEFAULT 0,
    last_sent_day TEXT
  );

  -- Things a person is working toward, and the days they moved them forward.
  CREATE TABLE goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    title TEXT NOT NULL,
    cadence TEXT NOT NULL DEFAULT 'daily',   -- daily | weekly | once
    status TEXT NOT NULL DEFAULT 'active',   -- active | done | dropped
    due_at INTEGER,                          -- an event to follow up on ("interview Thursday")
    followed_up_at INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX goals_sender ON goals (sender_id, status);

  CREATE TABLE goal_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX goal_logs_goal ON goal_logs (goal_id, at);

  -- One row per check-in bubble, so a thumbs-up or "yes" on it can be matched to its goal.
  CREATE TABLE goal_checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    message_id TEXT,
    answered_at INTEGER
  );
  CREATE INDEX goal_checkins_chat ON goal_checkins (chat_id, sent_at);

  -- When a person's daily check-in and Sunday review go out. Created with their first goal.
  CREATE TABLE checkins (
    sender_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    time TEXT NOT NULL DEFAULT '19:00',
    last_day TEXT,
    last_review_day TEXT
  );

  -- The copy of a local item in an outside app (Todoist, Notion), so it can be closed there too.
  CREATE TABLE external_refs (
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,                      -- reminder | list_item
    local_id INTEGER NOT NULL,
    remote_id TEXT NOT NULL,
    PRIMARY KEY (provider, kind, local_id)
  );
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = current; version < MIGRATIONS.length; version++) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
