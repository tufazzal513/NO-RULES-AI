# Render-এ NO-RULES-AI ডেপ্লয়

এই গাইডটি বর্তমান **Node.js + Express + React + SQLite** অ্যাপের জন্য। কোনো OpenAI, Gemini বা অন্য বাইরের AI API লাগবে না।

## আগে গুরুত্বপূর্ণ সিদ্ধান্ত

### Free plan — শুধু পরীক্ষা/ডেমোর জন্য

Render Free web service ১৫ মিনিট inbound traffic না পেলে ঘুমিয়ে যায়। ঘুমানো বা restart/redeploy হলে local filesystem-এর পরিবর্তন হারায়। তাই SQLite-এর chat, memory ও knowledge স্থায়ী থাকবে না। Telegram bot-ও service ঘুমিয়ে থাকলে উত্তর দেবে না।

Free plan ব্যবহার করলে:

- Telegram snapshot নিয়মিত নিন।
- গুরুত্বপূর্ণ data হারাতে পারে ধরে নিন।
- browser-এ app URL খুললে service আবার চালু হবে; cold start কিছু সময় নিতে পারে।

### Paid service + persistent disk — ব্যবহারযোগ্য পছন্দ

SQLite স্থায়ী রাখতে paid Render web service-এ persistent disk attach করুন:

- **Mount path:** `/var/data`
- **Environment variable:** `DATABASE_URL=sqlite:////var/data/myai.db`

> `sqlite:///./data/myai.db` হলো project-relative path। `/var/data` disk-এর জন্য চারটি slash-সহ `sqlite:////var/data/myai.db` ব্যবহার করুন।

Long-polling Telegram bot সব সময় চালু রাখতে এমন paid instance দরকার যা idle হলে ঘুমায় না।

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

Token কখনো GitHub, `render.yaml`, screenshot বা chat-এ প্রকাশ করবেন না। Render-এর secret environment field-এই রাখুন।

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

1. bot-কে private channel-এর admin করুন; **Post Messages** permission দিন।
2. Render Environment-এ token ও channel ID বসিয়ে redeploy করুন।
3. app-এর Telegram Storage tab থেকে **Verify** চাপুন।
4. Telegram-এ bot-কে `/start` পাঠান।
5. Render log-এ conflict দেখলে একই token দিয়ে অন্য কোথাও bot long-polling চলছে কি না দেখুন। একই bot token-এর একাধিক polling process একসঙ্গে চালাবেন না।

সম্পূর্ণ Telegram channel setup: [`TELEGRAM_SETUP.md`](./TELEGRAM_SETUP.md)

## Update ও rollback

- `render.yaml`-এ `autoDeployTrigger: commit` আছে; connected branch-এ নতুন commit এলে auto-deploy হবে।
- deploy-এর আগে local check:

```bash
npm_config_nodedir=/usr/local npm install
npx tsc --noEmit
npm run build
```

- deploy ব্যর্থ হলে Render-এর **Events/Logs** দেখুন। আগের successful deploy-এ rollback করা যায়।

## সাধারণ সমস্যা

### `better-sqlite3` build error

Dockerfile Debian image-এ `python3`, `make`, `g++` install করে native module build করে। Render runtime **Docker** নির্বাচিত আছে কি না নিশ্চিত করুন।

### App খোলে, কিন্তু পুরোনো data নেই

Free filesystem ephemeral হওয়ার কারণে restart/spin-down/redeploy-এ SQLite file হারিয়েছে। স্থায়ী সমাধান হলো paid persistent disk; Telegram snapshot recovery একটি backup পথ।

### Telegram bot মাঝে মাঝে উত্তর দেয় না

Free service idle হয়ে sleep করতে পারে। Browser দিয়ে service URL খুলে wake করুন, অথবা always-on paid instance নিন।

### Health check fail

`DATABASE_URL`-এর directory writable কি না এবং disk mount path/value পরস্পর মিলছে কি না দেখুন। Health URL সরাসরি browser-এ খুলে JSON response পরীক্ষা করুন।

## নিরাপত্তা নোট

বর্তমান dashboard/API-তে login নেই। Public deployment করলে URL জানা যে কেউ data দেখতে বা পরিবর্তন করতে পারে। ব্যক্তিগত production ব্যবহারের আগে authentication যোগ করা উচিত; তার আগে sensitive knowledge upload না করাই নিরাপদ।
