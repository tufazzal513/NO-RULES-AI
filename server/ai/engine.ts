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
import {
  ResearchService,
  forcedResearchTopic,
  formatFinding,
  isResearchQuestion,
  type ResearchResult,
} from "../research/research.ts";

export type AIMode = "intent" | "memory" | "knowledge" | "research" | "generate" | "fallback";

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
  private research: ResearchService | null = null;

  constructor(db: any, hooks: AIEngineHooks = {}, research: ResearchService | null = null) {
    this.db = db;
    this.hooks = hooks;
    this.research = research;
    this.load();
  }

  /** Attach/replace the mirror hooks after construction. */
  setHooks(hooks: AIEngineHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** Attach the online research service (optional — brain still works without it). */
  setResearch(research: ResearchService | null): void {
    this.research = research;
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
        "I'm your personal AI and I'm still learning. ✨\n\n" +
        "• Chat more, then press Train in the AI Brain tab so I learn your language.\n" +
        "• Add documents in AI Brain → Knowledge and I'll answer from them.\n" +
        "• Tell me facts (like \"My name is …\") and I'll remember them.\n" +
        "• Ask me a current question — I can research it online, keyless and free.\n" +
        "  (Type /research <topic> to force an online lookup.)\n\n" +
        "Everything stays on your own machine and your Telegram cloud database.",
      mode: "fallback",
    };
  }

  private researchFailReply(res: ResearchResult, topic: string): string {
    if (res.offline) {
      return (
        "⚠️ I couldn't reach the internet for research right now. I can still answer " +
        "from your own documents and memory — or just ask me again in a moment."
      );
    }
    return `🤷 I searched online for "${topic}" but couldn't find a good answer yet. Try rephrasing, or use /research <topic> to force another lookup.`;
  }

  /**
   * Async reply used by the chat API and the Telegram bot.
   *
   * Decision order (brain FIRST, internet LAST):
   *   math → intent → memory → knowledge → (/research | question-like) → markov → fallback
   * Online research only runs when the local brain has nothing — and it is
   * bounded by a hard time budget, so an offline machine never hangs a chat.
   */
  async replyAsync(input: string): Promise<ChatResult> {
    const math = tryEvaluateMath(input);
    if (math !== null) return { reply: `The result is ${math}.`, mode: "intent" };

    const intent = detectIntent(input);
    if (intent) return { reply: intent, mode: "intent" };

    const mem = this.handleMemory(input);
    if (mem) return { reply: mem, mode: "memory" };

    const know = this.retrieve(input);
    if (know) return know;

    // `/research <topic>` — force an online lookup even for non-question text.
    const forced = forcedResearchTopic(input);
    if (forced) {
      if (!this.research || !this.research.enabled) {
        return {
          reply: "⚠️ Online research is disabled (RESEARCH_ENABLED=false). I can still answer from your own documents, memory and math.",
          mode: "fallback",
        };
      }
      const res = await this.research.research(forced);
      if (res.ok && res.finding) return { reply: formatFinding(res.finding), mode: "research" };
      return { reply: this.researchFailReply(res, forced), mode: "research" };
    }

    // Natural question the local brain could not answer → look online.
    if (this.research && this.research.enabled && isResearchQuestion(input)) {
      const res = await this.research.research(input);
      if (res.ok && res.finding) return { reply: formatFinding(res.finding), mode: "research" };
      if (!res.ok) return { reply: this.researchFailReply(res, input.trim()), mode: "research" };
    }

    if (this.markov.trained) {
      const gen = this.markov.generate(60);
      if (gen) return { reply: gen, mode: "generate" };
    }

    return this.reply(input);
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
