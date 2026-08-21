/**
 * Shared SQLite schema + helpers.
 * --------------------------------
 * Extracted out of `server.ts` so that the snapshot/restore engine and the
 * automated tests can create an identical database (including in-memory ones)
 * without booting the whole HTTP server.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

/**
 * Every table that belongs to the permanent Telegram snapshot.
 * Order matters: parents first (used for insert order during a restore).
 */
export const SNAPSHOT_TABLES = [
  "users",
  "conversations",
  "chat_messages",
  "knowledge",
  "memory",
  "ai_model",
  "research_cache",
  "research_negcache",
  "telegram_index",
] as const;

export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/**
 * Tables that carry real AI data. `telegram_index` is only a local pointer
 * table, so it is deliberately excluded when deciding "is this DB empty?".
 */
export const CORE_DATA_TABLES: SnapshotTable[] = [
  "users",
  "conversations",
  "chat_messages",
  "knowledge",
  "memory",
  "ai_model",
];

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    telegram_chat_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    role TEXT CHECK(role IN ('user', 'ai')),
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'web',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS telegram_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    telegram_message_id INTEGER,
    telegram_file_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ai_model (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Permanent cache for online research answers. Lives in the Telegram
  -- snapshot too, so findings survive Render restarts and can be answered
  -- again even with no internet at all.
  CREATE TABLE IF NOT EXISTS research_cache (
    key TEXT PRIMARY KEY,
    topic TEXT,
    result TEXT,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Negative cache: topics that were searched cleanly and had NO answer.
  -- Remembered briefly so repeated questions don't hammer the public sources
  -- (and therefore don't trip their rate limits). Snapshot table too.
  CREATE TABLE IF NOT EXISTS research_negcache (
    key TEXT PRIMARY KEY,
    topic TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Local-only bookkeeping (never part of a snapshot): remembers the last
  -- snapshot/restore checksums so we can skip no-op snapshots and refuse to
  -- restore the very same snapshot twice.
  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

/** Create every table (idempotent) and run the small in-place migrations. */
export function applySchema(db: any): void {
  db.exec(SCHEMA_SQL);

  const ensureColumn = (table: string, column: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  ensureColumn("conversations", "telegram_chat_id", "telegram_chat_id TEXT");
  // Where a chat message came from: 'web' | 'training' | 'telegram'.
  ensureColumn("chat_messages", "source", "source TEXT NOT NULL DEFAULT 'web'");
}

/** Resolve DATABASE_URL (`sqlite:///…`) into a real filesystem path. */
export function resolveDbPath(databaseUrl?: string, cwd = process.cwd()): string {
  if (!databaseUrl) return path.join(cwd, "myai.db");
  let customPath = databaseUrl;
  if (customPath.startsWith("sqlite:///")) {
    customPath = customPath.replace("sqlite:///", "");
  } else if (customPath.startsWith("sqlite://")) {
    customPath = customPath.replace("sqlite://", "");
  }
  return path.resolve(cwd, customPath);
}

/** Open (creating the folder if needed) a SQLite database with the schema applied. */
export function openDatabase(dbPath: string): any {
  if (dbPath !== ":memory:") {
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  applySchema(db);
  return db;
}

/** Read a local-only bookkeeping value. */
export function getSyncState(db: any, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as any;
    return row ? row.value : null;
  } catch {
    return null;
  }
}

/** Write a local-only bookkeeping value. */
export function setSyncState(db: any, key: string, value: string): void {
  try {
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    ).run(key, value);
  } catch {
    /* bookkeeping is best-effort only */
  }
}

/** Create a throwaway in-memory database — used by the automated tests. */
export function createMemoryDatabase(): any {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

/** Column names of a table, in declaration order. */
export function tableColumns(db: any, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } catch {
    return [];
  }
}

/** Row counts for every snapshot table (missing tables count as 0). */
export function tableCounts(db: any, tables: readonly string[] = SNAPSHOT_TABLES): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    try {
      counts[table] = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c) || 0;
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

/**
 * A database is "fresh/empty" when none of the CORE data tables hold a row.
 * A brand new Render container after a restart looks exactly like this.
 */
export function isDatabaseEmpty(db: any): boolean {
  const counts = tableCounts(db, CORE_DATA_TABLES);
  return Object.values(counts).every((n) => n === 0);
}
