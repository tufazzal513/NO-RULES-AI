/**
 * Built-in conversation + language corpus.
 * Loaded once per database (idempotent via sync_state.seed_version) so a
 * fresh Render deploy already knows how to greet and answer simple
 * English / বাংলা / Banglish chat.
 */

import { getSyncState, setSyncState } from "./db.ts";
import { applyIngest, planIngest } from "./ingest.ts";

export const SEED_VERSION = "2";

const QA = (user: string, ai: string) => `User: ${user}\nAI: ${ai}`;

function greetings(): string {
  return [
    QA("hello", "Hello! I'm your personal AI. How can I help you today?"),
    QA("hi", "Hi! I'm here. Ask me anything in English, বাংলা or Banglish."),
    QA("hey", "Hey! What's on your mind?"),
    QA("good morning", "Good morning! Hope you have a calm, useful day."),
    QA("good night", "Good night. Rest well — I'll be here when you come back."),
    QA("how are you", "I'm doing well — running on your own server, no company API. How are you?"),
    QA("who are you", "I'm MY-AI, your self-hosted personal assistant. I live on your machine and Telegram cloud."),
    QA("thank you", "You're welcome. Anytime."),
    QA("thanks", "Glad I could help."),
    QA("ok", "Okay. Tell me what you need next."),
    QA("হাই", "আসসালামু আলাইকুম! আমি আপনার নিজের AI। কী সাহায্য করতে পারি?"),
    QA("হ্যালো", "হ্যালো! আমি এখানে আছি। বাংলা, ইংরেজি বা Banglish — যেভাবে খুশি লিখুন।"),
    QA("কেমন আছো", "ভালো আছি, ধন্যবাদ। আপনি কেমন আছেন?"),
    QA("কেমন আছেন", "আমি ভালো আছি। আপনার কী জানার আছে?"),
    QA("তুমি কে", "আমি MY-AI — আপনার নিজের সার্ভারে চলা পার্সোনাল অ্যাসিস্ট্যান্ট। কোনো কোম্পানির API নই।"),
    QA("ধন্যবাদ", "আপনাকেও ধন্যবাদ। আর কিছু লাগলে বলুন।"),
    QA("শুভ সকাল", "শুভ সকাল! আজকের দিনটা ভালো কাটুক।"),
    QA("শুভ রাত্রি", "শুভ রাত্রি। আরাম করে ঘুমান।"),
    QA("assalamualaikum", "Wa alaikum assalam. Ami apnar nijer AI. Kemon achhen?"),
    QA("kemon acho", "Bhalo achi. Apni kemon acho?"),
    QA("tumi ke", "Ami MY-AI — apnar nijer server e choli. Company r API noi."),
    QA("dhonnobad", "Welcome. Aro kichu lagle bolun."),
    QA("hi kemon acho", "Bhalo achi! Apni kemon?"),
    QA("hello kemon aso", "I'm good. You can write Banglish, Bangla or English — I follow your language."),
  ].join("\n\n");
}

function bangladesh(): string {
  return [
    QA("what is the capital of Bangladesh", "Dhaka is the capital of Bangladesh."),
    QA("বাংলাদেশের রাজধানী কী", "বাংলাদেশের রাজধানী ঢাকা।"),
    QA("bangladesher rajdhani ki", "Bangladesher rajdhani Dhaka."),
    QA("who is the prime minister of Bangladesh", "I may not have the very latest name cached. Ask again with /research if you need a live lookup. Historically Sheikh Hasina led for many years; always verify current office-holders."),
    QA("বাংলাদেশের ভাষা কী", "বাংলাদেশের রাষ্ট্রভাষা বাংলা। ইংরেজিও ব্যাপকভাবে ব্যবহৃত হয়।"),
    QA("bangladesher vasha ki", "Rashtrobhasha Bangla. English o onek kaj e use hoy."),
    QA("what currency does Bangladesh use", "Bangladesh uses the Taka (BDT, ৳)."),
    QA("বাংলাদেশের মুদ্রা কী", "বাংলাদেশের মুদ্রা টাকা (BDT)।"),
    QA("where is cox's bazar", "Cox's Bazar is in south-east Bangladesh, famous for one of the world's longest natural sea beaches."),
    QA("কক্সবাজার কোথায়", "কক্সবাজার বাংলাদেশের দক্ষিণ-পূর্বে, বিশ্বের অন্যতম দীর্ঘ সমুদ্র সৈকতের জন্য বিখ্যাত।"),
    QA("sundarban ki", "Sundarban holo world er sobcheye boro mangrove forest — Bangladesh o India te. Royal Bengal Tiger er bas."),
    QA("সুন্দরবন কী", "সুন্দরবন পৃথিবীর সবচেয়ে বড় ম্যানগ্রোভ বন। বাংলাদেশ ও ভারতে বিস্তৃত। রয়েল বেঙ্গল টাইগারের বাস এখানে।"),
    QA("padma setu", "Padma Bridge (Padma Setu) connects Munshiganj with Shariatpur/Madaripur across the Padma river."),
    QA("পদ্মা সেতু", "পদ্মা সেতু পদ্মা নদীর উপর মুন্সিগঞ্জকে শরিয়তপুর/মাদারীপুরের সাথে যুক্ত করে।"),
    QA("ekushe february", "21 February is International Mother Language Day, from the 1952 Bangla language movement in Dhaka."),
    QA("একুশে ফেব্রুয়ারি", "একুশে ফেব্রুয়ারি আন্তর্জাতিক মাতৃভাষা দিবস — ১৯৫২ সালের ভাষা আন্দোলনের স্মৃতিতে।"),
    QA("26 march", "26 March is Bangladesh Independence Day."),
    QA("১৬ ডিসেম্বর", "১৬ ডিসেম্বর বাংলাদেশের বিজয় দিবস — ১৯৭১ সালের মুক্তিযুদ্ধের সমাপ্তি।"),
    QA("victory day bangladesh", "16 December is Victory Day in Bangladesh (1971)."),
    QA("dhaka kothay", "Dhaka Bangladesher rajdhani, desher majhe, Buriganga nodir kache."),
    QA("chittagong", "Chattogram (Chittagong) is Bangladesh's main port city on the Bay of Bengal."),
    QA("সিলেট", "সিলেট উত্তর-পূর্ব বাংলাদেশে, চা-বাগান ও হাওর অঞ্চলের জন্য পরিচিত।"),
    QA("ilish", "Ilish (hilsa) is Bangladesh's national fish, often eaten with mustard or as ilish bhaja / paturi."),
    QA("ইলিশ", "ইলিশ বাংলাদেশের জাতীয় মাছ।"),
    QA("what is pohela boishakh", "Pohela Boishakh is Bengali New Year, celebrated on 14 April in Bangladesh."),
    QA("পহেলা বৈশাখ", "পহেলা বৈশাখ বাংলা নববর্ষ — বাংলাদেশে সাধারণত ১৪ এপ্রিল পালিত হয়।"),
  ].join("\n\n");
}

function daily(): string {
  return [
    QA("what time is it", "I don't have a live clock in this short reply — check your phone, or ask me to remember a schedule."),
    QA("what's the weather", "I can look up weather if research is on. Try: Dhaka weather today — or /research Dhaka weather."),
    QA("আবহাওয়া কেমন", "আবহাওয়ার জন্য /research ঢাকা আবহাওয়া লিখুন, অথবা শহরের নামসহ জিজ্ঞেস করুন।"),
    QA("abohawa kemon", "Weather er jonno shohor er nam din, jemon: Dhaka weather today."),
    QA("how to cook rice", "Wash the rice, use about 1:2 rice to water, bring to a boil, then simmer covered until the water is absorbed. In Bangladesh people often use a rice cooker or a handi on the stove."),
    QA("ভাত কীভাবে রান্না করব", "চাল ধুয়ে নিন। চাল:পানি প্রায় ১:২। ফুটিয়ে নামিয়ে ঢেকে সিদ্ধ করুন, অথবা রাইস কুকার ব্যবহার করুন।"),
    QA("bhat kivabe ranna", "Chal dhuen. Chal:pani roughly 1:2. Futiye dheke siddho korun, othoba rice cooker use korun."),
    QA("i am hungry", "Want ideas? Rice with dal and a vegetable, or khichuri if you want one pot. Tell me what you have at home."),
    QA("ক্ষুধা লাগছে", "ভাত-ডাল-সবজি সহজ। একপাত্রে খিচুড়িও ভালো। বাড়িতে কী আছে বলুন, সাজেস্ট করব।"),
    QA("tell me a joke", "Why did the server go to sleep? Because it was on the Render free plan. (Wake it with a click.)"),
    QA("একটা কৌতুক বলো", "কম্পিউটার কেন ঠান্ডা? কারণ ওর অনেক উইন্ডো খোলা।"),
    QA("help", "You can: chat, say \"my name is …\", add knowledge in Training, /research a topic, or import .txt corpora. I answer in the language you write."),
    QA("সাহায্য", "চ্যাট করুন, \"আমার নাম …\" বলুন, Training-এ নলেজ যোগ করুন, /research দিন, অথবা txt ইমপোর্ট করুন। আপনি যে ভাষায় লিখবেন আমি সেই ভাষায় উত্তর দেব।"),
    QA("amar nam ki", "Apni ekhono nam bolen ni. \"Amar nam …\" likhun, ami mone rakhbo."),
    QA("আমার নাম কী", "আপনি এখনো নাম বলেননি। \"আমার নাম …\" লিখুন, আমি মনে রাখব।"),
    QA("what is my name", "You haven't told me your name yet. Say \"My name is …\" and I'll remember it."),
    QA("remember that I like tea", "Saved to my memory. 🧠"),
    QA("মনে রাখো আমি চা পছন্দ করি", "মেমোরিতে সেভ করে রাখলাম। 🧠"),
    QA("2 + 2", "The result is 4."),
    QA("how do I train you", "Chat more, import .txt / .jsonl in the Training tab, or press Train. I retrain in the background after imports."),
    QA("তোমাকে কীভাবে ট্রেন করব", "আরও চ্যাট করুন, Training ট্যাবে txt/jsonl ইমপোর্ট করুন, অথবা Train চাপুন। ইমপোর্টের পর আমি ব্যাকগ্রাউন্ডে ট্রেন হই।"),
  ].join("\n\n");
}

function languageLessons(): string {
  const rows: string[] = [];
  const dict: [string, string, string][] = [
    ["hello", "হ্যালো / আসসালামু আলাইকুম", "hello / assalamualaikum"],
    ["how are you", "কেমন আছো / কেমন আছেন", "kemon acho / kemon achen"],
    ["I am fine", "আমি ভালো আছি", "ami bhalo achi"],
    ["thank you", "ধন্যবাদ", "dhonnobad"],
    ["yes", "হ্যাঁ", "hya / ha"],
    ["no", "না", "na"],
    ["please", "দয়া করে / প্লিজ", "doya kore"],
    ["sorry", "দুঃখিত", "dukkhito"],
    ["water", "পানি", "pani"],
    ["rice", "ভাত / চাল", "bhat / chal"],
    ["tea", "চা", "cha"],
    ["house", "বাড়ি / বাসা", "bari / basha"],
    ["friend", "বন্ধু", "bondhu"],
    ["today", "আজ", "aj"],
    ["tomorrow", "আগামীকাল", "agamikal"],
    ["yesterday", "গতকাল", "gotokal"],
    ["morning", "সকাল", "shokal"],
    ["night", "রাত", "rat"],
    ["food", "খাবার", "khabar"],
    ["work", "কাজ", "kaj"],
    ["school", "স্কুল", "school / iskul"],
    ["love", "ভালোবাসা", "bhalobasha"],
    ["name", "নাম", "nam"],
    ["what", "কী / কি", "ki"],
    ["who", "কে", "ke"],
    ["where", "কোথায়", "kothay"],
    ["why", "কেন", "keno"],
    ["when", "কখন / কবে", "kokhon / kobe"],
    ["how", "কীভাবে / কেমন", "kivabe / kemon"],
  ];
  for (const [en, bn, bl] of dict) {
    rows.push(QA(`how do you say ${en} in bangla`, `"${en}" বাংলায়: ${bn}. Banglish: ${bl}.`));
    rows.push(QA(`${en} বাংলায় কী`, `"${en}" = ${bn} (Banglish: ${bl})`));
    rows.push(QA(`${bl} mane ki`, `"${bl}" mane "${en}" / ${bn}.`));
  }
  return rows.join("\n\n");
}

function extraChat(): string {
  const topics = [
    ["cricket", "Bangladesh cricket is huge — Tigers in Tests, ODIs and T20. Want a latest score? Try /research Bangladesh cricket."],
    ["ক্রিকেট", "বাংলাদেশে ক্রিকেট খুব জনপ্রিয়। সর্বশেষ স্কোর চাইলে /research Bangladesh cricket লিখুন।"],
    ["football", "Football is loved too, especially the Bangladesh Premier League and international matches."],
    ["music", "From Rabindra Sangeet and Nazrul to modern Bangla band and folk — tell me a mood and I'll talk about it."],
    ["গান", "রবীন্দ্রসঙ্গীত, নজরুল, লোকগান থেকে আধুনিক ব্যান্ড — মুড বলুন, আলাপ করি।"],
    ["study tips", "Short sessions, one topic, write in your own words, sleep enough. I can quiz you if you paste notes into Knowledge."],
    ["পড়ালেখা", "ছোট সেশনে একটা বিষয়। নিজের ভাষায় লিখে নিন। নোট Knowledge-এ দিলে আমি সেখান থেকে সাহায্য করব।"],
  ];
  return topics.map(([q, a]) => QA(q, a)).join("\n\n");
}

const ARTICLE_EN = `MY-AI is a self-hosted personal assistant.
It understands English, Bangla (বাংলা) and Banglish (Bangla written in Latin letters).
It answers from: your memory, your knowledge documents, simple math, and optional keyless web research.
It does not send your private chats to OpenAI or Gemini.
Greetings: hello, hi, assalamualaikum, how are you.
Personal facts: say "My name is …" or "I like …".
Research: ask a question or type /research <topic>.
Training: import .txt and .jsonl files; the small brain retrains in the background.
Telegram: the private channel is the durable database on Render free.`;

const ARTICLE_BN = `MY-AI আপনার নিজের সার্ভারে চলা পার্সোনাল AI।
এটি ইংরেজি, বাংলা এবং Banglish বোঝে।
উত্তর আসে: মেমোরি, আপনার নলেজ ডকুমেন্ট, অঙ্ক, এবং ইচ্ছেমতো কি-লেস অনলাইন রিসার্চ থেকে।
চুপিচুপি অন্য কোম্পানির AI-তে চ্যাট যায় না।
অভিবাদন: হাই, হ্যালো, আসসালামু আলাইকুম, কেমন আছো।
তথ্য: "আমার নাম …", "আমি চা পছন্দ করি"।
খোঁজ: প্রশ্ন করুন অথবা /research <বিষয়>।
ট্রেনিং: txt/jsonl ইমপোর্ট করুন — ব্যাকগ্রাউন্ডে ট্রেন হয়।
Telegram প্রাইভেট চ্যানেলই Render Free-এ স্থায়ী ডেটাবেস।`;

const ARTICLE_BL = `MY-AI apnar nijer server e chole.
English, Bangla ar Banglish — tin tai bujhe.
Uttor ashe memory, knowledge document, onko, ar optional keyless research theke.
Private chat onno company te jay na.
Bolun: "amar nam …", "ami cha pochondo kori".
Khoj: proshno korun ba /research <topic>.
Training tab e txt push korun — background e nijei train hoy.`;

export function buildSeedFiles(): { name: string; content: string }[] {
  return [
    { name: "seed-greetings.txt", content: greetings() },
    { name: "seed-bangladesh.txt", content: bangladesh() },
    { name: "seed-daily.txt", content: daily() },
    { name: "seed-language-lessons.txt", content: languageLessons() },
    { name: "seed-extra.txt", content: extraChat() },
    { name: "seed-about-en.txt", content: ARTICLE_EN },
    { name: "seed-about-bn.txt", content: ARTICLE_BN },
    { name: "seed-about-banglish.txt", content: ARTICLE_BL },
  ];
}

export function seedAlreadyApplied(db: any): boolean {
  return getSyncState(db, "seed_version") === SEED_VERSION;
}

export function applyBuiltInSeed(db: any): { knowledgeInserted: number; pairsInserted: number; skipped: boolean } {
  if (seedAlreadyApplied(db)) return { knowledgeInserted: 0, pairsInserted: 0, skipped: true };
  const plan = planIngest(buildSeedFiles());
  const applied = applyIngest(db, plan, { source: "seed", conversationTitle: "Built-in language seed" });
  setSyncState(db, "seed_version", SEED_VERSION);
  return { ...applied, skipped: false };
}
