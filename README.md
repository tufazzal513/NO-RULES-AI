# MY-AI

A self-hosted General AI platform with a built-in REST API and web-based control panel. The **runtime is Node.js only** (Express + React/Vite + SQLite). Python is used solely for the optional LoRA training pipeline in [`training/`](./training/). Designed to be deployed on Render.

## Features

- REST API for AI interactions
- **Offline personal AI brain** — no external AI service: local memory,
  knowledge retrieval (RAG over your own documents), a trainable text model
  that learns your writing style, plus a safe math engine.
- **Gemini-style web UI (static dark theme 🌙)** — the whole control panel
  looks and works like the Gemini web chat, restyled in a fixed dark theme:
  "New chat" pill + recent chats sidebar, centered conversation column,
  suggestion cards, pill composer with working attachment (text file →
  knowledge doc) and voice input, copy / regenerate / speak /
  save-to-knowledge actions on every AI reply. Mobile drawer layout.
- **Training page with chat 💬** — chat with the AI right on the Training page;
  every message is stored as training data (`source='training'`). With the
  optional `ADMIN_PASSWORD` set, Training and all write actions are
  admin-only; without it, the panel owner is the admin (single-user app).
- **Background training — live view 🏋️** — a live panel on the Training page
  shows exactly how the AI trains itself in the background: status
  (idle / scheduled / running), an animated progress bar, a step-by-step phase
  log and a run history (trigger, duration, chains + vocab learned). Every
  automatic retrain is also written to the Activity log and exposed through
  `GET /api/v1/ai/training`.
- **Push training data 📥** — on the Training page you can import files
  (`.txt` / `.md` / `.jsonl`, other-AI dumps, `User:/AI:` transcripts) **or
  paste text straight into a box**; both are chunked into knowledge + Q/A
  pairs and trigger an automatic background retrain.
- **Fully working Control Panel** — Dashboard (live status + quick actions),
  Training, Research, Datasets (stats + JSONL export + per-chat delete),
  Users (add/list/delete), Telegram Cloud, Settings (live config) and
  Activity (in-memory log viewer). No demo placeholders left.
- Database Support (SQLite / PostgreSQL)
- **Telegram Cloud Database** — a free, unlimited cloud store built on a Telegram
  bot + private channel. Every record is mirrored to the channel; full JSON
  snapshots can be restored any time. See [`TELEGRAM_SETUP.md`](./TELEGRAM_SETUP.md).
- **Chat from Telegram 📱** — the same bot doubles as your AI assistant: message
  it in Telegram (from your phone) and your AI replies. Long-polling, no webhook
  needed. **Every web shortcut exists as a slash command too** — `/new`,
  `/history`, `/chats`, `/edit <new text>`, `/again`, `/undo`, `/clear`,
  `/forget`, `/research <topic>` — and the bot answers in whichever of
  English / বাংলা / Banglish you have been writing in.
- **Trilingual brain 🗣️ — English, বাংলা and Banglish.** Write however you
  like ("what is my name", "আমার নাম কী", "amar nam ki") — one canonical
  matcher folds all three onto the same intent, and the reply comes back in the
  language you used. Banglish is transliterated to Bengali before searching, so
  "Bangladesher rajdhani ki?" is looked up as "বাংলাদেশের রাজধানী".
  See [`server/ai/language.ts`](./server/ai/language.ts).
- **Chat shortcuts ⌨️** — searchable history (⌘/Ctrl + K), new chat
  (⌘/Ctrl + Shift + O), edit a question you already sent and get a fresh answer
  (↑ or the ✏️ button), regenerate (⌘/Ctrl + Shift + R), rename a chat
  (double-click), delete a single message, delete a chat
  (⌘/Ctrl + Shift + ⌫) and "Clear all". Press ⌘/Ctrl + / for the cheat sheet.
- **Online research 🔎 — free, keyless, no signup, hardened.** Seventeen public
  sources (English **and Bengali Wikipedia**, DuckDuckGo Instant Answer/HTML/Lite,
  8 rotating SearXNG instances, Mojeek, Wiktionary, Marginalia, Wikipedia REST
  summary), each on its own hostname. Automatic lookups can't get "blocked":
  per-host circuit breakers (exponential backoff 1→15 min, honouring
  `Retry-After`), a hard per-call attempt cap, a global per-minute request cap,
  6 rotating browser User-Agents, polite spacing, permanent cache with
  stale-cache fallback, a negative cache (cleanly-failed topics aren't
  re-searched for a while — `/research <topic>` forces a bypass), fast offline
  detection (2 consecutive network errors stop the call early), one retry per
  source for transient blips, request de-duplication and a hard time budget.
  The AI answers from its own brain first (math, memory, knowledge documents)
  and only goes online when it cannot; `/research <topic>` forces a lookup.
  Bengali questions (কে, কী, কেন, কীভাবে, সর্বশেষ, খবর …) are detected too.
  Every finding is saved as a knowledge document and into the Telegram
  snapshot, so it survives Render restarts and can be answered later with no
  internet at all.
- **Training data from 2 places** — (1) every chat exchange (web / training /
  Telegram) and (2) research findings auto-saved as knowledge documents.
  Both are automatic, both are mirrored to the Telegram snapshot, and the
  Datasets page shows exactly where each training example came from.
- **Train your own model** — LoRA fine-tuning pipeline for a fully personal AI,
  with a **1–5 hour Google Colab notebook** that teaches it Bangla + English
  conversation inside a wall-clock time budget (auto Bangla/English dataset mix,
  GPU speed probe, checkpoint/resume, GGUF export for Ollama).
  See [`training/GUIDE_COLAB_BN.md`](./training/GUIDE_COLAB_BN.md) and
  [`training/README.md`](./training/README.md).
- Render Deployment Ready

## Deployment on Render

The repository includes a Dockerfile and a ready-to-use `render.yaml` Blueprint
for the current Node.js application.

1. Push the repository to GitHub.
2. In Render, choose **New > Blueprint**.
3. Select this repository and apply the Blueprint.
4. Enter `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STORAGE_CHAT_ID` as Render secrets
   (or leave them blank until Telegram is configured).
5. Open `/api/v1/health/detailed` on the deployed URL to verify the service.

**Important:** Render Free services sleep after inactivity and their local SQLite
files are ephemeral. For durable data and an always-on Telegram bot, use a paid
service with a persistent disk. See the complete Bengali guide:
[`DEPLOY_RENDER.md`](./DEPLOY_RENDER.md).

## Data restore — what was fixed

The Telegram private channel is the permanent database and the local SQLite
file is only a cache, so "restore" has to be bullet-proof. Four real failure
modes were closed:

| Problem | Fix |
| --- | --- |
| A restore succeeded but the AI kept answering from the **pre-restore model** | `CloudSync` now fires an `onRestored` hook after *every* successful restore (startup, manual, or from a file) and the server reloads the AI model there |
| Older backups (schema v1, before the research cache existed) were **rejected as "incomplete"** and could never be restored | `validateSnapshot` knows which tables each schema version is required to carry; tables that did not exist yet are treated as empty. A table missing from a *current*-schema snapshot is still rejected |
| The latest snapshot was discoverable **only through the pinned message** — if the bot lost "Pin Messages" rights or the pin was removed, a wiped container reported "no snapshot found" | The snapshot `file_id` is now also written into the **channel description**, a second durable pointer that `getChat` always returns. Discovery order: pin → description → local index |
| A failed restore pinned the app in `restore_failed` **until a full restart** (Telegram bot off, error banner stuck) | `POST /api/v1/telegram/restore/dismiss` (a button in the Telegram Cloud tab) clears the failure, restarts the bot and re-enables auto-snapshots |

On top of that there is now an offline escape hatch: **Restore from file**
(`POST /api/v1/telegram/restore/file`) accepts a `myai_snapshot_*.json` /
`.json.gz` downloaded earlier, validates it exactly like a Telegram snapshot
and applies it in the same single transaction — so a wrong channel id or a
de-admined bot can never lock you out of your own data.

Guarantees that were already there and still hold: a corrupt or
checksum-mismatched snapshot is never applied, an empty remote snapshot never
overwrites a non-empty local database, and the whole import runs in ONE
transaction — a failure leaves the database exactly as it was.

## Custom Domain Setup

Render supports custom domains natively. To add one:
1. Go to your Render Web Service Dashboard.
2. Click **Settings > Custom Domains**.
3. Click **Add Custom Domain** and enter your domain.
4. Configure your DNS provider with the CNAME/A records provided by Render.
5. Your API will now be available at `https://your-domain.com/api/v1/...` without any code changes!

## API check

Once deployed, visit `https://your-domain.com/api/v1/health/detailed` to verify
that the API, SQLite database, local AI brain, and Telegram configuration are
available.

## Online research

The AI researches automatically when a question cannot be answered from the
local brain, and every chat reply stays inside a hard time budget (default
4000 ms — configurable with `RESEARCH_TIMEOUT_MS`).

**How an answer is chosen (accuracy, not just availability):**

1. **Query cleaning** — conversational filler is stripped before anything is
   sent to a search engine. `"can you please tell me who is alan turing?"`
   becomes `"who is alan turing"`; `"বাংলাদেশের রাজধানী কী"` becomes
   `"বাংলাদেশের রাজধানী"`.
2. **Language routing** — a Bengali/Banglish question starts at
   `bn.wikipedia.org` (and is transliterated into Bengali first); an English
   question starts at the English engines. Sources that cannot help are skipped
   without spending an attempt: the Wikipedia "exact title" endpoint is only
   used for short, title-like topics, and Wiktionary only for single words.
3. **Relevance ranking** — every hit is scored against the question's
   meaningful terms. The *best* hit inside a source is used (not blindly the
   first one), and a source whose best hit is unrelated is skipped so the next
   source gets a chance. Only a strongly matching answer ends the search.
4. **Alternative spelling retry** — if nothing matched, the other spelling of
   the same question (Banglish ⇄ বাংলা) is tried once, inside the same budget.
5. **Honest confidence** — the finding carries a `confidence` score, and a
   low-confidence answer is labelled as "the closest match I found" instead of
   being presented as fact.

The Markov model is never used to answer a *question* any more — it only
contributes to open-ended chit-chat, so a question either gets a real answer or
an honest "I don't know yet".

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/research/status` | Which sources are ready / cooling down, cache + negative-cache stats, requests/minute |
| `GET /api/v1/research/selftest` | Probe every live source (English + বাংলা + Banglish) — per-source pass/fail, latency, sample answer |
| `POST /api/v1/research` | Force a lookup now — body `{ "topic": "…" }` |
| `POST /api/v1/research/reset` | Reopen every circuit breaker — body `{ "clearCache": false }` optionally wipes the caches |

Optional, non-secret environment variables (defaults shown in `.env.example`):

- `RESEARCH_ENABLED=true` — master switch for online research
- `RESEARCH_CACHE_TTL_MINUTES=360` — how long a cached finding stays fresh
- `RESEARCH_TIMEOUT_MS=4000` — hard time budget per research call
- `RESEARCH_SAVE_TO_KNOWLEDGE=true` — save findings as knowledge documents
- `RESEARCH_MAX_ATTEMPTS=8` — max sources one question may touch
- `RESEARCH_MAX_REQUESTS_PER_MINUTE=60` — global cap so automatic lookups can never hammer the sources into blocking

Every finding is stored in the permanent cache **and** as a knowledge document,
so both survive Render restarts through the Telegram snapshot — and can answer
the same question later even with no internet connection.

## Control panel API

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/auth/status` · `POST /api/v1/auth/verify` | Admin-password state / verification (only when `ADMIN_PASSWORD` is set) |
| `GET /api/v1/logs` | Recent activity (in-memory ring buffer — no secrets ever logged) |
| `GET /api/v1/settings` | Non-secret runtime configuration |
| `GET /api/v1/dataset/stats` | Where every training example comes from |
| `GET/POST /api/v1/users`, `DELETE /api/v1/users/:id` | User management (Telegram-mirrored) |
| `GET /api/v1/chats?q=…&limit=…` | Chat history with message counts, previews and full-text search over titles **and** message text |
| `PATCH /api/v1/chats/:id` | Rename a conversation |
| `DELETE /api/v1/chats/:id` | Delete a conversation and its messages |
| `DELETE /api/v1/chats` | Clear the whole chat history (knowledge, memory and the trained model are kept) |
| `PATCH /api/v1/chats/:id/messages/:messageId` | Edit a question you already sent — the stale answer is dropped and the AI replies again |
| `DELETE /api/v1/chats/:id/messages/:messageId` | Delete a message (a question takes its answer with it) |
| `POST /api/v1/chats/:id/regenerate` | Answer the last question again |
| `POST /api/v1/telegram/restore/file` | Restore from an uploaded snapshot file — the escape hatch when Telegram itself is misconfigured |
| `POST /api/v1/telegram/restore/dismiss` | Leave the `restore_failed` state and continue with the local data |

Optional `ADMIN_PASSWORD` — when set, Training and all write actions
(train model, knowledge, memory, users, restore, research reset, …) require
the password from the web UI (`x-admin-token` header). Left empty, the panel
behaves as a single-user admin panel.

## Chat shortcuts

Everything a chat app is expected to have, on the keyboard and in the UI.

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl + K` | Search the chat history — matches chat titles **and** message text |
| `⌘/Ctrl + Shift + O` | Start a new chat |
| `⌘/Ctrl + B` | Show / hide the sidebar |
| `↑` (empty composer) or `⌘/Ctrl + ↑` | Edit the question you sent last |
| `⌘/Ctrl + Shift + R` | Regenerate the last answer |
| `⌘/Ctrl + Shift + ⌫` | Delete the open chat |
| `Enter` / `Shift + Enter` | Send / new line |
| `Esc` | Close the editor, the search palette or any modal |
| `⌘/Ctrl + /` | Show this cheat sheet inside the app |

Mouse equivalents: hover a **user message** for ✏️ edit / 📋 copy / 🗑️ delete,
hover an **AI message** for copy / regenerate / speak / save-to-knowledge,
**double-click a chat** in the sidebar to rename it, and use **Clear all** at the
top of the Recent list to wipe the whole history (knowledge, memory and the
trained model are never touched).

Editing a question is a real edit, not a re-send: the message is rewritten in
place, every message that came after it is removed (the old answer is no longer
valid) and the AI answers the new wording — the same way ChatGPT/Gemini behave.

The **Training tab** chat has the same edit / delete / regenerate controls, so a
bad training exchange can be corrected instead of polluting the dataset.

### …and the same shortcuts on your phone

| Telegram command | Same as |
| --- | --- |
| `/new` | New chat |
| `/history [n]` | Scroll back through this conversation |
| `/chats` | The Recent list (▶️ marks the active one) |
| `/edit <new text>` | ✏️ Edit the last question and rerun |
| `/again` | 🔄 Regenerate |
| `/undo` | 🗑️ Delete the last question + answer |
| `/clear` | Delete every message of this conversation |
| `/forget` | Wipe the AI's memory of you |
| `/help` | The cheat sheet (⌘/Ctrl + /) |

The bot picks its language from your recent messages, so a Banglish user gets
Banglish command replies without configuring anything.
