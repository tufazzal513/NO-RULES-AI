# 📦 Telegram Cloud Database — Setup Guide

এই প্রজেক্টে Telegram-এর **bot + private channel** ব্যবহার করে একটা **ফ্রি, আনলিমিটেড ক্লাউড ডাটাবেস** বানানো হয়েছে।

---

## 🧭 আর্কিটেকচার — এক নজরে

| স্তর | ভূমিকা | স্থায়ী? |
|---|---|---|
| **Telegram private channel** | **Permanent database / source of truth** — সব ডেটার আসল ও স্থায়ী কপি এখানে | ✅ হ্যাঁ, চিরস্থায়ী |
| **Render-এর SQLite (`myai.db`)** | **Temporary cache** — শুধু দ্রুত read/write ও data processing-এর জন্য | ❌ না, restart-এ মুছে যায় |

> ⚠️ **Render Free-এর disk ephemeral।** Service restart, redeploy বা sleep থেকে wake হলে local SQLite ফাইল মুছে যেতে পারে। তাই **Telegram channel-ই আপনার আসল ডাটাবেস** — SQLite শুধু একটা অস্থায়ী কপি।

কাজের ধারা:

```
আপনি চ্যাট করলেন
      ↓
SQLite-এ লেখা হলো  ──মিরর──►  Telegram channel (JSON message)
      ↓
প্রতি ৩০ মিনিটে  ──snapshot──►  Telegram channel (gzip ফাইল, pinned)
      ↓
Render restart / redeploy / wake → SQLite খালি
      ↓
Startup-এ pinned snapshot ডাউনলোড → checksum যাচাই → SQLite-এ restore
      ↓
তারপরই Telegram bot চালু হয় ✅
```

---

## 🔐 কোন কোন ডেটা ব্যাকআপ হয়

প্রতিটি snapshot-এ **সব টেবিল** থাকে:

- `users`
- `conversations`
- `chat_messages`
- `knowledge` (আপনার ডকুমেন্ট)
- `memory` (আপনার সম্পর্কে মনে রাখা তথ্য)
- `ai_model` (trained Markov মডেল)
- `telegram_index`

Snapshot-এর metadata-তে থাকে: **schema version**, **creation time**, **প্রতিটি টেবিলের record count**, এবং **SHA-256 checksum**।

উপরন্তু নিচের প্রতিটি পরিবর্তন সাথে সাথে channel-এ mirror হয়:

- conversation create · user message · AI reply
- memory add/update · memory delete
- knowledge add · knowledge delete
- AI model train/update

Delete হলে একটা **tombstone** মেসেজ যায়:

```json
{
  "operation": "delete",
  "collection": "knowledge",
  "record_id": "123",
  "deleted_at": "2026-08-20T10:00:00.000Z"
}
```

---

## 📱 বোনাস — Telegram থেকেই AI-এর সাথে চ্যাট!

**একই bot token** storage এবং AI assistant দুটোর জন্যই ব্যবহার হয়। Bot-কে Telegram-এ মেসেজ করলেই আপনার নিজের AI উত্তর দেবে।

AI **English, বাংলা আর Banglish** — তিন ভাষাতেই বোঝে, আর আপনি যে ভাষায় লিখবেন
সেই ভাষাতেই উত্তর দেয়। Bot-এর কমান্ডগুলোও আপনার ভাষা ধরে নিয়ে উত্তর দেয়
(আপনার শেষ কয়েকটা মেসেজ দেখে ভাষা ঠিক করা হয়)।

ওয়েব প্যানেলের **সব chat shortcut** এখানেও আছে:

| কমান্ড | কাজ |
|---|---|
| `/start` | ওয়েলকাম মেসেজ |
| `/help` | সব shortcut-এর তালিকা |
| `/new` | নতুন কথোপকথন শুরু (আগেরটা history-তে থেকে যায়) |
| `/history [n]` | এই কথোপকথনের শেষ n (default 10) মেসেজ |
| `/chats` | সব কথোপকথনের তালিকা, চলতিটা ▶️ দিয়ে চিহ্নিত |
| `/edit <নতুন লেখা>` | শেষ প্রশ্নটা বদলে আবার উত্তর নিন (পুরনো উত্তর মুছে যায়) |
| `/again` | শেষ উত্তরটা নতুন করে তৈরি করুন |
| `/undo` | শেষ প্রশ্ন ও তার উত্তর মুছে ফেলুন |
| `/clear` | এই কথোপকথনের সব মেসেজ মুছুন (Knowledge/Memory অক্ষত) |
| `/forget` | আপনার সম্পর্কে মনে রাখা সব তথ্য মুছুন |
| `/research <বিষয়>` | জোর করে অনলাইনে খুঁজুন |
| যেকোনো মেসেজ | আপনার AI brain (memory, knowledge, math, research) |

`/help@YourBotName` লিখলেও কাজ করে (group-এ কাজে লাগে)।

Long-polling পদ্ধতি, তাই কোনো webhook URL লাগে না।

> 🔒 **Restore শেষ না হওয়া পর্যন্ত bot চালু হয় না।** এতে অসম্পূর্ণ ডাটাবেসের উপর নতুন মেসেজ লেখা হয়ে যাওয়ার ঝুঁকি থাকে না।

---

## 🛠️ একবারই করার সেটআপ (৫ মিনিট)

### ধাপ ১ — বট বানান
1. Telegram-এ খুঁজুন: **@BotFather**
2. লিখুন: `/newbot`
3. একটা নাম দিন (যেমন: `My AI Storage`)
4. একটা username দিন (শেষে `bot` থাকতে হবে, যেমন: `my_ai_storage_bot`)
5. BotFather একটা **token** দেবে — কপি করে রাখুন। **কারো সাথে শেয়ার করবেন না, GitHub-এ commit করবেন না!**

### ধাপ ২ — প্রাইভেট চ্যানেল বানান
1. Telegram-এ **New Channel** চাপুন
2. নাম দিন (যেমন: `My AI Database`)
3. **Private** রাখুন
4. Settings → **Administrators** → **Add Admin**
5. আপনার বটটাকে admin বানান। এই permission-গুলো চালু রাখুন:
   - **Post Messages** (snapshot আপলোডের জন্য) — *বাধ্যতামূলক*
   - **Pin Messages** (latest snapshot চিহ্নিত করার জন্য — **restore-এর জন্য জরুরি**)
   - **Change Channel Info** (latest snapshot-এর দ্বিতীয় pointer চ্যানেল
     description-এ লেখা হয় — pin মুছে গেলে বা pin permission না থাকলে এটাই
     আপনার ডেটা ফিরে পাওয়ার backup রাস্তা)

> তিনটার একটাও না থাকলে অ্যাপ ক্র্যাশ করবে না — শুধু warning দেবে। তবে
> **Pin আর Change Info দুটোর একটাও না থাকলে** wipe হওয়া container নিজের
> backup খুঁজে পাবে না; তখন **Restore from file** দিয়ে ফেরাতে হবে।

### ধাপ ৩ — চ্যানেলের ID বের করুন
1. চ্যানেলে যেকোনো একটা মেসেজ পাঠান
2. সেই মেসেজটা **forward** করুন **@userinfobot**-এ (বা @getidsbot)
3. বট একটা ID দেবে, যেমন: `-1001234567890` — এটাই আপনার channel ID

### ধাপ ৪ — Environment variable বসান

Local-এ `.env` ফাইলে (`.env.example` কপি করে):

```env
TELEGRAM_BOT_TOKEN=1234567890:AA...আপনার-টোকেন
TELEGRAM_STORAGE_CHAT_ID=-1001234567890

TELEGRAM_AUTO_RESTORE=true
TELEGRAM_AUTO_SNAPSHOT=true
TELEGRAM_SNAPSHOT_INTERVAL_MINUTES=30
TELEGRAM_RESTORE_ON_EMPTY_ONLY=true
```

Render-এ deploy করলে এগুলো **Render Dashboard → Environment**-এ বসাবেন (কোডে নয়)।

### ধাপ ৫ — চালান ও যাচাই করুন
```bash
npm install
npm run dev
```
UI-এর **"Telegram Storage"** ট্যাবে গিয়ে **"Verify Connection"** চাপুন। ✅ পেলে **"Backup Now"** চেপে প্রথম snapshot নিন।

---

## ⚙️ Environment variable-এর ব্যাখ্যা

| Variable | ডিফল্ট | কাজ |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | BotFather-এর token (**secret**) |
| `TELEGRAM_STORAGE_CHAT_ID` | — | Private channel ID (**secret**) |
| `TELEGRAM_AUTO_RESTORE` | `true` | Startup-এ Telegram থেকে সর্বশেষ snapshot restore করবে |
| `TELEGRAM_RESTORE_ON_EMPTY_ONLY` | `true` | শুধু local DB খালি হলে restore করবে (বিদ্যমান ডেটা রক্ষা করে) |
| `TELEGRAM_AUTO_SNAPSHOT` | `true` | নিয়মিত অটো snapshot নেবে |
| `TELEGRAM_SNAPSHOT_INTERVAL_MINUTES` | `30` | কত মিনিট পরপর snapshot |

---

## 🔄 Application state

App-এর চারটি অবস্থা আছে, UI-তে ও `/api/v1/telegram/status`-এ দেখা যায়:

| State | মানে |
|---|---|
| `starting` | সার্ভার উঠছে, restore শুরু হয়নি |
| `restoring` | Telegram থেকে restore চলছে — chat API **HTTP 503** দেবে, bot বন্ধ |
| `ready` | সব প্রস্তুত — bot চালু, auto-snapshot চালু |
| `restore_failed` | Restore ব্যর্থ — **local ডেটা অক্ষত আছে**, bot বন্ধ রাখা হয়েছে |

Restore চলাকালে chat API-এর উত্তর:

```json
{ "error": "AI data is being restored", "state": "restoring" }
```

---

## 🛡️ Data safety — যে নিয়মগুলো কোডে জোর করে মানা হয়

1. **Restore সবসময় একটি SQLite transaction-এ** হয় — হয় পুরোটা, নয় কিছুই না।
2. **Checksum mismatch হলে snapshot reject** — corrupt ফাইল কখনো ডাটাবেস ছোঁয় না।
3. **Structure validation** — কোনো টেবিল অনুপস্থিত বা record count না মিললে reject।
4. **খালি remote snapshot দিয়ে non-empty local DB কখনো overwrite হয় না** (এই guard `force` দিয়েও বাইপাস করা যায় না)।
5. **Snapshot ও restore একসাথে চলতে পারে না** — mutual-exclusion lock আছে।
6. **একই সময়ে দুটো snapshot চলে না।**
7. **Duplicate restore প্রতিরোধ** — একই snapshot দ্বিতীয়বার apply হয় না; `INSERT OR REPLACE` ব্যবহারের ফলে duplicate row-ও তৈরি হয় না।
8. **Restore ব্যর্থ হলে local ডেটা delete/overwrite হয় না।**
9. **Telegram unavailable হলে local AI স্বাভাবিকভাবে চলে** — শুধু warning log হয়, app crash করে না।
10. **Data পরিবর্তন না হলে অপ্রয়োজনীয় snapshot skip** হয়।
11. **Shutdown-এর আগে timeout-সহ best-effort final snapshot** নেওয়া হয়।

---

## 🔌 API এন্ডপয়েন্ট

| Method | Endpoint | কাজ |
|---|---|---|
| GET | `/api/v1/telegram/status` | state, auto restore/snapshot, last backup/restore, next snapshot, error — সব |
| POST | `/api/v1/telegram/verify` | বট+চ্যানেল যাচাই, টেস্ট মেসেজ পাঠায় |
| POST | `/api/v1/telegram/sync` | সব লোকাল record channel-এ mirror করে |
| POST | `/api/v1/telegram/snapshot` | পুরো DB-র gzip snapshot আপলোড ও pin করে |
| GET | `/api/v1/telegram/snapshot/download` | Snapshot-টা সরাসরি JSON ফাইল হিসেবে নামায় |
| GET | `/api/v1/telegram/snapshots` | snapshot ও index-এর লিস্ট |
| POST | `/api/v1/telegram/restore` | `{ "fileId": "..." }` অথবা খালি body দিলে latest snapshot |
| POST | `/api/v1/telegram/restore/file` | আপলোড করা snapshot ফাইল থেকে restore — `{ "snapshot": {...} }` বা `{ "base64": "..." }` |
| POST | `/api/v1/telegram/restore/dismiss` | `restore_failed` অবস্থা থেকে বেরিয়ে লোকাল ডেটা নিয়ে চালু হন |
| POST | `/api/v1/backup` | raw `.db` ফাইল ব্যাকআপ |

### উদাহরণ

```bash
# Snapshot নিন
curl -X POST http://localhost:3000/api/v1/telegram/snapshot

# সর্বশেষ snapshot থেকে restore করুন
curl -X POST http://localhost:3000/api/v1/telegram/restore \
  -H "Content-Type: application/json" -d '{}'

# নির্দিষ্ট fileId থেকে restore
curl -X POST http://localhost:3000/api/v1/telegram/restore \
  -H "Content-Type: application/json" -d '{"fileId":"BQACAgQAAx..."}'
```

---

## 🧷 Latest snapshot কীভাবে খুঁজে পাওয়া যায়?

Telegram bot API দিয়ে চ্যানেলের পুরনো মেসেজের লিস্ট পড়া যায় **না**। তাই
প্রতিটি সফল snapshot-এর `file_id` **দুই জায়গায়** রাখা হয় — একটা নষ্ট হলে
অন্যটা দিয়ে ডেটা ফিরে পাওয়া যায়:

1. **Pinned message** — snapshot মেসেজটা চ্যানেলে pin করা হয়। `getChat` API
   pinned message ফেরত দেয় → সেখান থেকে permanent `file_id`।
   (দরকার: **Pin Messages** permission)
2. **Channel description** — `MYAI_SNAPSHOT|<file_id>|<createdAt>|<records>`
   ফরম্যাটে description-এও লেখা হয়। `getChat` description-ও ফেরত দেয়।
   (দরকার: **Change Channel Info** permission)

Restore-এর সময় খোঁজার ক্রম: **pin → description → লোকাল index**।

> আগে শুধু pin দেখা হতো, তাই bot-এর pin permission না থাকলে বা কেউ pin সরিয়ে
> দিলে restore "No snapshot found" বলত — অথচ ডেটা চ্যানেলেই পড়ে থাকত।
> description pointer সেই ফাঁকটা বন্ধ করে।

### শেষ ভরসা — Restore from file

Telegram একেবারেই কাজ না করলে (ভুল channel id, bot admin থেকে সরে গেছে):
Telegram Cloud ট্যাব → **⬇️ Download Snapshot (JSON)** দিয়ে ফাইলটা রেখে দিন,
পরে **⬆️ Restore from file** দিয়ে সেটা আপলোড করলেই সব ডেটা ফিরে আসবে।
একই checksum validation, একই single transaction — কাজেই ভুল ফাইল দিলে
ডাটাবেসের কিছুই নষ্ট হবে না।

```bash
# ডাউনলোড
curl -o backup.json http://localhost:3000/api/v1/telegram/snapshot/download

# ফাইল থেকে restore
curl -X POST http://localhost:3000/api/v1/telegram/restore/file \
  -H "Content-Type: application/json" \
  -d "{\"snapshot\": $(cat backup.json)}"
```

---

## 🧪 টেস্ট

Telegram network call mock করা আছে, তাই ইন্টারনেট ছাড়াই টেস্ট চলে:

```bash
npm test
```

কভার করা হয়েছে: snapshot-এ সব টেবিল · checksum validation · corrupt snapshot rejection · empty DB auto restore · non-empty DB overwrite prevention · concurrent snapshot lock · restore-before-bot-start · memory/knowledge/model mirror · delete tombstone · Telegram unavailable fallback · **পুরনো (schema v1) snapshot restore** · **আপলোড করা ফাইল থেকে restore** · **bot-এর সব chat shortcut (`/new` `/history` `/chats` `/edit` `/again` `/undo` `/clear` `/forget`) তিন ভাষায়**।

---

## 🔒 নিরাপত্তা টিপস

- **Token কখনো GitHub, code, `render.yaml`, screenshot বা chat-এ রাখবেন না।** শুধু Render-এর Environment variable-এ বসান (`.env` ইতিমধ্যে `.gitignore`-এ আছে)।
- চ্যানেল **Private** রাখুন; বট ছাড়া কেউ ঢুকতে পারবে না।
- Token ফাঁস হলে সাথে সাথে @BotFather-এ `/revoke` করে নতুন token নিন।
- নিয়মিত snapshot নিন — এটাই আপনার ক্লাউড ব্যাকআপ।
