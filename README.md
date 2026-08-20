# MY-AI

A self-hosted General AI platform with a built-in REST API and web-based control panel. Designed to be deployed on Render.

## Features

- REST API for AI interactions
- Admin Control Panel (Web Dashboard)
- Extensible Model Interface
- Database Support (SQLite / PostgreSQL)
- **Telegram Cloud Database** — a free, unlimited cloud store built on a Telegram
  bot + private channel. Every record is mirrored to the channel; full JSON
  snapshots can be restored any time. See [`TELEGRAM_SETUP.md`](./TELEGRAM_SETUP.md).
- Render Deployment Ready

## Deployment on Render

This project natively supports Render.

1.  **Create GitHub repository:** Push this project to a new GitHub repository.
2.  **Connect repository to Render:** Go to your Render dashboard and click **New > Web Service**.
3.  Select your repository.
4.  **Settings:**
    - **Language:** Python 3
    - **Build Command:** `pip install -r requirements.txt`
    - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
5.  **Environment Variables:** Add the variables listed in `.env.example`.
6.  **Deploy:** Click "Create Web Service".

## Custom Domain Setup

Render supports custom domains natively. To add one:
1. Go to your Render Web Service Dashboard.
2. Click **Settings > Custom Domains**.
3. Click **Add Custom Domain** and enter your domain.
4. Configure your DNS provider with the CNAME/A records provided by Render.
5. Your API will now be available at `https://your-domain.com/api/v1/...` without any code changes!

## API Documentation

Once deployed, visit:
- `https://your-domain.com/docs` for interactive Swagger UI.
- `https://your-domain.com/redoc` for ReDoc.
