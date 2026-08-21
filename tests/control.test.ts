/**
 * Automated tests for the control-panel support modules:
 * admin gate (auth), dataset statistics, in-memory logs.
 * ------------------------------------------------------------
 * All pure/unit — no network, no Telegram.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createAdminGate, adminTokenFrom } from "../server/auth.ts";
import { datasetStats } from "../server/dataset.ts";
import { pushLog, recentLogs } from "../server/logs.ts";
import { createMemoryDatabase } from "../server/db.ts";

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

test("without ADMIN_PASSWORD everything is open (single-user panel)", () => {
  const gate = createAdminGate(undefined);
  assert.equal(gate.required, false);
  assert.equal(gate.check(undefined), true);
  assert.equal(gate.check("anything"), true);
});

test("with ADMIN_PASSWORD the gate accepts only the exact password", () => {
  const gate = createAdminGate("  s3cret!  "); // whitespace is trimmed
  assert.equal(gate.required, true);
  assert.equal(gate.check("s3cret!"), true);
  assert.equal(gate.check("s3cret"), false);
  assert.equal(gate.check("S3CRET!"), false);
  assert.equal(gate.check(undefined), false);
  assert.equal(gate.check(""), false);
});

test("empty ADMIN_PASSWORD behaves like unset", () => {
  const gate = createAdminGate("   ");
  assert.equal(gate.required, false);
});

test("adminTokenFrom reads only the x-admin-token header", () => {
  const req = (h: Record<string, string | string[]>) => ({ header: (n: string) => h[n] });
  assert.equal(adminTokenFrom(req({ "x-admin-token": "abc" })), "abc");
  assert.equal(adminTokenFrom(req({ "x-admin-token": ["a", "b"] })), "a");
  assert.equal(adminTokenFrom(req({})), undefined);
});

// ---------------------------------------------------------------------------
// Dataset stats — the "2 places" training data comes from
// ---------------------------------------------------------------------------

test("dataset stats count chat pairs and break messages down by source", () => {
  const db = createMemoryDatabase();
  db.prepare("INSERT INTO conversations (title) VALUES ('web chat')").run();
  db.prepare("INSERT INTO conversations (title) VALUES ('training chat')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (1, 'user', 'hi', 'web')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (1, 'ai', 'hello', 'web')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (1, 'user', 'what is 2+2', 'web')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (1, 'ai', '4', 'web')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (2, 'user', 'my name is T', 'training')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (2, 'ai', 'hi T', 'training')").run();
  db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (2, 'user', 'hello from telegram', 'telegram')").run();
  db.prepare("INSERT INTO knowledge (title, content) VALUES ('Research: moon', 'The Moon orbits Earth.')").run();

  const s = datasetStats(db);
  assert.equal(s.conversations, 2);
  assert.equal(s.totalMessages, 7);
  assert.equal(s.userMessages, 4);
  assert.equal(s.aiMessages, 3);
  assert.equal(s.pairs, 3);
  assert.deepEqual(s.bySource, { web: 4, training: 2, telegram: 1 });
  assert.equal(s.knowledgeDocs, 1);
  assert.equal(s.researchFindings, 1);
});

// ---------------------------------------------------------------------------
// Logs ring buffer
// ---------------------------------------------------------------------------

test("logs keep newest first and never leak more than the limit", () => {
  for (let i = 1; i <= 12; i++) pushLog("info", "test", `entry ${i}`);
  const logs = recentLogs(10);
  assert.equal(logs.length, 10);
  assert.equal(logs[0].message, "entry 12", "newest first");
  assert.equal(logs[9].message, "entry 3");
  assert.equal(logs[0].source, "test");
  assert.equal(logs[0].level, "info");
});
