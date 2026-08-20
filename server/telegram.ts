/**
 * Telegram Cloud Storage
 * -----------------------
 * Uses a Telegram bot + a private channel as a free, unlimited cloud database.
 *
 *  - Every record (conversations, chat messages, memories, knowledge, ...)
 *    is pushed to the channel as a JSON message (append-only audit log).
 *  - Full snapshots are uploaded to the channel as JSON files. A snapshot's
 *    `file_id` is permanent, so we can re-download the exact file any time
 *    via `getFile` — that is the mechanism that lets us "restore from Telegram".
 *  - A local SQLite table (`telegram_index`) keeps the mapping between local
 *    records and their Telegram message/file ids.
 *
 * NOTE: a bot cannot list a channel's message history via the API. That is why
 * we keep file_id/message_id locally and re-download by id. This is the correct
 * way to use Telegram as a durable store.
 */

import fs from "fs";
import path from "path";

const TG_API = "https://api.telegram.org";
// Telegram text messages are capped at 4096 chars.
const MAX_TEXT_LEN = 4000;

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

export interface TelegramStatus {
  configured: boolean;
  botTokenSet: boolean;
  chatIdSet: boolean;
  botUsername?: string;
  botName?: string;
  channelTitle?: string;
  channelType?: string;
}

export class TelegramStorage {
  botToken: string;
  chatId: string;
  configured: boolean;

  constructor(config: TelegramConfig) {
    this.botToken = (config.botToken || "").trim();
    this.chatId = (config.chatId || "").trim();
    this.configured = Boolean(this.botToken && this.chatId);
  }

  private requireConfig(): void {
    if (!this.configured) {
      throw new Error(
        "Telegram storage is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_STORAGE_CHAT_ID."
      );
    }
  }

  /** Generic JSON API call (no file upload). */
  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    this.requireConfig();
    const res = await fetch(`${TG_API}/bot${this.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as any;
    if (!data.ok) {
      throw new Error(`Telegram API error (${method}): ${data.description || `HTTP ${res.status}`}`);
    }
    return data.result;
  }

  /** Multipart API call for file uploads. */
  private async callMultipart(
    method: string,
    fields: Record<string, string>,
    file?: { name: string; content: Buffer }
  ): Promise<any> {
    this.requireConfig();
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    if (file) {
      form.append("document", new Blob([file.content]), file.name);
    }
    const res = await fetch(`${TG_API}/bot${this.botToken}/${method}`, {
      method: "POST",
      body: form,
    });
    const data = (await res.json()) as any;
    if (!data.ok) {
      throw new Error(`Telegram API error (${method}): ${data.description || `HTTP ${res.status}`}`);
    }
    return data.result;
  }

  /** Return info about the configured bot + channel (validates the setup). */
  async status(): Promise<TelegramStatus> {
    const base: TelegramStatus = {
      configured: this.configured,
      botTokenSet: Boolean(this.botToken),
      chatIdSet: Boolean(this.chatId),
    };
    if (!this.configured) return base;

    try {
      const bot = await this.getMe();
      base.botUsername = bot.username;
      base.botName = bot.first_name;
      const channel = await this.call("getChat", { chat_id: this.chatId });
      base.channelTitle = channel.title;
      base.channelType = channel.type;
    } catch (err: any) {
      base.channelTitle = "ERROR: " + (err.message || err);
    }
    return base;
  }

  async getMe(): Promise<any> {
    return this.call("getMe", {});
  }

  /** Verify that the bot can actually post to the channel. */
  async verify(): Promise<{ bot: any; channel: any; testMessageId: number }> {
    const bot = await this.getMe();
    let channel: any;
    try {
      channel = await this.call("getChat", { chat_id: this.chatId });
    } catch (err: any) {
      throw new Error(
        `Cannot access chat "${this.chatId}". Make sure the bot is an admin of the channel (with "Post Messages" permission). ${err.message}`
      );
    }
    // Send a harmless test message to confirm write access.
    const test = await this.call("sendMessage", {
      chat_id: this.chatId,
      text: `✅ Storage connected — ${new Date().toISOString()}`,
      disable_notification: true,
    });
    return { bot, channel, testMessageId: test.message_id };
  }

  /** Save a JSON record to the channel. Returns Telegram message_id + date. */
  async saveRecord(
    collection: string,
    recordId: string | number,
    payload: unknown
  ): Promise<{ messageId: number; date: number; asFile: boolean }> {
    const header = `📦 ${collection} #${recordId}\n`;
    const json = JSON.stringify(payload, null, 0);
    const asFile = header.length + json.length > MAX_TEXT_LEN;

    if (!asFile) {
      const result = await this.call("sendMessage", {
        chat_id: this.chatId,
        text: header + json,
        disable_web_page_preview: true,
      });
      return { messageId: result.message_id, date: result.date, asFile: false };
    }

    const fileName = `${collection}_${recordId}_${Date.now()}.json`;
    const result = await this.callMultipart(
      "sendDocument",
      { chat_id: this.chatId, caption: header + "(long record stored as file)" },
      { name: fileName, content: Buffer.from(json, "utf-8") }
    );
    return { messageId: result.message_id, date: result.date, asFile: true };
  }

  /** Upload a local file to the channel. Returns message_id + permanent file_id. */
  async saveFile(
    filePath: string,
    caption?: string
  ): Promise<{ messageId: number; fileId: string; fileName: string; date: number }> {
    const fileName = path.basename(filePath);
    const content = fs.readFileSync(filePath);
    const result = await this.callMultipart(
      "sendDocument",
      {
        chat_id: this.chatId,
        caption: caption || `📁 ${fileName} — ${new Date().toISOString()}`,
      },
      { name: fileName, content }
    );
    return {
      messageId: result.message_id,
      fileId: result.document?.file_id || "",
      fileName,
      date: result.date,
    };
  }

  /** Send plain text to the channel. */
  async sendText(text: string): Promise<{ messageId: number }> {
    const result = await this.call("sendMessage", { chat_id: this.chatId, text });
    return { messageId: result.message_id };
  }

  /** Download a file (or JSON snapshot) by its permanent file_id. */
  async downloadFile(fileId: string): Promise<Buffer> {
    const fileInfo = await this.call("getFile", { file_id: fileId });
    const filePath = fileInfo.file_path;
    if (!filePath) throw new Error("Telegram returned no file_path for the given file_id.");
    const res = await fetch(`${TG_API}/file/bot${this.botToken}/${filePath}`);
    if (!res.ok) throw new Error(`Failed to download file from Telegram: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
