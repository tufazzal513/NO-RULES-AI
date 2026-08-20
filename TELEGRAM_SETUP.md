# 📦 Telegram Cloud Database — Setup Guide

এই প্রজেক্টে Telegram-এর **bot + private channel** ব্যবহার করে একটা **ফ্রি, আনলিমিটেড ক্লাউড ডাটাবেস** বানানো হয়েছে। আপনার AI-এর সব ডেটা (কথোপকথন, মেসেজ, মেমোরি, নলেজ) এখানে জমা থাকবে।

---

## 🧠 এটা কীভাবে কাজ করে?

| কাজ | কী হয় |
|---|---|
| **Auto-sync** | প্রতিটি নতুন চ্যাট/মেসেজ সাথে সাথে Telegram channel-এ JSON মেসেজ হয়ে যায় |
| **Snapshot** | পুরো ডাটাবেসের একটা JSON ফাইল channel-এ আপলোড হয়। ফাইলের `file_id` স্থায়ী — তাই পরে যেকোনো সময় exact ফাইলটা আবার নামানো যায় |
| **Restore** | `file_id` দিয়ে snapshot নামিয়ে পুরো ডাটাবেস ফিরিয়ে আনা যায় |
| **Local index** | কোন record কোথায় আছে, সেটা লোকাল SQLite-এ (`telegram_index` টেবিল) রাখা হয় |

> ⚠️ **গুরুত্বপূর্ণ সত্য:** Telegram bot চ্যানেলের পুরনো মেসেজের লিস্ট API দিয়ে পড়তে পারে না। তাই আমরা `file_id`/`message_id` লোকালি জমা রাখি এবং সেটা দিয়ে পরে নামাই। এটাই Telegram-কে durable storage হিসেবে ব্যবহারের সঠিক উপায়।

---

## 🛠️ একবারই করার সেটআপ (৫ মিনিট)

### ধাপ ১ — বট বানান
1. Telegram-এ খুঁজুন: **@BotFather**
2. লিখুন: `/newbot`
3. একটা নাম দিন (যেমন: `My AI Storage`)
4. একটা username দিন (শেষে `bot` থাকতে হবে, যেমন: `my_ai_storage_bot`)
5. BotFather একটা **token** দেবে — সেটা কপি করে রাখুন। (কারো সাথে শেয়ার করবেন না!)

### ধাপ ২ — প্রাইভেট চ্যানেল বানান
1. Telegram-এ **New Channel** চাপুন
2. নাম দিন (যেমন: `My AI Database`)
3. **Private** রাখুন
4. চ্যানেলের Settings → **Administrators** → **Add Admin**
5. আপনার বটটাকে (username) খুঁজে admin বানান, **"Post Messages"** permission চালু রাখুন

### ধাপ ৩ — চ্যানেলের ID বের করুন
সবচেয়ে সহজ উপায়:
1. চ্যানেলে একটা যেকোনো মেসেজ পাঠান
2. সেই মেসেজটা **forward** করুন এই বটে: **@userinfobot** (বা @getidsbot)
3. বট আপনাকে একটা ID দেবে, যেমন: `-1001234567890` — এটাই আপনার channel ID

### ধাপ ৪ — `.env` ফাইলে বসান
```env
TELEGRAM_BOT_TOKEN=1234567890:AA...আপনার-টোকেন
TELEGRAM_STORAGE_CHAT_ID=-1001234567890
```
(`.env.example` কপি করে `.env` নাম দিয়ে সেটা এডিট করুন)

### ধাপ ৫ — চালান ও যাচাই করুন
```bash
npm install
npm run dev
```
তারপর UI-এর **"Telegram Storage"** ট্যাবে গিয়ে **"Verify Connection"** চাপুন। ✅ পেলে সব রেডি!

---

## 🔌 API এন্ডপয়েন্ট

| Method | Endpoint | কাজ |
|---|---|---|
| GET | `/api/v1/telegram/status` | কনফিগ/কানেকশন স্ট্যাটাস |
| POST | `/api/v1/telegram/verify` | বট+চ্যানেল যাচাই, টেস্ট মেসেজ পাঠায় |
| POST | `/api/v1/telegram/sync` | সব লোকাল ডেটা Telegram-এ পাঠায় |
| POST | `/api/v1/telegram/snapshot` | পুরো DB-র JSON snapshot ফাইল আপলোড করে |
| GET | `/api/v1/telegram/snapshots` | snapshot ও index-এর লিস্ট |
| POST | `/api/v1/telegram/restore` | `{ "fileId": "..." }` দিয়ে snapshot থেকে restore |
| POST | `/api/v1/backup` | raw `.db` ফাইল ব্যাকআপ |

---

## 🔁 Snapshot + Restore — উদাহরণ

Snapshot নিলে এরকম একটা উত্তর পাবেন:
```json
{
  "success": true,
  "fileId": "BQACAgQAAx...",
  "messageId": 12,
  "hint": "Keep this fileId safe — use it to restore everything later."
}
```

Restore করতে:
```bash
curl -X POST http://localhost:3000/api/v1/telegram/restore \
  -H "Content-Type: application/json" \
  -d '{"fileId":"BQACAgQAAx..."}'
```

`fileId` ছাড়া `/restore` কল করলে **সর্বশেষ snapshot** অটো ব্যবহার হবে।

---

## 🔒 নিরাপত্তা টিপস
- Token কখনো GitHub-এ push করবেন না (`.env` `.gitignore`-এ আছে)
- চ্যানেল **Private** রাখুন; বট ছাড়া কেউ ঢুকতে পারবে না
- নিয়মিত snapshot নিন — এটাই আপনার ক্লাউড ব্যাকআপ
