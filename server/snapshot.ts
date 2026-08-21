/**
 * Snapshot engine — Telegram private channel as the permanent source of truth.
 * ---------------------------------------------------------------------------
 * Render Free has an ephemeral disk, so the local SQLite file is treated as a
 * *temporary cache*. The durable copy of everything (users, conversations,
 * chat_messages, knowledge, memory, ai_model, telegram_index) lives in the
 * Telegram private channel as gzipped JSON snapshot files.
 *
 * A snapshot document looks like:
 *
 * {
 *   "meta": {
 *     "schemaVersion": 2,
 *     "createdAt": "2026-08-20T10:00:00.000Z",
 *     "app": "NO-RULES-AI",
 *     "counts": { "users": 1, "conversations": 4, ... },
 *     "totalRecords": 128,
 *     "checksum": "<sha256 of the canonical JSON of `data`>"
 *   },
 *   "data": { "users": [...], "conversations": [...], ... }
 * }
 *
 * The checksum covers ONLY the `data` object, serialised canonically, so it can
 * be recomputed byte-for-byte after a download. A snapshot whose checksum does
 * not match, or whose structure is incomplete, is rejected and never restored.
 */

import crypto from "crypto";
import zlib from "zlib";
import {
  SNAPSHOT_TABLES,
  CORE_DATA_TABLES,
  tableColumns,
  type SnapshotTable,
} from "./db.ts";

export const SCHEMA_VERSION = 2;
export const APP_NAME = "NO-RULES-AI";

/**
 * Which tables a snapshot MUST contain, per schema version.
 *
 * This is what makes old backups restorable: a snapshot written before the
 * research cache existed (schema v1) simply has no `research_cache` /
 * `research_negcache` key, and rejecting it would strand the user's real data
 * in the channel forever. Missing tables from an older schema are treated as
 * empty; a table missing from a CURRENT-schema snapshot is still corruption.
 */
export const REQUIRED_TABLES_BY_VERSION: Record<number, readonly string[]> = {
  1: ["users", "conversations", "chat_messages", "knowledge", "memory", "ai_model", "telegram_index"],
  2: SNAPSHOT_TABLES,
};

/** The tables a snapshot of `version` is required to carry. */
export function requiredTables(version: number): readonly string[] {
  const known = REQUIRED_TABLES_BY_VERSION[version];
  if (known) return known;
  // Unknown but older-than-current version → be permissive, ask for the v1 core.
  return version < SCHEMA_VERSION ? REQUIRED_TABLES_BY_VERSION[1] : SNAPSHOT_TABLES;
}

export interface SnapshotMeta {
  schemaVersion: number;
  createdAt: string;
  app: string;
  counts: Record<string, number>;
  totalRecords: number;
  checksum: string;
  /** Set by the uploader once the file is fully in Telegram. */
  complete?: boolean;
}

export interface SnapshotDocument {
  meta: SnapshotMeta;
  data: Record<string, any[]>;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  totalRecords: number;
}

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so that
 * two logically identical dumps always produce the same bytes (and checksum).
 */
export function canonicalize(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

/** sha256 of the canonical form of the snapshot's `data` payload. */
export function computeChecksum(data: Record<string, any[]>): string {
  return crypto.createHash("sha256").update(canonicalize(data), "utf-8").digest("hex");
}

/** Dump EVERY snapshot table out of the local SQLite database. */
export function dumpAll(db: any): Record<string, any[]> {
  const dump: Record<string, any[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    try {
      dump[table] = db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      dump[table] = [];
    }
  }
  return dump;
}

/** Build a complete snapshot document (metadata + checksum) from the database. */
export function buildSnapshot(db: any): SnapshotDocument {
  const data = dumpAll(db);
  const counts: Record<string, number> = {};
  let totalRecords = 0;
  for (const table of SNAPSHOT_TABLES) {
    const n = Array.isArray(data[table]) ? data[table].length : 0;
    counts[table] = n;
    totalRecords += n;
  }
  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      app: APP_NAME,
      counts,
      totalRecords,
      checksum: computeChecksum(data),
      complete: true,
    },
    data,
  };
}

/**
 * Checksum over the CORE data tables only.
 *
 * `meta.checksum` covers the whole payload (integrity), but change-detection
 * must ignore `telegram_index`: taking a snapshot or mirroring a record appends
 * a pointer row there, which would otherwise make every database look "changed"
 * and defeat the "skip unnecessary snapshots" rule.
 */
export function coreChecksum(data: Record<string, any[]>): string {
  const subset: Record<string, any[]> = {};
  for (const table of CORE_DATA_TABLES) subset[table] = Array.isArray(data[table]) ? data[table] : [];
  return computeChecksum(subset);
}

/** Number of rows in the CORE (non-index) tables of a snapshot document. */
export function coreRecordCount(doc: SnapshotDocument): number {
  let n = 0;
  for (const table of CORE_DATA_TABLES) {
    const rows = doc.data?.[table];
    if (Array.isArray(rows)) n += rows.length;
  }
  return n;
}

/**
 * Validate a snapshot document: structure, schema version, every table present,
 * per-table counts, and finally the sha256 checksum. Anything suspicious is
 * rejected — a corrupt snapshot must never touch the database.
 */
export function validateSnapshot(doc: any): ValidationResult {
  if (!doc || typeof doc !== "object") {
    return { valid: false, reason: "Snapshot is not a JSON object.", totalRecords: 0 };
  }
  const meta = doc.meta;
  const data = doc.data;
  if (!meta || typeof meta !== "object") {
    return { valid: false, reason: "Snapshot metadata is missing.", totalRecords: 0 };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, reason: "Snapshot data section is missing.", totalRecords: 0 };
  }
  if (typeof meta.schemaVersion !== "number") {
    return { valid: false, reason: "Snapshot schema version is missing.", totalRecords: 0 };
  }
  if (meta.schemaVersion > SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `Snapshot schema version ${meta.schemaVersion} is newer than supported version ${SCHEMA_VERSION}.`,
      totalRecords: 0,
    };
  }
  if (meta.complete === false) {
    return { valid: false, reason: "Snapshot is marked incomplete.", totalRecords: 0 };
  }
  if (typeof meta.checksum !== "string" || meta.checksum.length !== 64) {
    return { valid: false, reason: "Snapshot checksum is missing or malformed.", totalRecords: 0 };
  }

  let totalRecords = 0;
  const required = requiredTables(meta.schemaVersion);
  for (const table of SNAPSHOT_TABLES) {
    const rows = data[table];
    if (rows === undefined || rows === null) {
      // Absent table: fatal only if this schema version promised to carry it.
      if (required.includes(table)) {
        return { valid: false, reason: `Snapshot is incomplete: table "${table}" is missing.`, totalRecords: 0 };
      }
      continue; // older snapshot — the table simply did not exist yet
    }
    if (!Array.isArray(rows)) {
      return { valid: false, reason: `Snapshot is corrupt: table "${table}" is not a list.`, totalRecords: 0 };
    }
    if (meta.counts && typeof meta.counts[table] === "number" && meta.counts[table] !== rows.length) {
      return {
        valid: false,
        reason: `Record count mismatch for "${table}" (meta says ${meta.counts[table]}, file has ${rows.length}).`,
        totalRecords: 0,
      };
    }
    totalRecords += rows.length;
  }

  if (typeof meta.totalRecords === "number" && meta.totalRecords !== totalRecords) {
    return {
      valid: false,
      reason: `Total record count mismatch (meta says ${meta.totalRecords}, file has ${totalRecords}).`,
      totalRecords: 0,
    };
  }

  const actual = computeChecksum(data);
  if (actual !== meta.checksum) {
    return {
      valid: false,
      reason: `Checksum mismatch — snapshot is corrupt (expected ${meta.checksum.slice(0, 12)}…, got ${actual.slice(0, 12)}…).`,
      totalRecords: 0,
    };
  }

  return { valid: true, totalRecords };
}

/**
 * Restore a validated snapshot into SQLite inside ONE transaction.
 * Either every table is replaced, or nothing changes at all.
 * Duplicate records are impossible because each table is cleared first and
 * rows are inserted with `INSERT OR REPLACE` on their original primary key.
 */
export function importDump(db: any, doc: SnapshotDocument): Record<string, number> {
  const restored: Record<string, number> = {};

  const run = db.transaction(() => {
    // Children first so foreign keys never dangle mid-transaction.
    for (const table of [...SNAPSHOT_TABLES].reverse()) {
      try {
        db.prepare(`DELETE FROM ${table}`).run();
      } catch {
        /* table may not exist in an older database */
      }
    }
    for (const table of SNAPSHOT_TABLES) {
      const rows = doc.data[table];
      restored[table] = 0;
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const allowed = new Set(tableColumns(db, table));
      if (allowed.size === 0) continue;
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const columns = Object.keys(row).filter((c) => allowed.has(c));
        if (columns.length === 0) continue;
        const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns
          .map(() => "?")
          .join(", ")})`;
        db.prepare(sql).run(...columns.map((c) => normalize(row[c])));
        restored[table]++;
      }
    }
  });

  run();
  return restored;
}

/** SQLite can only bind primitives — objects/booleans are coerced safely. */
function normalize(value: any): any {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/** Serialize + gzip a snapshot document, ready for upload. */
export function serializeSnapshot(doc: SnapshotDocument, gzip = true): { buffer: Buffer; fileName: string } {
  const json = Buffer.from(JSON.stringify(doc), "utf-8");
  const stamp = doc.meta.createdAt.replace(/[:.]/g, "-");
  if (!gzip) return { buffer: json, fileName: `myai_snapshot_${stamp}.json` };
  return { buffer: zlib.gzipSync(json), fileName: `myai_snapshot_${stamp}.json.gz` };
}

/** Parse a downloaded snapshot buffer (transparently handles gzip). */
export function parseSnapshotBuffer(buffer: Buffer): SnapshotDocument {
  let raw = buffer;
  // gzip magic number: 1f 8b
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    raw = zlib.gunzipSync(buffer);
  }
  return JSON.parse(raw.toString("utf-8"));
}

/** Human-friendly one-line summary used in the restore logs. */
export function describeSnapshot(doc: SnapshotDocument): string {
  const parts = SNAPSHOT_TABLES.map((t: SnapshotTable) => `${t}=${doc.data?.[t]?.length ?? 0}`);
  return `schema v${doc.meta.schemaVersion} · ${doc.meta.createdAt} · ${parts.join(" ")}`;
}
