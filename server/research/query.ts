/**
 * Query understanding for online research.
 * ----------------------------------------
 * The old code sent the user's raw message straight to every search engine:
 *
 *     "তুমি কি বলতে পারবে বাংলাদেশের রাজধানী কী?"  →  search engine
 *
 * …which is why answers were often wrong or irrelevant: the filler words
 * ("তুমি কি বলতে পারবে") dominate the query, Bengali questions were sent to
 * English-only engines, and Banglish went nowhere at all.
 *
 * This module turns ONE message into a small, ordered list of clean search
 * queries, and provides the relevance scoring used to pick the best answer
 * across the sources instead of blindly trusting the first one.
 */

import {
  banglishToBengali,
  bengaliToBanglish,
  detectLanguage,
  type Lang,
} from "../ai/language.ts";

export interface ResearchQuery {
  /** The primary (best) query string. */
  primary: string;
  /** Alternative spellings/translations, tried when the primary finds nothing. */
  variants: string[];
  /** Language the user wrote in. */
  lang: Lang;
  /** Meaningful terms used for relevance scoring (already lowercased). */
  terms: string[];
  /** True when the topic is short enough to be a Wikipedia/Wiktionary title. */
  titleLike: boolean;
  /** True when the user is asking for fresh/live information. */
  newsy: boolean;
}

// ---------------------------------------------------------------------------
// Filler that must never reach a search engine
// ---------------------------------------------------------------------------

/** Polite / conversational wrappers, in all three languages. */
const FILLER_PHRASES: RegExp[] = [
  // English
  /^(?:hey|hi|hello|ok|okay|so|well|umm?)\s+/i,
  /^(?:can|could|will|would)\s+you\s+(?:please\s+)?(?:tell|say|explain|show|find|search|give)\s+me\s+/i,
  /^(?:please\s+)?(?:tell|say|explain|show|find|search|give)\s+me\s+(?:about\s+)?/i,
  /^(?:do|does|did)\s+you\s+know\s+(?:about\s+)?/i,
  /^i\s+(?:want|need|would\s+like)\s+to\s+know\s+(?:about\s+)?/i,
  /\s+(?:please|plz|pls|thanks|thank\s+you)\s*[.!?]*$/i,
  // Bengali
  /^(?:তুমি|আপনি|তুই)\s+(?:কি|কী)\s+(?:বলতে|বলবে|জানো|জানেন|পারবে|পারবেন)\s+/,
  /^(?:আমাকে|আমায়)\s+(?:একটু\s+)?(?:বলো|বলুন|জানাও|জানান|বল)\s+/,
  /^(?:একটু|দয়া\s*করে|প্লিজ)\s+/,
  /\s+(?:বলো|বলুন|বল|জানাও|জানান|প্লিজ|দয়া\s*করে)\s*[।.!?]*$/,
  // Banglish
  /^(?:tumi|apni|tui)\s+(?:ki|kii)\s+(?:bolte|bolba|bolben|jano|janen|parbe|parben)\s+/i,
  /^(?:amake|amay)\s+(?:ektu\s+)?(?:bolo|bol|bolen|janao)\s+/i,
  /^(?:ektu|doya\s*kore|plz|please)\s+/i,
  /\s+(?:bolo|bol|bolen|janao|plz|please)\s*[.!?]*$/i,
];

/** Words that carry no search value on their own. */
const QUERY_STOPWORDS = new Set([
  // English
  "a", "an", "the", "is", "are", "was", "were", "be", "am", "do", "does", "did",
  "of", "to", "in", "on", "at", "for", "with", "and", "or", "me", "my", "you",
  "your", "i", "it", "its", "that", "this", "please", "tell", "about", "can",
  "could", "would", "will", "shall", "some", "any", "there", "their",
  // Bengali
  "আমি", "আমার", "আমাকে", "তুমি", "তোমার", "আপনি", "আপনার", "এটা", "ওটা",
  "একটা", "একটি", "এবং", "আর", "কিন্তু", "তবে", "যে", "সে", "টা", "টি",
  "হয়", "হবে", "ছিল", "করে", "করা", "থেকে", "জন্য", "সাথে", "একটু", "প্লিজ",
  "বলো", "বলুন", "বল", "জানাও", "দয়া",
  // Banglish
  "ami", "amar", "amake", "tumi", "tomar", "apni", "apnar", "eta", "ota",
  "ekta", "ekti", "ebong", "ar", "aar", "kintu", "tobe", "je", "se",
  "hoy", "hobe", "chilo", "kore", "kora", "theke", "jonno", "sathe", "ektu",
  "plz", "please", "bolo", "bol", "janao", "doya",
]);

/** Question words — dropped from the *terms* used for scoring, kept in the query. */
const QUESTION_WORDS = new Set([
  "who", "what", "why", "when", "where", "how", "which", "whose", "whom",
  "কে", "কী", "কি", "কেন", "কখন", "কোথায়", "কীভাবে", "কিভাবে", "কার", "কত", "কবে", "কেমন",
  "ke", "ki", "keno", "kokhon", "kothay", "kivabe", "kibhabe", "kar", "koto", "kobe", "kemon",
]);

const NEWSY = [
  "latest", "news", "today", "recent", "current", "now", "breaking", "live",
  "weather", "score", "price", "update",
  "সর্বশেষ", "খবর", "সংবাদ", "আজকের", "আজ", "এখন", "সাম্প্রতিক", "লাইভ",
  "আবহাওয়া", "দাম", "স্কোর", "নিউজ", "লেটেস্ট", "আপডেট",
  "khobor", "khobar", "news", "ajker", "aj", "ekhon", "abohawa", "dam", "score",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Words of a text, keeping Bengali vowel signs attached to their letters. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).filter(Boolean);
}

/** Strip conversational filler and trailing punctuation from a message. */
export function stripFiller(text: string): string {
  let t = (text || "").trim();
  // Drop a leading slash command (/research, /search).
  t = t.replace(/^\/(?:research|search|ask|find)\s+/i, "");
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 6) {
    changed = false;
    for (const re of FILLER_PHRASES) {
      const next = t.replace(re, " ").trim();
      if (next !== t && next.length > 0) {
        t = next;
        changed = true;
      }
    }
  }
  // Trailing question/sentence marks add nothing to a search query.
  t = t.replace(/[?？।!.\s]+$/u, "").trim();
  // A leading "about …" is left over from "tell me about X".
  t = t.replace(/^(?:about|regarding|on the topic of)\s+/i, "").trim();
  // A trailing lone question word ("… রাজধানী কী", "… name ki") is noise for a
  // search engine — but only drop it when something meaningful remains.
  const trailing = /\s+(?:কী|কি|কে|কেন|কত|কোথায়|কখন|কবে|ki|kii|ke|keno|koto|kothay|kokhon|kobe)$/u;
  if (trailing.test(t)) {
    const stripped = t.replace(trailing, "").trim();
    if (words(stripped).length >= 2) t = stripped;
  }
  return t;
}

/** Meaningful (non-stopword, non-question-word) terms used for scoring. */
export function scoringTerms(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (w.length < 2) continue;
    if (QUERY_STOPWORDS.has(w)) continue;
    if (QUESTION_WORDS.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * Build the ordered search queries for a message.
 *
 * Bengali → the Bengali text is primary (bn.wikipedia understands it) and a
 * Banglish/Latin transliteration follows. Banglish → the Bengali script form
 * becomes the primary query, because search engines index Bengali content in
 * Bengali, not in Latin.
 */
export function buildResearchQuery(input: string): ResearchQuery {
  const raw = (input || "").trim();
  const lang = detectLanguage(raw);
  const cleaned = stripFiller(raw) || raw;

  const seen = new Set<string>();
  const push = (q: string, into: string[]) => {
    const v = q.trim().replace(/\s+/g, " ");
    if (!v || v.length < 2) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    into.push(v);
  };

  const ordered: string[] = [];
  if (lang === "banglish") {
    // Bengali script first — that is where the answers actually live.
    push(banglishToBengali(cleaned), ordered);
    push(cleaned, ordered);
  } else if (lang === "bn") {
    push(cleaned, ordered);
    push(bengaliToBanglish(cleaned), ordered);
  } else {
    push(cleaned, ordered);
  }
  // The untouched message is always a last-resort variant.
  push(raw, ordered);

  const primary = ordered[0] ?? raw;
  const terms = scoringTerms(cleaned).length > 0 ? scoringTerms(cleaned) : words(cleaned);
  const wordCount = words(cleaned).length;
  const lower = raw.toLowerCase();

  return {
    primary,
    variants: ordered.slice(1),
    lang,
    terms,
    titleLike: wordCount > 0 && wordCount <= 5,
    newsy: NEWSY.some((k) => lower.includes(k)),
  };
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

export interface Scorable {
  title?: string;
  snippet?: string;
  answer?: string;
  url?: string;
}

/**
 * How well does a candidate answer the question? 0 (unrelated) … 1 (perfect).
 *
 * The score is dominated by *term coverage* — how many of the meaningful query
 * terms actually appear in the candidate — because that is exactly what was
 * missing before: the old code returned the first hit of the first source even
 * when it had nothing to do with the question.
 */
export function relevanceScore(candidate: Scorable, terms: string[]): number {
  const text = `${candidate.title ?? ""} ${candidate.answer ?? ""} ${candidate.snippet ?? ""}`.toLowerCase();
  if (!text.trim()) return 0;
  if (terms.length === 0) return 0.35; // nothing to check against — neutral

  const haystack = words(text);
  const hay = new Set(haystack);
  let hits = 0;
  for (const term of terms) {
    if (hay.has(term)) {
      hits++;
      continue;
    }
    // Partial match: handles Bengali case endings (ঢাকা / ঢাকার / ঢাকায়)
    // and English plurals, without a stemmer.
    if (term.length >= 4 && text.includes(term.slice(0, Math.max(4, term.length - 2)))) {
      hits += 0.6;
    }
  }
  const coverage = Math.min(1, hits / terms.length);

  // Substance bonus: a real sentence beats a bare link title.
  const body = (candidate.answer ?? candidate.snippet ?? "").trim();
  const substance = body.length >= 120 ? 0.15 : body.length >= 50 ? 0.1 : body.length >= 20 ? 0.04 : 0;

  // A candidate with a usable source URL is slightly preferred.
  const linked = candidate.url && /^https?:/i.test(candidate.url) ? 0.03 : 0;

  return Math.min(1, coverage * 0.82 + substance + linked);
}

/** A score at or above this is "good enough" — stop searching and answer. */
export const STRONG_SCORE = 0.62;
/** Below this a candidate is basically noise and is never returned alone. */
export const WEAK_SCORE = 0.12;
