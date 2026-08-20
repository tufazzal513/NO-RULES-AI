# MY-AI

A self-hosted General AI platform with a built-in REST API and web-based control panel. Designed to be deployed on Render.

## Features

- REST API for AI interactions
- **Offline personal AI brain** — no external AI service: local memory,
  knowledge retrieval (RAG over your own documents), a trainable text model
  that learns your writing style, plus a safe math engine.
- Admin Control Panel (Web Dashboard)
- Extensible Model Interface
- Database Support (SQLite / PostgreSQL)
- **Telegram Cloud Database** — a free, unlimited cloud store built on a Telegram
  bot + private channel. Every record is mirrored to the channel; full JSON
  snapshots can be restored any time. See [`TELEGRAM_SETUP.md`](./TELEGRAM_SETUP.md).
- **Chat from Telegram 📱** — the same bot doubles as your AI assistant: message
  it in Telegram (from your phone) and your AI replies. Long-polling, no webhook
  needed.
- **Online research 🔎 — free, keyless, no signup.** Seven public sources
  (Wikipedia Search API, DuckDuckGo Instant Answer/HTML/Lite, 5 rotating SearXNG
  instances, Mojeek, Wikipedia REST summary), each on its own hostname. Rate
  limits are handled with per-host circuit breakers (exponential backoff
  1→15 min, honouring `Retry-After`), 6 rotating browser User-Agents, polite
  request spacing, a permanent cache with stale-cache fallback, request
  de-duplication and a hard time budget — an offline chat never hangs.
  The AI answers from its own brain first (math, memory, knowledge documents)
  and only goes online when it cannot; `/research <topic>` forces a lookup.
  Bengali questions (কে, কী, কেন, কীভাবে, সর্বশেষ, খবর …) are detected too.
  Every finding is saved as a knowledge document and into the Telegram
  snapshot, so it survives Render restarts and can be answered later with no
  internet at all.
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
| `GET /api/v1/research/status` | Which sources are ready / cooling down, cache stats, saved findings |
| `POST /api/v1/research` | Force a lookup now — body `{ "topic": "…" }` |
| `POST /api/v1/research/reset` | Reopen every circuit breaker — body `{ "clearCache": false }` optionally wipes the cache |

Optional, non-secret environment variables (defaults shown in `.env.example`):

- `RESEARCH_ENABLED=true` — master switch for online research
- `RESEARCH_CACHE_TTL_MINUTES=360` — how long a cached finding stays fresh
- `RESEARCH_TIMEOUT_MS=4000` — hard time budget per research call
- `RESEARCH_SAVE_TO_KNOWLEDGE=true` — save findings as knowledge documents

Every finding is stored in the permanent cache **and** as a knowledge document,
so both survive Render restarts through the Telegram snapshot — and can answer
the same question later even with no internet connection.
