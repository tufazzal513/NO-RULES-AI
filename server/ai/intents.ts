/**
 * Rule-based intents + a safe math evaluator.
 * Small, offline, deterministic — no external AI.
 */

// ---------------------------------------------------------------------------
// Safe math evaluator (shunting-yard). Never uses eval().
// ---------------------------------------------------------------------------

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "lp" } | { t: "rp" };

function tokenizeMath(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      const num = parseFloat(s.slice(i, j));
      if (Number.isNaN(num)) throw new Error("bad number");
      out.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rp" });
      i++;
      continue;
    }
    throw new Error("bad char");
  }
  return out;
}

function precedence(op: string): number {
  if (op === "+" || op === "-") return 1;
  if (op === "*" || op === "/" || op === "%") return 2;
  if (op === "^") return 3;
  return 0;
}

function evaluate(tokens: Tok[]): number | null {
  // Shunting-yard → RPN
  const out: Tok[] = [];
  const ops: Tok[] = [];
  for (const tok of tokens) {
    if (tok.t === "num") out.push(tok);
    else if (tok.t === "op") {
      while (
        ops.length > 0 &&
        ops[ops.length - 1].t === "op" &&
        precedence((ops[ops.length - 1] as { v: string }).v) >= precedence(tok.v)
      ) {
        out.push(ops.pop()!);
      }
      ops.push(tok);
    } else if (tok.t === "lp") ops.push(tok);
    else if (tok.t === "rp") {
      while (ops.length > 0 && ops[ops.length - 1].t !== "lp") out.push(ops.pop()!);
      if (ops.length === 0) return null;
      ops.pop();
    }
  }
  while (ops.length > 0) {
    const o = ops.pop()!;
    if (o.t === "lp") return null;
    out.push(o);
  }

  // Evaluate RPN
  const stack: number[] = [];
  for (const tok of out) {
    if (tok.t === "num") stack.push(tok.v);
    else if (tok.t === "op") {
      if (stack.length < 2) return null;
      const b = stack.pop()!;
      const a = stack.pop()!;
      let r: number;
      switch (tok.v) {
        case "+": r = a + b; break;
        case "-": r = a - b; break;
        case "*": r = a * b; break;
        case "/": if (b === 0) return null; r = a / b; break;
        case "%": if (b === 0) return null; r = a % b; break;
        case "^": r = Math.pow(a, b); break;
        default: return null;
      }
      stack.push(r);
    }
  }
  return stack.length === 1 ? stack[0] : null;
}

export function tryEvaluateMath(input: string): number | null {
  const trimmed = input.trim();
  if (!/^[0-9+\-*/%^().\s]+$/.test(trimmed) || !/\d/.test(trimmed)) return null;
  try {
    const value = evaluate(tokenizeMath(trimmed));
    if (value === null || !Number.isFinite(value)) return null;
    return Math.round(value * 1e10) / 1e10;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Intents — English 🇬🇧 / বাংলা 🇧🇩 / Banglish, all at once
// ---------------------------------------------------------------------------
//
// Every rule matches against `normalizeForMatch(input)`, which folds all three
// scripts onto ONE canonical Latin form:
//
//   "কেমন আছো"        → "kemon acho"
//   "kemon acho?"      → "kemon acho"
//   "how are you"      → "how are you"
//
// …so a single pattern handles all of them, and the reply is rendered in the
// language the user actually wrote in.

import { detectLanguage, normalizeForMatch, t, type Lang } from "./language.ts";

interface Rule {
  /** Matched against the normalized Latin form of the message. */
  test: RegExp;
  reply: (lang: Lang, raw: string) => string;
}

const RULES: Rule[] = [
  // --- greeting -------------------------------------------------------------
  {
    test: /^(?:hi|hello|hey|yo|hola|salam|assalamualaikum(?:\s+alaikum)?|slamalikum|nomoskar|adab|hai|helo|halo)[\s!.,]*$/,
    reply: (lang) =>
      t(lang, {
        en: "Hello! 👋 I'm your personal AI. How can I help you today?",
        bn: "আসসালামু আলাইকুম! 👋 আমি আপনার নিজের AI। আজ কীভাবে সাহায্য করতে পারি?",
        banglish: "Assalamu alaikum! 👋 Ami apnar nijer AI. Aj kivabe help korte pari?",
      }),
  },
  // --- how are you ----------------------------------------------------------
  {
    test: /(?:^|\s)(?:kemon acho|kemon achen|kemon achis|kemon|how are you|hows it going|how do you do)(?:\s|$)/,
    reply: (lang) =>
      t(lang, {
        en: "I'm doing great, thanks for asking! 😊 What can I do for you?",
        bn: "আমি ভালো আছি, জিজ্ঞেস করার জন্য ধন্যবাদ! 😊 আপনার জন্য কী করতে পারি?",
        banglish: "Ami bhalo achi, jiggesh korar jonno dhonnobad! 😊 Apnar jonno ki korte pari?",
      }),
  },
  // --- who are you ----------------------------------------------------------
  {
    test: /^(?:who are you|who r u|what are you|tumi ke|apni ke|tui ke|tomar porichoy|apnar porichoy)/,
    reply: (lang) =>
      t(lang, {
        en:
          "I'm MY-AI — your own self-hosted personal AI. Everything I know comes from the data and documents you give me, plus free keyless web research. Nothing leaves your machine except what you store in your Telegram cloud database.",
        bn:
          "আমি MY-AI — আপনার নিজের সেলফ-হোস্টেড AI। আমি যা জানি তার সবই আপনার দেওয়া ডেটা ও ডকুমেন্ট থেকে, সাথে ফ্রি ও কী-লেস অনলাইন রিসার্চ। আপনার Telegram ক্লাউড ছাড়া কিছুই বাইরে যায় না।",
        banglish:
          "Ami MY-AI — apnar nijer self-hosted AI. Ami ja jani shob apnar deya data o document theke, sathe free online research. Apnar Telegram cloud chara kichui baire jay na.",
      }),
  },
  // --- what can you do ------------------------------------------------------
  {
    test: /(?:^|\s)(?:what can you do|help|your features|ki ki paro|ki korte paro|ki ki korte paren|shahajjo|sahajjo|command|shortcut)(?:\s|$)/,
    reply: (lang) =>
      t(lang, {
        en:
          "Here's what I can do:\n" +
          "• Answer from your knowledge documents 📚\n" +
          "• Remember facts about you 🧠 (\"My name is …\", \"remember that …\")\n" +
          "• Solve math ➗ (just type 12 * 8 + 4)\n" +
          "• Research current questions online — free, no API key 🔎 (/research <topic>)\n" +
          "• Understand English, বাংলা and Banglish 🗣️\n" +
          "• Keep everything in your Telegram cloud database ☁️",
        bn:
          "আমি যা করতে পারি:\n" +
          "• আপনার ডকুমেন্ট থেকে উত্তর দিতে পারি 📚\n" +
          "• আপনার তথ্য মনে রাখতে পারি 🧠 (\"আমার নাম …\", \"মনে রাখো …\")\n" +
          "• অঙ্ক করতে পারি ➗ (শুধু লিখুন 12 * 8 + 4)\n" +
          "• অনলাইনে খুঁজে দিতে পারি — ফ্রি, কোনো API key লাগে না 🔎 (/research <বিষয়>)\n" +
          "• English, বাংলা আর Banglish — তিনটাই বুঝি 🗣️\n" +
          "• সব কিছু আপনার Telegram ক্লাউডে জমা রাখি ☁️",
        banglish:
          "Ami ja korte pari:\n" +
          "• Apnar document theke uttor dite pari 📚\n" +
          "• Apnar totho mone rakhte pari 🧠 (\"amar nam …\", \"mone rakho …\")\n" +
          "• Onko korte pari ➗ (likhun 12 * 8 + 4)\n" +
          "• Online e khuje dite pari — free 🔎 (/research <topic>)\n" +
          "• English, Bangla ar Banglish — tinta i bujhi 🗣️\n" +
          "• Shob kichu apnar Telegram cloud e rakhi ☁️",
      }),
  },
  // --- thanks ---------------------------------------------------------------
  {
    test: /(?:^|\s)(?:thanks|thank you|thnx|thx|dhonnobad|shukriya)(?:\s|$)/,
    reply: (lang) =>
      t(lang, {
        en: "You're most welcome! 😊",
        bn: "আপনাকেও ধন্যবাদ! 😊 আর কিছু লাগলে বলুন।",
        banglish: "Apnake o dhonnobad! 😊 Ar kichu lagle bolben.",
      }),
  },
  // --- goodbye --------------------------------------------------------------
  {
    test: /^(?:bye|goodbye|see you|bidae|tata|allah hafez|khoda hafez|allah hafej)[\s!.,]*$/,
    reply: (lang) =>
      t(lang, {
        en: "Goodbye! 👋 Come back any time.",
        bn: "আল্লাহ হাফেজ! 👋 যেকোনো সময় আবার আসবেন।",
        banglish: "Allah hafez! 👋 Jekono somoy abar asben.",
      }),
  },
  // --- which language do you speak -----------------------------------------
  {
    test: /(?:^|\s)(?:do you (?:speak|understand|know) (?:bangla|bengali|banglish|english)|bangla (?:jani|jano|janen|bolte paro|bujho|bujhen|paro)|banglish (?:jani|jano|bujho)|tumi bangla|apni bangla)(?:\s|$)/,
    reply: (lang) =>
      t(lang, {
        en: "Yes — I understand English, বাংলা and Banglish. Write however you like and I'll reply in the same language. 🗣️",
        bn: "হ্যাঁ — আমি English, বাংলা আর Banglish তিনটাই বুঝি। আপনি যেভাবে খুশি লিখুন, আমি একই ভাষায় উত্তর দেব। 🗣️",
        banglish: "Hae — ami English, Bangla ar Banglish tinta i bujhi. Apni jevabe khushi likhun, ami oi bhashay uttor debo. 🗣️",
      }),
  },
];

/** Current time / date — handled separately because it builds a live string. */
function timeIntent(norm: string, lang: Lang): string | null {
  const now = new Date();
  const wantsTime = /(?:^|\s)(?:what time|current time|time now|koyta baje|somoy koto|kota baje)(?:\s|$)/.test(norm);
  const wantsDate = /(?:^|\s)(?:what(?:'s| is)? (?:the )?date|todays date|today date|aj koto tarikh|ajker tarikh|aj ki bar|tarikh koto)(?:\s|$)/.test(norm);
  if (!wantsTime && !wantsDate) return null;

  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateEn = now.toDateString();
  const dateBn = now.toLocaleDateString("bn-BD", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  if (wantsTime) {
    return t(lang, {
      en: `Current time: ${time}\nToday is ${dateEn}.`,
      bn: `এখন সময়: ${time}\nআজ ${dateBn}।`,
      banglish: `Ekhon somoy: ${time}\nAj ${dateEn}.`,
    });
  }
  return t(lang, {
    en: `Today is ${dateEn}.`,
    bn: `আজ ${dateBn}।`,
    banglish: `Aj ${dateEn}.`,
  });
}

/**
 * Match a rule-based intent. Returns `null` when nothing matches, so the
 * caller can move on to memory → knowledge → research.
 */
export function detectIntent(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const lang = detectLanguage(raw);
  const norm = normalizeForMatch(raw);
  if (!norm) return null;

  const timed = timeIntent(norm, lang);
  if (timed) return timed;

  for (const rule of RULES) {
    if (rule.test.test(norm)) return rule.reply(lang, raw);
  }
  return null;
}
