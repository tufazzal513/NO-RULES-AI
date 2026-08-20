/**
 * AIEngine — the local, offline "brain" of MY-AI.
 * -------------------------------------------------
 * Decision order for every message:
 *   1. math          → safe arithmetic evaluator
 *   2. intent        → greetings, help, time, who-are-you…
 *   3. memory        → store/recall facts about the user
 *   4. knowledge     → BM25 retrieval over the user's own documents (local RAG)
 *   5. generate      → Markov text generated in the user's own style
 *   6. fallback      → honest guidance
 *
 * No external AI service is used anywhere in this path.
 */

import { MarkovModel } from "./markov.ts";
import { BM25, meaningfulTerms, type KnowledgeDoc } from "./retrieval.ts";
import { detectIntent, tryEvaluateMath } from "./intents.ts";

export type AIMode = "intent" | "memory" | "knowledge" | "generate" | "fallback";

export interface ChatResult {
  reply: string;
  mode: AIMode;
}

export interface EngineStatus {
  trained: boolean;
  corpusMessages: number;
  knowledgeDocs: number;
  memoryFacts: number;
  modelChains: number;
  vocabSize: number;
}

/** Optional hooks so the server can mirror AI-side writes to Telegram. */
export interface AIEngineHooks {
  onMemoryChange?: (row: { id?: number; key: string; value: string }) => void;
  onModelChange?: (row: { key: string; value: string }) => void;
}

export class AIEngine {
  private db: any;
  private markov = new MarkovModel();
  private hooks: AIEngineHooks;

  constructor(db: any, hooks: AIEngineHooks = {}) {
    this.db = db;
    this.hooks = hooks;
    this.load();
  }

  /** Attach/replace the mirror hooks after construction. */
  setHooks(hooks: AIEngineHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** Reload the persisted model — used right after a Telegram restore. */
  reload(): void {
    this.markov.reset();
    this.load();
  }

  private load(): void {
    try {
      const row = this.db.prepare("SELECT value FROM ai_model WHERE key = 'markov'").get();
      if (row && row.value) this.markov.fromJSON(JSON.parse(row.value));
    } catch (e) {
      console.error("Failed to load AI model:", (e as Error).message);
    }
  }

  private persist(): void {
    try {
      const json = JSON.stringify(this.markov.toJSON());
      this.db
        .prepare(
          "INSERT INTO ai_model (key, value) VALUES ('markov', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
        )
        .run(json);
      this.hooks.onModelChange?.({ key: "markov", value: json });
    } catch (e) {
      console.error("Failed to persist AI model:", (e as Error).message);
    }
  }

  // -- memory ---------------------------------------------------------------
  private getMemory(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM memory WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  private setMemory(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO memory (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
    try {
      const row = this.db.prepare("SELECT id FROM memory WHERE key = ?").get(key) as any;
      this.hooks.onMemoryChange?.({ id: row?.id, key, value });
    } catch {
      /* mirroring is best-effort */
    }
  }

  private allMemory(): { key: string; value: string }[] {
    return this.db.prepare("SELECT key, value FROM memory ORDER BY key").all();
  }

  private handleMemory(input: string): string | null {
    const t = input.trim();
    const lower = t.toLowerCase();
    let m: RegExpMatchArray | null;

    // --- stores (checked first, so "My name is X" stores instead of recalling) ---
    if ((m = t.match(/^(?:my name is|amar nam|আমার নাম)\s+(.+)$/i))) {
      const name = m[1].replace(/[.!?।]$/, "").trim();
      this.setMemory("name", name);
      return `Nice to meet you, ${name}! I'll remember your name. 🧠`;
    }
    if ((m = t.match(/^(?:i am|i'm)\s+(.+)$/i))) {
      const val = m[1].replace(/[.!?।]$/, "").trim();
      this.setMemory("about", val);
      return "Got it — I've saved that about you. 🧠";
    }
    if ((m = t.match(/^(?:i like|i love|amar pochondo|আমার পছন্দ)\s+(.+)$/i))) {
      const val = m[1].replace(/[.!?।]$/, "").trim();
      this.setMemory("likes", val);
      return "Noted! I'll remember that. 🧠";
    }
    if ((m = t.match(/^(?:remember that|remember|মনে রাখ|মনে রাখো)\s+(.+)$/i))) {
      const val = m[1].replace(/[.!?।]$/, "").trim();
      this.setMemory("note_" + Date.now(), val);
      return "Saved to my memory. 🧠";
    }

    // --- recalls ---
    if (/^(what is my name|what's my name|amar nam ki|আমার নাম কি)/.test(lower)) {
      const n = this.getMemory("name");
      return n
        ? `Your name is ${n}. 🙂`
        : `You haven't told me your name yet. Say "My name is …" and I'll remember it.`;
    }
    if (/(what do you know about me|আমার সম্পর্কে কি জান|আমার সম্পর্কে)/.test(lower)) {
      const mems = this.allMemory().filter((x) => x.key !== "name");
      const name = this.getMemory("name");
      if (mems.length === 0 && !name) {
        return "I don't know much about you yet — tell me things and I'll remember!";
      }
      const lines = mems.map((x) => `• ${x.key}: ${x.value}`).join("\n");
      return (name ? `Your name is ${name}.\n` : "") + "Here's what I remember:\n" + lines;
    }
    return null;
  }

  // -- knowledge (local RAG) --------------------------------------------------
  private retrieve(input: string): ChatResult | null {
    try {
      const docs = this.db.prepare("SELECT id, title, content FROM knowledge").all() as KnowledgeDoc[];
      if (docs.length === 0) return null;
      const bm25 = new BM25(docs);
      const results = bm25.search(input, 1);
      if (results.length === 0) return null;
      const r = results[0];

      // Require at least one meaningful (non-stopword) query term to actually
      // appear in the document — avoids false positives on common words.
      const qTerms = meaningfulTerms(input);
      if (qTerms.length === 0) return null;
      const haystack = ((r.doc.title || "") + " " + (r.doc.content || "")).toLowerCase();
      const matched = qTerms.some((t) => haystack.includes(t));
      if (!matched || r.score < 0.2) return null;

      return {
        reply: `📚 From my knowledge "${r.doc.title}":\n\n${r.snippet}\n\n(confidence: ${r.score.toFixed(1)})`,
        mode: "knowledge",
      };
    } catch (e) {
      console.error("Knowledge retrieval failed:", (e as Error).message);
      return null;
    }
  }

  reply(input: string): ChatResult {
    const math = tryEvaluateMath(input);
    if (math !== null) return { reply: `The result is ${math}.`, mode: "intent" };

    const intent = detectIntent(input);
    if (intent) return { reply: intent, mode: "intent" };

    const mem = this.handleMemory(input);
    if (mem) return { reply: mem, mode: "memory" };

    const know = this.retrieve(input);
    if (know) return know;

    if (this.markov.trained) {
      const gen = this.markov.generate(60);
      if (gen) return { reply: gen, mode: "generate" };
    }

    return {
      reply:
        "I'm your offline personal AI and I'm still learning. ✨\n\n" +
        "• Chat more, then press Train in the AI Brain tab so I learn your language.\n" +
        "• Add documents in AI Brain → Knowledge and I'll answer from them.\n" +
        "• Tell me facts (like \"My name is …\") and I'll remember them.\n\n" +
        "Everything stays on your own machine and your Telegram cloud database.",
      mode: "fallback",
    };
  }

  train(): EngineStatus & { trainedMessages: number } {
    const rows = this.db
      .prepare("SELECT content FROM chat_messages WHERE role = 'user' ORDER BY id ASC")
      .all() as { content: string }[];
    this.markov.reset();
    for (const r of rows) this.markov.train(r.content);
    this.persist();
    return { ...this.status(), trainedMessages: rows.length };
  }

  status(): EngineStatus {
    const corpusMessages = (this.db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE role = 'user'").get() as any).c;
    const knowledgeDocs = (this.db.prepare("SELECT COUNT(*) c FROM knowledge").get() as any).c;
    const memoryFacts = (this.db.prepare("SELECT COUNT(*) c FROM memory").get() as any).c;
    return {
      trained: this.markov.trained,
      corpusMessages,
      knowledgeDocs,
      memoryFacts,
      modelChains: this.markov.size,
      vocabSize: this.markov.vocabSize,
    };
  }
}
