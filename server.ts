import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import { TelegramStorage } from "./server/telegram.ts";
import { TelegramBot, type TelegramMessage } from "./server/telegram-bot.ts";
import { createBotCommands } from "./server/telegram-commands.ts";
import { AIEngine } from "./server/ai/engine.ts";
import { ResearchService } from "./server/research/research.ts";
import { openDatabase, resolveDbPath, SNAPSHOT_TABLES } from "./server/db.ts";
import { buildSnapshot, serializeSnapshot } from "./server/snapshot.ts";
import { CloudSync, parseBool } from "./server/cloud-sync.ts";
import { pushLog, recentLogs } from "./server/logs.ts";
import { createAdminGate, adminTokenFrom } from "./server/auth.ts";
import { datasetStats } from "./server/dataset.ts";
import { planIngest, applyIngest } from "./server/ingest.ts";
import { applyBuiltInSeed } from "./server/seed.ts";

// Initialize express app
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Request log — feeds the control panel's Activity/Logs page.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    pushLog(res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info", "http", `${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  next();
});

// Admin gate — when ADMIN_PASSWORD is set, training and data-writing
// endpoints require the `x-admin-token` header. Unset ⇒ single-user panel.
const adminGate = createAdminGate(process.env.ADMIN_PASSWORD);

/** Log bridge: console for Render, ring buffer for the control panel. */
const systemLogger = {
  log: (msg: string) => {
    console.log(msg);
    pushLog("info", "system", msg);
  },
  warn: (msg: string) => {
    console.warn(msg);
    pushLog("warn", "system", msg);
  },
  error: (msg: string) => {
    console.error(msg);
    pushLog("error", "system", msg);
  },
};

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
  logger: systemLogger,
});
// After ANY successful restore (startup, manual, or from an uploaded file) the
// in-memory AI model must be reloaded from the freshly restored database —
// otherwise the brain keeps answering from the pre-restore model and the
// restore looks like it silently "did nothing".
cloud.setOnRestored((restored) => {
  ai.reload();
  const summary = Object.entries(restored)
    .map(([table, n]) => `${table}=${n}`)
    .join(" ");
  pushLog("info", "system", `♻️ Restore applied and AI model reloaded — ${summary}`);
});

// Memory learned during a chat and the retrained model are mirrored too, so
// they never live only in the ephemeral SQLite file.
ai.setHooks({
  onMemoryChange: (row) => cloud.mirror("memory", row.id ?? row.key, row),
  onModelChange: (row) => cloud.mirror("ai_model", row.key, { key: row.key, value: row.value }),
});

// ---------------------------------------------------------------------------
// Online research — free, keyless sources with per-host circuit breakers,
// a permanent cache, a negative cache, hard attempt/time budgets and a
// global per-minute request cap, so automatic lookups can never get the app
// "blocked". Every fresh finding is saved into `knowledge`, so it is mirrored
// to Telegram and survives Render restarts.
// All env vars are optional and non-secret (see .env.example).
// ---------------------------------------------------------------------------
const research = new ResearchService(
  db,
  {
    enabled: parseBool(process.env.RESEARCH_ENABLED, true),
    cacheTtlMinutes: Number(process.env.RESEARCH_CACHE_TTL_MINUTES) || 360,
    timeoutMs: Number(process.env.RESEARCH_TIMEOUT_MS) || 4000,
    saveToKnowledge: parseBool(process.env.RESEARCH_SAVE_TO_KNOWLEDGE, true),
    maxAttempts: Number(process.env.RESEARCH_MAX_ATTEMPTS) || 8,
    maxRequestsPerMinute: Number(process.env.RESEARCH_MAX_REQUESTS_PER_MINUTE) || 60,
    logger: (msg) => {
      console.log(msg);
      pushLog("info", "research", msg);
    },
  },
  {
    onKnowledgeSave: (row) => cloud.mirror("knowledge", row.id, row),
  }
);
ai.setResearch(research);

// ---------------------------------------------------------------------------
// Telegram bot — chat with your AI directly from Telegram (long-polling)
// ---------------------------------------------------------------------------

/**
 * Slash-command handler: the web panel's chat shortcuts (new chat, history,
 * edit, regenerate, undo, clear, forget) available from a phone too.
 * Declared before `handleTelegramMessage` uses it — `const` in module scope is
 * initialised at load time, well before any Telegram update arrives.
 */
const botCommands = createBotCommands({
  db,
  ai,
  mirror: (collection, id, payload) => cloud.mirror(collection, id, payload),
  mirrorDelete: (collection, id) => cloud.mirrorDelete(collection, id),
});

/** Route one incoming Telegram text message through the AI and persist it. */
async function handleTelegramMessage(msg: TelegramMessage): Promise<string> {
  // The bot must not touch the database while a restore is running.
  if (cloud.isRestoring()) {
    return "♻️ I'm restoring my memory from the cloud backup right now. Please try again in a few seconds.";
  }
  const text = (msg.text || "").trim();
  const chatId = msg.chat.id;
  const name = msg.chat.first_name || msg.from?.first_name || msg.chat.username || "friend";

  // Slash commands — the same chat shortcuts as the web panel (new chat,
  // history, edit, regenerate, undo, clear, forget…), answered in the
  // language the user has been writing in.
  const command = await botCommands.handleCommand(text, chatId, name);
  if (command.handled) return command.reply;

  // Find (or create) the conversation for this Telegram user.
  const conv = botCommands.currentConversation(chatId, name);
  const sid = conv.id;

  // Persist the user's message.
  botCommands.saveMessage(sid, "user", text);

  // Get the AI's reply (brain first, keyless online research if needed).
  const result = await ai.replyAsync(text);

  // Persist the AI's reply.
  botCommands.saveMessage(sid, "ai", result.reply);

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

/**
 * Guard for training / write endpoints: when ADMIN_PASSWORD is configured,
 * the request must carry the correct `x-admin-token` header.
 */
function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!adminGate.required) return true;
  if (adminGate.check(adminTokenFrom(req))) return true;
  res.status(401).json({ error: "Admin password required", code: "admin_required" });
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
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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

/**
 * Restore from a snapshot file the user uploads — the escape hatch for when
 * Telegram itself is the problem (wrong chat id, bot lost admin rights, pin
 * deleted). Accepts the raw JSON document, a base64 gzip blob, or the file
 * body posted as `application/json` / `application/octet-stream`.
 */
app.post(
  "/api/v1/telegram/restore/file",
  express.raw({ type: ["application/octet-stream", "application/gzip"], limit: "50mb" }),
  async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      let buffer: Buffer | null = null;

      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        buffer = req.body as Buffer;
      } else if (req.body && typeof req.body === "object" && typeof (req.body as any).base64 === "string") {
        buffer = Buffer.from((req.body as any).base64, "base64");
      } else if (req.body && typeof req.body === "object" && (req.body as any).snapshot) {
        buffer = Buffer.from(JSON.stringify((req.body as any).snapshot), "utf-8");
      } else if (req.body && typeof req.body === "object" && (req.body as any).meta && (req.body as any).data) {
        buffer = Buffer.from(JSON.stringify(req.body), "utf-8");
      }

      if (!buffer || buffer.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No snapshot supplied. Send the snapshot JSON, {snapshot:{…}} or {base64:'…'}.",
        });
      }

      const result = await cloud.restoreFromBuffer(buffer, { force: req.body?.force === true });
      if (!result.success) {
        return res.status(result.skipped ? 409 : 400).json({
          success: false,
          skipped: Boolean(result.skipped),
          error: result.error || result.reason,
          state: cloud.getState(),
        });
      }
      res.json({
        success: true,
        message: "Database restored from the uploaded snapshot file.",
        restored: result.restored,
        checksum: result.checksum,
        state: cloud.getState(),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

/**
 * Leave the `restore_failed` dead-end and continue with the local data.
 * Without this the app stayed stuck (Telegram bot off, UI showing an error)
 * until the whole service was restarted.
 */
app.post("/api/v1/telegram/restore/dismiss", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const before = cloud.getState();
  const out = cloud.clearRestoreFailure();
  if (before === "restore_failed" && out.state === "ready") {
    pushLog("warn", "system", "Restore failure dismissed — continuing with the local database.");
    if (telegramBot) {
      telegramBot.start().catch((err) => console.error("Failed to start Telegram bot:", err.message));
    }
    cloud.startAutoSnapshot();
  }
  res.json({ success: true, state: out.state, previousState: before });
});

/** Raw DB file backup to Telegram (kept for compatibility). */
app.post("/api/v1/backup", async (req, res) => {
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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

// ---------------------------------------------------------------------------
// Chat API — history, search, rename, edit & delete
// ---------------------------------------------------------------------------

/**
 * List conversations for the sidebar / history panel.
 *
 * Query params:
 *   `q`     — full-text search across chat titles AND message contents
 *   `limit` — cap the number of chats returned (default 200)
 *
 * Every row carries `messageCount`, `lastMessageAt` and a `preview`, so the
 * UI can render a real history list instead of just a title.
 */
app.get("/api/v1/chats", (req, res) => {
  try {
    const q = String((req.query.q as string) || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

    const base = `
      SELECT c.id, c.title, c.telegram_chat_id, c.created_at,
             COUNT(m.id) AS messageCount,
             MAX(m.created_at) AS lastMessageAt,
             (SELECT content FROM chat_messages WHERE session_id = c.id ORDER BY id DESC LIMIT 1) AS preview
      FROM conversations c
      LEFT JOIN chat_messages m ON m.session_id = c.id
    `;

    let rows: any[];
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      rows = db
        .prepare(
          `${base}
           WHERE LOWER(COALESCE(c.title, '')) LIKE ?
              OR EXISTS (SELECT 1 FROM chat_messages x WHERE x.session_id = c.id AND LOWER(x.content) LIKE ?)
           GROUP BY c.id
           ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC
           LIMIT ?`
        )
        .all(like, like, limit);
    } else {
      rows = db
        .prepare(
          `${base}
           GROUP BY c.id
           ORDER BY COALESCE(MAX(m.created_at), c.created_at) DESC
           LIMIT ?`
        )
        .all(limit);
    }

    res.json(
      rows.map((r) => ({
        ...r,
        preview: typeof r.preview === "string" ? r.preview.slice(0, 120) : null,
      }))
    );
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
  const { role, content, source } = req.body;
  try {
    const info = db
      .prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (?, ?, ?, ?)")
      .run(req.params.id, role, content, source || "web");
    const msg = { id: info.lastInsertRowid, session_id: req.params.id, role, content, source: source || "web" };
    tryMirror("chat_messages", info.lastInsertRowid, msg);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Delete a conversation and every message inside it (admin action). */
app.delete("/api/v1/chats/:id", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    db.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(req.params.id);
    db.prepare("DELETE FROM conversations WHERE id = ?").run(req.params.id);
    tryMirrorDelete("conversations", req.params.id);
    pushLog("info", "system", `Conversation #${req.params.id} deleted`);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Rename a chat — the "Rename" shortcut in the history list. */
app.patch("/api/v1/chats/:id", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    const title = String(req.body?.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });
    const info = db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.slice(0, 120), req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: "Chat not found" });
    tryMirror("conversations", req.params.id, { id: Number(req.params.id), title: title.slice(0, 120) });
    res.json({ success: true, id: Number(req.params.id), title: title.slice(0, 120) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Clear the whole chat history in one action ("Delete all chats").
 * Knowledge, memory and the trained model are deliberately left untouched —
 * this wipes conversations only.
 */
app.delete("/api/v1/chats", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const ids = (db.prepare("SELECT id FROM conversations").all() as any[]).map((r) => r.id);
    const wipe = db.transaction(() => {
      db.prepare("DELETE FROM chat_messages").run();
      db.prepare("DELETE FROM conversations").run();
    });
    wipe();
    for (const id of ids) tryMirrorDelete("conversations", id);
    pushLog("warn", "system", `Chat history cleared — ${ids.length} conversation(s) deleted`);
    res.json({ success: true, deleted: ids.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Delete a single message (and, for a user message, the AI reply after it). */
app.delete("/api/v1/chats/:id/messages/:messageId", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    const sid = Number(req.params.id);
    const mid = Number(req.params.messageId);
    const msg = db.prepare("SELECT * FROM chat_messages WHERE id = ? AND session_id = ?").get(mid, sid) as any;
    if (!msg) return res.status(404).json({ error: "Message not found" });

    let deleted = 1;
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run(mid);
    tryMirrorDelete("chat_messages", mid);

    if (msg.role === "user") {
      // The answer that belonged to this question goes with it.
      const answer = db
        .prepare("SELECT id FROM chat_messages WHERE session_id = ? AND id > ? AND role = 'ai' ORDER BY id ASC LIMIT 1")
        .get(sid, mid) as any;
      if (answer) {
        db.prepare("DELETE FROM chat_messages WHERE id = ?").run(answer.id);
        tryMirrorDelete("chat_messages", answer.id);
        deleted++;
      }
    }
    res.json({ success: true, deleted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Edit a message that was already sent, and answer it again.
 *
 * This is the "edit your question" shortcut people expect from a chat app:
 * the user message is rewritten, everything that came AFTER it in that chat is
 * removed (the old answer is no longer valid), and the AI replies to the new
 * wording. Returns the fresh reply so the UI can swap it in place.
 */
app.patch("/api/v1/chats/:id/messages/:messageId", async (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    const sid = Number(req.params.id);
    const mid = Number(req.params.messageId);
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content is required" });

    const msg = db.prepare("SELECT * FROM chat_messages WHERE id = ? AND session_id = ?").get(mid, sid) as any;
    if (!msg) return res.status(404).json({ error: "Message not found" });
    if (msg.role !== "user") return res.status(400).json({ error: "Only your own messages can be edited" });

    // Rewrite the question and drop everything that followed it.
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(content, mid);
    tryMirror("chat_messages", mid, { id: mid, session_id: sid, role: "user", content, source: msg.source || "web" });

    const stale = db.prepare("SELECT id FROM chat_messages WHERE session_id = ? AND id > ?").all(sid, mid) as any[];
    for (const s of stale) {
      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(s.id);
      tryMirrorDelete("chat_messages", s.id);
    }

    const result = await ai.replyAsync(content);
    const am = db
      .prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (?, 'ai', ?, ?)")
      .run(sid, result.reply, msg.source || "web");
    tryMirror("chat_messages", am.lastInsertRowid, {
      id: am.lastInsertRowid,
      session_id: sid,
      role: "ai",
      content: result.reply,
      source: msg.source || "web",
    });

    res.json({
      success: true,
      sessionId: sid,
      messageId: mid,
      content,
      removed: stale.length,
      reply: result.reply,
      replyId: Number(am.lastInsertRowid),
      mode: result.mode,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Regenerate the last AI answer of a chat — same question, fresh reply.
 * (The 🔄 shortcut under every AI message.)
 */
app.post("/api/v1/chats/:id/regenerate", async (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    const sid = Number(req.params.id);
    const lastUser = db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(sid) as any;
    if (!lastUser) return res.status(400).json({ error: "This chat has no question to answer" });

    const after = db
      .prepare("SELECT id FROM chat_messages WHERE session_id = ? AND id > ? AND role = 'ai'")
      .all(sid, lastUser.id) as any[];
    for (const a of after) {
      db.prepare("DELETE FROM chat_messages WHERE id = ?").run(a.id);
      tryMirrorDelete("chat_messages", a.id);
    }

    const result = await ai.replyAsync(lastUser.content);
    const am = db
      .prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (?, 'ai', ?, ?)")
      .run(sid, result.reply, lastUser.source || "web");
    tryMirror("chat_messages", am.lastInsertRowid, {
      id: am.lastInsertRowid,
      session_id: sid,
      role: "ai",
      content: result.reply,
      source: lastUser.source || "web",
    });

    res.json({ success: true, sessionId: sid, reply: result.reply, replyId: Number(am.lastInsertRowid), mode: result.mode });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// AI Brain API
// ---------------------------------------------------------------------------

/** Main chat endpoint — saves both messages and returns the AI's reply + mode. */
app.post("/api/v1/ai/chat", async (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  try {
    const { sessionId, message, training } = req.body || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }
    // Messages typed in the Training tab are stored as training data too —
    // with their own source label so the Datasets page can show where each
    // training example came from.
    const source = training ? "training" : "web";

    let sid: number | null = sessionId ? Number(sessionId) : null;
    if (!sid) {
      const title = message.trim().slice(0, 40) || "New Chat";
      const info = db.prepare("INSERT INTO conversations (title) VALUES (?)").run(title);
      sid = Number(info.lastInsertRowid);
      tryMirror("conversations", sid, { id: sid, title });
    }

    const um = db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (?, 'user', ?, ?)").run(sid, message.trim(), source);
    tryMirror("chat_messages", um.lastInsertRowid, { id: um.lastInsertRowid, session_id: sid, role: "user", content: message.trim(), source });

    const result = await ai.replyAsync(message.trim());

    const am = db.prepare("INSERT INTO chat_messages (session_id, role, content, source) VALUES (?, 'ai', ?, ?)").run(sid, result.reply, source);
    tryMirror("chat_messages", am.lastInsertRowid, { id: am.lastInsertRowid, session_id: sid, role: "ai", content: result.reply, source });

    res.json({ sessionId: sid, reply: result.reply, mode: result.mode });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/v1/ai/train", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    // Kick the training off asynchronously so the Training page can watch the
    // progress bar and phase log fill in live.
    setTimeout(() => {
      try {
        ai.runTrain("manual");
        // The trained model lives in `ai_model` — mirror it so it is never lost.
        try {
          const row = db.prepare("SELECT key, value, updated_at FROM ai_model WHERE key = 'markov'").get() as any;
          if (row) tryMirror("ai_model", "markov", { key: row.key, value: row.value, updated_at: row.updated_at });
        } catch {
          /* best-effort */
        }
      } catch (err: any) {
        console.error("Manual train failed:", err?.message || err);
      }
    }, 60);
    res.json({ success: true, started: true, message: "Background training started." });
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

/** Background-training journal — how the AI trains itself in the background. */
app.get("/api/v1/ai/training", (req, res) => {
  try {
    res.json(ai.getTraining());
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
  if (!requireAdmin(req, res)) return;
  const { title, content } = req.body || {};
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  try {
    const info = db.prepare("INSERT INTO knowledge (title, content) VALUES (?, ?)").run(title || "Untitled", content.trim());
    tryMirror("knowledge", info.lastInsertRowid, { id: info.lastInsertRowid, title: title || "Untitled", content: content.trim() });
    ai.scheduleTrain(2000, "knowledge");
    res.json({ success: true, id: Number(info.lastInsertRowid) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Bulk ingest — dump .txt / .md / .jsonl (from another AI, or a Bangla/English
 * language corpus). Saved as knowledge (+ Q/A pairs when the file is a
 * transcript). The Markov brain retrains in the background automatically.
 */
app.post("/api/v1/ingest", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) return res.status(400).json({ error: "files[] required — each { name, content }" });
    const trimmed = files
      .slice(0, 50)
      .map((f: any) => ({ name: String(f.name || "untitled.txt"), content: String(f.content || "") }));
    const plan = planIngest(trimmed);
    const applied = applyIngest(db, plan, { source: "ingest", conversationTitle: req.body?.title });
    const knowRows = db.prepare("SELECT id, title, content FROM knowledge ORDER BY id DESC LIMIT ?").all(applied.knowledgeInserted) as any[];
    for (const row of knowRows) tryMirror("knowledge", row.id, row);
    if (applied.conversationId) {
      tryMirror("conversations", applied.conversationId, { id: applied.conversationId, title: req.body?.title || "Ingest" });
      const msgs = db.prepare("SELECT * FROM chat_messages WHERE session_id = ?").all(applied.conversationId) as any[];
      for (const m of msgs) tryMirror("chat_messages", m.id, m);
    }
    ai.scheduleTrain(800, "ingest");
    pushLog("info", "system", `Ingested ${applied.knowledgeInserted} docs, ${applied.pairsInserted} Q/A pairs (${applied.bytes} bytes) — background train scheduled`);
    res.json({ ok: true, ...applied, chunksPlanned: plan.chunks.length, skippedEmpty: plan.skippedEmpty });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/v1/knowledge/:id", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
  try {
    db.prepare("DELETE FROM memory WHERE id = ?").run(req.params.id);
    tryMirrorDelete("memory", req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Online Research API — 7 keyless sources, circuit breakers, permanent cache.
// ---------------------------------------------------------------------------

/** Which sources are ready / cooling down, plus cache statistics. */
app.get("/api/v1/research/status", (req, res) => {
  try {
    res.json(research.status());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Probe every live source — used after deploy to see what actually works. */
app.get("/api/v1/research/selftest", async (req, res) => {
  try {
    const report = await research.selftest();
    res.json({ ok: true, ...report });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Force an online lookup now (fresh cache answered instantly). */
app.post("/api/v1/research", async (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  const { topic } = req.body || {};
  if (!topic || typeof topic !== "string" || !topic.trim()) {
    return res.status(400).json({ ok: false, error: "topic is required" });
  }
  try {
    const result = await research.research(topic.trim());
    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        offline: Boolean(result.offline),
        triedSources: result.triedSources ?? [],
        error: result.offline ? "Internet unreachable — try again later." : "No answer found for this topic.",
      });
    }
    res.json({ ok: true, finding: result.finding });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Reset every circuit breaker (the "Reset Cooldowns" button), optionally the cache too. */
app.post("/api/v1/research/reset", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const clearCache = req.body?.clearCache === true;
    const result = research.reset(clearCache);
    res.json({
      ok: true,
      message: clearCache
        ? "Circuit breakers and research cache cleared — every source is ready again."
        : "Circuit breakers reset — every source is ready again.",
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Control panel support — auth, logs, settings, datasets, users.
// Every endpoint here is read-only except where requireAdmin is applied.
// ---------------------------------------------------------------------------

/** Is an admin password configured? (The UI shows a password prompt when yes.) */
app.get("/api/v1/auth/status", (req, res) => {
  res.json({
    passwordRequired: adminGate.required,
    adminAuthed: adminGate.check(adminTokenFrom(req)),
  });
});

/** Verify an admin password client-side (stateless — the token lives in the browser session). */
app.post("/api/v1/auth/verify", (req, res) => {
  const { password } = req.body || {};
  if (!adminGate.required) return res.json({ ok: true, message: "No admin password configured." });
  if (adminGate.check(String(password ?? ""))) {
    return res.json({ ok: true, message: "Password accepted." });
  }
  res.status(401).json({ ok: false, error: "Wrong password." });
});

/** Recent activity log (in-memory ring buffer — no secrets are ever logged). */
app.get("/api/v1/logs", (req, res) => {
  const n = Math.min(Number(req.query.n) || 200, 500);
  res.json({ entries: recentLogs(n) });
});

/** Non-secret runtime settings — what the control panel's Settings page shows. */
app.get("/api/v1/settings", (req, res) => {
  res.json({
    adminPasswordRequired: adminGate.required,
    telegram: {
      configured: telegram.configured,
      botTokenSet: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      storageChatIdSet: Boolean(process.env.TELEGRAM_STORAGE_CHAT_ID),
      autoRestore: parseBool(process.env.TELEGRAM_AUTO_RESTORE, true),
      autoSnapshot: parseBool(process.env.TELEGRAM_AUTO_SNAPSHOT, true),
      restoreOnEmptyOnly: parseBool(process.env.TELEGRAM_RESTORE_ON_EMPTY_ONLY, true),
      snapshotIntervalMinutes: Number(process.env.TELEGRAM_SNAPSHOT_INTERVAL_MINUTES) || 30,
      botRunning: Boolean(telegramBot),
    },
    research: {
      enabled: research.enabled,
      cacheTtlMinutes: Number(process.env.RESEARCH_CACHE_TTL_MINUTES) || 360,
      timeoutMs: Number(process.env.RESEARCH_TIMEOUT_MS) || 4000,
      saveToKnowledge: parseBool(process.env.RESEARCH_SAVE_TO_KNOWLEDGE, true),
      maxAttempts: Number(process.env.RESEARCH_MAX_ATTEMPTS) || 8,
      maxRequestsPerMinute: Number(process.env.RESEARCH_MAX_REQUESTS_PER_MINUTE) || 60,
    },
    database: dbPath,
    port: PORT,
    cloudState: cloud.getState(),
  });
});

/** Dataset statistics — where every training example comes from. */
app.get("/api/v1/dataset/stats", (req, res) => {
  try {
    res.json(datasetStats(db));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** All users. */
app.get("/api/v1/users", (req, res) => {
  try {
    res.json(db.prepare("SELECT * FROM users ORDER BY id DESC").all());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Create a user. */
app.post("/api/v1/users", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  if (!requireAdmin(req, res)) return;
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "name and email are required" });
  try {
    const info = db.prepare("INSERT INTO users (name, email) VALUES (?, ?)").run(name, email);
    tryMirror("users", info.lastInsertRowid, { id: info.lastInsertRowid, name, email });
    res.json({ success: true, id: Number(info.lastInsertRowid) });
  } catch (err: any) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return res.status(409).json({ error: "A user with this email already exists." });
    }
    res.status(500).json({ error: err.message });
  }
});

/** Delete a user. */
app.delete("/api/v1/users/:id", (req, res) => {
  if (blockWhileRestoring(req, res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    tryMirrorDelete("users", req.params.id);
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
  pushLog("info", "system", "🚀 Application state: starting");
  try {
    await cloud.runStartupRestore();
    // The Markov model may have just been restored from the channel.
    ai.reload();
  } catch (err: any) {
    console.error("❌ Startup restore crashed (continuing with local data):", err?.message || err);
  }
  try {
    const seeded = applyBuiltInSeed(db);
    if (!seeded.skipped) {
      ai.runTrain("startup");
      pushLog(
        "info",
        "system",
        `🌱 Built-in language seed applied — ${seeded.knowledgeInserted} docs, ${seeded.pairsInserted} Q/A pairs; model trained`
      );
    }
  } catch (err: any) {
    console.warn("⚠️  Built-in seed skipped:", err?.message || err);
  }
  console.log(`🚀 Application state: ${cloud.getState()}`);
  pushLog("info", "system", `🚀 Application state: ${cloud.getState()}`);

  if (cloud.getState() === "restore_failed") {
    console.error(
      "❌ Restore failed. Local data was NOT modified. The Telegram bot stays OFF so it cannot write on top of an unrestored database. " +
        "Fix the issue and use 'Restore Latest' in the Telegram Storage tab, or restart the service."
    );
  } else {
    cloud.markReady();
    // Long-polling starts only once the app is ready.
    if (telegramBot) {
      telegramBot
        .start()
        .then(() => pushLog("info", "system", "🤖 Telegram bot long-polling started"))
        .catch((err) => console.error("Failed to start Telegram bot:", err.message));
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
