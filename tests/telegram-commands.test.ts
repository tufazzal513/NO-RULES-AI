/**
 * Telegram bot chat-shortcut tests.
 * ---------------------------------
 * The bot must offer the SAME shortcuts as the web panel (new chat, history,
 * edit, regenerate, undo, clear, forget) and answer in the language the user
 * has been writing in — English, বাংলা or Banglish.
 *
 * Fully offline: in-memory SQLite, a stub AI, and a fake mirror that just
 * records what would have gone to Telegram.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryDatabase } from "../server/db.ts";
import { AIEngine } from "../server/ai/engine.ts";
import { createBotCommands } from "../server/telegram-commands.ts";

const CHAT_ID = 99001;

function rig() {
  const db = createMemoryDatabase();
  const ai = new AIEngine(db);
  const mirrored: { collection: string; id: string | number }[] = [];
  const deleted: { collection: string; id: string | number }[] = [];
  const bot = createBotCommands({
    db,
    ai,
    mirror: (collection, id) => mirrored.push({ collection, id }),
    mirrorDelete: (collection, id) => deleted.push({ collection, id }),
  });

  /** Send a normal (non-command) message exactly like the server does. */
  async function say(text: string): Promise<string> {
    const handled = await bot.handleCommand(text, CHAT_ID, "Tufazzal");
    if (handled.handled) return handled.reply;
    const conv = bot.currentConversation(CHAT_ID, "Tufazzal");
    bot.saveMessage(conv.id, "user", text);
    const r = await ai.replyAsync(text);
    bot.saveMessage(conv.id, "ai", r.reply);
    return r.reply;
  }

  const messages = () =>
    db.prepare("SELECT role, content FROM chat_messages ORDER BY id ASC").all() as { role: string; content: string }[];

  return { db, ai, bot, say, messages, mirrored, deleted };
}

// ---------------------------------------------------------------------------

test("/start and /help answer in the language the user has been writing in", async () => {
  const en = rig();
  await en.say("hello there");
  assert.match(await en.say("/help"), /Chat shortcuts/);

  const bn = rig();
  await bn.say("আমার নাম তুফাজ্জল");
  const bnHelp = await bn.say("/help");
  assert.match(bnHelp, /চ্যাট shortcut/, "a Bengali user must get Bengali help");

  const bl = rig();
  await bl.say("amar nam Tufazzal");
  const blHelp = await bl.say("/help");
  assert.match(blHelp, /Chat shortcut/i);
  assert.match(blHelp, /notun kothopokothon/, "a Banglish user must get Banglish help");
});

test("/new keeps the old conversation in history and opens a fresh one", async () => {
  const r = rig();
  await r.say("first conversation message");
  const firstId = r.bot.currentConversation(CHAT_ID, "Tufazzal").id;

  const reply = await r.say("/new");
  assert.match(reply, /🆕/);

  const secondId = r.bot.currentConversation(CHAT_ID, "Tufazzal").id;
  assert.notEqual(secondId, firstId, "a brand new conversation must be attached to the chat");

  // The old one still exists with its messages.
  const old = r.db.prepare("SELECT * FROM conversations WHERE id = ?").get(firstId) as any;
  assert.ok(old, "the previous conversation must be kept");
  assert.equal(old.telegram_chat_id, null, "…but detached from the live chat");
  assert.equal(
    Number((r.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE session_id = ?").get(firstId) as any).c),
    2,
    "its messages are untouched"
  );

  // Calling /new again on an empty conversation is a no-op.
  assert.match(await r.say("/new"), /already in a fresh/i);
});

test("/history lists the recent messages of this conversation", async () => {
  const r = rig();
  await r.say("what is 2 + 2");
  await r.say("what is 10 * 10");

  const out = await r.say("/history");
  assert.match(out, /what is 2 \+ 2/);
  assert.match(out, /what is 10 \* 10/);
  assert.match(out, /🧑/);
  assert.match(out, /✨/);
});

test("/chats lists every conversation and marks the current one", async () => {
  const r = rig();
  await r.say("conversation one");
  await r.say("/new");
  await r.say("conversation two");

  const out = await r.say("/chats");
  assert.match(out, /▶️/, "the active conversation is marked");
  assert.match(out, /conversation one/);
});

test("/edit rewrites the last question and answers the NEW one", async () => {
  const r = rig();
  const first = await r.say("12 * 8 + 4");
  assert.match(first, /100/);

  const edited = await r.say("/edit 2 + 2");
  assert.match(edited, /✏️/);
  assert.match(edited, /\b4\b/, "the answer must be for the edited question");

  const msgs = r.messages();
  assert.equal(msgs.length, 2, "exactly one question + one answer remain");
  assert.equal(msgs[0].content, "2 + 2");
  assert.doesNotMatch(msgs[1].content, /100/, "the stale answer is gone");
});

test("/edit without text explains how to use it", async () => {
  const r = rig();
  await r.say("hello");
  assert.match(await r.say("/edit"), /\/edit /);
});

test("/again regenerates without duplicating the question", async () => {
  const r = rig();
  await r.say("7 * 6");

  const again = await r.say("/again");
  assert.match(again, /42/);

  const msgs = r.messages();
  assert.equal(msgs.filter((m) => m.role === "user").length, 1);
  assert.equal(msgs.filter((m) => m.role === "ai").length, 1);
});

test("/undo removes the last question together with its answer", async () => {
  const r = rig();
  await r.say("first question");
  await r.say("second question");
  assert.equal(r.messages().length, 4);

  const out = await r.say("/undo");
  assert.match(out, /↩️/);

  const left = r.messages();
  assert.equal(left.length, 2);
  assert.equal(left[0].content, "first question");
});

test("/clear empties the conversation but keeps knowledge and memory", async () => {
  const r = rig();
  await r.say("My name is Tufazzal");
  r.db.prepare("INSERT INTO knowledge (title, content) VALUES ('keep', 'this survives')").run();

  const out = await r.say("/clear");
  assert.match(out, /🧹/);
  assert.equal(r.messages().length, 0);
  assert.equal(Number((r.db.prepare("SELECT COUNT(*) c FROM knowledge").get() as any).c), 1);
  assert.equal(Number((r.db.prepare("SELECT COUNT(*) c FROM memory").get() as any).c), 1, "memory is untouched");
});

test("/forget wipes the AI's memory of the user", async () => {
  const r = rig();
  await r.say("My name is Tufazzal");
  assert.match(await r.say("what is my name"), /Tufazzal/);

  const out = await r.say("/forget");
  assert.match(out, /🧠/);
  assert.equal(Number((r.db.prepare("SELECT COUNT(*) c FROM memory").get() as any).c), 0);
  assert.doesNotMatch(await r.say("what is my name"), /Tufazzal/);
});

test("/research is left to the AI brain, unknown commands are explained", async () => {
  const r = rig();
  const research = await r.bot.handleCommand("/research alan turing", CHAT_ID, "Tufazzal");
  assert.equal(research.handled, false, "the brain must handle /research itself");

  const unknown = await r.bot.handleCommand("/banana", CHAT_ID, "Tufazzal");
  assert.equal(unknown.handled, true);
  assert.match((unknown as any).reply, /banana/);
  assert.match((unknown as any).reply, /\/help/);
});

test("commands addressed to the bot (/help@MyBot) still work", async () => {
  const r = rig();
  const out = await r.bot.handleCommand("/help@MyAiBot", CHAT_ID, "Tufazzal");
  assert.equal(out.handled, true);
  assert.match((out as any).reply, /shortcuts?/i);
});

test("plain text is never treated as a command", async () => {
  const r = rig();
  const out = await r.bot.handleCommand("just a normal message", CHAT_ID, "Tufazzal");
  assert.equal(out.handled, false);
});

test("every bot-side change is mirrored to the Telegram cloud database", async () => {
  const r = rig();
  await r.say("hello");
  assert.ok(r.mirrored.some((m) => m.collection === "conversations"), "the conversation is mirrored");
  assert.ok(r.mirrored.some((m) => m.collection === "chat_messages"), "messages are mirrored");

  await r.say("/undo");
  assert.ok(r.deleted.some((d) => d.collection === "chat_messages"), "deletes emit tombstones");
});

test("the language survives /new — a fresh conversation is not English by default", async () => {
  const r = rig();
  await r.say("tumi kemon acho bolo to");
  await r.say("/new");
  const help = await r.say("/help");
  assert.match(help, /notun kothopokothon/, "Banglish must stick across a new conversation");

  const chats = await r.say("/chats");
  assert.match(chats, /kothopokothon/, "list headers follow the same language");
});
