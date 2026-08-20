/**
 * Online research — 7 free, keyless sources. No API key, no signup.
 * -----------------------------------------------------------------
 * Sources (each on its OWN hostname, so a rate limit on one never
 * affects the others):
 *
 *   1. Wikipedia Search API      en.wikipedia.org
 *   2. DuckDuckGo Instant Answer api.duckduckgo.com
 *   3. DuckDuckGo HTML           html.duckduckgo.com
 *   4. DuckDuckGo Lite           lite.duckduckgo.com
 *   5. SearXNG (5 public instances, rotated)
 *   6. Mojeek                    www.mojeek.com
 *   7. Wikipedia REST summary    en.wikipedia.org/api/rest_v1
 *
 * Rate-limit protection:
 *   • per-host circuit breaker with exponential backoff (1 → 15 min),
 *     honouring Retry-After headers (see circuit.ts)
 *   • 6 rotating browser User-Agents
 *   • polite spacing between requests
 *   • permanent cache (SQLite → Telegram snapshot) + stale-cache fallback
 *   • in-flight request de-duplication
 *   • a hard time budget so a chat reply can never hang for long
 *
 * Every fresh finding is also saved into the `knowledge` table, so it
 * survives Render restarts (Telegram snapshot) and can later be answered
 * completely offline by the local brain.
 */

import crypto from "crypto";
import { CircuitBreaker } from "./circuit.ts";

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
}

export interface ResearchResult {
  ok: boolean;
  finding?: ResearchFinding;
  /** Every source failed at the network level (likely: no internet). */
  offline?: boolean;
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
}

export interface ResearchStatus {
  enabled: boolean;
  cacheTtlMinutes: number;
  timeoutMs: number;
  saveToKnowledge: boolean;
  sources: {
    name: string;
    host: string;
    ready: boolean;
    failures: number;
    cooldownRemainingMs: number;
    lastRetryAfterMs: number | null;
  }[];
  cache: { entries: number; hits: number; misses: number; staleServed: number };
  savedFindings: number;
  inFlight: number;
}

// ---------------------------------------------------------------------------
// Question detection (English + Bengali)
// ---------------------------------------------------------------------------

const QUESTION_FIRST_WORDS = new Set([
  "who", "what", "why", "when", "where", "how", "which", "whose",
  "কে", "কী", "কি", "কেন", "কখন", "কোথায়", "কোথা", "কীভাবে", "কিভাবে", "কার", "কত",
  "keno", "kivabe", "kibhabe", "kothay", "kobe", "kara",
]);

const NEWS_KEYWORDS = [
  "latest", "news", "recent", "current", "weather", "breaking",
  "সর্বশেষ", "খবর", "সংবাদ", "লেটেস্ট", "নিউজ", "আবহাওয়া", "সাম্প্রতিক",
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
  const lower = t.toLowerCase();
  return NEWS_KEYWORDS.some((k) => lower.includes(k));
}

/** `/research <topic>` (or `/search <topic>`) forces an online lookup. */
export function forcedResearchTopic(text: string): string | null {
  const m = /^\/(?:research|search)\s+(.+)$/i.exec(text.trim());
  return m ? m[1].trim() : null;
}

/** Render a finding as a chat reply. */
export function formatFinding(f: ResearchFinding): string {
  const lines = [`🔎 ${f.answer.trim()}`];
  if (f.sources.length > 0) {
    lines.push("", "📎 Sources:");
    for (const s of f.sources) lines.push(`• ${s.title} — ${s.url}`);
  }
  if (f.stale) lines.push("", "⚠️ (served from cache — the internet was unreachable just now)");
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
// The 7 keyless sources
// ---------------------------------------------------------------------------

interface ParsedHits {
  answer: string;
  results: ResearchSourceHit[];
}

interface SourceInstance {
  name: string;
  host: string;
  buildUrl(topic: string): string;
  parse(body: string, url: string): ParsedHits | null;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

const WIKIPEDIA_SEARCH: SourceInstance = {
  name: "Wikipedia Search",
  host: "en.wikipedia.org",
  buildUrl: (t) =>
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(t)}&format=json&srlimit=3&origin=*`,
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
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
        snippet: decodeEntities(stripTags(r.snippet ?? "")),
      }));
    if (hits.length === 0) return { answer: "", results: [] };
    return { answer: cap(hits[0].snippet, 500), results: hits };
  },
};

const DDG_INSTANT: SourceInstance = {
  name: "DuckDuckGo Instant Answer",
  host: "api.duckduckgo.com",
  buildUrl: (t) =>
    `https://api.duckduckgo.com/?q=${encodeURIComponent(t)}&format=json&no_html=1&skip_disambig=1`,
  parse(body) {
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
    if (results.length === 0) return { answer: "", results: [] };
    return { answer: cap(results[0].snippet, 500), results };
  },
};

const DDG_HTML: SourceInstance = {
  name: "DuckDuckGo HTML",
  host: "html.duckduckgo.com",
  buildUrl: (t) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(t)}`,
  parse(body) {
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
    if (results.length === 0) return null;
    return { answer: cap(results[0].snippet || results[0].title, 500), results };
  },
};

const DDG_LITE: SourceInstance = {
  name: "DuckDuckGo Lite",
  host: "lite.duckduckgo.com",
  buildUrl: (t) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(t)}`,
  parse(body) {
    const results: ResearchSourceHit[] = [];
    const linkRe = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
    const snippets = [...body.matchAll(snippetRe)].map((m) => decodeEntities(stripTags(m[1])));
    let i = 0;
    for (const m of body.matchAll(linkRe)) {
      if (results.length >= 3) break;
      const url = decodeEntities(m[1]);
      if (!/^https?:/i.test(url)) continue;
      results.push({ title: decodeEntities(stripTags(m[2])) || url, url, snippet: snippets[i] ?? "" });
      i++;
    }
    if (results.length === 0) return null;
    return { answer: cap(results[0].snippet || results[0].title, 500), results };
  },
};

function parseSearx(body: string, baseUrl: string): ParsedHits | null {
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
  if (results.length === 0) return null;
  return { answer: cap(results[0].title, 500), results };
}

const SEARXNG_HOSTS = [
  "searx.be",
  "paulgo.io",
  "searx.tiekoetter.com",
  "search.inetol.net",
  "baresearch.org",
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
    if (results.length === 0) return null;
    return { answer: cap(results[0].snippet || results[0].title, 500), results };
  },
};

const WIKIPEDIA_SUMMARY: SourceInstance = {
  name: "Wikipedia REST summary",
  host: "en.wikipedia.org",
  buildUrl: (t) => `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`,
  parse(body) {
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

export class ResearchService {
  readonly enabled: boolean;

  private db: any;
  private options: Required<Pick<ResearchOptions, "cacheTtlMinutes" | "timeoutMs" | "saveToKnowledge" | "spacingMs">> &
    Pick<ResearchOptions, "fetchImpl" | "logger" | "now">;
  private hooks: ResearchHooks;
  private breaker = new CircuitBreaker();
  private inflight = new Map<string, Promise<ResearchResult>>();
  private searxCursor = 0;
  private uaIndex = 0;
  private lastRequestAt = 0;
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

  /** Static order used by the status endpoint (no cursor side effects). */
  private staticSources(): SourceInstance[] {
    return [DDG_INSTANT, WIKIPEDIA_SEARCH, DDG_HTML, DDG_LITE, ...SEARXNG_INSTANCES, MOJEEK, WIKIPEDIA_SUMMARY];
  }

  /** Search order with the SearXNG instances rotated per call. */
  private rotatedSources(): SourceInstance[] {
    const list: SourceInstance[] = [DDG_INSTANT, WIKIPEDIA_SEARCH, DDG_HTML, DDG_LITE];
    for (let i = 0; i < SEARXNG_INSTANCES.length; i++) {
      list.push(SEARXNG_INSTANCES[(this.searxCursor + i) % SEARXNG_INSTANCES.length]);
    }
    list.push(MOJEEK, WIKIPEDIA_SUMMARY);
    this.searxCursor = (this.searxCursor + 1) % SEARXNG_INSTANCES.length;
    return list;
  }

  // -- public API ------------------------------------------------------------

  /**
   * Research a topic. Fresh cache answers instantly; otherwise the sources are
   * tried in order inside one hard time budget. Concurrent calls for the same
   * topic share ONE in-flight request.
   */
  async research(topic: string): Promise<ResearchResult> {
    if (!this.enabled) return { ok: false, error: "Online research is disabled." };
    const key = this.cacheKey(topic);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.doResearch(topic, key);
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
    const savedFindings =
      Number((this.db.prepare("SELECT COUNT(*) AS c FROM knowledge WHERE title LIKE 'Research:%'").get() as any).c) || 0;
    return {
      enabled: this.enabled,
      cacheTtlMinutes: this.options.cacheTtlMinutes,
      timeoutMs: this.options.timeoutMs,
      saveToKnowledge: this.options.saveToKnowledge,
      sources: this.staticSources().map((s) => ({
        name: s.name,
        host: s.host,
        ...this.breaker.state(s.host),
      })),
      cache: { entries: cacheEntries, hits: this.hits, misses: this.misses, staleServed: this.staleServed },
      savedFindings,
      inFlight: this.inflight.size,
    };
  }

  /** Reset every circuit breaker (and optionally the cache). */
  reset(clearCache = false): { ok: boolean; clearedCache: boolean } {
    this.breaker.resetAll();
    if (clearCache) {
      this.db.prepare("DELETE FROM research_cache").run();
    }
    return { ok: true, clearedCache: clearCache };
  }

  // -- internals --------------------------------------------------------------

  private async doResearch(topic: string, key: string): Promise<ResearchResult> {
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

    // 2) Live lookup inside the hard time budget.
    const deadline = this.now() + this.options.timeoutMs;
    const tried: string[] = [];
    let sawNetworkError = false;
    let attempted = 0;
    let skippedOpenCircuits = 0;

    for (const src of this.rotatedSources()) {
      if (this.now() >= deadline) break;
      tried.push(src.name);
      if (this.breaker.isOpen(src.host)) {
        skippedOpenCircuits++;
        continue;
      }
      attempted++;
      try {
        const finding = await this.trySource(src, topic, deadline);
        if (finding) {
          this.save(key, topic, finding, src.name);
          return { ok: true, finding };
        }
      } catch (e) {
        // fetch-level error (DNS/refused/timeout) — likely offline, never fatal.
        sawNetworkError = true;
        this.breaker.recordFailure(src.host);
        this.log(`research: ${src.name} network error: ${(e as Error).message}`);
      }
    }

    // 3) Internet unreachable? Serve the stale cache instead of nothing.
    if (row) {
      this.staleServed++;
      const finding: ResearchFinding = JSON.parse(row.result);
      return { ok: true, finding: { ...finding, cached: true, stale: true } };
    }

    // Every host either failed at the network level or was already cooling
    // down from earlier failures — treat that as "no internet right now".
    const offline = sawNetworkError || (attempted === 0 && skippedOpenCircuits > 0);
    return { ok: false, offline, triedSources: tried };
  }

  private async trySource(src: SourceInstance, topic: string, deadline: number): Promise<ResearchFinding | null> {
    const check = this.breaker.check(src.host);
    if (!check.allowed) {
      this.log(`research: ${src.name} in cooldown (${Math.round(check.retryInMs / 1000)}s left)`);
      return null;
    }
    const remaining = deadline - this.now();
    if (remaining <= 0) return null;

    // Polite spacing between consecutive requests to different hosts.
    if (this.lastRequestAt > 0) {
      const since = this.now() - this.lastRequestAt;
      if (since < this.options.spacingMs) {
        await sleep(Math.min(this.options.spacingMs - since, remaining));
        if (this.now() >= deadline) return null;
      }
    }
    this.lastRequestAt = this.now();

    const controller = new AbortController();
    // One slow host must never eat the whole budget — give it at most half of
    // what is left, so later sources still get their chance inside the deadline.
    const remainingNow = deadline - this.now();
    const perSourceTimeout = Math.min(2500, Math.max(300, Math.floor(remainingNow / 2)));
    const timer = setTimeout(() => controller.abort(), perSourceTimeout);
    try {
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
        this.breaker.recordFailure(src.host, retryAfter);
        this.log(`research: ${src.name} answered HTTP ${res.status} — circuit opened`);
        return null;
      }
      if (!res.ok) {
        this.breaker.recordFailure(src.host);
        return null;
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
        this.breaker.recordFailure(src.host);
        return null;
      }
      if (parsed.results.length === 0) {
        // Clean, healthy response that simply has no answer for this topic.
        this.breaker.recordSuccess(src.host);
        return null;
      }
      this.breaker.recordSuccess(src.host);
      return {
        topic,
        answer: parsed.answer,
        sources: parsed.results.slice(0, 3),
        sourceHosts: [src.host],
        timestamp: this.now(),
        cached: false,
      };
    } catch (e) {
      if (isAbortError(e)) {
        this.log(`research: ${src.name} timed out (${perSourceTimeout}ms)`);
        this.breaker.recordFailure(src.host);
        return null;
      }
      throw e;
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

    if (this.options.saveToKnowledge) {
      const title = `Research: ${topic.slice(0, 60)}`;
      const content = formatFinding(finding);
      const info = this.db.prepare("INSERT INTO knowledge (title, content) VALUES (?, ?)").run(title, content);
      this.hooks.onKnowledgeSave?.({ id: Number(info.lastInsertRowid), title, content });
    }
  }
}
