/**
 * Language layer — English 🇬🇧 / বাংলা 🇧🇩 / Banglish (Bangla written in Latin).
 * ---------------------------------------------------------------------------
 * MY-AI must understand a user who writes:
 *
 *    "what is the capital of Bangladesh?"      → English
 *    "বাংলাদেশের রাজধানী কী?"                  → Bangla
 *    "Bangladesher rajdhani ki?"               → Banglish
 *    "amar nam ki? tell me please"             → mixed Banglish + English
 *
 * Everything here is offline, dependency-free and deterministic:
 *
 *   • `detectLanguage()`      — which of the three the message is written in
 *   • `banglishToBengali()`   — word-level transliteration using a curated
 *                               dictionary of the ~400 most common Banglish
 *                               words (plus a phonetic fallback for the rest)
 *   • `normalizeForMatch()`   — one canonical Latin form of ANY of the three
 *                               scripts, so a single regex can match all of
 *                               them (this is what powers intents + memory)
 *   • `t()`                   — pick the reply variant for the user's language
 *
 * The point: the rest of the brain (intents, memory, retrieval, research)
 * only ever deals with normalised text, so it works identically in all three.
 */

export type Lang = "en" | "bn" | "banglish";

const BENGALI_RE = /[\u0980-\u09FF]/;
const LATIN_RE = /[A-Za-z]/;

/** How much of the message is written in the Bengali script (0…1). */
export function bengaliRatio(text: string): number {
  const letters = text.match(/[\p{L}]/gu) ?? [];
  if (letters.length === 0) return 0;
  const bengali = letters.filter((c) => BENGALI_RE.test(c)).length;
  return bengali / letters.length;
}

// ---------------------------------------------------------------------------
// Banglish → Bengali dictionary
// ---------------------------------------------------------------------------

/**
 * Curated Banglish → Bengali word map.
 * Keys are lowercase, punctuation-free Latin words. Multiple spellings of the
 * same word (ki / kii / kee) all map to the same Bengali word, because people
 * genuinely type them all.
 */
export const BANGLISH_WORDS: Record<string, string> = {
  // --- question words -------------------------------------------------------
  ki: "কি", kii: "কি", kee: "কি", kie: "কি",
  ke: "কে", kea: "কে", kay: "কে",
  kake: "কাকে", kar: "কার", kara: "কারা", kader: "কাদের",
  keno: "কেন", kano: "কেন", kn: "কেন",
  kivabe: "কীভাবে", kibhabe: "কীভাবে", kemne: "কীভাবে", kmne: "কীভাবে", kemon: "কেমন", kmn: "কেমন",
  kothay: "কোথায়", kothae: "কোথায়", kothai: "কোথায়", kuthay: "কোথায়",
  kobe: "কবে", kokhon: "কখন", kkhn: "কখন",
  koto: "কত", kto: "কত", kotota: "কতটা", kotokhon: "কতক্ষণ", kotodin: "কতদিন",
  kon: "কোন", kono: "কোনো", konta: "কোনটা", kongulo: "কোনগুলো",
  keu: "কেউ", kichu: "কিছু", kichui: "কিছুই",

  // --- pronouns -------------------------------------------------------------
  ami: "আমি", amar: "আমার", amake: "আমাকে", amra: "আমরা", amader: "আমাদের",
  tumi: "তুমি", tomar: "তোমার", tomake: "তোমাকে", tomra: "তোমরা", tomader: "তোমাদের",
  apni: "আপনি", apnar: "আপনার", apnake: "আপনাকে", apnara: "আপনারা",
  tui: "তুই", tor: "তোর", toke: "তোকে",
  se: "সে", tar: "তার", take: "তাকে", tara: "তারা", tader: "তাদের",
  eta: "এটা", ota: "ওটা", eti: "এটি", oti: "ওটি", egulo: "এগুলো", ogulo: "ওগুলো",
  ei: "এই", oi: "ওই", sei: "সেই",
  ekhane: "এখানে", okhane: "ওখানে", sekhane: "সেখানে",
  ekhon: "এখন", tokhon: "তখন", pore: "পরে", age: "আগে",

  // --- verbs / helpers ------------------------------------------------------
  ache: "আছে", achi: "আছি", acho: "আছো", achen: "আছেন", chilo: "ছিল", chilam: "ছিলাম",
  hoy: "হয়", hoye: "হয়ে", hobe: "হবে", holo: "হলো", hoyeche: "হয়েছে", hocche: "হচ্ছে",
  korbo: "করব", koro: "করো", korte: "করতে", kore: "করে", korchi: "করছি", korlam: "করলাম",
  korben: "করবেন", korba: "করবা", kora: "করা",
  bolo: "বলো", bol: "বল", bolte: "বলতে", bole: "বলে", bolbo: "বলব", bolen: "বলেন",
  jani: "জানি", jano: "জানো", janen: "জানেন", jante: "জানতে", janao: "জানাও", jana: "জানা",
  dekho: "দেখো", dekhi: "দেখি", dekhte: "দেখতে", dekha: "দেখা",
  chai: "চাই", chao: "চাও", chan: "চান", lagbe: "লাগবে", lage: "লাগে",
  dao: "দাও", den: "দেন", dite: "দিতে", diye: "দিয়ে",
  nao: "নাও", nite: "নিতে", niye: "নিয়ে",
  jao: "যাও", jabo: "যাব", jai: "যাই", jete: "যেতে",
  asbe: "আসবে", asho: "আসো", esechi: "এসেছি",
  parbo: "পারব", paro: "পারো", paren: "পারেন", pari: "পারি", parbe: "পারবে",
  thako: "থাকো", thaki: "থাকি", thakbe: "থাকবে",
  khai: "খাই", khao: "খাও", kheye: "খেয়ে", khabo: "খাব",
  suru: "শুরু", sesh: "শেষ", shuru: "শুরু", shesh: "শেষ",
  likhe: "লিখে", likho: "লিখো", lekha: "লেখা",
  sikhi: "শিখি", sikhbo: "শিখব", shikha: "শেখা", shikhao: "শেখাও",

  // --- common nouns ---------------------------------------------------------
  nam: "নাম", naam: "নাম", boyos: "বয়স", boyosh: "বয়স",
  bari: "বাড়ি", basha: "বাসা", ghor: "ঘর",
  desh: "দেশ", deshe: "দেশে", desher: "দেশের",
  bangladesh: "বাংলাদেশ", bangladesher: "বাংলাদেশের", bangladeshe: "বাংলাদেশে",
  bangla: "বাংলা", banglar: "বাংলার",
  dhaka: "ঢাকা", dhakay: "ঢাকায়", dhakar: "ঢাকার",
  rajdhani: "রাজধানী", sohor: "শহর", gram: "গ্রাম",
  manush: "মানুষ", chele: "ছেলে", meye: "মেয়ে", bondhu: "বন্ধু",
  baba: "বাবা", ma: "মা", bhai: "ভাই", bon: "বোন", poribar: "পরিবার",
  kaj: "কাজ", chakri: "চাকরি", poralekha: "পড়ালেখা", school: "স্কুল",
  boi: "বই", khabar: "খাবার", bhat: "ভাত", pani: "পানি", cha: "চা",
  taka: "টাকা", somoy: "সময়", din: "দিন", rat: "রাত", shokal: "সকাল", bikel: "বিকেল",
  aj: "আজ", ajke: "আজকে", kal: "কাল", kalke: "কালকে", gotokal: "গতকাল", agamikal: "আগামীকাল",
  bochor: "বছর", mash: "মাস", soptaho: "সপ্তাহ",
  abohawa: "আবহাওয়া", brishti: "বৃষ্টি", rod: "রোদ",
  khela: "খেলা", cricket: "ক্রিকেট", football: "ফুটবল",
  khobor: "খবর", khobar: "খবর", songbad: "সংবাদ", news: "খবর",
  itihas: "ইতিহাস", biggan: "বিজ্ঞান", ganit: "গণিত", prithibi: "পৃথিবী",
  akash: "আকাশ", surjo: "সূর্য", chad: "চাঁদ", nokkhotro: "নক্ষত্র",
  jonmodin: "জন্মদিন", tarikh: "তারিখ", barta: "বার্তা",
  proshno: "প্রশ্ন", uttor: "উত্তর", uttar: "উত্তর",
  totho: "তথ্য", gan: "গান", cinema: "সিনেমা",
  pradhanmontri: "প্রধানমন্ত্রী", rashtropoti: "রাষ্ট্রপতি", sorkar: "সরকার",

  // --- adjectives / adverbs -------------------------------------------------
  bhalo: "ভালো", valo: "ভালো", kharap: "খারাপ", bharap: "খারাপ",
  boro: "বড়", choto: "ছোট", notun: "নতুন", puran: "পুরান", purano: "পুরনো",
  sundor: "সুন্দর", sundar: "সুন্দর", darun: "দারুণ", osadharon: "অসাধারণ",
  onek: "অনেক", beshi: "বেশি", kom: "কম", shob: "সব", sob: "সব", sobai: "সবাই",
  aro: "আরও", arek: "আরেক", aar: "আর", ar: "আর",
  taratari: "তাড়াতাড়ি", aste: "আস্তে", dhire: "ধীরে",
  sotti: "সত্যি", mittha: "মিথ্যা", thik: "ঠিক", tik: "ঠিক", bhul: "ভুল", vul: "ভুল",
  sohoj: "সহজ", kothin: "কঠিন", dorkar: "দরকার", proyojon: "প্রয়োজন",
  sombhob: "সম্ভব", osombhob: "অসম্ভব",

  // --- function words -------------------------------------------------------
  na: "না", nai: "নেই", nei: "নেই", ha: "হ্যাঁ", hya: "হ্যাঁ", hae: "হ্যাঁ",
  jodi: "যদি", tahole: "তাহলে", kintu: "কিন্তু", tobe: "তবে", karon: "কারণ",
  jonno: "জন্য", jonne: "জন্য", theke: "থেকে", porjonto: "পর্যন্ত",
  sathe: "সাথে", soho: "সহ", chara: "ছাড়া", moddhe: "মধ্যে", upore: "উপরে", niche: "নিচে",
  ekta: "একটা", ekti: "একটি", duita: "দুইটা", duti: "দুটি", tinta: "তিনটা",
  onno: "অন্য", nijer: "নিজের", nije: "নিজে",
  matro: "মাত্র", abar: "আবার", tao: "তাও", oboshoi: "অবশ্যই",

  // --- greetings / social ---------------------------------------------------
  salam: "সালাম", assalamualaikum: "আসসালামু আলাইকুম", slamalikum: "আসসালামু আলাইকুম",
  nomoskar: "নমস্কার", adab: "আদাব",
  dhonnobad: "ধন্যবাদ", dhonnbad: "ধন্যবাদ", donnobad: "ধন্যবাদ", shukriya: "শুকরিয়া",
  sorry: "দুঃখিত", dukkhito: "দুঃখিত",
  bidae: "বিদায়", tata: "টাটা",
  bhalobasi: "ভালোবাসি", valobasi: "ভালোবাসি", pochondo: "পছন্দ", posondo: "পছন্দ",
  mone: "মনে", rakho: "রাখো", mnre: "মনে",
};

/** Rough phonetic fallback for Banglish words that are not in the dictionary. */
const PHONETIC_RULES: [RegExp, string][] = [
  [/kh/g, "খ"], [/gh/g, "ঘ"], [/ch/g, "চ"], [/jh/g, "ঝ"],
  [/th/g, "থ"], [/dh/g, "ধ"], [/ph/g, "ফ"], [/bh/g, "ভ"], [/sh/g, "শ"],
  [/aa/g, "আ"], [/ee/g, "ঈ"], [/oo/g, "ু"],
];

/**
 * A Latin word "looks Banglish" when it is not an ordinary English word but
 * has Bangla-typical letter clusters / endings.
 */
const BANGLISH_HINTS = /(?:^|[^a-z])(?:ki|ke|keno|kobe|kothay|kivabe|kemon|ami|amar|tumi|tomar|apni|ache|hobe|korbo|kore|bolo|jani|nam|bhalo|valo|onek|khub|dhonnobad|kemon)(?:[^a-z]|$)/;

/** English words that also appear in the Banglish dictionary — never a signal. */
const AMBIGUOUS = new Set(["ma", "na", "ha", "ke", "ki", "se", "ache", "tara", "kal", "din", "boi", "cha", "news", "school", "cricket", "football", "sorry", "gram"]);

/**
 * Detect whether a message is Bangla script, Banglish (Bangla in Latin) or
 * plain English. Mixed messages resolve to whichever side dominates.
 */
export function detectLanguage(text: string): Lang {
  const t = (text || "").trim();
  if (!t) return "en";

  const ratio = bengaliRatio(t);
  if (ratio >= 0.35) return "bn";

  if (!LATIN_RE.test(t)) return ratio > 0 ? "bn" : "en";

  const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return "en";

  let banglishHits = 0;
  for (const w of words) {
    if (AMBIGUOUS.has(w)) continue;
    if (BANGLISH_WORDS[w]) banglishHits++;
  }

  const score = banglishHits / words.length;
  // Two solid Banglish words, or a third of the message, or a clear cluster.
  if (banglishHits >= 2 || score >= 0.34 || (banglishHits >= 1 && BANGLISH_HINTS.test(" " + t.toLowerCase() + " "))) {
    return "banglish";
  }
  return ratio > 0.1 ? "bn" : "en";
}

/** Transliterate ONE Banglish word (dictionary first, phonetics as fallback). */
export function banglishWord(word: string, phonetic = false): string | null {
  const w = word.toLowerCase();
  const direct = BANGLISH_WORDS[w];
  if (direct) return direct;
  if (!phonetic || w.length < 3) return null;
  let out = w;
  for (const [re, rep] of PHONETIC_RULES) out = out.replace(re, rep);
  return out === w ? null : out;
}

/**
 * Rewrite a Banglish sentence into Bengali script. Words that are not in the
 * dictionary are kept as-is — this is deliberately conservative, because a
 * wrong transliteration hurts search more than an untranslated word.
 */
export function banglishToBengali(text: string): string {
  return (text || "").replace(/[A-Za-z]+/g, (w) => banglishWord(w) ?? w);
}

/**
 * Bengali → Latin overrides. Several Bengali spellings mean the same thing
 * ("কি"/"কী", "ভালো"/"ভাল"), and matching must fold them onto ONE token.
 */
const REVERSE_OVERRIDES: Record<string, string> = {
  "কী": "ki", "কি": "ki", "কে": "ke", "কেন": "keno", "কীভাবে": "kivabe",
  "কিভাবে": "kivabe", "কোথায়": "kothay", "কখন": "kokhon", "কবে": "kobe",
  "কত": "koto", "কার": "kar", "কাকে": "kake", "কেমন": "kemon",
  "আমার": "amar", "আমি": "ami", "আমাকে": "amake", "আমরা": "amra",
  "তোমার": "tomar", "তুমি": "tumi", "আপনি": "apni", "আপনার": "apnar",
  "নাম": "nam", "ভালো": "bhalo", "ভাল": "bhalo", "খারাপ": "kharap",
  "ধন্যবাদ": "dhonnobad", "আছে": "ache", "আছো": "acho", "আছেন": "achen",
  "হবে": "hobe", "সময়": "somoy", "খবর": "khobor", "আবহাওয়া": "abohawa",
  "মনে": "mone", "রাখো": "rakho", "পছন্দ": "pochondo", "সম্পর্কে": "somporke",
  "জান": "jani", "জানো": "jani", "জানেন": "jani", "বল": "bolo", "বলো": "bolo",
  "সাহায্য": "help", "তারিখ": "tarikh", "আজ": "aj", "আজকে": "aj",
  // greetings & farewells
  "হাই": "hi", "হ্যালো": "hello", "হেলো": "hello",
  "আসসালামু": "assalamualaikum", "আলাইকুম": "alaikum", "সালাম": "salam",
  "নমস্কার": "nomoskar", "আদাব": "adab",
  "বিদায়": "bidae", "আল্লাহ": "allah", "হাফেজ": "hafez", "খোদা": "khoda",
  // misc high-traffic words
  "কয়টা": "koyta", "বাজে": "baje", "বাংলা": "bangla", "বাংলাদেশ": "bangladesh",
  "বুঝো": "bujho", "বুঝেন": "bujho", "বুঝি": "bujhi", "ভুলে": "bhule",
  "প্রশ্ন": "proshno", "উত্তর": "uttor", "সব": "shob", "সবকিছু": "shob",
  "ইতিহাস": "itihas", "রাজধানী": "rajdhani", "প্রধানমন্ত্রী": "pradhanmontri",
};

/** Reverse map (Bengali → Banglish) built once from the dictionary. */
const BENGALI_TO_LATIN: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [latin, bengali] of Object.entries(BANGLISH_WORDS)) {
    // First spelling wins — the dictionary lists the canonical one first.
    if (!map[bengali]) map[bengali] = latin;
  }
  return { ...map, ...REVERSE_OVERRIDES };
})();

/** Rewrite a Bengali sentence into its Banglish (Latin) form where possible. */
export function bengaliToBanglish(text: string): string {
  return (text || "").replace(/[\u0980-\u09FF]+/g, (w) => BENGALI_TO_LATIN[w] ?? w);
}

/**
 * ONE canonical lowercase Latin form for any of the three languages.
 *
 *   "আমার নাম কী"          → "amar nam ki"
 *   "Amar naam ki?"        → "amar nam ki"
 *   "what is my name?"     → "what is my name"
 *
 * Intents and memory rules match against this, so a single pattern covers
 * English, Bangla and Banglish at once.
 */
export function normalizeForMatch(text: string): string {
  let t = (text || "").toLowerCase().trim();
  // Bengali → Latin so one pattern can match every script.
  t = t.replace(/[\u0980-\u09FF]+/g, (w) => BENGALI_TO_LATIN[w] ?? w);
  // Canonicalise the many Banglish spellings to their first dictionary form.
  t = t.replace(/[a-z]+/g, (w) => {
    const bengali = BANGLISH_WORDS[w];
    if (!bengali) return w;
    return BENGALI_TO_LATIN[bengali] ?? w;
  });
  // Drop punctuation, collapse whitespace. \p{M} keeps Bengali vowel signs and
  // the hasanta attached to their letters (সর্বশেষ must stay ONE word).
  return t.replace(/[^\p{L}\p{N}\p{M}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Every useful spelling of a message — used to widen search + matching. */
export function languageVariants(text: string): string[] {
  const raw = (text || "").trim();
  const out = new Set<string>();
  if (raw) out.add(raw);
  const lang = detectLanguage(raw);
  if (lang === "banglish") {
    const bn = banglishToBengali(raw);
    if (bn && bn !== raw) out.add(bn);
  }
  if (lang === "bn") {
    const latin = bengaliToBanglish(raw);
    if (latin && latin !== raw) out.add(latin);
  }
  const norm = normalizeForMatch(raw);
  if (norm && norm !== raw.toLowerCase()) out.add(norm);
  return [...out];
}

// ---------------------------------------------------------------------------
// Reply localisation
// ---------------------------------------------------------------------------

export interface Localized {
  en: string;
  bn: string;
  /** Optional Banglish variant — falls back to `bn` when omitted. */
  banglish?: string;
}

/** Pick the reply text that matches the language the user wrote in. */
export function t(lang: Lang, text: Localized): string {
  if (lang === "bn") return text.bn;
  if (lang === "banglish") return text.banglish ?? text.bn;
  return text.en;
}

/** Convenience: detect + localise in one call. */
export function reply(input: string, text: Localized): string {
  return t(detectLanguage(input), text);
}
