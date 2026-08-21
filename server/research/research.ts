/**
 * Online research — free, keyless sources. No API key, no signup.
 * -----------------------------------------------------------------
 * Sources (each on its OWN hostname, so a rate limit on one never
 * affects the others):
 *
 *   1. DuckDuckGo Instant Answer   api.duckduckgo.com
 *   2. Wikipedia Search            en.wikipedia.org
 *   3. DuckDuckGo HTML             html.duckduckgo.com
 *   4. DuckDuckGo Lite             lite.duckduckgo.com
 *   5. Bengali Wikipedia Search    bn.wikipedia.org   ← বাংলা প্রশ্নের জন্য
 *   6. SearXNG (8 public instances, 2 rotated per call)
 *   7. Wiktionary REST             en.wiktionary.org
 *   8. Mojeek                      www.mojeek.com
 *   9. Wikipedia REST summary      en.wikipedia.org
 *  10. Marginalia Search           search.marginalia.nu
 *
 * Rate-limit protection (so automatic lookups can never get "blocked"):
 *   • per-host circuit breaker with exponential backoff (1 → 15 min),
 *     honouring Retry-After headers (see circuit.ts)
 *   • a hard cap on network attempts per call (default 8) — we never
 *     hammer every source for one question
 *   • a global cap on requests per rolling minute (default 60)
 *   • 6 rotating browser User-Agents
 *   • polite spacing between requests
 *   • permanent cache (SQLite → Telegram snapshot) + stale-cache fallback
 *   • negative cache — a topic that cleanly returned "no answer" is not
 *     re-searched for a while, so repeat questions don't burn requests
 *   • fast offline detection — 2 consecutive fetch-level errors with no
 *     HTTP response at all stop the whole call early (stale cache wins)
 *   • one retry per source when the internet is known to be up (transient
 *     network blips recover without opening a circuit)
 *   • in-flight request de-duplication
 *   • a hard time budget so a chat reply can never hang for long
 *
 * Every fresh finding is also saved into the `knowledge` table, so it
 * survives Render restarts (Telegram snapshot) and can later be answered
 * completely offline by the local brain.
 */

import crypto from "crypto";
import { CircuitBreaker } from "./circuit.ts";
import {
  buildResearchQuery,
  relevanceScore,
  scoringTerms,
  STRONG_SCORE,
  WEAK_SCORE,
  type ResearchQuery,
} from "./query.ts";
import { detectLanguage } from "../ai/language.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResearchSourceHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchFinding {
  topic: string;
  answer: string;
  sources: ResearchSourceHit[];
  sourceHosts: string[];
  /** Epoch ms when the finding was fetched (or first cached). */
  timestamp: number;
  cached: boolean;
  /** True when this came from the cache because the internet was unreachable. */
  stale?: boolean;
  /** 0…1 — how well the answer matches the question (relevance ranking). */
  confidence?: number;
  /** The cleaned query that was actually sent to the search engines. */
  query?: string;
}

export interface ResearchResult {
  ok: boolean;
  finding?: ResearchFinding;
  /** Every source failed at the network level (likely: no internet). */
  offline?: boolean;
  /** The global per-minute request cap was reached — we chose not to hammer sources. */
  rateLimited?: boolean;
  /** This topic was recently searched cleanly and had no answer (negative cache). */
  negative?: boolean;
  /** Sources that were attempted during this call. */
  triedSources?: string[];
  error?: string;
}

export interface ResearchHooks {
  /** Called after a finding is saved into `knowledge` (for Telegram mirroring). */
  onKnowledgeSave?: (row: { id: number; title: string; content: string }) => void;
}

export interface ResearchOptions {
  enabled: boolean;
  cacheTtlMinutes: number;
  /** Hard budget for ONE research call — chat latency stays inside this. */
  timeoutMs: number;
  saveToKnowledge: boolean;
  /** Injectable fetch (tests pass a fake — every network call stays mocked). */
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
  now?: () => number;
  /** Minimum gap between two network requests (polite spacing). */
  spacingMs?: number;
  /** Hard cap on network requests per research call (default 8). */
  maxAttempts?: number;
  /** Global cap on requests per rolling minute (default 60). */
  maxRequestsPerMinute?: number;
  /** How long a cleanly-failed topic is remembered before re-searching (minutes, default 10). */
  negativeTtlMinutes?: number;
  /** Consecutive fetch-level errors with no HTTP response that prove "offline" (default 2). */
  offlineFailFastAfter?: number;
}

export interface ResearchStatus {
  enabled: boolean;
  cacheTtlMinutes: number;
  timeoutMs: number;
  saveToKnowledge: boolean;
  maxAttempts: number;
  maxRequestsPerMinute: number;
  sources: {
    name: string;
    host: string;
    ready: boolean;
    failures: number;
    cooldownRemainingMs: number;
    lastRetryAfterMs: number | null;
  }[];
  cache: {
    entries: number;
    hits: number;
    misses: number;
    staleServed: number;
    negativeEntries: number;
  };
  savedFindings: number;
  inFlight: number;
  requestsLastMinute: number;
}

// ---------------------------------------------------------------------------
// Question detection (English + Bengali)
// ---------------------------------------------------------------------------

const QUESTION_FIRST_WORDS = new Set([
  "who", "what", "why", "when", "where", "how", "which", "whose",
  "কে", "কী", "কি", "কেন", "কখন", "কোথায়", "কোথা", "কীভাবে", "কিভাবে", "কার", "কত",
  "কাকে", "কাদের", "কারা", "কবে", "কেমন", "কোন", "কোনটা",
  "ke", "ki", "kii", "keno", "kivabe", "kibhabe", "kothay", "kobe", "kara",
  "kokhon", "koto", "kar", "kake", "kemon", "kon", "konta",
]);

/** Question markers that may appear anywhere (Bengali often ends with them). */
const QUESTION_ANYWHERE = new Set([
  "কী", "কেন", "কীভাবে", "কিভাবে", "কোথায়", "কখন", "কত", "কবে", "কাকে", "কারা",
  "keno", "kivabe", "kibhabe", "kothay", "kokhon", "kobe", "koto",
]);

const NEWS_KEYWORDS = [
  "latest", "news", "recent", "current", "weather", "breaking", "live score", "update",
  "সর্বশেষ", "খবর", "সংবাদ", "লেটেস্ট", "নিউজ", "আবহাওয়া", "সাম্প্রতিক", "আজকের",
  "khobor", "khobar", "songbad", "abohawa", "ajker news", "sorboshesh",
];

/** Would a human expect this message to need outside, up-to-date knowledge? */
export function isResearchQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[?？]$/.test(t)) return true;
  // \p{M} keeps Bengali vowel signs (ে, ে, ি, ী …) attached to their letters,
  // so "কেন" stays one word instead of splitting into "ক" + "ন".
  const words = t.toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  if (words.length > 0 && QUESTION_FIRST_WORDS.has(words[0])) return true;
  // Bengali/Banglish put the question word at the END just as often:
  // "বাংলাদেশের রাজধানী কী", "tomar nam ki".
  if (words.length > 1 && QUESTION_FIRST_WORDS.has(words[words.length - 1])) return true;
  const lower = t.toLowerCase();
  if (words.some((w) => QUESTION_ANYWHERE.has(w))) return true;
  return NEWS_KEYWORDS.some((k) => lower.includes(k));
}

/** `/research <topic>` (or `/search <topic>`) forces an online lookup. */
export function forcedResearchTopic(text: string): string | null {
  const m = /^\/(?:research|search|khoj|khujo)\s+(.+)$/i.exec(text.trim());
  return m ? m[1].trim() : null;
}

/** Render a finding as a chat reply, in the language the user asked in. */
export function formatFinding(f: ResearchFinding): string {
  const lang = detectLanguage(f.topic || "");
  const bn = lang !== "en";
  const lines = [`🔎 ${f.answer.trim()}`];
  if (f.sources.length > 0) {
    lines.push("", bn ? "📎 সূত্র:" : "📎 Sources:");
    for (const s of f.sources) lines.push(`• ${s.title} — ${s.url}`);
  }
  if (typeof f.confidence === "number" && f.confidence < STRONG_SCORE) {
    lines.push(
      "",
      bn
        ? "ℹ️ এটি সবচেয়ে কাছাকাছি ফলাফল — প্রশ্নটি একটু অন্যভাবে লিখলে আরও ভালো উত্তর পেতে পারেন।"
        : "ℹ️ This is the closest match I found — try rephrasing for a sharper answer."
    );
  }
  if (f.stale) {
    lines.push(
      "",
      bn
        ? "⚠️ (ইন্টারনেট পাওয়া যায়নি — সংরক্ষিত ফলাফল দেখানো হলো)"
        : "⚠️ (served from cache — the internet was unreachable just now)"
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML / header helpers
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Human-readable wait from a Retry-After header (seconds or HTTP date). */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const t = Date.parse(value);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /aborted/i.test(e.message));
}

// ---------------------------------------------------------------------------
// The keyless sources
// ---------------------------------------------------------------------------

interface ParsedHits {
  answer: string;
  results: ResearchSourceHit[];
}

interface SourceInstance {
  name: string;
  host: string;
  /**
   * Which query string this source should receive — `null` skips the source
   * entirely (without burning an attempt). This is how a Bengali question is
   * routed to bn.wikipedia and a 12-word sentence never hits the Wikipedia
   * "exact page title" endpoint, which is what used to produce junk answers.
   */
  queryFor?(q: ResearchQuery): string | null;
  buildUrl(topic: string): string;
  parse(body: string, url: string): ParsedHits | null;
}

/** Default: every source gets the cleaned primary query. */
function queryOf(src: SourceInstance, q: ResearchQuery): string | null {
  return src.queryFor ? src.queryFor(q) : q.primary;
}

/** The Bengali-script spelling of the question, when we have one. */
function bengaliQuery(q: ResearchQuery): string | null {
  if (q.lang === "bn") return q.primary;
  if (q.lang === "banglish") return /[\u0980-\u09FF]/.test(q.primary) ? q.primary : q.variants.find((v) => /[\u0980-\u09FF]/.test(v)) ?? null;
  return null;
}

/** A Latin-script spelling of the question, when we have one. */
function latinQuery(q: ResearchQuery): string | null {
  if (q.lang === "en") return q.primary;
  const latin = [q.primary, ...q.variants].find((v) => !/[\u0980-\u09FF]/.test(v));
  return latin ?? null;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

/** An empty body is a clean "no results" response, not a block. */
const emptyResults = (): ParsedHits => ({ answer: "", results: [] });

function makeWikiSource(name: string, host: string, basePath: string): SourceInstance {
  return {
    name,
    host,
    buildUrl: (t) =>
      `https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(t)}&format=json&srlimit=3&origin=*`,
    parse(body) {
      let j: any;
      try {
        j = JSON.parse(body);
      } catch {
        return null;
      }
      const hits = ((j?.query?.search ?? []) as any[])
        .filter((r) => r?.title)
        .slice(0, 3)
        .map((r) => ({
          title: r.title,
          url: `https://${host}${basePath}${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
          snippet: decodeEntities(stripTags(r.snippet ?? "")),
        }));
      if (hits.length === 0) return emptyResults();
      return { answer: cap(hits[0].snippet, 500), results: hits };
    },
  };
}

const WIKIPEDIA_SEARCH: SourceInstance = makeWikiSource("Wikipedia Search", "en.wikipedia.org", "/wiki/");
const BENGALI_WIKIPEDIA: SourceInstance = {
  ...makeWikiSource("বাংলা উইকিপিডিয়া", "bn.wikipedia.org", "/wiki/"),
  // Only ask the Bengali encyclopedia in Bengali — sending Latin text there
  // returned nothing useful and wasted a request on every English question.
  queryFor: (q) => bengaliQuery(q),
};

const DDG_INSTANT: SourceInstance = {
  name: "DuckDuckGo Instant Answer",
  host: "api.duckduckgo.com",
  buildUrl: (t) =>
    `https://api.duckduckgo.com/?q=${encodeURIComponent(t)}&format=json&no_html=1&skip_disambig=1`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const results: ResearchSourceHit[] = [];
    if (j?.AbstractText && j?.AbstractURL) {
      results.push({ title: j.Heading || j.AbstractSource || "DuckDuckGo", url: j.AbstractURL, snippet: decodeEntities(stripTags(j.AbstractText)) });
    }
    for (const r of (j?.RelatedTopics ?? []) as any[]) {
      if (r?.Text && r?.FirstURL && results.length < 3) {
        results.push({ title: decodeEntities(stripTags(r.Text)).split(" - ")[0], url: r.FirstURL, snippet: decodeEntities(stripTags(r.Text)) });
      }
    }
    if (results.length === 0) return emptyResults();
    return { answer: cap(results[0].snippet, 500), results };
  },
};

function makeDdgHtmlSource(name: string, host: string, urlFor: (t: string) => string): SourceInstance {
  return {
    name,
    host,
    buildUrl: urlFor,
    parse(body) {
      if (!body.trim()) return emptyResults();
      const results: ResearchSourceHit[] = [];
      const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippets = [...body.matchAll(snippetRe)].map((m) => decodeEntities(stripTags(m[1])));
      let i = 0;
      for (const m of body.matchAll(linkRe)) {
        if (results.length >= 3) break;
        const url = decodeEntities(m[1]);
        if (!/^https?:/i.test(url)) continue;
        results.push({ title: decodeEntities(stripTags(m[2])) || url, url, snippet: snippets[i] ?? "" });
        i++;
      }
      if (results.length === 0) return emptyResults();
      return { answer: cap(results[0].snippet || results[0].title, 500), results };
    },
  };
}

const DDG_HTML: SourceInstance = makeDdgHtmlSource(
  "DuckDuckGo HTML",
  "html.duckduckgo.com",
  (t) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(t)}`
);

const DDG_LITE: SourceInstance = makeDdgHtmlSource(
  "DuckDuckGo Lite",
  "lite.duckduckgo.com",
  (t) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(t)}`
);

function parseSearx(body: string, baseUrl: string): ParsedHits | null {
  if (!body.trim()) return emptyResults();
  try {
    const j = JSON.parse(body);
    const hits = ((j?.results ?? []) as any[])
      .filter((r) => r?.url && r?.title)
      .slice(0, 3)
      .map((r) => ({
        title: decodeEntities(stripTags(r.title)),
        url: String(r.url),
        snippet: decodeEntities(stripTags(r.content ?? "")),
      }));
    if (hits.length > 0) return { answer: cap(hits[0].snippet, 500), results: hits };
    return emptyResults();
  } catch {
    /* not JSON — fall back to HTML link extraction below */
  }
  const results: ResearchSourceHit[] = [];
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{4,180}?)<\/a>/gi;
  for (const m of body.matchAll(linkRe)) {
    if (results.length >= 3) break;
    const title = decodeEntities(stripTags(m[2]));
    if (title.length < 8) continue;
    let url = decodeEntities(m[1]);
    try {
      url = new URL(url, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url)) continue;
    if (/\/search|\/about|\/preferences|\/stats/i.test(url)) continue;
    results.push({ title, url, snippet: "" });
  }
  if (results.length === 0) return emptyResults();
  return { answer: cap(results[0].title, 500), results };
}

const SEARXNG_HOSTS = [
  "searx.be",
  "paulgo.io",
  "searx.tiekoetter.com",
  "search.inetol.net",
  "baresearch.org",
  "priv.au",
  "opnxng.com",
  "search.hbubli.cc",
] as const;

const SEARXNG_INSTANCES: SourceInstance[] = SEARXNG_HOSTS.map((host, i) => ({
  name: `SearXNG #${i + 1}`,
  host,
  buildUrl: (t) => `https://${host}/search?q=${encodeURIComponent(t)}&format=json`,
  parse: (body, url) => parseSearx(body, url),
}));

const MOJEEK: SourceInstance = {
  name: "Mojeek",
  host: "www.mojeek.com",
  buildUrl: (t) => `https://www.mojeek.com/search?q=${encodeURIComponent(t)}`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    const results: ResearchSourceHit[] = [];
    const linkRe = /<a[^>]*class="[^"]*\bob\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<p[^>]*class="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
    const snippets = [...body.matchAll(snippetRe)].map((m) => decodeEntities(stripTags(m[1])));
    let i = 0;
    for (const m of body.matchAll(linkRe)) {
      if (results.length >= 3) break;
      const url = decodeEntities(m[1]);
      if (!/^https?:/i.test(url)) continue;
      results.push({ title: decodeEntities(stripTags(m[2])) || url, url, snippet: snippets[i] ?? "" });
      i++;
    }
    if (results.length === 0) return emptyResults();
    return { answer: cap(results[0].snippet || results[0].title, 500), results };
  },
};

const WIKIPEDIA_SUMMARY: SourceInstance = {
  name: "Wikipedia REST summary",
  host: "en.wikipedia.org",
  // This endpoint resolves an EXACT page title. Feeding it a whole sentence
  // ("who is the prime minister of bangladesh") always 404s, so only short,
  // title-like English topics are sent here.
  queryFor: (q) => {
    if (!q.titleLike || q.terms.length === 0) return null;
    const latin = latinQuery(q);
    if (!latin) return null;
    return q.terms.join(" ");
  },
  buildUrl: (t) => `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    if (!j?.extract && !j?.title) return null;
    const url = j?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(j.title).replace(/ /g, "_"))}`;
    return {
      answer: cap(String(j.extract ?? j.title), 600),
      results: [{ title: j.title, url, snippet: String(j.extract ?? "") }],
    };
  },
};

const WIKTIONARY: SourceInstance = {
  name: "Wiktionary definition",
  host: "en.wiktionary.org",
  // A dictionary only makes sense for a single word — never for a sentence.
  queryFor: (q) => {
    const latin = latinQuery(q);
    if (!latin) return null;
    return q.terms.length === 1 ? q.terms[0] : null;
  },
  buildUrl: (t) =>
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(t.split(/\s+/)[0].toLowerCase())}`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const sections = Object.values(j ?? {}) as any[];
    const defs: string[] = [];
    for (const s of sections) {
      for (const d of s ?? []) {
        for (const def of d?.definitions ?? []) {
          if (def?.definition) defs.push(decodeEntities(stripTags(String(def.definition))));
        }
      }
    }
    if (defs.length === 0) return emptyResults();
    const word = decodeURIComponent(this.buildUrl("").split("/").pop() ?? "");
    const title = (sections[0]?.[0]?.partOfSpeech ? `${word} (${sections[0][0].partOfSpeech})` : word) || "Wiktionary";
    return {
      answer: cap(defs.slice(0, 3).join(" "), 600),
      results: [{ title, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`, snippet: cap(defs[0], 400) }],
    };
  },
};

function haystack(q: ResearchQuery): string {
  return `${q.primary} ${q.variants.join(" ")}`.toLowerCase();
}

function isWeatherQuery(q: ResearchQuery): boolean {
  return /weather|forecast|temperature|humidity|আবহাওয়া|abohawa|brishti|বৃষ্টি|gorom|thanda/.test(haystack(q));
}

function isCodeQuery(q: ResearchQuery): boolean {
  return /stack.?overflow|error|exception|javascript|python|typescript|programming|compiler|debug|code sample/.test(haystack(q));
}

function isBookQuery(q: ResearchQuery): boolean {
  return /book|author|isbn|novel|library|লেখক|উপন্যাস|lekhok|uponnash/.test(haystack(q));
}

function isPaperQuery(q: ResearchQuery): boolean {
  return /arxiv|preprint|doi|physics|neural network|quantum|scientific paper|research paper/.test(haystack(q));
}

const OPEN_METEO: SourceInstance = {
  name: "Open-Meteo geocoding",
  host: "geocoding-api.open-meteo.com",
  queryFor: (q) => (isWeatherQuery(q) ? latinQuery(q) ?? q.primary : null),
  buildUrl: (t) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(t)}&count=1&language=en&format=json`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const r = j?.results?.[0];
    if (!r?.name) return emptyResults();
    const snippet = `${r.name}${r.admin1 ? ", " + r.admin1 : ""}${r.country ? ", " + r.country : ""} (${r.latitude}°, ${r.longitude}°)`;
    return {
      answer: cap(`Weather location: ${snippet}`, 400),
      results: [{ title: r.name, url: `https://open-meteo.com/en/docs#latitude=${r.latitude}&longitude=${r.longitude}`, snippet }],
    };
  },
};

const OPEN_METEO_FORECAST: SourceInstance = {
  name: "Open-Meteo forecast",
  host: "api.open-meteo.com",
  // Needs coordinates; skip unless the query already looks like "lat,lon" — geocoding source covers city names.
  queryFor: (q) => {
    if (!isWeatherQuery(q)) return null;
    const m = haystack(q).match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
    return m ? `${m[1]},${m[2]}` : null;
  },
  buildUrl: (t) => {
    const [lat, lon] = t.split(",");
    return `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true`;
  },
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const w = j?.current_weather;
    if (!w) return emptyResults();
    const snippet = `Temperature ${w.temperature}°C, wind ${w.windspeed} km/h, weather code ${w.weathercode}.`;
    return {
      answer: snippet,
      results: [{ title: "Open-Meteo current weather", url: "https://open-meteo.com/", snippet }],
    };
  },
};

const WIKIDATA: SourceInstance = {
  name: "Wikidata search",
  host: "www.wikidata.org",
  queryFor: (q) => (q.titleLike ? latinQuery(q) ?? q.primary : null),
  buildUrl: (t) =>
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(t)}&language=en&format=json&limit=3&origin=*`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const hits = ((j?.search ?? []) as any[])
      .filter((r) => r?.label)
      .slice(0, 3)
      .map((r) => ({
        title: r.label,
        url: r.concepturi || `https://www.wikidata.org/wiki/${r.id}`,
        snippet: r.description || r.label,
      }));
    if (hits.length === 0) return emptyResults();
    return { answer: cap(hits[0].snippet, 500), results: hits };
  },
};

const WIKIMEDIA_REST: SourceInstance = {
  name: "Wikimedia REST search",
  host: "api.wikimedia.org",
  queryFor: (q) => latinQuery(q),
  buildUrl: (t) => `https://api.wikimedia.org/core/v1/wikipedia/en/search/page?q=${encodeURIComponent(t)}&limit=3`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const hits = ((j?.pages ?? []) as any[])
      .filter((r) => r?.title)
      .slice(0, 3)
      .map((r) => ({
        title: r.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
        snippet: decodeEntities(stripTags(r.excerpt || r.description || r.title)),
      }));
    if (hits.length === 0) return emptyResults();
    return { answer: cap(hits[0].snippet, 500), results: hits };
  },
};

const STACK_EXCHANGE: SourceInstance = {
  name: "Stack Exchange",
  host: "api.stackexchange.com",
  queryFor: (q) => (isCodeQuery(q) ? latinQuery(q) ?? q.primary : null),
  buildUrl: (t) =>
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(t)}&site=stackoverflow&pagesize=3&filter=default`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const hits = ((j?.items ?? []) as any[])
      .filter((r) => r?.link && r?.title)
      .slice(0, 3)
      .map((r) => ({
        title: decodeEntities(stripTags(r.title)),
        url: String(r.link),
        snippet: r.body ? decodeEntities(stripTags(String(r.body))).slice(0, 280) : decodeEntities(stripTags(r.title)),
      }));
    if (hits.length === 0) return emptyResults();
    return { answer: cap(hits[0].snippet, 500), results: hits };
  },
};

const OPEN_LIBRARY: SourceInstance = {
  name: "Open Library",
  host: "openlibrary.org",
  queryFor: (q) => (isBookQuery(q) ? latinQuery(q) ?? q.primary : null),
  buildUrl: (t) => `https://openlibrary.org/search.json?q=${encodeURIComponent(t)}&limit=3`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return null;
    }
    const hits = ((j?.docs ?? []) as any[])
      .filter((r) => r?.title)
      .slice(0, 3)
      .map((r) => ({
        title: r.title,
        url: r.key ? `https://openlibrary.org${r.key}` : "https://openlibrary.org/",
        snippet: [r.author_name?.[0], r.first_publish_year, r.subject?.[0]].filter(Boolean).join(" · "),
      }));
    if (hits.length === 0) return emptyResults();
    return { answer: cap(`${hits[0].title}${hits[0].snippet ? " — " + hits[0].snippet : ""}`, 500), results: hits };
  },
};

const ARXIV: SourceInstance = {
  name: "arXiv",
  host: "export.arxiv.org",
  queryFor: (q) => (isPaperQuery(q) ? latinQuery(q) ?? q.primary : null),
  buildUrl: (t) => `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(t)}&start=0&max_results=3`,
  parse(body) {
    if (!body.trim()) return emptyResults();
    const results: ResearchSourceHit[] = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
    for (const m of body.matchAll(entryRe)) {
      if (results.length >= 3) break;
      const block = m[1];
      const title = decodeEntities(stripTags((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "")).trim();
      const summary = decodeEntities(stripTags((block.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "")).trim();
      const id = decodeEntities(stripTags((block.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "")).trim();
      if (!title) continue;
      results.push({ title, url: id || "https://arxiv.org/", snippet: cap(summary, 280) });
    }
    if (results.length === 0) return emptyResults();
    return { answer: cap(results[0].snippet || results[0].title, 500), results };
  },
};

function makeHtmlSearchSource(name: string, host: string, urlFor: (t: string) => string): SourceInstance {
  return {
    name,
    host,
    buildUrl: urlFor,
    parse(body, url) {
      if (!body.trim()) return emptyResults();
      const results: ResearchSourceHit[] = [];
      const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{8,180}?)<\/a>/gi;
      for (const m of body.matchAll(linkRe)) {
        if (results.length >= 3) break;
        const title = decodeEntities(stripTags(m[2]));
        if (title.length < 8) continue;
        let href = decodeEntities(m[1]);
        try {
          href = new URL(href, url).toString();
        } catch {
          continue;
        }
        if (!/^https?:/i.test(href)) continue;
        if (href.includes(host) || /\/search|\/about|\/preferences|\/settings/i.test(href)) continue;
        results.push({ title, url: href, snippet: "" });
      }
      if (results.length === 0) return emptyResults();
      return { answer: cap(results[0].title, 500), results };
    },
  };
}

const STARTPAGE: SourceInstance = makeHtmlSearchSource(
  "Startpage",
  "www.startpage.com",
  (t) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(t)}`
);

const ECOSIA: SourceInstance = makeHtmlSearchSource(
  "Ecosia",
  "www.ecosia.org",
  (t) => `https://www.ecosia.org/search?q=${encodeURIComponent(t)}`
);

const QWANT: SourceInstance = makeHtmlSearchSource(
  "Qwant",
  "www.qwant.com",
  (t) => `https://www.qwant.com/?q=${encodeURIComponent(t)}`
);

const EXTRA_SOURCES: SourceInstance[] = [
  OPEN_METEO,
  OPEN_METEO_FORECAST,
  WIKIDATA,
  WIKIMEDIA_REST,
  STACK_EXCHANGE,
  OPEN_LIBRARY,
  ARXIV,
  STARTPAGE,
  ECOSIA,
  QWANT,
];

const MARGINALIA: SourceInstance = {
  name: "Marginalia Search",
  host: "search.marginalia.nu",
  buildUrl: (t) => `https://search.marginalia.nu/search?query=${encodeURIComponent(t)}`,
  parse(body, url) {
    if (!body.trim()) return emptyResults();
    const results: ResearchSourceHit[] = [];
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]{6,160}?)<\/a>/gi;
    for (const m of body.matchAll(linkRe)) {
      if (results.length >= 3) break;
      const title = decodeEntities(stripTags(m[2]));
      if (title.length < 8) continue;
      let href = decodeEntities(m[1]);
      try {
        href = new URL(href, url).toString();
      } catch {
        continue;
      }
      if (!/^https?:/i.test(href)) continue;
      if (href.includes("marginalia.nu") || /\/about|\/search/i.test(href)) continue;
      results.push({ title, url: href, snippet: "" });
    }
    if (results.length === 0) return emptyResults();
    return { answer: cap(results[0].title, 500), results };
  },
};

// 6 rotating browser User-Agents.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 OPR/107.0.0.0",
];

// ---------------------------------------------------------------------------
// ResearchService
// ---------------------------------------------------------------------------

/** Outcome of ONE fetch attempt against ONE source. */
type TryOutcome =
  | { kind: "hit"; hits: ResearchSourceHit[] } // healthy response with results
  | { kind: "clean" } // healthy response, no answer for this topic
  | { kind: "http-fail"; status: number; retryAfterMs: number | null } // 429/5xx/blocked page
  | { kind: "error" }; // fetch threw / aborted — network-level problem

/** A scored answer candidate collected during a sweep. */
interface Candidate {
  finding: ResearchFinding;
  score: number;
}

/** Mutable bookkeeping shared by the sweeps of one research call. */
interface SweepState {
  tried: string[];
  sawNetworkError: boolean;
  sawHttp: boolean;
  skippedOpenCircuits: boolean;
  offlineDetected: boolean;
  candidates: Candidate[];
  consecutiveNetworkErrors?: number;
}

/**
 * Rank the hits of ONE source and build the answer from the best one.
 * This replaces the old "always take result #0" behaviour, which is why an
 * unrelated first link used to become the AI's answer.
 */
function rankHits(
  hits: ResearchSourceHit[],
  terms: string[]
): { answer: string; hits: ResearchSourceHit[]; score: number } | null {
  const scored = hits
    .map((h) => ({ hit: h, score: relevanceScore({ title: h.title, snippet: h.snippet, url: h.url }, terms) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const top = scored[0];
  const body = (top.hit.snippet || "").trim();
  const answer = body.length >= 20 ? body : `${top.hit.title}${body ? " — " + body : ""}`.trim();
  if (!answer) return null;
  return {
    answer: cap(answer, 700),
    hits: scored.map((s) => s.hit).slice(0, 3),
    score: top.score,
  };
}

/** Highest-scoring candidate across every source we tried. */
function pickBest(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.score > a.score ? b : a));
}

/** Token overlap between two answers — used to detect independent agreement. */
function answerOverlap(a: string, b: string): number {
  const wa = new Set((a.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 40));
  const wb = new Set((b.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 40));
  if (wa.size === 0 || wb.size === 0) return 0;
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n / Math.min(wa.size, wb.size);
}

/**
 * When two or more sources agree, merge their answers, keep every citation
 * and bump confidence. Uses relevanceScore so a rambling extra source cannot
 * drown a tight Wikipedia snippet.
 */
function synthesize(candidates: Candidate[], terms: string[]): Candidate | null {
  const best = pickBest(candidates);
  if (!best) return null;
  const agreeing = candidates.filter((c) => c === best || answerOverlap(c.finding.answer, best.finding.answer) >= 0.28);
  if (agreeing.length < 2) return best;
  const sources: ResearchSourceHit[] = [];
  const hosts: string[] = [];
  const seenUrl = new Set<string>();
  const seenHost = new Set<string>();
  for (const c of agreeing.sort((a, b) => b.score - a.score)) {
    for (const s of c.finding.sources) {
      if (seenUrl.has(s.url)) continue;
      seenUrl.add(s.url);
      sources.push(s);
    }
    for (const h of c.finding.sourceHosts) {
      if (seenHost.has(h)) continue;
      seenHost.add(h);
      hosts.push(h);
    }
  }
  const extra = agreeing
    .filter((c) => c !== best)
    .map((c) => c.finding.answer.trim())
    .filter((a) => a && a !== best.finding.answer.trim())
    .slice(0, 2);
  const mergedAnswer = extra.length
    ? cap(`${best.finding.answer.trim()}${extra.map((e) => " " + e).join("")}`, 900)
    : best.finding.answer;
  const conf = Math.min(1, Math.max(best.score, relevanceScore({ title: sources[0]?.title, snippet: mergedAnswer }, terms)) + 0.12);
  const finding: ResearchFinding = {
    ...best.finding,
    answer: mergedAnswer,
    sources: sources.slice(0, 6),
    sourceHosts: hosts,
    confidence: Math.round(conf * 100) / 100,
  };
  return { finding, score: conf };
}

export class ResearchService {
  readonly enabled: boolean;

  private db: any;
  private options: Required<
    Pick<
      ResearchOptions,
      "cacheTtlMinutes" | "timeoutMs" | "saveToKnowledge" | "spacingMs" | "maxAttempts" | "maxRequestsPerMinute" | "negativeTtlMinutes" | "offlineFailFastAfter"
    >
  > &
    Pick<ResearchOptions, "fetchImpl" | "logger" | "now">;
  private hooks: ResearchHooks;
  private breaker = new CircuitBreaker();
  private inflight = new Map<string, Promise<ResearchResult>>();
  private searxCursor = 0;
  private uaIndex = 0;
  private lastRequestAt = 0;
  private requestTimes: number[] = [];
  private attemptsThisCall = 0;
  private hits = 0;
  private misses = 0;
  private staleServed = 0;

  constructor(db: any, options: ResearchOptions, hooks: ResearchHooks = {}) {
    this.db = db;
    this.enabled = options.enabled !== false;
    this.options = {
      cacheTtlMinutes: options.cacheTtlMinutes,
      timeoutMs: options.timeoutMs,
      saveToKnowledge: options.saveToKnowledge !== false,
      spacingMs: options.spacingMs ?? 250,
      maxAttempts: options.maxAttempts ?? 8,
      maxRequestsPerMinute: options.maxRequestsPerMinute ?? 60,
      negativeTtlMinutes: options.negativeTtlMinutes ?? 10,
      offlineFailFastAfter: options.offlineFailFastAfter ?? 2,
      fetchImpl: options.fetchImpl,
      logger: options.logger,
      now: options.now,
    };
    this.hooks = hooks;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private fetchImpl: typeof fetch = (input, init) =>
    (this.options.fetchImpl ?? ((globalThis as any).fetch as typeof fetch))(input, init);

  private log(msg: string): void {
    this.options.logger?.(msg);
  }

  private cacheKey(topic: string): string {
    return crypto.createHash("sha1").update(topic.toLowerCase().trim()).digest("hex").slice(0, 24);
  }

  /** SQLite CURRENT_TIMESTAMP → epoch ms. */
  private dbTime(value: string): number {
    if (!value) return 0;
    const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  }

  private nextUserAgent(): string {
    const ua = USER_AGENTS[this.uaIndex % USER_AGENTS.length];
    this.uaIndex++;
    return ua;
  }

  // -- global request-rate cap ------------------------------------------------

  /** Am I allowed to send another request within the rolling minute? */
  private underRateCap(): boolean {
    const cutoff = this.now() - 60_000;
    this.requestTimes = this.requestTimes.filter((t) => t >= cutoff);
    return this.requestTimes.length < this.options.maxRequestsPerMinute;
  }

  private recordRequest(): void {
    this.requestTimes.push(this.now());
    this.attemptsThisCall++;
  }

  /** Static order used by the status endpoint (no cursor side effects). */
  private staticSources(): SourceInstance[] {
    return [DDG_INSTANT, WIKIPEDIA_SEARCH, DDG_HTML, DDG_LITE, BENGALI_WIKIPEDIA, ...SEARXNG_INSTANCES, WIKTIONARY, MOJEEK, WIKIPEDIA_SUMMARY, MARGINALIA, ...EXTRA_SOURCES];
  }

  /**
   * Search order per call, chosen by the language of the question.
   *
   * Bengali/Banglish questions start at bn.wikipedia (which actually indexes
   * Bengali content) instead of wasting the first, freshest attempts on
   * English-only engines — that alone fixes most "wrong answer" cases.
   * SearXNG instances rotate so the load is spread across all of them.
   */
  private rotatedSources(q?: ResearchQuery): SourceInstance[] {
    const bengali = q ? q.lang === "bn" || q.lang === "banglish" : false;
    const list: SourceInstance[] = bengali
      ? [BENGALI_WIKIPEDIA, DDG_HTML, DDG_LITE, DDG_INSTANT, WIKIPEDIA_SEARCH]
      : [DDG_INSTANT, WIKIPEDIA_SEARCH, DDG_HTML, DDG_LITE];
    list.push(SEARXNG_INSTANCES[this.searxCursor % SEARXNG_INSTANCES.length]);
    list.push(SEARXNG_INSTANCES[(this.searxCursor + 1) % SEARXNG_INSTANCES.length]);
    if (bengali) {
      list.push(MOJEEK, WIKIPEDIA_SUMMARY, MARGINALIA);
    } else {
      list.push(WIKTIONARY, MOJEEK, WIKIPEDIA_SUMMARY, MARGINALIA, BENGALI_WIKIPEDIA);
    }
    list.push(...EXTRA_SOURCES);
    this.searxCursor = (this.searxCursor + 2) % SEARXNG_INSTANCES.length;
    return list;
  }

  // -- public API ------------------------------------------------------------

  /**
   * Research a topic. Fresh cache answers instantly; otherwise the sources are
   * tried in order inside one hard time budget. Concurrent calls for the same
   * topic share ONE in-flight request.
   *
   * `force` (the `/research <topic>` command) bypasses the negative cache —
   * "I already know there was no answer recently" — and does a real lookup.
   */
  async research(topic: string, opts: { force?: boolean } = {}): Promise<ResearchResult> {
    if (!this.enabled) return { ok: false, error: "Online research is disabled." };
    const key = this.cacheKey(topic);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.doResearch(topic, key, opts.force === true);
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Current state for GET /api/v1/research/status. */
  status(): ResearchStatus {
    const cacheEntries = Number((this.db.prepare("SELECT COUNT(*) AS c FROM research_cache").get() as any).c) || 0;
    const negEntries = Number((this.db.prepare("SELECT COUNT(*) AS c FROM research_negcache").get() as any).c) || 0;
    const savedFindings =
      Number((this.db.prepare("SELECT COUNT(*) AS c FROM knowledge WHERE title LIKE 'Research:%'").get() as any).c) || 0;
    const cutoff = this.now() - 60_000;
    return {
      enabled: this.enabled,
      cacheTtlMinutes: this.options.cacheTtlMinutes,
      timeoutMs: this.options.timeoutMs,
      saveToKnowledge: this.options.saveToKnowledge,
      maxAttempts: this.options.maxAttempts,
      maxRequestsPerMinute: this.options.maxRequestsPerMinute,
      sources: this.staticSources().map((s) => ({
        name: s.name,
        host: s.host,
        ...this.breaker.state(s.host),
      })),
      cache: {
        entries: cacheEntries,
        hits: this.hits,
        misses: this.misses,
        staleServed: this.staleServed,
        negativeEntries: negEntries,
      },
      savedFindings,
      inFlight: this.inflight.size,
      requestsLastMinute: this.requestTimes.filter((t) => t >= cutoff).length,
    };
  }

  /**
   * Probe every source with a handful of known queries (English, বাংলা, Banglish).
   * Used by GET /api/v1/research/selftest after deploy — each source is fetched
   * once per applicable query so the circuit breaker still keys on hostname.
   */
  async selftest(): Promise<{
    at: number;
    queries: { topic: string; lang: string }[];
    sources: {
      name: string;
      host: string;
      pass: boolean;
      skipped: boolean;
      latencyMs: number;
      error?: string;
      sampleAnswer?: string;
      confidence?: number;
    }[];
  }> {
    const queries = [
      { topic: "Alan Turing", lang: "en" },
      { topic: "বাংলাদেশের রাজধানী", lang: "bn" },
      { topic: "Dhaka weather today", lang: "en" },
      { topic: "Bangladesher rajdhani ki", lang: "banglish" },
    ];
    const deadline = this.now() + Math.max(this.options.timeoutMs * 4, 20_000);
    const rows: {
      name: string;
      host: string;
      pass: boolean;
      skipped: boolean;
      latencyMs: number;
      error?: string;
      sampleAnswer?: string;
      confidence?: number;
    }[] = [];

    for (const src of this.staticSources()) {
      let applied: { topic: string; text: string } | null = null;
      for (const q of queries) {
        const rq = buildResearchQuery(q.topic);
        const routed = queryOf(src, rq);
        if (routed === null) continue;
        applied = { topic: q.topic, text: src.host === "bn.wikipedia.org" ? routed : routed };
        break;
      }
      if (!applied) {
        rows.push({ name: src.name, host: src.host, pass: false, skipped: true, latencyMs: 0 });
        continue;
      }
      const t0 = this.now();
      const outcome = await this.fetchOnce(src, applied.text, deadline);
      const latencyMs = this.now() - t0;
      if (outcome.kind === "hit") {
        const terms = scoringTerms(applied.topic);
        const ranked = rankHits(outcome.hits, terms);
        rows.push({
          name: src.name,
          host: src.host,
          pass: true,
          skipped: false,
          latencyMs,
          sampleAnswer: ranked?.answer?.slice(0, 220),
          confidence: ranked ? Math.round(ranked.score * 100) / 100 : undefined,
        });
      } else if (outcome.kind === "clean") {
        rows.push({ name: src.name, host: src.host, pass: false, skipped: false, latencyMs, error: "no results" });
      } else if (outcome.kind === "http-fail") {
        rows.push({ name: src.name, host: src.host, pass: false, skipped: false, latencyMs, error: `HTTP ${outcome.status}` });
      } else {
        rows.push({ name: src.name, host: src.host, pass: false, skipped: false, latencyMs, error: "network error" });
      }
    }
    return { at: this.now(), queries, sources: rows };
  }

  /** Reset every circuit breaker (and optionally the caches). */
  reset(clearCache = false): { ok: boolean; clearedCache: boolean } {
    this.breaker.resetAll();
    this.requestTimes = [];
    if (clearCache) {
      this.db.prepare("DELETE FROM research_cache").run();
      this.db.prepare("DELETE FROM research_negcache").run();
    }
    return { ok: true, clearedCache: clearCache };
  }

  // -- internals --------------------------------------------------------------

  private async doResearch(topic: string, key: string, force = false): Promise<ResearchResult> {
    const ttlMs = this.options.cacheTtlMinutes * 60_000;

    // 1) Fresh permanent cache → instant answer, zero network.
    const row = this.db
      .prepare("SELECT topic, result, source, created_at FROM research_cache WHERE key = ?")
      .get(key) as any;
    if (row) {
      const age = this.now() - this.dbTime(row.created_at);
      if (age <= ttlMs) {
        this.hits++;
        const finding: ResearchFinding = JSON.parse(row.result);
        return { ok: true, finding: { ...finding, cached: true } };
      }
    }

    // 2) Negative cache — this topic recently returned a clean "no answer".
    //    Re-searching it would only burn requests on the public sources.
    //    A forced lookup (/research <topic>) skips this guard.
    const neg = this.db.prepare("SELECT created_at FROM research_negcache WHERE key = ?").get(key) as any;
    if (neg && !force) {
      const age = this.now() - this.dbTime(neg.created_at);
      if (age <= this.options.negativeTtlMinutes * 60_000) {
        this.log(`research: "${topic}" has no known answer (negative cache) — skipping sources`);
        return { ok: false, offline: false, negative: true, triedSources: [] };
      }
    }

    // 3) Global rate cap — never hammer the public sources.
    if (!this.underRateCap()) {
      this.log(`research: global request cap reached (${this.options.maxRequestsPerMinute}/min) — cooling down`);
      if (row) {
        this.staleServed++;
        const finding: ResearchFinding = JSON.parse(row.result);
        return { ok: true, finding: { ...finding, cached: true, stale: true } };
      }
      return { ok: false, offline: false, rateLimited: true, triedSources: [] };
    }

    // 4) Live lookup inside the hard time budget.
    const query = buildResearchQuery(topic);
    this.log(
      `research: "${topic}" → query "${query.primary}" (${query.lang}` +
        (query.variants.length ? `, ${query.variants.length} variant(s)` : "") +
        `)`
    );

    const deadline = this.now() + this.options.timeoutMs;
    const state: SweepState = {
      tried: [],
      sawNetworkError: false,
      sawHttp: false,
      skippedOpenCircuits: false,
      offlineDetected: false,
      candidates: [],
    };
    this.attemptsThisCall = 0;

    let best = await this.sweep(query, query.primary, deadline, state);

    // The primary spelling found nothing usable? Try the other spelling of the
    // same question (Banglish ⇄ বাংলা) — but never while the internet is down.
    if (!best && !state.offlineDetected && state.sawHttp) {
      for (const variant of query.variants) {
        if (this.now() >= deadline) break;
        if (this.attemptsThisCall >= this.options.maxAttempts) break;
        if (!this.underRateCap()) break;
        this.log(`research: retrying with the alternative spelling "${variant}"`);
        best = await this.sweep(query, variant, deadline, state);
        if (best) break;
      }
    }

    if (best) {
      this.save(key, topic, best, best.sourceHosts[0] ?? "web");
      return { ok: true, finding: best };
    }

    // No strong answer — fall back to the best of everything we collected.
    const fallback = pickBest(state.candidates);
    if (fallback && fallback.score > WEAK_SCORE && state.sawHttp) {
      this.save(key, topic, fallback.finding, "best-effort");
      return { ok: true, finding: fallback.finding };
    }

    // 5) Internet unreachable? Serve the stale cache instead of nothing.
    if (row) {
      this.staleServed++;
      const finding: ResearchFinding = JSON.parse(row.result);
      return { ok: true, finding: { ...finding, cached: true, stale: true } };
    }

    // A very weak answer still beats "I found nothing" when the net was up.
    if (fallback && state.sawHttp) {
      this.save(key, topic, fallback.finding, "best-effort");
      return { ok: true, finding: fallback.finding };
    }

    // Every host either failed at the network level or was already cooling
    // down from earlier failures — treat that as "no internet right now".
    const offline = state.sawNetworkError || (this.attemptsThisCall === 0 && state.skippedOpenCircuits);

    // 6) The internet worked but no source knew the answer — remember that for
    //    a while so repeated questions don't hammer the sources again.
    if (!offline && this.attemptsThisCall > 0) {
      this.db
        .prepare("INSERT INTO research_negcache (key, topic) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET topic = excluded.topic, created_at = CURRENT_TIMESTAMP")
        .run(key, topic);
    }

    return { ok: false, offline, triedSources: state.tried };
  }

  /**
   * ONE pass over the source list with a single query string.
   * Returns a finding as soon as a source produces a *strongly relevant*
   * answer; weaker hits are collected in `state.candidates` so the caller can
   * still fall back to the best of them.
   */
  private async sweep(
    query: ResearchQuery,
    queryText: string,
    deadline: number,
    state: SweepState
  ): Promise<ResearchFinding | null> {
    // Terms of the string we are actually searching for (Bengali vs Latin).
    const terms = scoringTerms(queryText);
    const scoreTerms = terms.length > 0 ? terms : query.terms;

    for (const src of this.rotatedSources(query)) {
      if (this.now() >= deadline) break;
      if (this.attemptsThisCall >= this.options.maxAttempts) break;
      if (!this.underRateCap()) break;

      // Language / shape routing — skipping costs nothing.
      const routed = queryOf(src, query);
      if (routed === null) continue;
      // Bengali sources always get the Bengali spelling, everyone else gets
      // the sweep's query text.
      const searchText = src.host === "bn.wikipedia.org" ? routed : queryText;

      state.tried.push(src.name);
      if (this.breaker.isOpen(src.host)) {
        state.skippedOpenCircuits = true;
        continue;
      }

      const outcome = await this.trySource(src, searchText, deadline, { allowRetry: state.sawHttp });

      if (outcome.kind === "hit") {
        state.sawHttp = true;
        state.consecutiveNetworkErrors = 0;
        // Pick the BEST matching hit inside this source, not simply the first.
        const ranked = rankHits(outcome.hits, scoreTerms);
        if (!ranked) continue;
        const finding: ResearchFinding = {
          topic: query.primary,
          answer: ranked.answer,
          sources: ranked.hits,
          sourceHosts: [src.host],
          timestamp: this.now(),
          cached: false,
          confidence: Math.round(ranked.score * 100) / 100,
          query: searchText,
        };
        state.candidates.push({ finding, score: ranked.score });
        if (ranked.score >= STRONG_SCORE && ranked.answer.length >= 25) {
          this.log(`research: ${src.name} answered with confidence ${ranked.score.toFixed(2)}`);
          const syn = synthesize(state.candidates, scoreTerms);
          return syn?.finding ?? finding;
        }
        this.log(`research: ${src.name} hit was weak (${ranked.score.toFixed(2)}) — checking another source`);
        continue;
      }

      if (outcome.kind === "clean") {
        state.sawHttp = true;
        state.consecutiveNetworkErrors = 0;
      } else if (outcome.kind === "http-fail") {
        state.sawHttp = true;
        state.consecutiveNetworkErrors = 0;
        this.breaker.recordFailure(src.host, outcome.retryAfterMs);
        this.log(`research: ${src.name} answered HTTP ${outcome.status} — circuit opened`);
      } else {
        state.sawNetworkError = true;
        state.consecutiveNetworkErrors = (state.consecutiveNetworkErrors ?? 0) + 1;
        this.breaker.recordFailure(src.host);
        if (!state.sawHttp && state.consecutiveNetworkErrors >= this.options.offlineFailFastAfter) {
          this.log(
            `research: ${state.consecutiveNetworkErrors} consecutive network errors with no HTTP response — internet appears unreachable, stopping early`
          );
          state.offlineDetected = true;
          break;
        }
      }
    }
    const syn = synthesize(state.candidates, scoreTerms);
    if (syn && syn.score >= STRONG_SCORE && syn.finding.answer.length >= 25) return syn.finding;
    return null;
  }

  /** Try one source, with ONE retry for transient network errors when the internet is known to be up. */
  private async trySource(
    src: SourceInstance,
    topic: string,
    deadline: number,
    ctx: { allowRetry: boolean }
  ): Promise<TryOutcome> {
    const check = this.breaker.check(src.host);
    if (!check.allowed) {
      this.log(`research: ${src.name} in cooldown (${Math.round(check.retryInMs / 1000)}s left)`);
      return { kind: "clean" };
    }
    const remaining = deadline - this.now();
    if (remaining <= 0) return { kind: "clean" };

    // Polite spacing between consecutive requests to different hosts.
    if (this.lastRequestAt > 0) {
      const since = this.now() - this.lastRequestAt;
      if (since < this.options.spacingMs) {
        await sleep(Math.min(this.options.spacingMs - since, remaining));
        if (this.now() >= deadline) return { kind: "clean" };
      }
    }

    let outcome = await this.fetchOnce(src, topic, deadline);
    if (outcome.kind === "error" && ctx.allowRetry && this.underRateCap()) {
      const left = deadline - this.now();
      if (left > 400) {
        await sleep(Math.min(150, left));
        if (this.now() < deadline && this.attemptsThisCall < this.options.maxAttempts) {
          outcome = await this.fetchOnce(src, topic, deadline);
        }
      }
    }
    return outcome;
  }

  /** One fetch + parse round against one source. */
  private async fetchOnce(src: SourceInstance, topic: string, deadline: number): Promise<TryOutcome> {
    const controller = new AbortController();
    // One slow host must never eat the whole budget — give it at most half of
    // what is left, so later sources still get their chance inside the deadline.
    const remainingNow = deadline - this.now();
    const perSourceTimeout = Math.min(2500, Math.max(300, Math.floor(remainingNow / 2)));
    const timer = setTimeout(() => controller.abort(), perSourceTimeout);
    try {
      this.lastRequestAt = this.now();
      this.recordRequest();
      const url = src.buildUrl(topic);
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "user-agent": this.nextUserAgent(),
          accept: "application/json, text/html;q=0.9, */*;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseRetryAfterMs(res.headers?.get?.("retry-after"));
        return { kind: "http-fail", status: res.status, retryAfterMs: retryAfter };
      }
      if (!res.ok) {
        return { kind: "http-fail", status: res.status, retryAfterMs: null };
      }

      const text = await res.text();
      let parsed: ParsedHits | null = null;
      try {
        parsed = src.parse(text, url);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        // Unparsable page — likely a block/challenge page, not a clean answer.
        return { kind: "http-fail", status: res.status, retryAfterMs: null };
      }
      if (parsed.results.length === 0) {
        // Clean, healthy response that simply has no answer for this topic.
        this.breaker.recordSuccess(src.host);
        return { kind: "clean" };
      }
      this.breaker.recordSuccess(src.host);
      return { kind: "hit", hits: parsed.results.slice(0, 3) };
    } catch (e) {
      if (isAbortError(e)) {
        this.log(`research: ${src.name} timed out (${perSourceTimeout}ms)`);
        return { kind: "error" };
      }
      return { kind: "error" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persist a fresh finding: permanent cache + (optionally) a knowledge doc. */
  private save(key: string, topic: string, finding: ResearchFinding, source: string): void {
    this.misses++;
    this.db
      .prepare(
        `INSERT INTO research_cache (key, topic, result, source) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET topic = excluded.topic, result = excluded.result,
           source = excluded.source, created_at = CURRENT_TIMESTAMP`
      )
      .run(key, topic, JSON.stringify(finding), source);
    this.db.prepare("DELETE FROM research_negcache WHERE key = ?").run(key);

    if (this.options.saveToKnowledge) {
      const title = `Research: ${topic.slice(0, 60)}`;
      const content = formatFinding(finding);
      const info = this.db.prepare("INSERT INTO knowledge (title, content) VALUES (?, ?)").run(title, content);
      this.hooks.onKnowledgeSave?.({ id: Number(info.lastInsertRowid), title, content });
    }
  }
}
