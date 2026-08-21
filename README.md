# MY-AI

A self-hosted General AI platform with a built-in REST API and web-based control panel. Designed to be deployed on Render.

## Features

- REST API for AI interactions
- **Offline personal AI brain** — no external AI service: local memory,
  knowledge retrieval (RAG over your own documents), a trainable text model
  that learns your writing style, plus a safe math engine.
- **Gemini-style web UI** — the whole control panel looks and works like the
  Gemini web chat: light theme, "New chat" pill + recent chats sidebar,
  centered conversation column, suggestion cards, pill composer with working
  attachment (text file → knowledge doc) and voice input, copy / regenerate /
  speak / save-to-knowledge actions on every AI reply. Mobile drawer layout.
- **Training page with chat 💬** — chat with the AI right on the Training page;
  every message is stored as training data (`source='training'`). With the
  optional `ADMIN_PASSWORD` set, Training and all write actions are
  admin-only; without it, the panel owner is the admin (single-user app).
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
  needed.
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
- **Train your own model** — LoRA fine-tuning pipeline for a fully personal AI.
  See [`training/README.md`](./training/README.md).
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

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/research/status` | Which sources are ready / cooling down, cache + negative-cache stats, requests/minute |
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
| `DELETE /api/v1/chats/:id` | Delete a conversation and its messages |

Optional `ADMIN_PASSWORD` — when set, Training and all write actions
(train model, knowledge, memory, users, restore, research reset, …) require
the password from the web UI (`x-admin-token` header). Left empty, the panel
behaves as a single-user admin panel.
