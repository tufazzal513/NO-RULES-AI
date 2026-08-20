import express from "express";
import path from "path";
import os from "os";
import Database from "better-sqlite3";
import fs from "fs";
import cors from "cors";
import { TelegramStorage } from "./server/telegram.ts";
import { AIEngine } from "./server/ai/engine.ts";

// Initialize express app
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Initialize SQLite Database
let dbPath = path.join(process.cwd(), "myai.db");

// Use DATABASE_URL from .env if provided (strip sqlite:/// prefix if present)
if (process.env.DATABASE_URL) {
  let customPath = process.env.DATABASE_URL;
  if (customPath.startsWith("sqlite:///")) {
    customPath = customPath.replace("sqlite:///", "");
  } else if (customPath.startsWith("sqlite://")) {
    customPath = customPath.replace("sqlite://", "");
  }
  dbPath = path.resolve(process.cwd(), customPath);
}

let db: any;
try {
  // Ensure the directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  console.log("Connected to SQLite database at", dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      role TEXT CHECK(role IN ('user', 'ai')),
      content TEXT NOT NULL,
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
  `);
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
// Helpers
// ---------------------------------------------------------------------------

/** Push a record to Telegram as a JSON message (non-blocking, best-effort). */
function tryMirror(collection: string, recordId: string | number, payload: any): void {
  if (!telegram.configured) return;
  telegram
    .saveRecord(collection, recordId, payload)
    .then((r) => {
      try {
        db.prepare(
          "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
        ).run(collection, String(recordId), r.messageId, null);
      } catch (e: any) {
        console.error("Failed to index telegram message:", e.message);
      }
    })
    .catch((err) => console.error("Telegram mirror failed:", err.message));
}

/** Dump the whole local database as a JSON object (all tables). */
function dumpAll(): Record<string, any[]> {
  const tables = ["users", "conversations", "chat_messages", "telegram_index"];
  const dump: Record<string, any[]> = {};
  for (const table of tables) {
    try {
      dump[table] = db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      dump[table] = [];
    }
  }
  return dump;
}

/** Restore tables from a JSON dump object. */
function importDump(dump: Record<string, any[]>) {
  const tables = ["users", "conversations", "chat_messages", "telegram_index"];
  const tx = db.transaction(() => {
    for (const table of tables) {
      if (!Array.isArray(dump[table])) continue;
      db.prepare(`DELETE FROM ${table}`).run();
      const rows = dump[table];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
      );
      for (const row of rows) {
        insert.run(...columns.map((c) => row[c]));
      }
    }
  });
  tx();
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

    res.json({
      status: "Operational",
      api: "Online",
      database: "SQLite (myai.db)",
      model: "BasicEngine",
      telegram: telegram.configured ? "Configured" : "Not configured",
      stats: {
        totalUsers: userRow ? userRow.count : 0,
        totalConversations: convRow ? convRow.count : 0,
        totalMessages: msgRow ? msgRow.count : 0,
        telegramRecords: tgRow ? tgRow.count : 0,
        knowledgeDocs: 0,
        datasetCount: 0,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch stats", details: err.message });
  }
});

app.get("/api/v1/telegram/status", async (req, res) => {
  try {
    const status = await telegram.status();
    const indexed = (db.prepare("SELECT COUNT(*) as count FROM telegram_index").get() as any).count;
    res.json({ ...status, indexedRecords: indexed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    const counts = { users: 0, conversations: 0, chat_messages: 0 };
    const tables = ["users", "conversations", "chat_messages"] as const;
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const id = row.id ?? row.rowid ?? `${Date.now()}-${Math.random()}`;
        const r = await telegram.saveRecord(table, id, row);
        db.prepare(
          "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
        ).run(table, String(id), r.messageId, null);
        counts[table as keyof typeof counts]++;
      }
    }
    res.json({ success: true, message: "All data synced to Telegram channel.", counts });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Create a full JSON snapshot file and upload it to Telegram. */
app.post("/api/v1/telegram/snapshot", async (req, res) => {
  try {
    const dump = dumpAll();
    const snapshotName = `myai_snapshot_${Date.now()}.json`;
    const tmpPath = path.join(os.tmpdir(), snapshotName);
    let result;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(dump, null, 2), "utf-8");
      result = await telegram.saveFile(tmpPath, `📦 Full snapshot — ${new Date().toISOString()}`);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
    db.prepare(
      "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
    ).run("snapshot", result.fileId, result.messageId, result.fileId);
    res.json({
      success: true,
      message: "Snapshot uploaded to Telegram.",
      fileId: result.fileId,
      messageId: result.messageId,
      fileName: result.fileName,
      hint: "Keep this fileId safe — use it to restore everything later.",
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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

/** Restore the database from a Telegram snapshot (by fileId, or the latest one). */
app.post("/api/v1/telegram/restore", async (req, res) => {
  try {
    let fileId: string | undefined = req.body?.fileId;
    if (!fileId) {
      const latest = db
        .prepare("SELECT telegram_file_id FROM telegram_index WHERE collection = 'snapshot' ORDER BY id DESC LIMIT 1")
        .get() as any;
      fileId = latest?.telegram_file_id;
    }
    if (!fileId) {
      return res.status(400).json({ success: false, error: "No snapshot fileId provided and none found locally." });
    }
    const buffer = await telegram.downloadFile(fileId);
    const dump = JSON.parse(buffer.toString("utf-8"));
    importDump(dump);
    res.json({
      success: true,
      message: "Database restored from Telegram snapshot.",
      restoredTables: Object.keys(dump).filter((k) => Array.isArray(dump[k])),
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
  try {
    const stats = ai.train();
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
  try {
    db.prepare("DELETE FROM knowledge WHERE id = ?").run(req.params.id);
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
  const { key, value } = req.body || {};
  if (!key || !value) return res.status(400).json({ error: "key and value are required" });
  try {
    db.prepare("INSERT INTO memory (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/v1/memory/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM memory WHERE id = ?").run(req.params.id);
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

  // Handle graceful shutdown
  process.on("SIGTERM", () => {
    console.log("SIGTERM signal received: closing HTTP server");
    server.close(() => {
      console.log("HTTP server closed");
      if (db) {
        db.close();
      }
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("SIGINT signal received: closing HTTP server");
    server.close(() => {
      console.log("HTTP server closed");
      if (db) {
        db.close();
      }
      process.exit(0);
    });
  });
}

startServer();
