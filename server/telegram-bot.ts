/**
 * TelegramBot — chat with YOUR AI directly from Telegram.
 * --------------------------------------------------------
 * Uses long-polling (getUpdates), so it works on any self-hosted deployment
 * (Render, a VPS, your home server) WITHOUT a public webhook URL.
 *
 * Every text message is routed to the local AI brain, and every message is
 * persisted + mirrored to your Telegram cloud database. This is the fastest
 * way to talk to your personal AI from a phone — just open Telegram.
 */

const TG_API = "https://api.telegram.org";
const MAX_TEXT_LEN = 4000;

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; first_name?: string; last_name?: string; username?: string; type: string };
  text?: string;
  from?: { id: number; first_name?: string; username?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export type BotHandler = (msg: TelegramMessage) => Promise<string | null>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TelegramBot {
  private token: string;
  private offset = 0;
  private running = false;
  private handler: BotHandler;

  constructor(token: string, handler: BotHandler) {
    this.token = token.trim();
    this.handler = handler;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${TG_API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as any;
    if (!data.ok) {
      throw new Error(`Telegram Bot API error (${method}): ${data.description || `HTTP ${res.status}`}`);
    }
    return data.result;
  }

  /** Send a message, splitting it into 4000-char chunks if needed. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    if (!text) return;
    if (text.length <= MAX_TEXT_LEN) {
      await this.call("sendMessage", { chat_id: chatId, text });
      return;
    }
    // Split at sentence boundaries as much as possible.
    const parts: string[] = [];
    let rest = text;
    while (rest.length > MAX_TEXT_LEN) {
      let cut = rest.lastIndexOf("\n", MAX_TEXT_LEN);
      if (cut < MAX_TEXT_LEN * 0.5) cut = rest.lastIndexOf(". ", MAX_TEXT_LEN);
      if (cut < MAX_TEXT_LEN * 0.5) cut = MAX_TEXT_LEN;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    parts.push(rest);
    for (const p of parts) {
      await this.call("sendMessage", { chat_id: chatId, text: p });
    }
  }

  async setTyping(chatId: number): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // Best-effort only.
    }
  }

  private async pollOnce(): Promise<number> {
    const updates = (await this.call("getUpdates", {
      offset: this.offset,
      timeout: 25,
      allowed_updates: ["message"],
    })) as TelegramUpdate[];

    for (const u of updates) {
      this.offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || !msg.text) continue;
      try {
        const reply = await this.handler(msg);
        if (reply) await this.sendMessage(msg.chat.id, reply);
      } catch (e: any) {
        console.error("Telegram bot handler error:", e.message);
        try {
          await this.sendMessage(msg.chat.id, "⚠️ Sorry, something went wrong. Please try again.");
        } catch {
          // ignore
        }
      }
    }
    return updates.length;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log("🤖 Telegram bot started (long-polling).");
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (e: any) {
        const msg = e.message || e;
        console.error("Telegram bot poll error:", msg);
        // 409 means another poller is active (e.g. webhook) — recover offset anyway.
        await sleep(3000);
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("🤖 Telegram bot stopped.");
  }
}
