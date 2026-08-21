/**
 * Language + chat-shortcut tests.
 * -------------------------------
 * Covers the three things a user actually notices:
 *   1. the AI understands English, বাংলা and Banglish (and answers in kind)
 *   2. research queries are cleaned/translated before they hit a search engine
 *   3. chat history shortcuts (search, rename, edit, delete, clear all)
 *
 * Everything runs offline — no network, no Telegram, in-memory SQLite only.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryDatabase } from "../server/db.ts";
import { AIEngine } from "../server/ai/engine.ts";
import {
  banglishToBengali,
  detectLanguage,
  normalizeForMatch,
  languageVariants,
} from "../server/ai/language.ts";
import { buildResearchQuery, relevanceScore, stripFiller, scoringTerms } from "../server/research/query.ts";
import { isResearchQuestion } from "../server/research/research.ts";
import { validateSnapshot, buildSnapshot, importDump, computeChecksum, SCHEMA_VERSION } from "../server/snapshot.ts";

// ---------------------------------------------------------------------------
// 1. Language detection
// ---------------------------------------------------------------------------

test("language detection separates English, Bangla and Banglish", () => {
  assert.equal(detectLanguage("what is the capital of France?"), "en");
  assert.equal(detectLanguage("বাংলাদেশের রাজধানী কী?"), "bn");
  assert.equal(detectLanguage("Bangladesher rajdhani ki?"), "banglish");
  assert.equal(detectLanguage("tumi kemon acho"), "banglish");
  assert.equal(detectLanguage("My name is Tufazzal"), "en");
  assert.equal(detectLanguage("12 * 8 + 4"), "en");
  // Ordinary English must never be classified as Banglish (regression).
  assert.equal(detectLanguage("please tell me about Alan Turing"), "en");
  assert.equal(detectLanguage("can you help me with this question"), "en");
  assert.equal(detectLanguage("the weather in London is bad today"), "en");
  assert.equal(detectLanguage("I will go to school after lunch"), "en");
  assert.equal(detectLanguage("this is a test of the English language"), "en");
});

test("Banglish dictionary covers conjugations, family, food and numbers", () => {
  assert.equal(banglishToBengali("ami khabo"), "আমি খাব");
  assert.equal(banglishToBengali("ammu baba bhai bon"), "মা বাবা ভাই বোন");
  assert.equal(banglishToBengali("bhat dal ilish"), "ভাত ডাল ইলিশ");
  assert.equal(banglishToBengali("ek dui tin char pach"), "এক দুই তিন চার পাঁচ");
  assert.equal(banglishToBengali("chottogram sylhet khulna"), "চট্টগ্রাম সিলেট খুলনা");
  // spelling variants
  assert.equal(banglishToBengali("valo"), "ভালো");
  assert.equal(banglishToBengali("shuru"), "শুরু");
  assert.equal(banglishToBengali("kibhabe"), "কীভাবে");
});

test("all three scripts normalise onto ONE canonical form", () => {
  assert.equal(normalizeForMatch("আমার নাম কী"), "amar nam ki");
  assert.equal(normalizeForMatch("Amar naam kee?"), "amar nam ki");
  assert.equal(normalizeForMatch("কেমন আছো"), "kemon acho");
  assert.equal(normalizeForMatch("Kemon acho!"), "kemon acho");
  // Bengali words that are not in the dictionary stay intact (no letter split).
  assert.match(normalizeForMatch("সর্বশেষ খবর"), /সর্বশেষ/);
});

test("Banglish is transliterated into Bengali for search", () => {
  assert.equal(banglishToBengali("amar nam ki"), "আমার নাম কি");
  assert.equal(banglishToBengali("ke bangladesher pradhanmontri"), "কে বাংলাদেশের প্রধানমন্ত্রী");
  // Unknown words are left alone rather than mangled.
  assert.match(banglishToBengali("Tufazzal kemon ache"), /Tufazzal/);
});

test("languageVariants offers every useful spelling of a message", () => {
  const v = languageVariants("amar nam ki");
  assert.ok(v.some((x) => /আমার/.test(x)), "must include the Bengali spelling");
  assert.ok(v.includes("amar nam ki"), "must keep the original");
});

// ---------------------------------------------------------------------------
// 2. The brain answers in the user's language
// ---------------------------------------------------------------------------

function engine() {
  return new AIEngine(createMemoryDatabase());
}

test("greetings work in English, Bangla and Banglish", () => {
  const e = engine();
  assert.match(e.reply("hello").reply, /Hello!/);
  assert.match(e.reply("হাই").reply, /আসসালামু|আমি আপনার/);
  assert.match(e.reply("assalamualaikum").reply, /Assalamu|Hello/);
});

test("'how are you' is understood in all three languages", () => {
  const e = engine();
  assert.equal(e.reply("how are you").mode, "intent");
  assert.equal(e.reply("কেমন আছো").mode, "intent");
  assert.equal(e.reply("kemon acho").mode, "intent");
  assert.match(e.reply("কেমন আছো").reply, /ভালো আছি/);
});

test("memory: a name stored in one language is recalled in another", () => {
  const e = engine();
  assert.match(e.reply("My name is Tufazzal").reply, /Tufazzal/);
  assert.match(e.reply("amar nam ki").reply, /Tufazzal/);
  assert.match(e.reply("আমার নাম কী").reply, /Tufazzal/);
  assert.match(e.reply("what is my name").reply, /Tufazzal/);
});

test("'amar nam ki?' is a QUESTION and never stored as the name", () => {
  const e = engine();
  const r = e.reply("amar nam ki");
  assert.equal(r.mode, "memory");
  assert.match(r.reply, /ekhono nam bolen ni|haven't told me/i);
  // …and asking again must not have "learned" the word "ki".
  assert.doesNotMatch(e.reply("amar nam ki").reply, /Apnar nam ki/i);
});

test("Bengali memory commands work (মনে রাখো …)", () => {
  const e = engine();
  const r = e.reply("মনে রাখো আমি চা পছন্দ করি");
  assert.equal(r.mode, "memory");
  assert.match(r.reply, /সেভ|মনে/);
});

test("math answers in the language of the question", () => {
  const e = engine();
  assert.equal(e.reply("12 * 8 + 4").reply, "The result is 100.");
});

test("an untrained brain never answers a question with Markov gibberish", () => {
  const db = createMemoryDatabase();
  // Feed the corpus with unrelated text and train.
  db.prepare("INSERT INTO conversations (id, title) VALUES (1, 'corpus')").run();
  for (const c of ["i love cricket and tea", "cricket is the best game", "tea with milk please"]) {
    db.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (1, 'user', ?)").run(c);
  }
  const e = new AIEngine(db);
  e.train();
  const r = e.reply("who is the president of Bangladesh?");
  assert.notEqual(r.mode, "generate", "a question must never be answered by the Markov model");
});

// ---------------------------------------------------------------------------
// 3. Research query building & ranking
// ---------------------------------------------------------------------------

test("conversational filler is stripped before searching", () => {
  assert.equal(stripFiller("can you please tell me about alan turing?"), "alan turing");
  assert.equal(stripFiller("/research alan turing"), "alan turing");
  assert.equal(stripFiller("tell me the capital of france"), "the capital of france");
});

test("a Banglish question is searched in Bengali first", () => {
  const q = buildResearchQuery("Bangladesher rajdhani ki?");
  assert.equal(q.lang, "banglish");
  assert.match(q.primary, /বাংলাদেশের/, "the Bengali spelling must be the primary query");
  assert.ok(q.variants.length > 0, "the Latin spelling stays as a fallback variant");
});

test("a Bengali question keeps Bengali as the primary query", () => {
  const q = buildResearchQuery("বাংলাদেশের রাজধানী কী?");
  assert.equal(q.lang, "bn");
  assert.equal(q.primary, "বাংলাদেশের রাজধানী");
});

test("short topics are title-like, long sentences are not", () => {
  assert.equal(buildResearchQuery("alan turing").titleLike, true);
  assert.equal(buildResearchQuery("who is the current prime minister of the country of bangladesh").titleLike, false);
});

test("relevance scoring rejects an answer that has nothing to do with the question", () => {
  const terms = scoringTerms("who is alan turing");
  const good = relevanceScore(
    { title: "Alan Turing", snippet: "Alan Turing was a British mathematician and computer scientist." },
    terms
  );
  const bad = relevanceScore({ title: "Cheap flights to Dhaka", snippet: "Book now and save 40%." }, terms);
  assert.ok(good > 0.6, `a matching answer must score high (got ${good})`);
  assert.ok(bad < 0.2, `an unrelated answer must score low (got ${bad})`);
  assert.ok(good > bad);
});

test("question detection handles Bengali/Banglish questions that END with the question word", () => {
  assert.equal(isResearchQuestion("বাংলাদেশের রাজধানী কী"), true);
  assert.equal(isResearchQuestion("tomar nam ki"), true);
  assert.equal(isResearchQuestion("ke bangladesher pradhanmontri"), true);
  assert.equal(isResearchQuestion("My name is Tufazzal"), false);
  assert.equal(isResearchQuestion("just chatting with you"), false);
});

// ---------------------------------------------------------------------------
// 4. Restore: backwards compatibility with older snapshots
// ---------------------------------------------------------------------------

test("an OLD (schema v1) snapshot without the newer tables can still be restored", () => {
  const source = createMemoryDatabase();
  source.prepare("INSERT INTO users (name, email) VALUES ('A', 'a@b.c')").run();
  source.prepare("INSERT INTO conversations (title) VALUES ('Old chat')").run();
  source.prepare("INSERT INTO chat_messages (session_id, role, content) VALUES (1, 'user', 'hi')").run();
  source.prepare("INSERT INTO knowledge (title, content) VALUES ('doc', 'body')").run();

  // Simulate a v1 snapshot: no research_cache / research_negcache at all.
  const doc: any = buildSnapshot(source);
  doc.meta.schemaVersion = 1;
  delete doc.data.research_cache;
  delete doc.data.research_negcache;
  delete doc.meta.counts.research_cache;
  delete doc.meta.counts.research_negcache;
  // Recompute the integrity fields for the reduced payload.
  doc.meta.totalRecords = Object.values(doc.data).reduce((n: number, rows: any) => n + rows.length, 0);
  doc.meta.checksum = computeChecksum(doc.data);

  const v = validateSnapshot(doc);
  assert.equal(v.valid, true, `an older snapshot must stay restorable: ${v.reason}`);

  const target = createMemoryDatabase();
  const restored = importDump(target, doc);
  assert.equal(restored.users, 1);
  assert.equal(restored.chat_messages, 1);
  assert.equal((target.prepare("SELECT COUNT(*) c FROM knowledge").get() as any).c, 1);
});

test("a CURRENT-schema snapshot with a missing table is still rejected", () => {
  const source = createMemoryDatabase();
  source.prepare("INSERT INTO memory (key, value) VALUES ('name', 'x')").run();
  const doc: any = buildSnapshot(source);
  assert.equal(doc.meta.schemaVersion, SCHEMA_VERSION);
  delete doc.data.memory;
  const v = validateSnapshot(doc);
  assert.equal(v.valid, false);
  assert.match(String(v.reason), /memory/);
});
