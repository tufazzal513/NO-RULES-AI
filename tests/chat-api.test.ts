/**
 * End-to-end tests for the chat shortcut API.
 * -------------------------------------------
 * A REAL server process is started (production mode, temp SQLite file, no
 * Telegram) and driven over HTTP, so the routes, the SQL and the AI wiring are
 * all exercised exactly as they run on Render.
 *
 * Covered shortcuts: history list + search, rename, edit-and-rerun,
 * delete one message, delete one chat, clear the whole history.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 4300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myai-test-"));
const dbFile = path.join(tmpDir, "chat-api.db");

let proc: ChildProcessWithoutNullStreams | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health/detailed`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("server did not start in time");
}

async function call(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json ?? text };
}

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "production",
      DATABASE_URL: `sqlite:///${dbFile}`,
      RESEARCH_ENABLED: "false", // keep the suite fully offline
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_STORAGE_CHAT_ID: "",
      ADMIN_PASSWORD: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  await waitForServer();
});

after(async () => {
  proc?.kill("SIGKILL");
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ---------------------------------------------------------------------------

test("a chat is created by the first message and appears in the history list", async () => {
  const sent = await call("POST", "/api/v1/ai/chat", { message: "hello there" });
  assert.equal(sent.status, 200);
  const sid = sent.body.sessionId;
  assert.ok(sid, "a session id must come back");

  const list = await call("GET", "/api/v1/chats");
  assert.equal(list.status, 200);
  const chat = list.body.find((c: any) => c.id === sid);
  assert.ok(chat, "the new chat must show up in the history");
  assert.equal(chat.messageCount, 2, "question + answer");
  assert.ok(chat.preview, "the history list carries a preview line");
});

test("history search matches chat titles AND message text", async () => {
  const a = await call("POST", "/api/v1/ai/chat", { message: "tell me about pineapples" });
  await call("POST", "/api/v1/ai/chat", { sessionId: a.body.sessionId, message: "an unmistakable zebra fact" });

  const byMessage = await call("GET", "/api/v1/chats?q=zebra");
  assert.ok(
    byMessage.body.some((c: any) => c.id === a.body.sessionId),
    "searching message text must find the chat"
  );

  const byTitle = await call("GET", "/api/v1/chats?q=pineapples");
  assert.ok(byTitle.body.some((c: any) => c.id === a.body.sessionId), "searching the title must find the chat");

  const nothing = await call("GET", "/api/v1/chats?q=zzzznotarealword");
  assert.equal(nothing.body.length, 0);
});

test("a chat can be renamed", async () => {
  const created = await call("POST", "/api/v1/ai/chat", { message: "rename me please" });
  const sid = created.body.sessionId;

  const renamed = await call("PATCH", `/api/v1/chats/${sid}`, { title: "My renamed chat" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, "My renamed chat");

  const list = await call("GET", "/api/v1/chats");
  assert.equal(list.body.find((c: any) => c.id === sid).title, "My renamed chat");

  const empty = await call("PATCH", `/api/v1/chats/${sid}`, { title: "   " });
  assert.equal(empty.status, 400, "an empty title is refused");
});

test("editing a sent message rewrites it, drops the stale answer and replies again", async () => {
  const created = await call("POST", "/api/v1/ai/chat", { message: "12 * 8 + 4" });
  const sid = created.body.sessionId;
  assert.match(created.body.reply, /100/);

  const msgs = await call("GET", `/api/v1/chats/${sid}/messages`);
  const question = msgs.body.find((m: any) => m.role === "user");

  const edited = await call("PATCH", `/api/v1/chats/${sid}/messages/${question.id}`, { content: "2 + 2" });
  assert.equal(edited.status, 200);
  assert.match(edited.body.reply, /4/, "the AI must answer the NEW question");
  assert.equal(edited.body.removed, 1, "the outdated answer is removed");

  const after = await call("GET", `/api/v1/chats/${sid}/messages`);
  assert.equal(after.body.length, 2, "still exactly one question + one answer");
  assert.equal(after.body[0].content, "2 + 2");
  assert.match(after.body[1].content, /4/);
  assert.doesNotMatch(after.body[1].content, /100/, "the old answer must be gone");
});

test("an AI message cannot be edited, and a missing message 404s", async () => {
  const created = await call("POST", "/api/v1/ai/chat", { message: "hello again" });
  const sid = created.body.sessionId;
  const msgs = await call("GET", `/api/v1/chats/${sid}/messages`);
  const aiMsg = msgs.body.find((m: any) => m.role === "ai");

  const bad = await call("PATCH", `/api/v1/chats/${sid}/messages/${aiMsg.id}`, { content: "nope" });
  assert.equal(bad.status, 400);

  const missing = await call("PATCH", `/api/v1/chats/${sid}/messages/999999`, { content: "nope" });
  assert.equal(missing.status, 404);
});

test("regenerate replaces the last answer without duplicating the question", async () => {
  const created = await call("POST", "/api/v1/ai/chat", { message: "7 * 6" });
  const sid = created.body.sessionId;

  const again = await call("POST", `/api/v1/chats/${sid}/regenerate`);
  assert.equal(again.status, 200);
  assert.match(again.body.reply, /42/);

  const msgs = await call("GET", `/api/v1/chats/${sid}/messages`);
  assert.equal(msgs.body.filter((m: any) => m.role === "user").length, 1);
  assert.equal(msgs.body.filter((m: any) => m.role === "ai").length, 1);
});

test("deleting a question also deletes the answer that belonged to it", async () => {
  const created = await call("POST", "/api/v1/ai/chat", { message: "first question" });
  const sid = created.body.sessionId;
  await call("POST", "/api/v1/ai/chat", { sessionId: sid, message: "second question" });

  const msgs = await call("GET", `/api/v1/chats/${sid}/messages`);
  assert.equal(msgs.body.length, 4);
  const first = msgs.body[0];

  const del = await call("DELETE", `/api/v1/chats/${sid}/messages/${first.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, 2, "question + its answer");

  const left = await call("GET", `/api/v1/chats/${sid}/messages`);
  assert.equal(left.body.length, 2);
  assert.equal(left.body[0].content, "second question");
});

test("deleting a chat removes its messages too (no orphans)", async () => {
  const created = await call("POST", "/api/v1/ai/chat", { message: "delete this whole chat" });
  const sid = created.body.sessionId;

  const del = await call("DELETE", `/api/v1/chats/${sid}`);
  assert.equal(del.status, 200);

  const list = await call("GET", "/api/v1/chats");
  assert.ok(!list.body.some((c: any) => c.id === sid));

  const msgs = await call("GET", `/api/v1/chats/${sid}/messages`);
  assert.equal(msgs.body.length, 0, "the messages must be gone as well");
});

test("clear-all wipes the history but keeps knowledge and memory", async () => {
  await call("POST", "/api/v1/ai/chat", { message: "My name is Tufazzal" });
  await call("POST", "/api/v1/knowledge", { title: "keep me", content: "this document must survive" });

  const cleared = await call("DELETE", "/api/v1/chats");
  assert.equal(cleared.status, 200);
  assert.ok(cleared.body.deleted >= 1);

  const list = await call("GET", "/api/v1/chats");
  assert.equal(list.body.length, 0, "no chats left");

  const knowledge = await call("GET", "/api/v1/knowledge");
  assert.ok(knowledge.body.some((k: any) => k.title === "keep me"), "knowledge is untouched");

  const memory = await call("GET", "/api/v1/memory");
  assert.ok(memory.body.some((m: any) => m.key === "name"), "memory is untouched");
});

test("restore from an uploaded snapshot file brings the data back", async () => {
  // Seed something recognisable, then take a local snapshot of it.
  await call("POST", "/api/v1/ai/chat", { message: "a message that must come back" });
  const snapRes = await fetch(`${BASE}/api/v1/telegram/snapshot/download`);
  const snapshot = await snapRes.json();
  assert.ok(snapshot?.meta?.checksum, "the downloaded snapshot must be a valid document");

  // Wipe everything, then restore from the file we just downloaded.
  await call("DELETE", "/api/v1/chats");
  assert.equal((await call("GET", "/api/v1/chats")).body.length, 0);

  const restored = await call("POST", "/api/v1/telegram/restore/file", { snapshot });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.success, true);

  const list = await call("GET", "/api/v1/chats");
  assert.ok(list.body.length > 0, "the chats came back from the snapshot file");
});

test("a corrupt uploaded snapshot is rejected and changes nothing", async () => {
  const before = (await call("GET", "/api/v1/chats")).body.length;

  const bad = await call("POST", "/api/v1/telegram/restore/file", {
    snapshot: { meta: { schemaVersion: 2, checksum: "x".repeat(64), counts: {}, totalRecords: 0 }, data: {} },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.success, false);

  const after = (await call("GET", "/api/v1/chats")).body.length;
  assert.equal(after, before, "a rejected snapshot must never touch the database");
});
