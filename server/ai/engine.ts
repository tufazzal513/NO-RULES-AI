/**
 * AIEngine — the local, offline "brain" of MY-AI.
 * -------------------------------------------------
 * Decision order for every message:
 *   1. math          → safe arithmetic evaluator
 *   2. intent        → greetings, help, time, who-are-you…
 *   3. memory        → store/recall facts about the user
 *   4. knowledge     → BM25 retrieval over the user's own documents (local RAG)
 *   5. research      → free, keyless web lookup (questions only)
 *   6. generate      → Markov text generated in the user's own style
 *   7. fallback      → honest guidance
 *
 * Every step is language-aware: English, বাংলা and Banglish are understood
 * through `server/ai/language.ts`, and the reply comes back in whichever of
 * the three the user wrote in.
 *
 * No external AI service is used anywhere in this path.
 */

import { MarkovModel } from "./markov.ts";
import { BM25, meaningfulTerms, type KnowledgeDoc } from "./retrieval.ts";
import { detectIntent, tryEvaluateMath } from "./intents.ts";
import { detectLanguage, languageVariants, normalizeForMatch, t, type Lang } from "./language.ts";
import {
  ResearchService,
  forcedResearchTopic,
  formatFinding,
  isResearchQuestion,
  type ResearchResult,
} from "../research/research.ts";

export type AIMode = "intent" | "memory" | "knowledge" | "research" | "generate" | "fallback";

/**
 * Words that mean the sentence is a QUESTION, not a statement.
 * "amar nam ki?" must recall the name, never store "ki" as the name.
 */
const QUESTION_VALUE_RE =
  /^(?:ki+|kii|kee|ke|kake|kar|keno|kothay|kokhon|kobe|koto|kemon|kivabe|kibhabe|what|who|whats|which|how|why|when|where|কি|কী|কে|কাকে|কার|কেন|কোথায়|কখন|কবে|কত|কেমন|কীভাবে|কিভাবে)(?:$|[\s?？।.!,])/i;

function isQuestionValue(value: string): boolean {
  const v = value.trim().replace(/[?？।.!,]+$/u, "").trim();
  if (!v) return true;
  return QUESTION_VALUE_RE.test(v);
}

export interface ChatResult {
  reply: string;
  mode: AIMode;
  /** Language the reply was written in (handy for the UI / Telegram). */
  lang?: Lang;
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

  /**
   * Store/recall personal facts. Every pattern exists in all three languages,
   * and the value is kept in the exact script the user typed it in.
   */
  private handleMemory(input: string): string | null {
    const raw = input.trim();
    const lang = detectLanguage(raw);
    const norm = normalizeForMatch(raw);

    const valueFrom = (pattern: RegExp): string | null => {
      const m = raw.match(pattern);
      if (!m || !m[1]) return null;
      const v = m[1].replace(/[.!?।]+$/u, "").trim();
      if (v.length === 0) return null;
      // "amar nam ki?" is a QUESTION, not "my name is ki" — never store a
      // question word as a fact. This was the classic wrong-answer bug.
      if (isQuestionValue(v)) return null;
      return v;
    };

    // --- stores (checked first, so "My name is X" stores instead of recalling) ---
    const namePatterns = [
      /(?:my name is|i am called|call me)\s+(.+)$/i,
      /(?:amar naam|amar nam)\s*(?:hocche|holo|hoy)?\s+(.+)$/i,
      /(?:আমার নাম)\s*(?:হচ্ছে|হলো|হল)?\s*(.+)$/,
    ];
    for (const p of namePatterns) {
      const v = valueFrom(p);
      if (v) {
        this.setMemory("name", v);
        return t(lang, {
          en: `Nice to meet you, ${v}! I'll remember your name. 🧠`,
          bn: `আপনার সাথে পরিচিত হয়ে ভালো লাগলো, ${v}! নামটা মনে রাখলাম। 🧠`,
          banglish: `Apnar sathe porichito hoye bhalo laglo, ${v}! Nam ta mone rakhlam. 🧠`,
        });
      }
    }

    const likePatterns = [
      /(?:i like|i love|i enjoy|my favourite is|my favorite is)\s+(.+)$/i,
      /(?:amar pochondo|amar posondo|ami pochondo kori|amar priyo)\s+(.+)$/i,
      /(?:আমার পছন্দ|আমি পছন্দ করি|আমার প্রিয়)\s*(.+)$/,
    ];
    for (const p of likePatterns) {
      const v = valueFrom(p);
      if (v) {
        this.setMemory("likes", v);
        return t(lang, {
          en: "Noted! I'll remember that. 🧠",
          bn: "মনে রাখলাম! 🧠",
          banglish: "Mone rakhlam! 🧠",
        });
      }
    }

    const rememberPatterns = [
      /(?:remember that|remember this|remember|note that|keep in mind)\s+(.+)$/i,
      /(?:mone rakho|mone rakhben|mone rekho)\s+(.+)$/i,
      /(?:মনে রাখো|মনে রাখুন|মনে রেখো|মনে রাখ)\s*(.+)$/,
    ];
    for (const p of rememberPatterns) {
      const v = valueFrom(p);
      if (v) {
        this.setMemory("note_" + Date.now(), v);
        return t(lang, {
          en: "Saved to my memory. 🧠",
          bn: "মেমোরিতে সেভ করে রাখলাম। 🧠",
          banglish: "Memory te save kore rakhlam. 🧠",
        });
      }
    }

    const about = valueFrom(/^(?:i am|i'm)\s+(.+)$/i);
    if (about && !/^(?:fine|ok|okay|good|great|well)\b/i.test(about)) {
      this.setMemory("about", about);
      return t(lang, {
        en: "Got it — I've saved that about you. 🧠",
        bn: "বুঝেছি — আপনার সম্পর্কে এটা মনে রাখলাম। 🧠",
        banglish: "Bujhechi — apnar somporke eta mone rakhlam. 🧠",
      });
    }

    // --- recalls ---
    if (/(?:^|\s)(?:what is my name|whats my name|amar nam ki|ami ke)(?:\s|$)/.test(norm)) {
      const n = this.getMemory("name");
      return n
        ? t(lang, {
            en: `Your name is ${n}. 🙂`,
            bn: `আপনার নাম ${n}। 🙂`,
            banglish: `Apnar nam ${n}. 🙂`,
          })
        : t(lang, {
            en: `You haven't told me your name yet. Say "My name is …" and I'll remember it.`,
            bn: `আপনি এখনো নাম বলেননি। "আমার নাম …" লিখুন, আমি মনে রাখব।`,
            banglish: `Apni ekhono nam bolen ni. "Amar nam …" likhun, ami mone rakhbo.`,
          });
    }

    if (/(?:what do you know about me|amar somporke|amar sompoke|tell me about me)/.test(norm)) {
      const mems = this.allMemory().filter((x) => x.key !== "name");
      const name = this.getMemory("name");
      if (mems.length === 0 && !name) {
        return t(lang, {
          en: "I don't know much about you yet — tell me things and I'll remember!",
          bn: "আপনার সম্পর্কে এখনো বেশি কিছু জানি না — বলুন, আমি মনে রাখব!",
          banglish: "Apnar somporke ekhono beshi kichu jani na — bolun, ami mone rakhbo!",
        });
      }
      const lines = mems.map((x) => `• ${x.key}: ${x.value}`).join("\n");
      const nameLine = name
        ? t(lang, { en: `Your name is ${name}.\n`, bn: `আপনার নাম ${name}।\n`, banglish: `Apnar nam ${name}.\n` })
        : "";
      const header = t(lang, {
        en: "Here's what I remember:",
        bn: "আমি যা মনে রেখেছি:",
        banglish: "Ami ja mone rekhechi:",
      });
      return nameLine + header + "\n" + lines;
    }

    if (/(?:^|\s)(?:forget everything|forget me|clear memory|(?:shob|sob)\s+bhule\s+jao|bhule\s+jao\s+(?:shob|sob))(?:\s|$)/.test(norm)) {
      try {
        this.db.prepare("DELETE FROM memory").run();
      } catch {
        /* best-effort */
      }
      return t(lang, {
        en: "Done — I've cleared everything I remembered about you. 🧹",
        bn: "হয়ে গেছে — আপনার সম্পর্কে মনে রাখা সব মুছে ফেলেছি। 🧹",
        banglish: "Hoye geche — apnar somporke mone rakha shob muche felechi. 🧹",
      });
    }

    return null;
  }

  // -- knowledge (local RAG) --------------------------------------------------
  /**
   * BM25 retrieval over the user's own documents.
   *
   * The query is tried in EVERY spelling of the message (Bangla script,
   * Banglish, and the normalized Latin form), so a Bengali document is still
   * found when the question is typed in Banglish, and vice-versa.
   */
  private retrieve(input: string): { reply: string; mode: AIMode; score: number } | null {
    try {
      const docs = this.db.prepare("SELECT id, title, content FROM knowledge").all() as KnowledgeDoc[];
      if (docs.length === 0) return null;
      const bm25 = new BM25(docs);

      let best: { doc: KnowledgeDoc; score: number; snippet: string } | null = null;
      for (const variant of languageVariants(input)) {
        const qTerms = meaningfulTerms(variant);
        if (qTerms.length === 0) continue;
        const results = bm25.search(variant, 1);
        if (results.length === 0) continue;
        const r = results[0];

        // Require at least one meaningful (non-stopword) query term to actually
        // appear in the document — avoids false positives on common words.
        const haystack = ((r.doc.title || "") + " " + (r.doc.content || "")).toLowerCase();
        if (!qTerms.some((term) => haystack.includes(term))) continue;
        if (!best || r.score > best.score) best = r;
      }

      if (!best || best.score < 0.2) return null;

      const lang = detectLanguage(input);
      const header = t(lang, {
        en: `📚 From my knowledge "${best.doc.title}":`,
        bn: `📚 আমার জানা "${best.doc.title}" থেকে:`,
        banglish: `📚 Amar jana "${best.doc.title}" theke:`,
      });
      return {
        reply: `${header}\n\n${best.snippet}\n\n(confidence: ${best.score.toFixed(1)})`,
        mode: "knowledge",
        score: best.score,
      };
    } catch (e) {
      console.error("Knowledge retrieval failed:", (e as Error).message);
      return null;
    }
  }

  /** "The result is 100." — localised. */
  private mathReply(value: number, lang: Lang): string {
    return t(lang, {
      en: `The result is ${value}.`,
      bn: `উত্তর হলো ${value}।`,
      banglish: `Uttor holo ${value}.`,
    });
  }

  /** The honest "I don't know yet" answer, in the user's language. */
  private fallbackReply(lang: Lang): string {
    return t(lang, {
      en:
        "I'm your personal AI and I'm still learning. ✨\n\n" +
        "• Chat more, then press Train in the Training tab so I learn your style.\n" +
        "• Add documents in Training → Knowledge and I'll answer from them.\n" +
        '• Tell me facts (like "My name is …") and I\'ll remember them.\n' +
        "• Ask me a current question — I can research it online, keyless and free.\n" +
        "  (Type /research <topic> to force an online lookup.)\n\n" +
        "Everything stays on your own machine and your Telegram cloud database.",
      bn:
        "আমি আপনার নিজের AI, এখনো শিখছি। ✨\n\n" +
        "• আরও চ্যাট করুন, তারপর Training ট্যাবে Train চাপুন — আমি আপনার ভাষা শিখব।\n" +
        "• Training → Knowledge-এ ডকুমেন্ট যোগ করুন, আমি সেখান থেকে উত্তর দেব।\n" +
        '• আমাকে তথ্য বলুন (যেমন "আমার নাম …") — আমি মনে রাখব।\n' +
        "• সাম্প্রতিক কিছু জিজ্ঞেস করুন — আমি অনলাইনে ফ্রিতে খুঁজে দিতে পারি।\n" +
        "  (/research <বিষয়> লিখলে জোর করে অনলাইনে খুঁজব।)\n\n" +
        "সব কিছু আপনার নিজের সার্ভারে আর Telegram ক্লাউডেই থাকে।",
      banglish:
        "Ami apnar nijer AI, ekhono shikhchi. ✨\n\n" +
        "• Aro chat korun, tarpor Training tab e Train chapun.\n" +
        "• Training → Knowledge e document add korun, ami sekhan theke uttor debo.\n" +
        '• Amake totho bolun (jemon "amar nam …") — ami mone rakhbo.\n' +
        "• Somprotik kichu jiggesh korun — ami online e free te khuje dite pari.\n" +
        "  (/research <topic> likhle jor kore online e khujbo.)\n\n" +
        "Shob kichu apnar nijer server ar Telegram cloud e i thake.",
    });
  }

  /** Synchronous reply — no internet, used as the last stage of `replyAsync`. */
  reply(input: string): ChatResult {
    const lang = detectLanguage(input);

    const math = tryEvaluateMath(input);
    if (math !== null) return { reply: this.mathReply(math, lang), mode: "intent", lang };

    const intent = detectIntent(input);
    if (intent) return { reply: intent, mode: "intent", lang };

    const mem = this.handleMemory(input);
    if (mem) return { reply: mem, mode: "memory", lang };

    const know = this.retrieve(input);
    if (know) return { reply: know.reply, mode: know.mode, lang };

    // The Markov model writes in the user's style but has no idea what the
    // question MEANS — using it to "answer" a question is exactly what made
    // replies look wrong. It is only used for open-ended chit-chat now.
    if (this.markov.trained && !isResearchQuestion(input)) {
      const gen = this.markov.generate(60);
      if (gen) return { reply: gen, mode: "generate", lang };
    }

    return { reply: this.fallbackReply(lang), mode: "fallback", lang };
  }

  private researchFailReply(res: ResearchResult, topic: string, lang: Lang): string {
    if (res.offline) {
      return t(lang, {
        en:
          "⚠️ I couldn't reach the internet for research right now. I can still answer " +
          "from your own documents and memory — or just ask me again in a moment.",
        bn:
          "⚠️ এই মুহূর্তে ইন্টারনেটে পৌঁছাতে পারলাম না, তাই অনলাইনে খুঁজতে পারিনি। " +
          "তবে আপনার ডকুমেন্ট আর মেমোরি থেকে এখনো উত্তর দিতে পারি — একটু পরে আবার জিজ্ঞেস করুন।",
        banglish:
          "⚠️ Ei muhurte internet e pouchate parlam na, tai online e khujte pari ni. " +
          "Tobe apnar document ar memory theke ekhono uttor dite pari — ektu pore abar jiggesh korun.",
      });
    }
    if (res.rateLimited) {
      return t(lang, {
        en: "⏳ I've made a lot of web requests in the last minute, so I'm cooling down to stay unblocked. Try again in a moment.",
        bn: "⏳ গত এক মিনিটে অনেকবার অনলাইনে খুঁজেছি, তাই একটু বিরতি নিচ্ছি — যাতে ফ্রি সোর্সগুলো ব্লক না করে। একটু পরে আবার চেষ্টা করুন।",
        banglish: "⏳ Gato ek minute e onekbar online e khujechi, tai ektu birti nichhi. Ektu pore abar cheshta korun.",
      });
    }
    return t(lang, {
      en: `🤷 I searched online for "${topic}" but couldn't find a good answer yet. Try rephrasing, or use /research <topic> to force another lookup.`,
      bn: `🤷 "${topic}" নিয়ে অনলাইনে খুঁজলাম, কিন্তু ভালো উত্তর পেলাম না। প্রশ্নটা একটু অন্যভাবে লিখুন, অথবা /research <বিষয়> দিয়ে আবার খোঁজান।`,
      banglish: `🤷 "${topic}" niye online e khujlam, kintu bhalo uttor pelam na. Proshno ta ektu onno bhabe likhun, othoba /research <topic> diye abar khojan.`,
    });
  }

  /**
   * Async reply used by the chat API and the Telegram bot.
   *
   * Decision order (brain FIRST, internet LAST):
   *   math → intent → memory → knowledge → (/research | question-like) → markov → fallback
   *
   * A *weak* knowledge match on a real question no longer short-circuits the
   * lookup: the internet gets a chance to answer better, and the local
   * document is used only when research comes back empty.
   */
  async replyAsync(input: string): Promise<ChatResult> {
    const lang = detectLanguage(input);

    const math = tryEvaluateMath(input);
    if (math !== null) return { reply: this.mathReply(math, lang), mode: "intent", lang };

    const intent = detectIntent(input);
    if (intent) return { reply: intent, mode: "intent", lang };

    const mem = this.handleMemory(input);
    if (mem) return { reply: mem, mode: "memory", lang };

    const know = this.retrieve(input);
    const isQuestion = isResearchQuestion(input);
    if (know && (!isQuestion || know.score >= 1.2)) {
      return { reply: know.reply, mode: know.mode, lang };
    }

    // `/research <topic>` — force an online lookup even for non-question text.
    const forced = forcedResearchTopic(input);
    if (forced) {
      if (!this.research || !this.research.enabled) {
        return {
          reply: t(lang, {
            en: "⚠️ Online research is disabled (RESEARCH_ENABLED=false). I can still answer from your own documents, memory and math.",
            bn: "⚠️ অনলাইন রিসার্চ বন্ধ আছে (RESEARCH_ENABLED=false)। তবে আপনার ডকুমেন্ট, মেমোরি আর অঙ্ক থেকে এখনো উত্তর দিতে পারি।",
            banglish: "⚠️ Online research bondho ache (RESEARCH_ENABLED=false). Tobe apnar document, memory ar onko theke ekhono uttor dite pari.",
          }),
          mode: "fallback",
          lang,
        };
      }
      // `force` bypasses the negative cache — the user explicitly asked for a fresh lookup.
      const res = await this.research.research(forced, { force: true });
      if (res.ok && res.finding) return { reply: formatFinding(res.finding), mode: "research", lang };
      if (know) return { reply: know.reply, mode: know.mode, lang };
      return { reply: this.researchFailReply(res, forced, lang), mode: "research", lang };
    }

    // Natural question the local brain could not answer → look online.
    if (this.research && this.research.enabled && isQuestion) {
      const res = await this.research.research(input);
      if (res.ok && res.finding) return { reply: formatFinding(res.finding), mode: "research", lang };
      // Research came back empty — a weak local document still beats nothing.
      if (know) return { reply: know.reply, mode: know.mode, lang };
      if (!res.ok) return { reply: this.researchFailReply(res, input.trim(), lang), mode: "research", lang };
    }

    if (know) return { reply: know.reply, mode: know.mode, lang };

    if (this.markov.trained && !isQuestion) {
      const gen = this.markov.generate(60);
      if (gen) return { reply: gen, mode: "generate", lang };
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
