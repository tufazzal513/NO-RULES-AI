/**
 * In-memory Telegram mock.
 * -------------------------
 * The sandbox (and often Render's build step) cannot reach api.telegram.org, so
 * every test drives CloudSync through this fake channel instead. It implements
 * exactly the `TelegramLike` surface: documents keep a permanent `file_id`, a
 * pinned message points at the latest snapshot, and text records are appended
 * to a log we can assert against.
 */

import zlib from "zlib";

import type { TelegramLike } from "../server/cloud-sync.ts";

export interface MockRecord {
  collection: string;
  recordId: string;
  payload: any;
  messageId: number;
}

export class MockTelegram implements TelegramLike {
  configured = true;
  files = new Map<string, { name: string; content: Buffer; messageId: number }>();
  records: MockRecord[] = [];
  pinnedMessageId: number | null = null;
  uploads = 0;
  downloads = 0;

  /** Set to an Error to make every network call fail (offline simulation). */
  failWith: Error | null = null;
  /** Artificial latency in ms — lets tests exercise the concurrency locks. */
  uploadDelayMs = 0;

  private nextMessageId = 1;

  private async maybeFail(): Promise<void> {
    if (this.failWith) throw this.failWith;
  }

  async saveBuffer(fileName: string, content: Buffer, _caption?: string) {
    await this.maybeFail();
    if (this.uploadDelayMs > 0) await new Promise((r) => setTimeout(r, this.uploadDelayMs));
    await this.maybeFail();
    const messageId = this.nextMessageId++;
    const fileId = `file_${messageId}_${fileName}`;
    this.files.set(fileId, { name: fileName, content: Buffer.from(content), messageId });
    this.uploads++;
    return { messageId, fileId, fileName, date: Math.floor(Date.now() / 1000) };
  }

  async saveRecord(collection: string, recordId: string | number, payload: unknown) {
    await this.maybeFail();
    const messageId = this.nextMessageId++;
    this.records.push({ collection, recordId: String(recordId), payload, messageId });
    return { messageId, date: Math.floor(Date.now() / 1000), asFile: false };
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    await this.maybeFail();
    const f = this.files.get(fileId);
    if (!f) throw new Error(`Mock Telegram: unknown file_id ${fileId}`);
    this.downloads++;
    return f.content;
  }

  async findLatestSnapshot() {
    await this.maybeFail();
    if (this.pinnedMessageId === null) return null;
    for (const [fileId, f] of this.files) {
      if (f.messageId === this.pinnedMessageId) {
        return { fileId, fileName: f.name, messageId: f.messageId };
      }
    }
    return null;
  }

  async pinMessage(messageId: number): Promise<void> {
    await this.maybeFail();
    this.pinnedMessageId = messageId;
  }

  // -- test helpers ---------------------------------------------------------

  /** Overwrite a stored file's bytes to simulate corruption on the wire. */
  corruptFile(fileId: string, mutate: (json: any) => any): void {
    const f = this.files.get(fileId);
    if (!f) throw new Error("no such file");
    let raw = f.content;
    const wasGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    if (wasGzip) raw = zlib.gunzipSync(raw);
    const doc = JSON.parse(raw.toString("utf-8"));
    const next = Buffer.from(JSON.stringify(mutate(doc)), "utf-8");
    f.content = wasGzip ? zlib.gzipSync(next) : next;
  }

  recordsFor(collection: string): MockRecord[] {
    return this.records.filter((r) => r.collection === collection);
  }

  /** Silence the CloudSync logger during tests. */
  static silentLogger() {
    return { log: () => {}, warn: () => {}, error: () => {} };
  }
}
