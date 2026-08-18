import express from "express";
import path from "path";
import Database from "better-sqlite3";
import fs from "fs";
import cors from "cors";

// Initialize express app
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

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
  db.pragma('journal_mode = WAL');
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
  `);
} catch (err) {
  console.error("Error opening database:", err);
}

// Helper for Telegram Backup
async function backupToTelegram() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_STORAGE_CHAT_ID;

  if (!botToken || !chatId) {
    throw new Error("Telegram credentials not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_STORAGE_CHAT_ID.");
  }

  if (!fs.existsSync(dbPath)) {
    throw new Error("Database file does not exist yet.");
  }

  // Create form data for file upload
  const fileStats = fs.statSync(dbPath);
  
  // Use fetch to upload the document
  const fileBuffer = fs.readFileSync(dbPath);
  const blob = new Blob([fileBuffer], { type: 'application/octet-stream' });
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', blob, 'myai.db');
  formData.append('caption', `Database backup: ${new Date().toISOString()}`);

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error: ${response.status} ${errorText}`);
  }

  return await response.json();
}

// API Routes
app.get("/api/v1/health/detailed", (req, res) => {
  try {
    const userRow = db.prepare("SELECT COUNT(*) as count FROM users").get() as any;
    const convRow = db.prepare("SELECT COUNT(*) as count FROM conversations").get() as any;
    
    res.json({
      status: "Operational",
      api: "Online",
      database: "SQLite (myai.db)",
      model: "BasicEngine",
      telegram: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_STORAGE_CHAT_ID) ? "Configured" : "Not configured",
      stats: {
        totalUsers: userRow ? userRow.count : 0,
        totalConversations: convRow ? convRow.count : 0,
        knowledgeDocs: 0,
        datasetCount: 0
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch stats", details: err.message });
  }
});

app.post("/api/v1/backup", async (req, res) => {
  try {
    const result = await backupToTelegram();
    res.json({ success: true, message: "Backup sent to Telegram successfully", result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/v1/users/seed", (req, res) => {
  try {
    db.prepare("INSERT INTO users (name, email) VALUES ('Admin User', 'admin@myai.local')").run();
    res.json({ success: true, message: "Test user created" });
  } catch (err: any) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return res.json({ success: true, message: "User already exists" });
    }
    return res.status(500).json({ error: err.message });
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
