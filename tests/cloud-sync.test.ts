/**
 * Automated tests for the Telegram cloud-database layer.
 * -------------------------------------------------------
 * Run with:  npm test
 *
 * Every Telegram network call is mocked (see mock-telegram.ts), so these tests
 * pass in a sandbox / CI where api.telegram.org is unreachable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_DATA_TABLES,
  SNAPSHOT_TABLES,
  createMemoryDatabase,
  isDatabaseEmpty,
  tableCounts,
} from "../server/db.ts";
import {
  buildSnapshot,
  computeChecksum,
  parseSnapshotBuffer,
  serializeSnapshot,
  validateSnapshot,
} from "../server/snapshot.ts";
import { CloudSync, parseBool } from "../server/cloud-sync.ts";
import { MockTelegram } from "./mock-telegram.ts";

const logger = MockTelegram.silentLogger();

/** Build a database populated with one row in every core table. */
function seededDb() {
  const db = createMemoryDatabase();
  db.prepare("INSERT INTO users (name, email) VALUES ('Admin', 'admin@myai.local')").run();
  db.prepare("INSERT INTO conversations (title, telegram_chat_id) VALUES ('First chat', '4242')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (1, 'user', 'hello there')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (1, 'ai', 'hi! how can I help?')").run();
  db.prepare("INSERT INTO knowledge (title, content) VALUES ('Doc', 'The sky is blue.')").run();
  db.prepare("INSERT INTO memory (key, value) VALUES ('name', 'Tufazzal')").run();
  db.prepare("INSERT INTO ai_model (key, value) VALUES ('markov', '{\"chains\":{}}')").run();
  db.prepare(
    "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES ('memory', '1', 7, NULL)"
  ).run();
  return db;
}

function makeSync(db: any, tg: MockTelegram, opts: Partial<ConstructorParameters<typeof CloudSync>[0]> = {}) {
  return new CloudSync({ db, telegram: tg, logger, ...opts });
}

// ---------------------------------------------------------------------------
// 1. Snapshot contains every table
// ---------------------------------------------------------------------------

test("snapshot includes every required table with metadata and checksum", () => {
  const db = seededDb();
  const doc = buildSnapshot(db);

  for (const table of SNAPSHOT_TABLES) {
    assert.ok(Array.isArray(doc.data[table]), `snapshot must contain table "${table}"`);
  }
  // Explicitly assert the tables the brief calls out.
  for (const table of ["users", "conversations", "chat_messages", "knowledge", "memory", "ai_model", "telegram_index"]) {
    assert.ok(table in doc.data, `${table} missing from snapshot`);
  }

  assert.equal(doc.meta.schemaVersion, 2);
  assert.ok(Date.parse(doc.meta.createdAt) > 0, "createdAt must be an ISO date");
  assert.equal(doc.meta.counts.users, 1);
  assert.equal(doc.meta.counts.chat_messages, 2);
  assert.equal(doc.meta.counts.ai_model, 1);
  assert.equal(doc.meta.totalRecords, 8);
  assert.equal(doc.meta.checksum.length, 64);
  assert.equal(doc.meta.checksum, computeChecksum(doc.data));
});

test("snapshot survives a gzip round-trip", () => {
  const db = seededDb();
  const doc = buildSnapshot(db);
  const { buffer, fileName } = serializeSnapshot(doc, true);

  assert.ok(fileName.endsWith(".json.gz"));
  assert.equal(buffer[0], 0x1f, "gzip magic byte 1");
  assert.equal(buffer[1], 0x8b, "gzip magic byte 2");

  const parsed = parseSnapshotBuffer(buffer);
  assert.deepEqual(parsed.data, doc.data);
  assert.equal(validateSnapshot(parsed).valid, true);
});

// ---------------------------------------------------------------------------
// 2. Checksum validation + corrupt snapshot rejection
// ---------------------------------------------------------------------------

test("checksum validation accepts a good snapshot", () => {
  const doc = buildSnapshot(seededDb());
  const result = validateSnapshot(doc);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.totalRecords, 8);
});

test("checksum mismatch is rejected", () => {
  const doc = buildSnapshot(seededDb());
  doc.data.knowledge.push({ id: 99, title: "smuggled", content: "not in the checksum" });
  const result = validateSnapshot(doc);
  assert.equal(result.valid, false);
  assert.match(String(result.reason), /count mismatch|Checksum mismatch/i);
});

test("tampered checksum field is rejected", () => {
  const doc = buildSnapshot(seededDb());
  doc.meta.checksum = "0".repeat(64);
  const result = validateSnapshot(doc);
  assert.equal(result.valid, false);
  assert.match(String(result.reason), /Checksum mismatch/);
});

test("corrupt / incomplete snapshots are rejected", () => {
  const base = buildSnapshot(seededDb());

  assert.equal(validateSnapshot(null).valid, false);
  assert.equal(validateSnapshot({}).valid, false);
  assert.equal(validateSnapshot({ meta: base.meta }).valid, false);

  // Missing table
  const missing = JSON.parse(JSON.stringify(base));
  delete missing.data.memory;
  const r1 = validateSnapshot(missing);
  assert.equal(r1.valid, false);
  assert.match(String(r1.reason), /memory/);

  // Count mismatch in the metadata
  const badCount = JSON.parse(JSON.stringify(base));
  badCount.meta.counts.users = 99;
  assert.equal(validateSnapshot(badCount).valid, false);

  // Explicitly incomplete upload
  const incomplete = JSON.parse(JSON.stringify(base));
  incomplete.meta.complete = false;
  assert.equal(validateSnapshot(incomplete).valid, false);

  // Newer schema than we understand
  const future = JSON.parse(JSON.stringify(base));
  future.meta.schemaVersion = 999;
  assert.equal(validateSnapshot(future).valid, false);
});

test("a corrupt snapshot downloaded from Telegram never touches the database", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  const uploader = makeSync(source, tg);
  const up = await uploader.snapshot({ force: true });
  assert.equal(up.success, true);

  // Corrupt the stored bytes after the upload.
  tg.corruptFile(up.fileId!, (doc) => {
    doc.data.knowledge = [{ id: 1, title: "evil", content: "corrupted" }];
    return doc;
  });

  const target = seededDb();
  target.prepare("DELETE FROM knowledge").run();
  target.prepare("INSERT INTO knowledge (title, content) VALUES ('local', 'precious local data')").run();
  const sync = makeSync(target, tg);

  const result = await sync.restore({ fileId: up.fileId, force: true });
  assert.equal(result.success, false);
  assert.match(String(result.error), /rejected|Checksum mismatch/i);
  assert.equal(sync.getState(), "restore_failed");

  // Local data intact.
  const rows = target.prepare("SELECT content FROM knowledge").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "precious local data");
});

// ---------------------------------------------------------------------------
// 3. Empty database auto-restore
// ---------------------------------------------------------------------------

test("startup restores automatically into an empty database", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  const up = await makeSync(source, tg).snapshot({ force: true });
  assert.equal(up.success, true);

  const fresh = createMemoryDatabase();
  assert.equal(isDatabaseEmpty(fresh), true);

  const sync = makeSync(fresh, tg, { autoRestore: true, restoreOnEmptyOnly: true });
  const result = await sync.runStartupRestore();

  assert.equal(result.success, true, result.error || result.reason);
  assert.equal(sync.getState(), "ready");

  const counts = tableCounts(fresh);
  assert.equal(counts.users, 1);
  assert.equal(counts.conversations, 1);
  assert.equal(counts.chat_messages, 2);
  assert.equal(counts.knowledge, 1);
  assert.equal(counts.memory, 1);
  assert.equal(counts.ai_model, 1);
  assert.equal(counts.telegram_index, 1);

  // Content really came across, not just the row count.
  const mem = fresh.prepare("SELECT key, value FROM memory").get() as any;
  assert.equal(mem.key, "name");
  assert.equal(mem.value, "Tufazzal");
  const model = fresh.prepare("SELECT value FROM ai_model WHERE key = 'markov'").get() as any;
  assert.equal(model.value, '{"chains":{}}');
});

test("restore discovers the latest snapshot through the pinned message", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  const uploader = makeSync(source, tg);
  await uploader.snapshot({ force: true });

  // Second, newer snapshot — this one must win.
  source.prepare("INSERT INTO knowledge (title, content) VALUES ('Newer', 'second doc')").run();
  const second = await uploader.snapshot({ force: true });
  assert.equal(second.success, true);
  assert.equal(tg.pinnedMessageId, second.messageId);

  const fresh = createMemoryDatabase();
  const sync = makeSync(fresh, tg);
  const result = await sync.restore({});
  assert.equal(result.success, true);
  assert.equal(result.fileId, second.fileId);
  assert.equal((tableCounts(fresh) as any).knowledge, 2);
});

test("auto restore is skipped when disabled", async () => {
  const tg = new MockTelegram();
  await makeSync(seededDb(), tg).snapshot({ force: true });

  const fresh = createMemoryDatabase();
  const sync = makeSync(fresh, tg, { autoRestore: false });
  const result = await sync.runStartupRestore();

  assert.equal(result.skipped, true);
  assert.equal(sync.getState(), "ready");
  assert.equal(isDatabaseEmpty(fresh), true);
});

test("first ever boot with no snapshot in the channel still becomes ready", async () => {
  const tg = new MockTelegram();
  const fresh = createMemoryDatabase();
  const sync = makeSync(fresh, tg);
  const result = await sync.runStartupRestore();

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(sync.getState(), "ready", "an empty channel is a normal first boot");
});

// ---------------------------------------------------------------------------
// 4. Non-empty database overwrite prevention
// ---------------------------------------------------------------------------

test("TELEGRAM_RESTORE_ON_EMPTY_ONLY prevents overwriting a non-empty database", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  await makeSync(source, tg).snapshot({ force: true });

  const local = createMemoryDatabase();
  local.prepare("INSERT INTO knowledge (title, content) VALUES ('local only', 'do not lose me')").run();

  const sync = makeSync(local, tg, { restoreOnEmptyOnly: true });
  const result = await sync.runStartupRestore();

  assert.equal(result.skipped, true);
  assert.match(String(result.reason), /not empty/i);
  assert.equal(sync.getState(), "ready");

  const rows = local.prepare("SELECT title FROM knowledge").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "local only");
});

test("an empty remote snapshot never wipes a non-empty local database", async () => {
  const emptySource = createMemoryDatabase();
  const tg = new MockTelegram();
  const up = await makeSync(emptySource, tg).snapshot({ force: true });
  assert.equal(up.success, true);
  assert.equal(up.totalRecords, 0);

  const local = seededDb();
  const sync = makeSync(local, tg);
  // force:true would normally allow an overwrite — the empty-snapshot guard wins.
  const result = await sync.restore({ fileId: up.fileId, force: true });

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.match(String(result.reason), /empty/i);
  assert.equal((tableCounts(local) as any).chat_messages, 2, "local messages must survive");
});

test("duplicate restore of the same snapshot is prevented", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  const up = await makeSync(source, tg).snapshot({ force: true });

  const target = createMemoryDatabase();
  const sync = makeSync(target, tg);

  const first = await sync.restore({ fileId: up.fileId });
  assert.equal(first.success, true);
  assert.equal(first.skipped, undefined);

  const second = await sync.restore({ fileId: up.fileId });
  assert.equal(second.success, true);
  assert.equal(second.skipped, true, "the same snapshot must not be applied twice");

  // And no duplicated rows either way.
  assert.equal((tableCounts(target) as any).chat_messages, 2);
});

test("restoring twice with force produces no duplicate rows", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  const up = await makeSync(source, tg).snapshot({ force: true });

  const target = createMemoryDatabase();
  const sync = makeSync(target, tg);
  await sync.restore({ fileId: up.fileId, force: true });
  await sync.restore({ fileId: up.fileId, force: true });

  const counts = tableCounts(target);
  assert.equal(counts.users, 1);
  assert.equal(counts.chat_messages, 2);
  assert.equal(counts.knowledge, 1);
  assert.equal(counts.memory, 1);
});

// ---------------------------------------------------------------------------
// 5. Concurrency locks
// ---------------------------------------------------------------------------

test("two concurrent snapshots cannot run at once", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  tg.uploadDelayMs = 60;
  const sync = makeSync(db, tg);

  const [a, b] = await Promise.all([sync.snapshot({ force: true }), sync.snapshot({ force: true })]);

  const succeeded = [a, b].filter((r) => r.success && !r.skipped);
  const blocked = [a, b].filter((r) => r.skipped && /already running/i.test(String(r.reason)));
  assert.equal(succeeded.length, 1, "exactly one snapshot may upload");
  assert.equal(blocked.length, 1, "the second must be refused by the lock");
  assert.equal(tg.uploads, 1, "only one file may reach Telegram");
});

test("a snapshot cannot start while a restore is running, and vice versa", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  const up = await makeSync(source, tg).snapshot({ force: true });

  const db = createMemoryDatabase();
  const sync = makeSync(db, tg);

  // Kick off a restore and try to snapshot in the same tick.
  const restorePromise = sync.restore({ fileId: up.fileId });
  const snap = await sync.snapshot({ force: true });
  assert.equal(snap.skipped, true);
  assert.match(String(snap.reason), /restore/i);
  await restorePromise;

  // The reverse: block a restore while a slow snapshot uploads.
  tg.uploadDelayMs = 60;
  const snapPromise = sync.snapshot({ force: true });
  const restore = await sync.restore({ fileId: up.fileId, force: true });
  assert.equal(restore.skipped, true);
  assert.match(String(restore.reason), /snapshot is running/i);
  await snapPromise;
});

test("an unchanged database skips the periodic snapshot", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  const sync = makeSync(db, tg);

  const first = await sync.snapshot({ reason: "scheduled" });
  assert.equal(first.success, true);
  assert.equal(first.skipped, undefined);

  const second = await sync.snapshot({ reason: "scheduled" });
  assert.equal(second.success, true);
  assert.equal(second.skipped, true, "nothing changed → no upload");
  assert.equal(tg.uploads, 1);

  // A real change must produce a new snapshot again.
  db.prepare("INSERT INTO knowledge (title, content) VALUES ('new', 'fresh content')").run();
  const third = await sync.snapshot({ reason: "scheduled" });
  assert.equal(third.skipped, undefined);
  assert.equal(tg.uploads, 2);
});

// ---------------------------------------------------------------------------
// 6. Restore-before-bot-start / application state machine
// ---------------------------------------------------------------------------

test("state machine: starting → restoring → ready, and the bot waits for it", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  await makeSync(source, tg).snapshot({ force: true });

  const fresh = createMemoryDatabase();
  const sync = makeSync(fresh, tg);
  assert.equal(sync.getState(), "starting");
  assert.equal(sync.isReady(), false, "the bot must not start before the restore");

  const seen: string[] = [];
  const startupPromise = sync.runStartupRestore();
  seen.push(sync.getState()); // observed synchronously while the download is pending
  await startupPromise;
  seen.push(sync.getState());

  assert.ok(seen.includes("restoring"), `expected a 'restoring' phase, saw ${seen.join(" → ")}`);
  assert.equal(sync.getState(), "ready");
  assert.equal(sync.isReady(), true, "only now may long-polling start");
  assert.equal(sync.isRestoring(), false);
});

test("chat requests are blocked with 503 semantics while restoring", async () => {
  const source = seededDb();
  const tg = new MockTelegram();
  const up = await makeSync(source, tg).snapshot({ force: true });

  const fresh = createMemoryDatabase();
  const sync = makeSync(fresh, tg);
  const pending = sync.restore({ fileId: up.fileId });

  // This is exactly what the express guard checks before answering 503.
  assert.equal(sync.isRestoring(), true);
  assert.equal(sync.isReady(), false);

  await pending;
  assert.equal(sync.isRestoring(), false);
  assert.equal(sync.isReady(), true);
});

test("a failed restore leaves the app in restore_failed so the bot stays off", async () => {
  const tg = new MockTelegram();
  const source = seededDb();
  const up = await makeSync(source, tg).snapshot({ force: true });
  tg.corruptFile(up.fileId!, (doc) => {
    doc.meta.checksum = "f".repeat(64);
    return doc;
  });

  const fresh = createMemoryDatabase();
  const sync = makeSync(fresh, tg);
  const result = await sync.runStartupRestore();

  assert.equal(result.success, false);
  assert.equal(sync.getState(), "restore_failed");
  assert.equal(sync.isReady(), false, "the Telegram bot must NOT start after a failed restore");
});

test("status payload exposes everything the UI needs", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  const sync = makeSync(db, tg, { snapshotIntervalMinutes: 30 });
  await sync.snapshot({ force: true });
  sync.markReady();

  const s = sync.statusPayload();
  assert.equal(s.state, "ready");
  assert.equal(s.autoRestoreEnabled, true);
  assert.equal(s.autoSnapshotEnabled, true);
  assert.equal(s.snapshotIntervalMinutes, 30);
  assert.ok(s.lastSnapshotAt, "lastSnapshotAt must be set after a snapshot");
  assert.ok(s.latestSnapshotFileId, "latestSnapshotFileId must be set");
  assert.equal(s.snapshotInProgress, false);
  assert.equal(s.restoreInProgress, false);
  assert.equal(s.lastError, null);
  assert.equal(s.tableCounts.chat_messages, 2);
  assert.ok("lastRestoreAt" in s);
  assert.ok("nextSnapshotAt" in s);
});

// ---------------------------------------------------------------------------
// 7. Mirroring (memory / knowledge / ai_model) and delete tombstones
// ---------------------------------------------------------------------------

/** Mirroring is fire-and-forget, so let the microtask queue drain. */
const flush = () => new Promise((r) => setTimeout(r, 10));

test("memory, knowledge and ai_model changes are mirrored to Telegram", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  const sync = makeSync(db, tg);

  sync.mirror("memory", 1, { id: 1, key: "name", value: "Tufazzal" });
  sync.mirror("knowledge", 5, { id: 5, title: "Doc", content: "The sky is blue." });
  sync.mirror("ai_model", "markov", { key: "markov", value: '{"chains":{}}' });
  await flush();

  assert.equal(tg.recordsFor("memory").length, 1);
  assert.equal(tg.recordsFor("knowledge").length, 1);
  assert.equal(tg.recordsFor("ai_model").length, 1);

  const mem = tg.recordsFor("memory")[0];
  assert.equal(mem.payload.operation, "upsert");
  assert.equal(mem.payload.collection, "memory");
  assert.equal(mem.payload.record_id, "1");
  assert.equal(mem.payload.value, "Tufazzal");

  // And each mirrored record is indexed locally.
  const indexed = db
    .prepare("SELECT collection FROM telegram_index WHERE collection IN ('memory','knowledge','ai_model')")
    .all() as any[];
  assert.equal(indexed.length, 4); // 3 new + 1 seeded
});

test("deletes emit a tombstone message in the required shape", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  const sync = makeSync(db, tg);

  sync.mirrorDelete("knowledge", 123);
  sync.mirrorDelete("memory", 7);
  await flush();

  const tomb = tg.recordsFor("knowledge_tombstone");
  assert.equal(tomb.length, 1);
  assert.deepEqual(Object.keys(tomb[0].payload).sort(), ["collection", "deleted_at", "operation", "record_id"]);
  assert.equal(tomb[0].payload.operation, "delete");
  assert.equal(tomb[0].payload.collection, "knowledge");
  assert.equal(tomb[0].payload.record_id, "123");
  assert.ok(Date.parse(tomb[0].payload.deleted_at) > 0, "deleted_at must be an ISO date");

  assert.equal(tg.recordsFor("memory_tombstone").length, 1);
  assert.equal(tg.recordsFor("memory_tombstone")[0].payload.record_id, "7");
});

test("memory, knowledge and ai_model are also inside the full snapshot", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  const sync = makeSync(db, tg);
  const up = await sync.snapshot({ force: true });

  const doc = parseSnapshotBuffer(tg.files.get(up.fileId!)!.content);
  assert.equal(doc.data.memory.length, 1);
  assert.equal(doc.data.knowledge.length, 1);
  assert.equal(doc.data.ai_model.length, 1);
  assert.equal(doc.data.memory[0].value, "Tufazzal");
  assert.equal(doc.data.ai_model[0].key, "markov");
});

// ---------------------------------------------------------------------------
// 8. Telegram unavailable → the app keeps working
// ---------------------------------------------------------------------------

test("Telegram failures never throw into the app", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  tg.failWith = new Error("getaddrinfo ENOTFOUND api.telegram.org");
  const sync = makeSync(db, tg);

  const snap = await sync.snapshot({ force: true });
  assert.equal(snap.success, false);
  assert.match(String(snap.error), /ENOTFOUND/);

  // Mirroring must swallow the error (no unhandled rejection).
  sync.mirror("memory", 1, { key: "name", value: "x" });
  sync.mirrorDelete("knowledge", 1);
  await flush();

  // And startup still ends in a usable state with the local data untouched.
  const startup = await sync.runStartupRestore();
  assert.equal(startup.success, false);
  assert.equal((tableCounts(db) as any).chat_messages, 2);
});

test("an unconfigured Telegram setup degrades gracefully", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  tg.configured = false;
  const sync = makeSync(db, tg);

  const startup = await sync.runStartupRestore();
  assert.equal(startup.skipped, true);
  assert.equal(sync.getState(), "ready", "the local AI must still serve requests");

  const snap = await sync.snapshot({ force: true });
  assert.equal(snap.skipped, true);
  sync.mirror("memory", 1, { key: "a", value: "b" });
  await flush();
  assert.equal(tg.records.length, 0);
});

test("the shutdown snapshot is best-effort and bounded by a timeout", async () => {
  const db = seededDb();
  const tg = new MockTelegram();
  tg.uploadDelayMs = 500;
  const sync = makeSync(db, tg);

  const started = Date.now();
  const result = await sync.finalSnapshot(80);
  const elapsed = Date.now() - started;

  assert.equal(result.success, false);
  assert.match(String(result.error), /timed out/i);
  assert.ok(elapsed < 400, `finalSnapshot must respect its timeout (took ${elapsed}ms)`);
});

// ---------------------------------------------------------------------------
// 9. Misc helpers
// ---------------------------------------------------------------------------

test("isDatabaseEmpty ignores the local-only telegram_index table", () => {
  const db = createMemoryDatabase();
  assert.equal(isDatabaseEmpty(db), true);

  db.prepare(
    "INSERT INTO telegram_index (collection, record_id, telegram_message_id) VALUES ('memory','1',1)"
  ).run();
  assert.equal(isDatabaseEmpty(db), true, "a pointer row is not real AI data");

  db.prepare("INSERT INTO memory (key, value) VALUES ('k','v')").run();
  assert.equal(isDatabaseEmpty(db), false);
  assert.ok(CORE_DATA_TABLES.includes("memory"));
});

test("parseBool reads the environment flags correctly", () => {
  assert.equal(parseBool("true", false), true);
  assert.equal(parseBool("TRUE", false), true);
  assert.equal(parseBool("1", false), true);
  assert.equal(parseBool("false", true), false);
  assert.equal(parseBool("0", true), false);
  assert.equal(parseBool("off", true), false);
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool("", true), true);
  assert.equal(parseBool("garbage", true), true);
});
