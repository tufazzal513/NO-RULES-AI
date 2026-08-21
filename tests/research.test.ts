/**
 * Automated tests for the online research layer.
 * -----------------------------------------------
 * Run with:  npm test
 *
 * EVERY network call is mocked through an injected fake `fetch` — the keyless
 * sources (Wikipedia, DuckDuckGo, SearXNG, Mojeek, Wiktionary, Marginalia…)
 * are never contacted for real, so the whole suite runs without internet
 * access.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryDatabase, SNAPSHOT_TABLES } from "../server/db.ts";
import { buildSnapshot } from "../server/snapshot.ts";
import { AIEngine } from "../server/ai/engine.ts";
import {
  ResearchService,
  forcedResearchTopic,
  isResearchQuestion,
  parseRetryAfterMs,
  type ResearchHooks,
  type ResearchOptions,
} from "../server/research/research.ts";
import { CircuitBreaker, MAX_BACKOFF_MS, MIN_BACKOFF_MS } from "../server/research/circuit.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fake network
// ---------------------------------------------------------------------------

interface FakeCall {
  url: string;
  ua: string;
  at: number;
}

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: FakeCall[] = [];
  const start = Date.now();
  const fn = async (input: any, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, ua: headers["user-agent"] ?? "", at: Date.now() - start });
    return handler(url, init);
  };
  return { fn: fn as typeof fetch, calls };
}

const json = (obj: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(obj), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

const wikiJson = () =>
  json({
    query: {
      search: [
        {
          title: "Alan Turing",
          snippet:
            "<span class='searchmatch'>Alan Turing</span> was a British mathematician and computer scientist who formalised the concepts of algorithm and computation.",
        },
      ],
    },
  });

const instantJson = () =>
  json({
    Heading: "Alan Turing",
    AbstractURL: "https://duckduckgo.com/Alan_Turing",
    AbstractText: "Alan Turing was an English mathematician and computer scientist.",
  });

const searxJson = (title: string) =>
  json({
    results: [
      { title, url: `https://example.org/${title.replace(/ /g, "_")}`, content: `${title} — a helpful summary.` },
    ],
  });

/** Every request fails at the network level (the "no internet" simulation). */
const offlineHandler: Handler = () => Promise.reject(new TypeError("fetch failed"));

/** Wikipedia answers, everything else fails. */
const wikiOnlyHandler: Handler = (url) =>
  url.includes("en.wikipedia.org") ? Promise.resolve(wikiJson()) : Promise.reject(new TypeError("fetch failed"));

interface Rig {
  service: ResearchService;
  calls: FakeCall[];
  db: any;
  failNow: { value: boolean };
}

function makeRig(opts: Partial<ResearchOptions> = {}, hooks: ResearchHooks = {}, handler?: Handler): Rig {
  const db = createMemoryDatabase();
  const failNow = { value: false };
  const active: Handler = handler ?? ((url) => (failNow.value ? offlineHandler(url) : wikiOnlyHandler(url)));
  const { fn, calls } = fakeFetch(active);
  const service = new ResearchService(
    db,
    {
      enabled: true,
      cacheTtlMinutes: 360,
      timeoutMs: 4000,
      saveToKnowledge: true,
      ...opts,
      fetchImpl: fn,
    },
    hooks
  );
  return { service, calls, db, failNow };
}

const wikiRig = () => makeRig({ spacingMs: 0 }, {}, (url) => Promise.resolve(wikiJson()));

// ---------------------------------------------------------------------------
// 1–2. Question detection (English + Bengali)
// ---------------------------------------------------------------------------

test("question detection recognises English and Bengali question words", () => {
  assert.equal(isResearchQuestion("who is alan turing"), true);
  assert.equal(isResearchQuestion("what is the capital of france"), true);
  assert.equal(isResearchQuestion("কেন আকাশ নীল"), true, "কেন (why)");
  assert.equal(isResearchQuestion("কে বাংলাদেশের রাষ্ট্রপতি"), true, "কে (who)");
  assert.equal(isResearchQuestion("কীভাবে ভাত রান্না করব"), true, "কীভাবে (how)");
  assert.equal(isResearchQuestion("hello"), false);
  assert.equal(isResearchQuestion("2 + 2"), false);
  assert.equal(isResearchQuestion("My name is Tufazzal"), false);
});

test("question marks and newsy keywords also trigger research", () => {
  assert.equal(isResearchQuestion("tell me something?"), true);
  assert.equal(isResearchQuestion("সর্বশেষ ক্রিকেট খবর"), true);
  assert.equal(isResearchQuestion("latest iphone news"), true);
  assert.equal(isResearchQuestion("আজকের আবহাওয়া কেমন"), true);
  assert.equal(isResearchQuestion("just chatting with you"), false);
});

// ---------------------------------------------------------------------------
// 3–5. Engine integration
// ---------------------------------------------------------------------------

test("forced /research extracts the topic and researches non-question text", async () => {
  assert.equal(forcedResearchTopic("/research alan turing"), "alan turing");
  assert.equal(forcedResearchTopic("/search  weather in dhaka"), "weather in dhaka");
  assert.equal(forcedResearchTopic("just chatting"), null);

  const { db, service, calls } = wikiRig();
  const engine = new AIEngine(db, {}, service);
  const r = await engine.replyAsync("/research alan turing");
  assert.equal(r.mode, "research");
  assert.match(r.reply, /Alan Turing/);
  assert.ok(calls.length >= 1, "a forced research must hit the network");
});

test("the local brain answers math and memory without touching the network", async () => {
  const { db, service, calls } = wikiRig();
  db.prepare("INSERT INTO memory (key, value) VALUES ('name', 'Tufazzal')").run();
  const engine = new AIEngine(db, {}, service);

  const math = await engine.replyAsync("12 * 8 + 4");
  assert.equal(math.reply, "The result is 100.");
  assert.equal(math.mode, "intent");

  const mem = await engine.replyAsync("what is my name");
  assert.equal(mem.mode, "memory");
  assert.match(mem.reply, /Tufazzal/);

  assert.equal(calls.length, 0, "the brain must not go online for these");
});

test("a question is researched online and saved as a knowledge document", async () => {
  let mirrored: { id: number; title: string; content: string } | null = null;
  const { db, service } = makeRig(
    { spacingMs: 0 },
    { onKnowledgeSave: (row) => (mirrored = row) },
    (url) => Promise.resolve(wikiJson())
  );
  const engine = new AIEngine(db, {}, service);

  const r = await engine.replyAsync("who is alan turing");
  assert.equal(r.mode, "research");
  assert.match(r.reply, /Alan Turing/);

  const row = db.prepare("SELECT * FROM knowledge WHERE title LIKE 'Research:%'").get() as any;
  assert.ok(row, "the finding must be saved into knowledge");
  assert.match(row.content, /Alan Turing/);
  assert.ok(mirrored, "the knowledge hook (Telegram mirror) must fire");
  assert.equal(mirrored!.id, row.id);
});

// ---------------------------------------------------------------------------
// 6–9. Cache behaviour
// ---------------------------------------------------------------------------

test("a cached finding answers instantly with zero network calls", async () => {
  const { db, service, calls } = wikiRig();

  const r1 = await service.research("who is alan turing");
  assert.equal(r1.ok, true);
  assert.equal(r1.finding!.cached, false);

  const callsAfterFirst = calls.length;
  const r2 = await service.research("WHO IS ALAN TURING"); // same topic, different case
  assert.equal(r2.ok, true);
  assert.equal(r2.finding!.cached, true, "second lookup must come from the permanent cache");
  assert.equal(calls.length, callsAfterFirst, "no new network calls for a cached topic");

  const st = service.status();
  assert.equal(st.cache.entries, 1);
  assert.equal(st.cache.hits, 1);
  assert.equal(st.cache.misses, 1);
});

test("a stale cache is served when the internet is unreachable", async () => {
  const { service, calls, failNow } = makeRig({ cacheTtlMinutes: 0.0001, spacingMs: 0 });
  const r1 = await service.research("who is alan turing");
  assert.equal(r1.ok, true);

  await sleep(25); // cache TTL (6ms) has expired by now
  failNow.value = true;

  const r2 = await service.research("who is alan turing");
  assert.equal(r2.ok, true);
  assert.equal(r2.finding!.stale, true, "expired cache must fall back when offline");
  assert.match(r2.finding!.answer, /Alan Turing/);
  assert.ok(calls.length > 0, "it did try the network first");
  assert.equal(service.status().cache.staleServed, 1);
});

test("offline research fails gracefully instead of throwing", async () => {
  const { db, service } = makeRig({ spacingMs: 0 }, {}, offlineHandler);
  const direct = await service.research("who is alan turing");
  assert.equal(direct.ok, false);
  assert.equal(direct.offline, true);
  assert.ok((direct.triedSources ?? []).length > 0);

  const engine = new AIEngine(db, {}, service);
  const chat = await engine.replyAsync("who is alan turing");
  assert.equal(chat.mode, "research");
  assert.match(chat.reply, /couldn't reach the internet/);
});

test("the hard time budget aborts a hanging source and still answers", async () => {
  const { service } = makeRig(
    { timeoutMs: 900, spacingMs: 0 },
    {},
    (url, init) => {
      if (url.includes("api.duckduckgo.com")) {
        // Hangs forever unless aborted by the deadline.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          );
        });
      }
      return Promise.resolve(wikiJson());
    }
  );

  const t0 = Date.now();
  const r = await service.research("who is alan turing");
  const elapsed = Date.now() - t0;

  assert.equal(r.ok, true);
  assert.match(r.finding!.answer, /Alan Turing/);
  assert.ok(elapsed < 900 + 300, `whole call took ${elapsed}ms — budget must hold`);
});

// ---------------------------------------------------------------------------
// 10–13. Circuit breaker behaviour
// ---------------------------------------------------------------------------

test("an open circuit skips a rate-limited host on the next call", async () => {
  let ddgBroken = true;
  let everythingBroken = false;
  const { service, calls } = makeRig(
    { spacingMs: 0 },
    {},
    (url) => {
      if (url.includes("api.duckduckgo.com") && ddgBroken) {
        return Promise.resolve(new Response("busy", { status: 503 }));
      }
      if (everythingBroken) return offlineHandler(url);
      return Promise.resolve(wikiJson());
    }
  );
  const ddgCalls = () => calls.filter((c) => c.url.includes("api.duckduckgo.com")).length;

  const r1 = await service.research("who is alan turing");
  assert.equal(r1.ok, true, "other sources must answer while one host is down");
  assert.equal(ddgCalls(), 1);

  ddgBroken = false;
  everythingBroken = true;
  const r2 = await service.research("another topic");
  assert.equal(r2.ok, false);
  assert.equal(ddgCalls(), 1, "the broken host must be skipped without a new request");
});

test("circuit backoff doubles from 1 minute up to a 15 minute cap, honouring Retry-After", () => {
  const clock = { now: 0 };
  const breaker = new CircuitBreaker(() => clock.now);

  const expect = (ms: number, msg: string) => {
    const s = breaker.state("host");
    assert.equal(s.ready, false, msg);
    assert.ok(Math.abs(s.cooldownRemainingMs - ms) < 5, `${msg}: got ${s.cooldownRemainingMs}, want ~${ms}`);
  };

  breaker.recordFailure("host");
  expect(MIN_BACKOFF_MS, "1st failure → 1 minute");
  breaker.recordFailure("host");
  expect(2 * MIN_BACKOFF_MS, "2nd failure → 2 minutes");
  breaker.recordFailure("host");
  expect(4 * MIN_BACKOFF_MS, "3rd failure → 4 minutes");
  breaker.recordFailure("host");
  expect(8 * MIN_BACKOFF_MS, "4th failure → 8 minutes");
  breaker.recordFailure("host");
  expect(MAX_BACKOFF_MS, "5th failure → capped at 15 minutes");
  breaker.recordFailure("host");
  expect(MAX_BACKOFF_MS, "cap stays at 15 minutes");
  breaker.recordFailure("host", 20 * 60_000);
  expect(20 * 60_000, "an explicit Retry-After overrides the backoff");
});

test("a 429 response with Retry-After opens the circuit for at least that long", async () => {
  const { service } = makeRig(
    { spacingMs: 0 },
    {},
    (url) => {
      if (url.includes("api.duckduckgo.com")) {
        return Promise.resolve(new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }));
      }
      return offlineHandler(url);
    }
  );
  assert.equal(parseRetryAfterMs("120"), 120_000);

  await service.research("who is alan turing");
  const ddg = service.status().sources.find((s) => s.host === "api.duckduckgo.com")!;
  assert.equal(ddg.ready, false);
  assert.ok(ddg.cooldownRemainingMs >= 118_000, `cooldown ${ddg.cooldownRemainingMs}ms must honour Retry-After`);
  assert.equal(ddg.lastRetryAfterMs, 120_000);
});

test("Reset Cooldowns reopens every circuit and can clear the cache too", async () => {
  // Phase 1: everything fails → circuits open.
  const offline = makeRig({ spacingMs: 0 }, {}, offlineHandler);
  await offline.service.research("who is alan turing");
  let st = offline.service.status();
  assert.ok(st.sources.some((s) => !s.ready), "failing hosts must be in cooldown");

  offline.service.reset();
  st = offline.service.status();
  assert.ok(st.sources.every((s) => s.ready), "reset must reopen every circuit");

  // Phase 2: a finding fills the permanent cache; reset(true) wipes it.
  const rig = wikiRig();
  await rig.service.research("who is alan turing");
  assert.equal(rig.service.status().cache.entries, 1);

  rig.service.reset(true);
  assert.equal(rig.service.status().cache.entries, 0);
});

// ---------------------------------------------------------------------------
// 14–17. Rate-limit countermeasures
// ---------------------------------------------------------------------------

test("six rotating browser User-Agents spread the load", async () => {
  const { service, calls } = makeRig({ spacingMs: 0 }, {}, offlineHandler);
  // With fast offline detection each call stops after 2 network errors, so
  // make several calls — the UA must rotate on every single request.
  for (let i = 0; i < 4; i++) {
    await service.research(`user agent rotation test ${i}`);
  }

  const uas = new Set(calls.map((c) => c.ua));
  assert.ok(calls.length >= 6, `made ${calls.length} requests`);
  assert.ok(uas.size >= 6, `expected >= 6 distinct User-Agents, saw ${uas.size}`);
  for (const ua of uas) assert.match(ua, /Mozilla\/5\.0/);
});

test("polite spacing keeps a minimum gap between consecutive requests", async () => {
  const { service, calls } = makeRig({ spacingMs: 40 }, {}, offlineHandler);
  await service.research("polite spacing test");

  assert.ok(calls.length >= 2, "expected several requests");
  for (let i = 1; i < calls.length; i++) {
    const gap = calls[i].at - calls[i - 1].at;
    assert.ok(gap >= 39, `gap between request ${i} and ${i + 1} was only ${gap}ms`);
  }
});

test("SearXNG public instances rotate between calls", async () => {
  let hit = 0;
  const cleanEmpty = () => Promise.resolve(new Response("", { status: 200 }));
  const { service } = makeRig(
    { spacingMs: 0 },
    {},
    (url) => {
      if (/searx|paulgo|inetol|baresearch|tiekoetter|priv\.au|opnxng|hbubli/.test(url)) {
        hit++;
        return Promise.resolve(searxJson(`SearXNG hit ${hit}`));
      }
      return cleanEmpty();
    }
  );

  const r1 = await service.research("topic one");
  const r2 = await service.research("topic two");
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.finding!.sourceHosts[0], r2.finding!.sourceHosts[0], "instances must rotate per call");
  assert.match(r1.finding!.answer, /SearXNG hit 1/);
  assert.match(r2.finding!.answer, /SearXNG hit 2/);
});

test("concurrent requests for the same topic share one in-flight lookup", async () => {
  let networkCalls = 0;
  const { service } = makeRig(
    { spacingMs: 0 },
    {},
    (url) => {
      networkCalls++;
      return new Promise((resolve) => setTimeout(() => resolve(instantJson()), 30));
    }
  );

  const [a, b] = await Promise.all([service.research("same topic"), service.research("same topic")]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.finding, b.finding, "both callers must receive the same finding");
  assert.equal(networkCalls, 1, "de-duplication must collapse identical lookups into one request");
});

// ---------------------------------------------------------------------------
// 18–19. Environment flags
// ---------------------------------------------------------------------------

test("RESEARCH_ENABLED=false keeps the AI fully offline", async () => {
  const { db, service, calls } = makeRig({ enabled: false }, {}, offlineHandler);
  const engine = new AIEngine(db, {}, service);

  const r = await engine.replyAsync("who is alan turing");
  assert.equal(r.mode, "fallback");
  assert.equal(calls.length, 0, "no network with research disabled");

  const direct = await service.research("who is alan turing");
  assert.equal(direct.ok, false);
});

test("RESEARCH_SAVE_TO_KNOWLEDGE=false keeps findings in the cache only", async () => {
  const { db, service } = makeRig({ saveToKnowledge: false, spacingMs: 0 }, {}, (url) => Promise.resolve(wikiJson()));
  const r = await service.research("who is alan turing");
  assert.equal(r.ok, true);

  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM knowledge").get() as any).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM research_cache").get() as any).c, 1);
});

// ---------------------------------------------------------------------------
// 20–21. Persistence across restarts / offline answering
// ---------------------------------------------------------------------------

test("the research cache rides along in the Telegram snapshot", async () => {
  const { db, service } = wikiRig();
  await service.research("who is alan turing");

  assert.ok(SNAPSHOT_TABLES.includes("research_cache"), "research_cache must be a snapshot table");
  const doc = buildSnapshot(db);
  assert.ok(Array.isArray(doc.data.research_cache));
  assert.equal(doc.data.research_cache.length, 1, "cache rows survive in the snapshot");
  assert.equal(doc.meta.counts.research_cache, 1);
});

test("a saved finding answers the same question offline later", async () => {
  const db = createMemoryDatabase();

  // Online phase: ask once, finding lands in knowledge + cache.
  const { fn, calls } = fakeFetch((url) => Promise.resolve(wikiJson()));
  const online = new ResearchService(db, { enabled: true, cacheTtlMinutes: 360, timeoutMs: 4000, saveToKnowledge: true, fetchImpl: fn });
  const engine1 = new AIEngine(db, {}, online);
  const r1 = await engine1.replyAsync("who is alan turing");
  assert.equal(r1.mode, "research");
  assert.ok(calls.length > 0);

  // Offline phase (new container, internet gone): the brain answers alone.
  const { fn: deadFn } = fakeFetch(offlineHandler);
  const offline = new ResearchService(db, {
    enabled: true,
    cacheTtlMinutes: 360,
    timeoutMs: 1000,
    saveToKnowledge: false,
    fetchImpl: deadFn,
  });
  const engine2 = new AIEngine(db, {}, offline);
  const r2 = await engine2.replyAsync("who is alan turing");
  assert.equal(r2.mode, "knowledge");
  assert.match(r2.reply, /Alan Turing/);
});

// ---------------------------------------------------------------------------
// 22–27. Hardening: negative cache, attempt cap, rate cap, Bengali, fast fail
// ---------------------------------------------------------------------------

const cleanEmpty = () => Promise.resolve(new Response("", { status: 200 }));

test("a clean no-answer topic is remembered (negative cache) so sources are not hammered again", async () => {
  const { service, calls } = makeRig({ spacingMs: 0 }, {}, cleanEmpty);

  const r1 = await service.research("totally unknown topic xyz");
  assert.equal(r1.ok, false);
  assert.equal(r1.offline, false, "sources answered HTTP 200 — this is not offline");
  assert.ok(calls.length > 0);

  const afterFirst = calls.length;
  const r2 = await service.research("totally unknown topic xyz");
  assert.equal(r2.ok, false);
  assert.equal(r2.negative, true, "second lookup must come from the negative cache");
  assert.equal(calls.length, afterFirst, "no new network calls for a recently-failed topic");
  assert.equal(service.status().cache.negativeEntries, 1);
});

test("a successful finding clears the negative-cache entry for its topic", async () => {
  let mode = "empty" as "empty" | "wiki";
  const { service } = makeRig({ spacingMs: 0 }, {}, () =>
    mode === "wiki" ? Promise.resolve(wikiJson()) : cleanEmpty()
  );

  await service.research("who is alan turing");
  assert.equal(service.status().cache.negativeEntries, 1);

  // The internet "recovers" and the sources are allowed to answer again.
  // A forced lookup (/research) bypasses the negative cache and finds the answer.
  service.reset();
  mode = "wiki";
  const r = await service.research("who is alan turing", { force: true });
  assert.equal(r.ok, true);
  assert.equal(service.status().cache.negativeEntries, 0, "finding must clear the negative cache");
});

test("maxAttempts caps how many sources one call may touch", async () => {
  const { service, calls } = makeRig({ spacingMs: 0, maxAttempts: 3 }, {}, cleanEmpty);
  const r = await service.research("attempt cap test");
  assert.equal(r.ok, false);
  assert.equal(calls.length, 3, "exactly maxAttempts requests — never the whole source list");
});

test("the global per-minute request cap stops requests instead of risking blocks", async () => {
  const { service, calls } = makeRig({ spacingMs: 0, maxRequestsPerMinute: 4 }, {}, cleanEmpty);

  await service.research("cap test one");
  assert.equal(calls.length, 4, "first call stops at the cap");

  const r2 = await service.research("cap test two");
  assert.equal(r2.ok, false);
  assert.equal(r2.rateLimited, true, "second call must be refused while the minute window is full");
  assert.equal(calls.length, 4, "no extra network requests");
  assert.equal(service.status().requestsLastMinute, 4);
});

test("Bengali Wikipedia answers a Bengali question", async () => {
  const { service } = makeRig(
    { spacingMs: 0 },
    {},
    (url) => (url.includes("bn.wikipedia.org") ? Promise.resolve(wikiJson()) : cleanEmpty())
  );

  const r = await service.research("বাংলাদেশের রাজধানী কী");
  assert.equal(r.ok, true);
  assert.equal(r.finding!.sourceHosts[0], "bn.wikipedia.org");
  assert.match(r.finding!.answer, /Alan Turing/);
});

test("two consecutive network errors with no HTTP response stop the call early (fast offline detection)", async () => {
  let rejects = 0;
  const { service, calls } = makeRig(
    { spacingMs: 0, offlineFailFastAfter: 2 },
    {},
    (url) => {
      rejects++;
      return offlineHandler(url);
    }
  );
  const t0 = Date.now();
  const r = await service.research("fast offline test");
  const elapsed = Date.now() - t0;

  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
  assert.equal(calls.length, 2, "must stop right after the fail-fast threshold");
  assert.equal(rejects, 2);
  assert.ok(elapsed < 2000, `took ${elapsed}ms — an offline machine must fail fast`);
});

test("a transient network error is retried once when the internet is known to be up", async () => {
  let wikiFails = 1; // Wikipedia hiccups once, then recovers.
  const { service } = makeRig(
    { spacingMs: 0 },
    {},
    (url) => {
      if (url.includes("api.duckduckgo.com")) {
        return Promise.resolve(new Response("", { status: 200 })); // healthy, no answer
      }
      if (url.includes("en.wikipedia.org") && wikiFails > 0) {
        wikiFails--;
        return offlineHandler(url);
      }
      return Promise.resolve(wikiJson());
    }
  );

  const r = await service.research("who is alan turing");
  assert.equal(r.ok, true);
  assert.match(r.finding!.answer, /Alan Turing/);
  assert.equal(wikiFails, 0, "the retry must actually happen");
});
