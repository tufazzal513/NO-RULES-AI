# Render-এ NO-RULES-AI ডেপ্লয়

এই গাইডটি বর্তমান **Node.js + Express + React + SQLite** অ্যাপের জন্য। কোনো OpenAI, Gemini বা অন্য বাইরের AI API লাগবে না।

## 🧭 আর্কিটেকচার — Render Free-তে ডেটা কীভাবে টিকে থাকে

| স্তর | ভূমিকা | স্থায়ী? |
|---|---|---|
| **Telegram private channel** | **Permanent backup / source of truth** | ✅ চিরস্থায়ী |
| **Render-এর SQLite** | **Temporary cache** ও data processing DB | ❌ restart-এ মুছে যায় |

Render Free-এর filesystem **ephemeral** — restart, redeploy বা sleep থেকে wake হলে `myai.db` মুছে যেতে পারে। তাই এই অ্যাপে Telegram private channel-ই আসল ডাটাবেস।

কী ঘটে:

1. Render Free ১৫ মিনিট traffic না পেলে **sleep** করে। ঘুমন্ত অবস্থায় **Telegram bot উত্তর দেবে না** — এটা স্বাভাবিক, সমস্যা নয়।
2. Service **wake / restart / redeploy** হলে SQLite খালি অবস্থায় শুরু হয়।
3. Startup-এ অ্যাপ নিজে থেকেই Telegram channel-এর **pinned latest snapshot** নামায়, **checksum যাচাই** করে, এবং একটা **transaction-এর ভিতরে restore** করে।
4. Restore সফল হলে state `ready` হয় → **তারপরই Telegram bot long-polling চালু হয়**।
5. এরপর প্রতি ৩০ মিনিটে (configurable) অটো snapshot যায়, আর shutdown-এর আগেও একটা final snapshot নেওয়ার চেষ্টা হয়।

ফলে **কোনো chat, conversation, memory, knowledge বা trained AI model হারায় না।**

> Restore চলাকালে chat API `503` দেয়:
> ```json
> { "error": "AI data is being restored", "state": "restoring" }
> ```
> Restore ব্যর্থ হলে **local ডেটা delete/overwrite হয় না** এবং bot বন্ধ থাকে (state: `restore_failed`)।

### Free plan — Telegram backup চালু থাকলে ব্যবহারযোগ্য

Free plan-এ অবশ্যই `TELEGRAM_BOT_TOKEN` ও `TELEGRAM_STORAGE_CHAT_ID` সেট করুন, নাহলে restart-এ সব ডেটা সত্যিই হারিয়ে যাবে। Telegram সেট করা থাকলে ephemeral disk আর সমস্যা নয়।

মনে রাখবেন: Free instance ঘুমালে bot অফলাইন থাকে। Browser-এ app URL খুললে service আবার জেগে ওঠে (cold start কিছুটা সময় নেয়), তারপর restore হয়ে bot চালু হয়।

### Paid service + persistent disk — সবচেয়ে ভালো

SQLite-ও স্থায়ী রাখতে চাইলে paid Render web service-এ persistent disk attach করুন:

- **Mount path:** `/var/data`
- **Environment variable:** `DATABASE_URL=sqlite:////var/data/myai.db`

> `sqlite:///./data/myai.db` হলো project-relative path। `/var/data` disk-এর জন্য চারটি slash-সহ `sqlite:////var/data/myai.db` ব্যবহার করুন।

Telegram bot সব সময় online রাখতে এমন paid instance দরকার যা idle হলে ঘুমায় না। তবে paid plan-এও Telegram backup চালু রাখা বুদ্ধিমানের কাজ।

## পদ্ধতি A: Blueprint দিয়ে সহজ ডেপ্লয়

Repository root-এর `render.yaml` প্রস্তুত আছে।

1. কাজটি GitHub branch-এ push/merge করুন।
2. [Render Dashboard](https://dashboard.render.com/) খুলুন।
3. **New > Blueprint** নির্বাচন করুন।
4. GitHub account connect করে `tufazzal513/NO-RULES-AI` repository নির্বাচন করুন।
5. Render `render.yaml` পড়ে `no-rules-ai` web service দেখাবে।
6. secret prompt-এ নিচের value দিন:
   - `TELEGRAM_BOT_TOKEN`: BotFather-এর token
   - `TELEGRAM_STORAGE_CHAT_ID`: private storage channel ID, যেমন `-1001234567890`
   - Telegram এখন ব্যবহার না করলে blank রাখুন; পরে service-এর **Environment** থেকে বসাতে পারবেন।
7. **Apply / Deploy Blueprint** চাপুন।
8. deploy log-এ build এবং `Server running` message দেখুন।

Deploy শেষ হলে পরীক্ষা করুন:

```text
https://YOUR-SERVICE.onrender.com/
https://YOUR-SERVICE.onrender.com/api/v1/health/detailed
https://YOUR-SERVICE.onrender.com/api/v1/telegram/status
```

Health endpoint-এ HTTP 200 এবং `"status":"Operational"` থাকা উচিত।

## পদ্ধতি B: Manual Web Service

Blueprint ব্যবহার না করলে:

1. **New > Web Service** থেকে repository নির্বাচন করুন।
2. **Language/Runtime:** Docker
3. **Dockerfile path:** `./Dockerfile`
4. **Instance type:** Free (test) অথবা paid (recommended)
5. **Health check path:** `/api/v1/health/detailed`
6. Environment variables যোগ করুন:

| Key | Free/test value | Paid persistent disk value |
|---|---|---|
| `NODE_ENV` | `production` | `production` |
| `DATABASE_URL` | `sqlite:///./data/myai.db` | `sqlite:////var/data/myai.db` |
| `TELEGRAM_BOT_TOKEN` | আপনার secret token | আপনার secret token |
| `TELEGRAM_STORAGE_CHAT_ID` | channel ID | channel ID |
| `TELEGRAM_AUTO_RESTORE` | `true` | `true` |
| `TELEGRAM_RESTORE_ON_EMPTY_ONLY` | `true` | `true` |
| `TELEGRAM_AUTO_SNAPSHOT` | `true` | `true` |
| `TELEGRAM_SNAPSHOT_INTERVAL_MINUTES` | `30` | `30` |

### 🔒 Token নিরাপত্তা — খুব গুরুত্বপূর্ণ

**`TELEGRAM_BOT_TOKEN` কখনোই GitHub, কোড, `render.yaml`, screenshot বা chat-এ রাখবেন না।** Token শুধু **Render Dashboard → Environment**-এ (secret field) বসাবেন। `render.yaml`-এ token-এর জন্য `sync: false` দেওয়া আছে, অর্থাৎ value Git-এ যায় না। `.env` ফাইল `.gitignore`-এ আছে। Token ফাঁস হলে @BotFather-এ `/revoke` করে নতুন token নিন।

## Paid persistent disk সেটআপ

1. service-এর **Settings > Disks** খুলুন।
2. disk add করে mount path `/var/data` দিন।
3. Environment-এ `DATABASE_URL` পরিবর্তন করে দিন:

```text
sqlite:////var/data/myai.db
```

4. Save করে manual deploy/restart দিন।
5. কিছু chat/knowledge যোগ করে restart-এর পর data আছে কি না পরীক্ষা করুন।

SQLite একসঙ্গে একটিমাত্র app instance-এর জন্য রাখুন। Horizontal scaling করলে shared SQLite disk উপযুক্ত নয়।

## Telegram যাচাই

1. bot-কে private channel-এর admin করুন; **Post Messages** ও **Pin Messages** — দুটো permission-ই দিন। (Pin permission ছাড়া restart-এর পর latest snapshot খুঁজে পাওয়া যাবে না।)
2. Render Environment-এ token ও channel ID বসিয়ে redeploy করুন।
3. app-এর Telegram Storage tab থেকে **Verify** চাপুন।
4. Telegram Storage tab থেকে **Backup Now** চেপে প্রথম snapshot নিন — এটাই আপনার প্রথম permanent ব্যাকআপ।
5. Telegram-এ bot-কে `/start` পাঠান।
6. UI-তে state **Ready**, **Last Backup** ও **Auto Backup** দেখাচ্ছে কি না মিলিয়ে নিন।
7. Render log-এ conflict দেখলে একই token দিয়ে অন্য কোথাও bot long-polling চলছে কি না দেখুন। একই bot token-এর একাধিক polling process একসঙ্গে চালাবেন না।

সম্পূর্ণ Telegram channel setup: [`TELEGRAM_SETUP.md`](./TELEGRAM_SETUP.md)

## Update ও rollback

- `render.yaml`-এ `autoDeployTrigger: commit` আছে; connected branch-এ নতুন commit এলে auto-deploy হবে।
- deploy-এর আগে local check:

```bash
npm_config_nodedir=/usr/local npm install
npx tsc --noEmit
npm run build
npm test
```

- deploy ব্যর্থ হলে Render-এর **Events/Logs** দেখুন। আগের successful deploy-এ rollback করা যায়।

## সাধারণ সমস্যা

### `better-sqlite3` build error

Dockerfile Debian image-এ `python3`, `make`, `g++` install করে native module build করে। Render runtime **Docker** নির্বাচিত আছে কি না নিশ্চিত করুন।

### App খোলে, কিন্তু পুরোনো data নেই

Free filesystem ephemeral হওয়ার কারণে restart/spin-down/redeploy-এ SQLite file হারিয়েছে। Telegram configured থাকলে startup-এ **অটো restore** হওয়ার কথা। না হলে দেখুন:

- Render log-এ `♻️ Restoring the latest snapshot…` এবং `✅ Restore complete` আছে কি না।
- `TELEGRAM_AUTO_RESTORE=true` সেট আছে কি না।
- Channel-এ snapshot **pin** করা আছে কি না, অথবা channel **description**-এ
  `MYAI_SNAPSHOT|…` লেখা আছে কি না। অ্যাপ এই দুটোর যেকোনো একটা পেলেই restore
  করতে পারে (ক্রম: pin → description → লোকাল index)। তাই bot-কে **Pin Messages**
  আর **Change Channel Info** — অন্তত একটা permission দিন, দুটো দিলে সবচেয়ে ভালো।
- `/api/v1/telegram/status`-এ `state`, `lastError` ও `latestSnapshotFileId` দেখুন।
- সব ঠিক থাকলে UI থেকে **Restore Latest** চেপে ম্যানুয়ালি restore করুন।
- Telegram একেবারেই কাজ না করলে: **⬆️ Restore from file** দিয়ে আগে ডাউনলোড করা
  `myai_snapshot_*.json` আপলোড করুন — ওটাই সবচেয়ে নিশ্চিত রাস্তা।

> **পুরনো backup restore হচ্ছে না?** আগে schema v1-এর snapshot (research cache
> যোগ হওয়ার আগের) "incomplete" বলে বাতিল হতো। এখন schema version অনুযায়ী
> টেবিল যাচাই হয়, তাই পুরনো snapshot-ও restore হয়। শুধু update করে redeploy করুন।

### State `restore_failed` দেখাচ্ছে

Snapshot corrupt বা checksum mismatch হয়েছে। **আপনার local ডেটা মুছে যায়নি** এবং
নিরাপত্তার জন্য bot বন্ধ রাখা হয়েছে। `/api/v1/telegram/status`-এর `lastError`
দেখুন, তারপর UI-এর Snapshots লিস্ট থেকে আগের একটা ভালো snapshot বেছে **Restore**
করুন।

সমস্যা মিটে গেলে (বা লোকাল ডেটা নিয়েই চালাতে চাইলে) Telegram Cloud ট্যাবে
**"Continue with local data"** বাটন চাপুন — এতে `restore_failed` অবস্থা কেটে
যায়, Telegram bot আবার চালু হয় আর auto-snapshot ফিরে আসে। আগে এর জন্য পুরো
service restart করা লাগত।

### Restore হয়েছে বলছে, কিন্তু AI পুরনো উত্তরই দিচ্ছে

এটা একটা বাগ ছিল — restore-এর পর in-memory AI model reload হতো না। এখন প্রতিটি
সফল restore-এর পর model স্বয়ংক্রিয়ভাবে reload হয় এবং log-এ
`♻️ Restore applied and AI model reloaded — …` লেখা আসে। এই লাইনটা log-এ
খুঁজে দেখুন; না থাকলে পুরনো build চলছে, redeploy করুন।

### Snapshot "skipped" বলছে

ডেটা পরিবর্তন না হলে অপ্রয়োজনীয় আপলোড এড়াতে snapshot skip হয় — এটা স্বাভাবিক আচরণ। **Backup Now** বাটন সবসময় force করে, তাই সেটা চাপলে আপলোড হবেই।

### Telegram bot মাঝে মাঝে উত্তর দেয় না

Free service idle হয়ে sleep করতে পারে। Browser দিয়ে service URL খুলে wake করুন, অথবা always-on paid instance নিন।

### Health check fail

`DATABASE_URL`-এর directory writable কি না এবং disk mount path/value পরস্পর মিলছে কি না দেখুন। Health URL সরাসরি browser-এ খুলে JSON response পরীক্ষা করুন।

## নিরাপত্তা নোট

বর্তমান dashboard/API-তে login নেই। Public deployment করলে URL জানা যে কেউ data দেখতে বা পরিবর্তন করতে পারে। ব্যক্তিগত production ব্যবহারের আগে authentication যোগ করা উচিত; তার আগে sensitive knowledge upload না করাই নিরাপদ।
