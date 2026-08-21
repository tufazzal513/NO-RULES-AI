import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryDatabase } from "../server/db.ts";
import { AIEngine } from "../server/ai/engine.ts";
import { planIngest, applyIngest, chunkText, extractPairs } from "../server/ingest.ts";

test("chunkText splits a long dump into knowledge-sized pieces", () => {
  const body = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} about বাংলা ভাষা and English mixed text. `.repeat(8)).join("\n\n");
  const chunks = chunkText("corpus", body);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].title, "corpus");
  assert.ok(chunks.every((c) => c.content.length > 0));
});

test("extractPairs reads User:/AI: transcripts", () => {
  const pairs = extractPairs(`User: amar nam ki?\nAI: Apnar nam Tufazzal.\nপ্রশ্ন: রাজধানী কী?\nউত্তর: ঢাকা।`);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].user, "amar nam ki?");
  assert.match(pairs[1].ai, /ঢাকা/);
});

test("jsonl ShareGPT rows become training pairs", () => {
  const jsonl =
    JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
    }) + "\n";
  const plan = planIngest([{ name: "chat.jsonl", content: jsonl }]);
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.pairs[0].ai, "hi there");
});

test("applyIngest writes knowledge + chat pairs and background train learns them", () => {
  const db = createMemoryDatabase();
  const plan = planIngest([
    {
      name: "bangla.txt",
      content: "বাংলা একটি ইন্দো-আর্য ভাষা। Bangladesh e Bangla kotha bola hoy.\n\nUser: ki koro?\nAI: ami shikhchi.",
    },
  ]);
  const applied = applyIngest(db, plan, { source: "ingest" });
  assert.ok(applied.knowledgeInserted >= 1);
  assert.equal(applied.pairsInserted, 1);
  const e = new AIEngine(db);
  const st = e.train();
  assert.equal(st.trained, true);
  assert.ok(st.knowledgeDocs >= 1);
});
