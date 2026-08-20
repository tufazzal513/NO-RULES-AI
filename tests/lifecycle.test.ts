/**
 * End-to-end lifecycle test — the exact Render Free scenario.
 * ------------------------------------------------------------
 * 1. The user chats, adds knowledge/memory and trains the model.
 * 2. An automatic snapshot goes to the Telegram channel.
 * 3. Render wipes the disk (redeploy / wake from sleep) — a brand new,
 *    completely empty SQLite file appears.
 * 4. On startup the app restores from Telegram BEFORE the bot starts.
 * 5. The AI answers exactly as it did before: same memory, same knowledge,
 *    same trained model.
 *
 * Telegram is mocked, so this runs offline.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryDatabase, isDatabaseEmpty, tableCounts } from "../server/db.ts";
import { AIEngine } from "../server/ai/engine.ts";
import { CloudSync } from "../server/cloud-sync.ts";
import { MockTelegram } from "./mock-telegram.ts";

const logger = MockTelegram.silentLogger();
const flush = () => new Promise((r) => setTimeout(r, 10));

test("full Render lifecycle: use → snapshot → disk wipe → auto restore → AI works again", async () => {
  // ---- The Telegram private channel: the ONLY thing that survives. ----
  const channel = new MockTelegram();

  // =========================================================================
  // Phase 1 — the original container: the user works with the AI.
  // =========================================================================
  const db1 = createMemoryDatabase();
  const cloud1 = new CloudSync({ db: db1, telegram: channel, logger });
  const ai1 = new AIEngine(db1);
  ai1.setHooks({
    onMemoryChange: (row) => cloud1.mirror("memory", row.id ?? row.key, row),
    onModelChange: (row) => cloud1.mirror("ai_model", row.key, row),
  });

  await cloud1.runStartupRestore(); // first ever boot — nothing to restore
  assert.equal(cloud1.getState(), "ready");
  cloud1.markReady();

  // The user chats (this is what the /api/v1/ai/chat route does).
  const conv = db1.prepare("INSERT INTO conversations (title) VALUES ('My first chat')").run();
  const sid = Number(conv.lastInsertRowid);
  cloud1.mirror("conversations", sid, { id: sid, title: "My first chat" });

  for (const text of ["My name is Tufazzal", "I like building AI systems", "what is my name"]) {
    const um = db1
      .prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', ?)")
      .run(sid, text);
    cloud1.mirror("chat_messages", um.lastInsertRowid, { session_id: sid, role: "user", content: text });
    const reply = ai1.reply(text).reply;
    const am = db1
      .prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'ai', ?)")
      .run(sid, reply);
    cloud1.mirror("chat_messages", am.lastInsertRowid, { session_id: sid, role: "ai", content: reply });
  }

  // Knowledge + explicit memory + training.
  const k = db1
    .prepare("INSERT INTO knowledge (title, content) VALUES ('Rocket facts', 'The Saturn V rocket flew to the Moon.')")
    .run();
  cloud1.mirror("knowledge", k.lastInsertRowid, { title: "Rocket facts", content: "The Saturn V rocket flew to the Moon." });
  ai1.train();
  await flush();

  // The AI knows things now.
  assert.match(ai1.reply("what is my name").reply, /Tufazzal/);
  assert.match(ai1.reply("tell me about the Saturn V rocket").reply, /Saturn V/);
  assert.equal(ai1.status().trained, true);

  const beforeCounts = tableCounts(db1);
  assert.ok(beforeCounts.chat_messages >= 6);
  assert.equal(beforeCounts.knowledge, 1);
  assert.ok(beforeCounts.memory >= 2); // "name" + "likes"
  assert.equal(beforeCounts.ai_model, 1);

  // Mirrors reached the channel as individual records too.
  assert.ok(channel.recordsFor("memory").length >= 2);
  assert.equal(channel.recordsFor("knowledge").length, 1);
  assert.ok(channel.recordsFor("ai_model").length >= 1);

  // ---- The periodic snapshot fires. ----
  const snap = await cloud1.snapshot({ reason: "scheduled" });
  assert.equal(snap.success, true, snap.error);
  assert.ok(snap.checksum);
  assert.equal(channel.pinnedMessageId, snap.messageId, "the latest snapshot must be pinned");

  // ---- Render sends SIGTERM: best-effort final snapshot (nothing changed). ----
  const final = await cloud1.finalSnapshot(5000);
  assert.equal(final.success, true);
  assert.equal(final.skipped, true, "no changes since the scheduled snapshot");
  db1.close();

  // =========================================================================
  // Phase 2 — Render redeploys. The disk is GONE. A fresh container boots.
  // =========================================================================
  const db2 = createMemoryDatabase();
  assert.equal(isDatabaseEmpty(db2), true, "the new container starts with an empty database");

  const cloud2 = new CloudSync({ db: db2, telegram: channel, logger });
  assert.equal(cloud2.getState(), "starting");
  assert.equal(cloud2.isReady(), false, "the bot must not be polling yet");

  const restore = await cloud2.runStartupRestore();
  assert.equal(restore.success, true, restore.error || restore.reason);
  assert.equal(cloud2.getState(), "ready");
  assert.equal(cloud2.isReady(), true, "only now is it safe to start long-polling");

  // The AI brain is constructed AFTER the restore, exactly like server.ts does.
  const ai2 = new AIEngine(db2);

  // =========================================================================
  // Phase 3 — everything is back, byte for byte.
  // =========================================================================
  assert.deepEqual(tableCounts(db2), beforeCounts, "every table must be restored exactly");

  // Memory survived.
  assert.match(ai2.reply("what is my name").reply, /Tufazzal/);
  // Knowledge survived.
  assert.match(ai2.reply("tell me about the Saturn V rocket").reply, /Saturn V/);
  // The trained model survived.
  assert.equal(ai2.status().trained, true, "the trained Markov model must come back");
  assert.equal(ai2.status().knowledgeDocs, 1);
  assert.ok(ai2.status().memoryFacts >= 2);

  // Conversation history survived.
  const msgs = db2.prepare("SELECT content FROM chat_messages WHERE session_id = ? ORDER BY id").all(sid) as any[];
  assert.ok(msgs.length >= 6);
  assert.equal(msgs[0].content, "My name is Tufazzal");

  // A second restart in a row must be a no-op, not a duplicator.
  const again = await cloud2.runStartupRestore();
  assert.equal(again.skipped, true, "a populated DB is not restored over");
  assert.deepEqual(tableCounts(db2), beforeCounts, "no duplicate rows");

  db2.close();
});

test("a wiped container with an unreachable Telegram still serves the local AI", async () => {
  const channel = new MockTelegram();
  channel.failWith = new Error("connect ETIMEDOUT 149.154.167.220:443");

  const db = createMemoryDatabase();
  const cloud = new CloudSync({ db, telegram: channel, logger });

  const result = await cloud.runStartupRestore();
  assert.equal(result.success, false);
  assert.equal(cloud.getState(), "restore_failed");

  // The local brain still answers — Telegram being down is not fatal.
  const ai = new AIEngine(db);
  assert.ok(ai.reply("hello").reply.length > 0);
  assert.equal(ai.reply("2 + 2").reply, "The result is 4.");

  // And it can recover later once Telegram is reachable again.
  channel.failWith = null;
  const source = createMemoryDatabase();
  source.prepare("INSERT INTO memory (key, value) VALUES ('name', 'Tufazzal')").run();
  await new CloudSync({ db: source, telegram: channel, logger }).snapshot({ force: true });

  const retry = await cloud.restore({});
  assert.equal(retry.success, true, retry.error);
  assert.equal(cloud.getState(), "ready");
  assert.equal((db.prepare("SELECT value FROM memory WHERE key='name'").get() as any).value, "Tufazzal");
});
