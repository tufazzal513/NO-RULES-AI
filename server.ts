import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import { TelegramStorage } from "./server/telegram.ts";
import { TelegramBot, type TelegramMessage } from "./server/telegram-bot.ts";
import { AIEngine } from "./server/ai/engine.ts";
import { openDatabase, resolveDbPath, SNAPSHOT_TABLES } from "./server/db.ts";
import { buildSnapshot, serializeSnapshot } from "./server/snapshot.ts";
import { CloudSync, parseBool } from "./server/cloud-sync.ts";

// Initialize express app
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Initialize SQLite Database (temporary cache — Telegram is the source of truth)
const dbPath = resolveDbPath(process.env.DATABASE_URL);

let db: any;
try {
  db = openDatabase(dbPath);
  console.log("Connected to SQLite database at", dbPath);
} catch (err) {
  console.error("Error opening database:", err);
}

// Initialize Telegram Cloud Storage
const telegram = new TelegramStorage({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_STORAGE_CHAT_ID,
});

// Initialize the local AI brain (offline — no external AI service)
const ai = new AIEngine(db);

// ---------------------------------------------------------------------------
// CloudSync — Telegram private channel = permanent database / source of truth,
// local SQLite = temporary cache. Handles startup restore, periodic snapshots
// and mirroring of every important change.
// ---------------------------------------------------------------------------
const cloud = new CloudSync({
  db,
  telegram,
  autoRestore: parseBool(process.env.TELEGRAM_AUTO_RESTORE, true),
  autoSnapshot: parseBool(process.env.TELEGRAM_AUTO_SNAPSHOT, true),
  restoreOnEmptyOnly: parseBool(process.env.TELEGRAM_RESTORE_ON_EMPTY_ONLY, true),
  snapshotIntervalMinutes: Number(process.env.TELEGRAM_SNAPSHOT_INTERVAL_MINUTES) || 30,
});

// Memory learned during a chat and the retrained model are mirrored too, so
// they never live only in the ephemeral SQLite file.
ai.setHooks({
  onMemoryChange: (row) => cloud.mirror("memory", row.id ?? row.key, row),
  onModelChange: (row) => cloud.mirror("ai_model", row.key, { key: row.key, value: row.value }),
});

// ---------------------------------------------------------------------------
// Telegram bot — chat with your AI directly from Telegram (long-polling)
// ---------------------------------------------------------------------------

/** Route one incoming Telegram text message through the AI and persist it. */
async function handleTelegramMessage(msg: TelegramMessage): Promise<string> {
  // The bot must not touch the database while a restore is running.
  if (cloud.isRestoring()) {
    return "♻️ I'm restoring my memory from the cloud backup right now. Please try again in a few seconds.";
  }
  const text = (msg.text || "").trim();
  const chatId = msg.chat.id;
  const name = msg.chat.first_name || msg.from?.first_name || msg.chat.username || "friend";
  const lower = text.toLowerCase();

  if (lower === "/start") {
    return (
      `Hi ${name}! 👋 I'm MY-AI — your own personal AI.\n\n` +
      "• Just type a message and I'll reply.\n" +
      "• I remember facts about you (try: \"My name is …\").\n" +
      "• I answer from your knowledge documents.\n" +
      "• Everything is stored in your Telegram cloud database.\n\n" +
      "Type /help for more."
    );
  }
  if (lower === "/help" || lower === "/commands") {
    return (
      "Here's what I can do:\n\n" +
      "💬 Chat with me normally — I'll answer.\n" +
      "🧠 Memory: \"My name is …\", \"I like …\", \"remember that …\"\n" +
      "📚 Ask about your documents (added in the AI Brain tab)\n" +
      "➗ Math: just type \"12 * 8 + 4\"\n" +
      "\nCommands:\n/start — welcome\n/help — this help"
    );
  }

  // Find (or create) the conversation for this Telegram user.
  let conv = db.prepare("SELECT id FROM conversations WHERE telegram_chat_id = ?").get(String(chatId)) as any;
  if (!conv) {
    const info = db.prepare("INSERT INTO conversations (title, telegram_chat_id) VALUES (?, ?)").run(`TG: ${name}`, String(chatId));
    conv = { id: Number(info.lastInsertRowid) };
    tryMirror("conversations", conv.id, { id: conv.id, title: `TG: ${name}`, telegram_chat_id: String(chatId) });
  }
  const sid = conv.id;

  // Persist the user's message.
  const um = db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', ?)").run(sid, text);
  tryMirror("chat_messages", um.lastInsertRowid, { id: um.lastInsertRowid, session_id: sid, role: "user", content: text, source: "telegram" });

  // Get the AI's reply.
  const result = ai.reply(text);

  // Persist the AI's reply.
  const am = db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'ai', ?)").run(sid, result.reply);
  tryMirror("chat_messages", am.lastInsertRowid, { id: am.lastInsertRowid, session_id: sid, role: "ai", content: result.reply, source: "telegram" });

  return result.reply;
}

let telegramBot: TelegramBot | null = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, handleTelegramMessage);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Push a record to Telegram as a JSON message (non-blocking, best-effort). */
function tryMirror(collection: string, recordId: string | number, payload: any): void {
  cloud.mirror(collection, recordId, payload);
}

/** Push a delete tombstone to Telegram (non-blocking, best-effort). */
function tryMirrorDelete(collection: string, recordId: string | number): void {
  cloud.mirrorDelete(collection, recordId);
}

/**
 * Guard for every AI/data endpoint: while the startup restore is running we do
 * not touch the database, so callers get a clear 503 instead of half-restored
 * answers.
 */
function blockWhileRestoring(req: express.Request, res: express.Response): boolean {
  if (cloud.isRestoring()) {
    res.status(503).json({ error: "AI data is being restored", state: "restoring" });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

app.get("/api/v1/health/detailed", (req, res) => {
  try {
    const userRow = db.prepare("SELECT COUNT(*) as count FROM users").get() as any;
    const convRow = db.prepare("SELECT COUNT(*) as count FROM conversations").get() as any;
    const msgRow = db.prepare("SELECT COUNT(*) as count FROM chat_messages").get() as any;
    const tgRow = db.prepare("SELECT COUNT(*) as count FROM telegram_index").get() as any;
    const knowRow = db.prepare("SELECT COUNT(*) as count FROM knowledge").get() as any;
    const memRow = db.prepare("SELECT COUNT(*) as count FROM memory").get() as any;

    res.json({
      status: "Operational",
      api: "Online",
      database: "SQLite (myai.db)",
      model: "BasicEngine",
      telegram: telegram.configured ? "Configured" : "Not configured",
      telegramBot: telegramBot ? "Running" : "Not configured",
      stats: {
        totalUsers: userRow ? userRow.count : 0,
        totalConversations: convRow ? convRow.count : 0,
        totalMessages: msgRow ? msgRow.count : 0,
        telegramRecords: tgRow ? tgRow.count : 0,
        knowledgeDocs: knowRow ? knowRow.count : 0,
        datasetCount: memRow ? memRow.count : 0,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch stats", details: err.message });
  }
});

app.get("/api/v1/telegram/status", async (req, res) => {
  try {
    const status = await telegram.status();
    let indexed = 0;
    try {
      indexed = (db.prepare("SELECT COUNT(*) as count FROM telegram_index").get() as any).count;
    } catch {
      indexed = 0;
    }
    res.json({ ...status, indexedRecords: indexed, ...cloud.statusPayload() });
  } catch (err: any) {
    // Never fail the status endpoint just because Telegram is unreachable.
    res.json({
      configured: telegram.configured,
      botTokenSet: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      chatIdSet: Boolean(process.env.TELEGRAM_STORAGE_CHAT_ID),
      telegramError: err.message,
      ...cloud.statusPayload(),
    });
  }
});

app.post("/api/v1/telegram/verify", async (req, res) => {
  try {
    const result = await telegram.verify();
    res.json({
      success: true,
      message: "Telegram storage is connected and writable.",
      bot: result.bot,
      channel: result.channel,
      testMessageId: result.testMessageId,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Push every local record (users, conversations, messages) to Telegram. */
app.post("/api/v1/telegram/sync", async (req, res) => {
  try {
    if (!telegram.configured) {
      return res.status(400).json({ success: false, error: "Telegram not configured." });
    }
    const counts: Record<string, number> = {};
    const tables = SNAPSHOT_TABLES.filter((t) => t !== "telegram_index");
    for (const table of tables) {
      counts[table] = 0;
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const id = row.id ?? row.key ?? row.rowid ?? `${Date.now()}-${Math.random()}`;
        const r = await telegram.saveRecord(table, id, row);
        db.prepare(
          "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
        ).run(table, String(id), r.messageId, null);
        counts[table]++;
      }
    }
    res.json({ success: true, message: "All data synced to Telegram channel.", counts });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Create a full gzipped JSON snapshot and upload it to the Telegram channel. */
app.post("/api/v1/telegram/snapshot", async (req, res) => {
  try {
    if (!telegram.configured) {
      return res.status(400).json({ success: false, error: "Telegram not configured." });
    }
    const result = await cloud.snapshot({ force: req.body?.force !== false, reason: "manual" });
    if (!result.success && !result.skipped) {
      return res.status(500).json({ success: false, error: result.error });
    }
    res.json({
      success: true,
      skipped: Boolean(result.skipped),
      message: result.skipped
        ? `Snapshot skipped — ${result.reason}`
        : "Snapshot uploaded to Telegram (gzipped, checksummed and pinned).",
      fileId: result.fileId,
      messageId: result.messageId,
      fileName: result.fileName,
      counts: result.counts,
      checksum: result.checksum,
      totalRecords: result.totalRecords,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Download the current snapshot as a local file (no Telegram needed). */
app.get("/api/v1/telegram/snapshot/download", (req, res) => {
  try {
    const doc = buildSnapshot(db);
    const { buffer, fileName } = serializeSnapshot(doc, false);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** List all stored snapshots and the Telegram index. */
app.get("/api/v1/telegram/snapshots", (req, res) => {
  try {
    const snapshots = db
      .prepare("SELECT * FROM telegram_index WHERE collection = 'snapshot' ORDER BY id DESC")
      .all();
    const index = db.prepare("SELECT * FROM telegram_index ORDER BY id DESC LIMIT 500").all();
    res.json({ snapshots, index });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Restore the database from a Telegram snapshot (by fileId, or the pinned latest one). */
app.post("/api/v1/telegram/restore", async (req, res) => {
  try {
    if (!telegram.configured) {
      return res.status(400).json({ success: false, error: "Telegram not configured." });
    }
    const result = await cloud.restore({
      fileId: req.body?.fileId,
      // A manual restore from the UI is an explicit action, so it may overwrite.
      force: req.body?.force !== false,
      emptyOnly: req.body?.emptyOnly === true,
    });
    if (!result.success) {
      const code = result.skipped ? 409 : 500;
      return res.status(code).json({
        success: false,
        skipped: Boolean(result.skipped),
        error: result.error || result.reason,
        state: cloud.getState(),
      });
    }
    res.json({
      success: true,
      message: result.skipped
        ? `Restore skipped — ${result.reason}`
        : "Database restored from the Telegram snapshot.",
      restored: result.restored,
      fileId: result.fileId,
      checksum: result.checksum,
      state: cloud.getState(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Raw DB file backup to Telegram (kept for compatibility). */
app.post("/api/v1/backup", async (req, res) => {
  try {
    if (!fs.existsSync(dbPath)) {
      return res.status(400).json({ success: false, error: "Database file does not exist yet." });
    }
    const result = await telegram.saveFile(dbPath, `💾 Raw DB backup — ${new Date().toISOString()}`);
    db.prepare(
      "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
    ).run("db_backup", result.fileId, result.messageId, result.fileId);
    res.json({ success: true, message: "Raw database backup sent to Telegram.", fileId: result.fileId });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/v1/users/seed", (req, res) => {
  try {
    const info = db
      .prepare("INSERT INTO users (name, email) VALUES ('Admin User', 'admin@myai.local')")
      .run();
    tryMirror("users", info.lastInsertRowid, { id: info.lastInsertRowid, name: "Admin User", email: "admin@myai.local" });
    res.json({ success: true, message: "Test user created", id: info.lastInsertRowid });
  } catch (err: any) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return res.json({ success: true, message: "User already exists" });
    }
    return res.status(500).json({ error: err.message });
  }
});

// Chat API Routes
app.get("/api/v1/chats", (req, res) => {
  try {
    const chats = db.prepare("SELECT * FROM conversations ORDER BY created_at DESC").all();
    res.json(chats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v1/chats", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  const { title } = req.body;
  try {
    const info = db
      .prepare("INSERT INTO conversations (title) VALUES (?)")
      .run(title || "New Chat");
    const chat = { id: info.lastInsertRowid, title: title || "New Chat" };
    tryMirror("conversations", info.lastInsertRowid, chat);
    res.json(chat);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/v1/chats/:id/messages", (req, res) => {
  try {
    const messages = db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(req.params.id);
    res.json(messages);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v1/chats/:id/messages", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  const { role, content } = req.body;
  try {
    const info = db
      .prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)")
      .run(req.params.id, role, content);
    const msg = { id: info.lastInsertRowid, session_id: req.params.id, role, content };
    tryMirror("chat_messages", info.lastInsertRowid, msg);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// AI Brain API
// ---------------------------------------------------------------------------

/** Main chat endpoint — saves both messages and returns the AI's reply + mode. */
app.post("/api/v1/ai/chat", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    const { sessionId, message } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    let sid: number | null = sessionId ? Number(sessionId) : null;
    if (!sid) {
      const title = message.trim().slice(0, 40) || "New Chat";
      const info = db.prepare("INSERT INTO conversations (title) VALUES (?)").run(title);
      sid = Number(info.lastInsertRowid);
      tryMirror("conversations", sid, { id: sid, title });
    }

    const um = db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', ?)").run(sid, message.trim());
    tryMirror("chat_messages", um.lastInsertRowid, { id: um.lastInsertRowid, session_id: sid, role: "user", content: message.trim() });

    const result = ai.reply(message.trim());

    const am = db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'ai', ?)").run(sid, result.reply);
    tryMirror("chat_messages", am.lastInsertRowid, { id: am.lastInsertRowid, session_id: sid, role: "ai", content: result.reply });

    res.json({ sessionId: sid, reply: result.reply, mode: result.mode });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v1/ai/train", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    const stats = ai.train();
    // The trained model lives in `ai_model` — mirror it so it is never lost.
    try {
      const row = db.prepare("SELECT key, value, updated_at FROM ai_model WHERE key = 'markov'").get() as any;
      if (row) tryMirror("ai_model", "markov", { key: row.key, value: row.value, updated_at: row.updated_at });
    } catch {
      /* best-effort */
    }
    res.json({ success: true, message: "Model trained on your messages.", stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/v1/ai/status", (req, res) => {
  try {
    res.json(ai.status());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Knowledge (local RAG documents)
app.get("/api/v1/knowledge", (req, res) => {
  try {
    res.json(db.prepare("SELECT * FROM knowledge ORDER BY id DESC").all());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v1/knowledge", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  const { title, content } = req.body || {};
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  try {
    const info = db.prepare("INSERT INTO knowledge (title, content) VALUES (?, ?)").run(title || "Untitled", content.trim());
    tryMirror("knowledge", info.lastInsertRowid, { id: info.lastInsertRowid, title: title || "Untitled", content: content.trim() });
    res.json({ success: true, id: Number(info.lastInsertRowid) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/v1/knowledge/:id", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    db.prepare("DELETE FROM knowledge WHERE id = ?").run(req.params.id);
    tryMirrorDelete("knowledge", req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Memory (facts about the user)
app.get("/api/v1/memory", (req, res) => {
  try {
    res.json(db.prepare("SELECT * FROM memory ORDER BY id DESC").all());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v1/memory", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  const { key, value } = req.body || {};
  if (!key || !value) return res.status(400).json({ error: "key and value are required" });
  try {
    db.prepare("INSERT INTO memory (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    const row = db.prepare("SELECT * FROM memory WHERE key = ?").get(key) as any;
    tryMirror("memory", row?.id ?? key, { id: row?.id, key, value });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/v1/memory/:id", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    db.prepare("DELETE FROM memory WHERE id = ?").run(req.params.id);
    tryMirrorDelete("memory", req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Dataset export — conversation pairs in ShareGPT-style JSONL (for fine-tuning)
app.get("/api/v1/dataset/export", (req, res) => {
  try {
    const sessions = db.prepare("SELECT DISTINCT session_id FROM chat_messages").all() as { session_id: number }[];
    const lines: string[] = [];
    for (const s of sessions) {
      const msgs = db.prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id ASC").all(s.session_id) as { role: string; content: string }[];
      for (let i = 0; i < msgs.length - 1; i++) {
        if (msgs[i].role === "user" && msgs[i + 1].role === "ai") {
          lines.push(
            JSON.stringify({
              messages: [
                { role: "user", content: msgs[i].content },
                { role: "assistant", content: msgs[i + 1].content },
              ],
            })
          );
        }
      }
    }
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=myai-dataset.jsonl");
    res.send(lines.join("\n"));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // -------------------------------------------------------------------------
  // Startup restore — Telegram private channel is the permanent database, the
  // local SQLite file is only a cache that Render Free wipes on every restart.
  //
  // The HTTP server is already listening (so Render's health check passes and
  // the container can wake up), but every AI/data endpoint answers 503 while
  // `cloud` is in the `restoring` state, and the Telegram bot is only started
  // AFTER the restore has finished.
  // -------------------------------------------------------------------------
  console.log("🚀 Application state: starting");
  try {
    await cloud.runStartupRestore();
    // The Markov model may have just been restored from the channel.
    ai.reload();
  } catch (err: any) {
    console.error("❌ Startup restore crashed (continuing with local data):", err?.message || err);
  }
  console.log(`🚀 Application state: ${cloud.getState()}`);

  if (cloud.getState() === "restore_failed") {
    console.error(
      "❌ Restore failed. Local data was NOT modified. The Telegram bot stays OFF so it cannot write on top of an unrestored database. " +
        "Fix the issue and use 'Restore Latest' in the Telegram Storage tab, or restart the service."
    );
  } else {
    cloud.markReady();
    // Long-polling starts only once the app is ready.
    if (telegramBot) {
      telegramBot.start().catch((err) => console.error("Failed to start Telegram bot:", err.message));
    }
    cloud.startAutoSnapshot();
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    telegramBot?.stop();
    cloud.stopAutoSnapshot();

    // Best-effort final snapshot so nothing is lost when Render spins us down.
    try {
      await cloud.finalSnapshot(8000);
    } catch (e: any) {
      console.warn("⚠️  Final snapshot failed:", e?.message || e);
    }

    server.close(() => {
      console.log("HTTP server closed");
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      process.exit(0);
    });
    // Hard stop if the socket refuses to close in time.
    setTimeout(() => process.exit(0), 10000).unref();
  };

  process.on("SIGTERM", () => {
    console.log("SIGTERM signal received: closing HTTP server");
    void shutdown();
  });

  process.on("SIGINT", () => {
    console.log("SIGINT signal received: closing HTTP server");
    void shutdown();
  });
}

startServer();
