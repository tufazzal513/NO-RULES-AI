/**
 * CloudSync — glue between the ephemeral SQLite cache and the permanent
 * Telegram private-channel database.
 * ---------------------------------------------------------------------------
 * Responsibilities:
 *   1. Application state machine: starting → restoring → ready | restore_failed
 *   2. Startup automatic restore (only when the local DB is fresh/empty)
 *   3. Periodic + final (shutdown) snapshots with a mutual-exclusion lock
 *   4. Mirroring every important change to the channel (incl. delete tombstones)
 *
 * Telegram is always best-effort: a network failure logs a warning and the
 * local AI keeps serving requests. It must never crash the app.
 */

import {
  CORE_DATA_TABLES,
  getSyncState,
  isDatabaseEmpty,
  setSyncState,
  tableCounts,
} from "./db.ts";
import {
  buildSnapshot,
  coreChecksum,
  coreRecordCount,
  describeSnapshot,
  importDump,
  parseSnapshotBuffer,
  serializeSnapshot,
  validateSnapshot,
  type SnapshotDocument,
} from "./snapshot.ts";

export type AppState = "starting" | "restoring" | "ready" | "restore_failed";

/** The minimal slice of TelegramStorage that CloudSync needs (easy to mock). */
export interface TelegramLike {
  configured: boolean;
  saveBuffer(
    fileName: string,
    content: Buffer,
    caption?: string
  ): Promise<{ messageId: number; fileId: string; fileName: string; date: number }>;
  saveRecord(
    collection: string,
    recordId: string | number,
    payload: unknown
  ): Promise<{ messageId: number; date: number; asFile: boolean }>;
  downloadFile(fileId: string): Promise<Buffer>;
  findLatestSnapshot(): Promise<{ fileId: string; fileName: string; messageId: number } | null>;
  pinMessage(messageId: number): Promise<void>;
  /** Optional second, durable pointer to the latest snapshot (channel description). */
  setSnapshotPointer?(fileId: string, createdAt: string, records: number): Promise<void>;
}

export interface CloudSyncOptions {
  db: any;
  telegram: TelegramLike;
  autoRestore?: boolean;
  autoSnapshot?: boolean;
  restoreOnEmptyOnly?: boolean;
  snapshotIntervalMinutes?: number;
  gzip?: boolean;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /**
   * Called after every SUCCESSFUL restore, inside the same call.
   * The server uses it to reload the AI model — without this the brain kept
   * serving the pre-restore Markov chain and the restore looked like it had
   * "not worked".
   */
  onRestored?: (restored: Record<string, number>) => void;
}

export interface SnapshotOutcome {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  fileId?: string;
  messageId?: number;
  fileName?: string;
  counts?: Record<string, number>;
  checksum?: string;
  totalRecords?: number;
  error?: string;
}

export interface RestoreOutcome {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  restored?: Record<string, number>;
  fileId?: string;
  checksum?: string;
  error?: string;
}

const LAST_SNAPSHOT_CHECKSUM = "last_snapshot_checksum";
const LAST_RESTORE_CHECKSUM = "last_restore_checksum";

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

export class CloudSync {
  private db: any;
  private telegram: TelegramLike;
  private log: Pick<Console, "log" | "warn" | "error">;

  readonly autoRestore: boolean;
  readonly autoSnapshot: boolean;
  readonly restoreOnEmptyOnly: boolean;
  readonly snapshotIntervalMinutes: number;
  private gzip: boolean;

  private state: AppState = "starting";
  private snapshotRunning = false;
  private restoreRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onRestored?: (restored: Record<string, number>) => void;

  lastSnapshotAt: string | null = null;
  lastRestoreAt: string | null = null;
  latestSnapshotFileId: string | null = null;
  latestSnapshotMessageId: number | null = null;
  nextSnapshotAt: string | null = null;
  lastError: string | null = null;

  constructor(opts: CloudSyncOptions) {
    this.db = opts.db;
    this.telegram = opts.telegram;
    this.log = opts.logger ?? console;
    this.autoRestore = opts.autoRestore ?? true;
    this.autoSnapshot = opts.autoSnapshot ?? true;
    this.restoreOnEmptyOnly = opts.restoreOnEmptyOnly ?? true;
    this.snapshotIntervalMinutes = Math.max(1, Number(opts.snapshotIntervalMinutes) || 30);
    this.gzip = opts.gzip ?? true;
    this.onRestored = opts.onRestored;
  }

  /** Register/replace the post-restore hook (the server wires `ai.reload`). */
  setOnRestored(hook: (restored: Record<string, number>) => void): void {
    this.onRestored = hook;
  }

  // -- state ----------------------------------------------------------------

  getState(): AppState {
    return this.state;
  }

  private setState(next: AppState): void {
    this.state = next;
  }

  /** True while a restore is in flight — chat APIs answer 503 in that window. */
  isRestoring(): boolean {
    return this.state === "restoring" || this.restoreRunning;
  }

  /** True once startup finished; the Telegram bot only polls when ready. */
  isReady(): boolean {
    return this.state === "ready";
  }

  isSnapshotRunning(): boolean {
    return this.snapshotRunning;
  }

  markReady(): void {
    if (this.state !== "restore_failed") this.setState("ready");
  }

  // -- snapshot -------------------------------------------------------------

  /**
   * Build + upload a full snapshot. Returns `skipped` (not an error) when a
   * snapshot is already running, a restore is in progress, Telegram is not
   * configured, or nothing changed since the previous snapshot.
   */
  async snapshot(opts: { force?: boolean; reason?: string } = {}): Promise<SnapshotOutcome> {
    if (!this.telegram.configured) {
      return { success: false, skipped: true, reason: "Telegram is not configured." };
    }
    if (this.restoreRunning || this.state === "restoring") {
      return { success: false, skipped: true, reason: "A restore is in progress." };
    }
    if (this.snapshotRunning) {
      return { success: false, skipped: true, reason: "A snapshot is already running." };
    }

    this.snapshotRunning = true;
    try {
      const doc = buildSnapshot(this.db);
      const dataChecksum = coreChecksum(doc.data);
      const previous = getSyncState(this.db, LAST_SNAPSHOT_CHECKSUM);
      if (!opts.force && previous && previous === dataChecksum) {
        this.log.log("📦 Snapshot skipped — no data changed since the last snapshot.");
        return {
          success: true,
          skipped: true,
          reason: "No data changed since the last snapshot.",
          checksum: doc.meta.checksum,
          counts: doc.meta.counts,
          totalRecords: doc.meta.totalRecords,
        };
      }

      const { buffer, fileName } = serializeSnapshot(doc, this.gzip);
      const caption =
        `📦 MY-AI snapshot\n` +
        `schema: v${doc.meta.schemaVersion}\n` +
        `created: ${doc.meta.createdAt}\n` +
        `records: ${doc.meta.totalRecords}\n` +
        `checksum: ${doc.meta.checksum}\n` +
        Object.entries(doc.meta.counts)
          .map(([t, n]) => `• ${t}: ${n}`)
          .join("\n") +
        (opts.reason ? `\ntrigger: ${opts.reason}` : "");

      const result = await this.telegram.saveBuffer(fileName, buffer, caption);

      // Only AFTER the upload fully succeeded is this the "latest valid snapshot".
      this.latestSnapshotFileId = result.fileId;
      this.latestSnapshotMessageId = result.messageId;
      this.lastSnapshotAt = new Date().toISOString();
      this.lastError = null;
      setSyncState(this.db, LAST_SNAPSHOT_CHECKSUM, dataChecksum);

      try {
        this.db
          .prepare(
            "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
          )
          .run("snapshot", result.fileId, result.messageId, result.fileId);
      } catch (e: any) {
        this.log.warn("⚠️  Could not index snapshot locally:", e.message);
      }

      // Pin it so a wiped container can rediscover it via getChat.
      try {
        await this.telegram.pinMessage(result.messageId);
      } catch (e: any) {
        this.log.warn("⚠️  Could not pin the snapshot message:", e.message);
      }

      // Second, independent pointer (channel description). Pinning can be
      // revoked or fail silently; without this a wiped container sometimes
      // could not find its own backup — the "restore finds nothing" bug.
      try {
        await this.telegram.setSnapshotPointer?.(result.fileId, doc.meta.createdAt, doc.meta.totalRecords);
      } catch (e: any) {
        this.log.warn("⚠️  Could not update the channel snapshot pointer:", e.message);
      }

      this.log.log(
        `📦 Snapshot uploaded to Telegram — ${doc.meta.totalRecords} records, checksum ${doc.meta.checksum.slice(0, 12)}…`
      );
      return {
        success: true,
        fileId: result.fileId,
        messageId: result.messageId,
        fileName: result.fileName,
        counts: doc.meta.counts,
        checksum: doc.meta.checksum,
        totalRecords: doc.meta.totalRecords,
      };
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      this.log.warn("⚠️  Snapshot failed (local AI keeps working):", this.lastError);
      return { success: false, error: this.lastError };
    } finally {
      this.snapshotRunning = false;
      this.scheduleNextLabel();
    }
  }

  // -- restore --------------------------------------------------------------

  /**
   * Download + validate + transactionally restore a snapshot.
   * Guards enforced here:
   *   - never while a snapshot is running (mutual exclusion)
   *   - never overwrite a non-empty local DB when `restoreOnEmptyOnly`
   *   - never apply a corrupt / checksum-mismatched snapshot
   *   - never wipe a non-empty local DB with an empty remote snapshot
   *   - never apply the exact same snapshot twice (duplicate-restore guard)
   */
  async restore(
    opts: { fileId?: string; force?: boolean; emptyOnly?: boolean } = {}
  ): Promise<RestoreOutcome> {
    if (!this.telegram.configured) {
      return { success: false, skipped: true, reason: "Telegram is not configured." };
    }
    if (this.snapshotRunning) {
      return { success: false, skipped: true, reason: "A snapshot is running — restore refused." };
    }
    if (this.restoreRunning) {
      return { success: false, skipped: true, reason: "A restore is already running." };
    }

    const emptyOnly = opts.emptyOnly ?? false;
    const localEmpty = isDatabaseEmpty(this.db);
    if (emptyOnly && !localEmpty) {
      return {
        success: false,
        skipped: true,
        reason: "Local database already has data — automatic restore skipped.",
      };
    }

    this.restoreRunning = true;
    const previousState = this.state;
    this.setState("restoring");
    try {
      let fileId = opts.fileId;
      if (!fileId) {
        const latest = await this.telegram.findLatestSnapshot();
        fileId = latest?.fileId;
        if (!fileId) {
          const row = this.db
            .prepare(
              "SELECT telegram_file_id FROM telegram_index WHERE collection = 'snapshot' ORDER BY id DESC LIMIT 1"
            )
            .get() as any;
          fileId = row?.telegram_file_id || undefined;
        }
      }
      if (!fileId) {
        this.setState(previousState === "restoring" || previousState === "starting" ? "ready" : previousState);
        return {
          success: false,
          skipped: true,
          reason:
            "No snapshot found in the Telegram channel. Take a snapshot first " +
            "(Telegram Cloud → Snapshot Now), or upload a snapshot file with " +
            "Restore from file.",
        };
      }

      this.log.log(`♻️  Downloading snapshot ${String(fileId).slice(0, 16)}… from Telegram`);
      const buffer = await this.telegram.downloadFile(fileId);

      let doc: SnapshotDocument;
      try {
        doc = parseSnapshotBuffer(buffer);
      } catch (e: any) {
        throw new Error(`Snapshot could not be parsed (corrupt file): ${e.message}`);
      }

      const validation = validateSnapshot(doc);
      if (!validation.valid) {
        throw new Error(`Snapshot rejected — ${validation.reason}`);
      }

      // An empty remote snapshot must NEVER wipe real local data — this guard
      // is absolute and cannot be bypassed with `force`.
      if (!localEmpty && coreRecordCount(doc) === 0) {
        this.setState("ready");
        return {
          success: false,
          skipped: true,
          reason: "Remote snapshot is empty — refusing to overwrite the non-empty local database.",
        };
      }

      // Duplicate-restore guard: same snapshot already applied and DB unchanged.
      const already = getSyncState(this.db, LAST_RESTORE_CHECKSUM);
      if (!opts.force && already && already === doc.meta.checksum && !localEmpty) {
        this.setState("ready");
        return {
          success: true,
          skipped: true,
          reason: "This snapshot has already been restored.",
          checksum: doc.meta.checksum,
        };
      }

      this.log.log(`♻️  Restoring snapshot — ${describeSnapshot(doc)}`);
      const restored = importDump(this.db, doc);

      setSyncState(this.db, LAST_RESTORE_CHECKSUM, doc.meta.checksum);
      // The local DB now matches the snapshot exactly — no need to re-upload it.
      setSyncState(this.db, LAST_SNAPSHOT_CHECKSUM, coreChecksum(doc.data));
      this.lastRestoreAt = new Date().toISOString();
      this.latestSnapshotFileId = fileId;
      this.lastError = null;
      this.setState("ready");

      // Reload anything that was cached in memory from the OLD database
      // (the AI's Markov model above all) — otherwise the restore is invisible.
      try {
        this.onRestored?.(restored);
      } catch (e: any) {
        this.log.warn("⚠️  Post-restore reload hook failed:", e?.message || e);
      }

      const summary = Object.entries(restored)
        .map(([t, n]) => `${t}=${n}`)
        .join(" ");
      this.log.log(`✅ Restore complete — ${summary}`);
      return { success: true, restored, fileId, checksum: doc.meta.checksum };
    } catch (err: any) {
      // IMPORTANT: nothing was written (the import runs in one transaction), so
      // whatever was in the local database is still intact.
      this.lastError = err?.message || String(err);
      this.log.error("❌ Restore failed — local data left untouched:", this.lastError);
      this.setState("restore_failed");
      return { success: false, error: this.lastError };
    } finally {
      this.restoreRunning = false;
    }
  }

  /**
   * Restore from a snapshot the user supplies directly (an uploaded
   * `myai_snapshot_*.json` / `.json.gz`, or the parsed document).
   *
   * This is the escape hatch when Telegram itself is the problem — a wrong
   * chat id, a bot that lost its admin rights, a deleted pin. The same
   * validation and the same single transaction are used, so an invalid file
   * can never damage the database.
   */
  async restoreFromBuffer(buffer: Buffer, opts: { force?: boolean } = {}): Promise<RestoreOutcome> {
    if (this.snapshotRunning) {
      return { success: false, skipped: true, reason: "A snapshot is running — restore refused." };
    }
    if (this.restoreRunning) {
      return { success: false, skipped: true, reason: "A restore is already running." };
    }

    this.restoreRunning = true;
    this.setState("restoring");
    try {
      let doc: SnapshotDocument;
      try {
        doc = parseSnapshotBuffer(buffer);
      } catch (e: any) {
        throw new Error(`Snapshot file could not be parsed: ${e.message}`);
      }

      const validation = validateSnapshot(doc);
      if (!validation.valid) throw new Error(`Snapshot rejected — ${validation.reason}`);

      const localEmpty = isDatabaseEmpty(this.db);
      if (!localEmpty && coreRecordCount(doc) === 0 && !opts.force) {
        this.setState("ready");
        return {
          success: false,
          skipped: true,
          reason: "That snapshot file is empty — refusing to wipe the current database.",
        };
      }

      this.log.log(`♻️  Restoring uploaded snapshot — ${describeSnapshot(doc)}`);
      const restored = importDump(this.db, doc);

      setSyncState(this.db, LAST_RESTORE_CHECKSUM, doc.meta.checksum);
      setSyncState(this.db, LAST_SNAPSHOT_CHECKSUM, coreChecksum(doc.data));
      this.lastRestoreAt = new Date().toISOString();
      this.lastError = null;
      this.setState("ready");

      try {
        this.onRestored?.(restored);
      } catch (e: any) {
        this.log.warn("⚠️  Post-restore reload hook failed:", e?.message || e);
      }

      this.log.log(
        `✅ Restore from file complete — ${Object.entries(restored).map(([t, n]) => `${t}=${n}`).join(" ")}`
      );
      return { success: true, restored, checksum: doc.meta.checksum };
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      this.log.error("❌ Restore from file failed — local data left untouched:", this.lastError);
      this.setState("restore_failed");
      return { success: false, error: this.lastError };
    } finally {
      this.restoreRunning = false;
    }
  }

  /**
   * Leave the `restore_failed` dead-end.
   *
   * A failed restore used to pin the app in `restore_failed` until the process
   * was restarted: the Telegram bot stayed off and the UI kept showing an
   * error even after the cause was fixed. This lets the control panel say
   * "continue with the local data" and get back to a working state.
   */
  clearRestoreFailure(): { ok: boolean; state: AppState } {
    if (this.state === "restore_failed") {
      this.lastError = null;
      this.setState("ready");
    }
    return { ok: true, state: this.state };
  }

  /**
   * Startup sequence. Resolves once the app is safe to serve traffic; the
   * caller only starts the Telegram bot after this promise resolves ready.
   */
  async runStartupRestore(): Promise<RestoreOutcome> {
    this.setState("starting");

    if (!this.telegram.configured) {
      this.log.warn("⚠️  Telegram is not configured — running on local SQLite only (data is NOT durable on Render Free).");
      this.setState("ready");
      return { success: false, skipped: true, reason: "Telegram is not configured." };
    }
    if (!this.autoRestore) {
      this.log.log("ℹ️  TELEGRAM_AUTO_RESTORE is off — skipping the startup restore.");
      this.setState("ready");
      return { success: false, skipped: true, reason: "Auto restore is disabled." };
    }

    const localEmpty = isDatabaseEmpty(this.db);
    const counts = tableCounts(this.db, CORE_DATA_TABLES);
    this.log.log(
      `🔎 Startup check — local database is ${localEmpty ? "EMPTY (fresh container)" : "populated"} ` +
        `(${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(" ")})`
    );

    if (this.restoreOnEmptyOnly && !localEmpty) {
      this.log.log("ℹ️  Local data already present — automatic restore skipped (TELEGRAM_RESTORE_ON_EMPTY_ONLY=true).");
      this.setState("ready");
      return { success: false, skipped: true, reason: "Local database is not empty." };
    }

    this.log.log("♻️  Restoring the latest snapshot from the Telegram channel…");
    const result = await this.restore({ emptyOnly: this.restoreOnEmptyOnly });

    if (result.success) {
      this.setState("ready");
    } else if (result.skipped) {
      // Nothing to restore is a perfectly normal first boot.
      this.log.log(`ℹ️  Startup restore skipped — ${result.reason}`);
      this.setState("ready");
    }
    return result;
  }

  // -- periodic snapshots ---------------------------------------------------

  startAutoSnapshot(): void {
    if (!this.autoSnapshot || !this.telegram.configured || this.timer) return;
    const ms = this.snapshotIntervalMinutes * 60_000;
    this.timer = setInterval(() => {
      this.snapshot({ reason: "scheduled" }).catch((e) =>
        this.log.warn("⚠️  Scheduled snapshot failed:", e?.message || e)
      );
      this.scheduleNextLabel();
    }, ms);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.scheduleNextLabel();
    this.log.log(`⏱️  Automatic Telegram snapshot every ${this.snapshotIntervalMinutes} minute(s).`);
  }

  stopAutoSnapshot(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextSnapshotAt = null;
  }

  private scheduleNextLabel(): void {
    if (!this.timer) return;
    this.nextSnapshotAt = new Date(Date.now() + this.snapshotIntervalMinutes * 60_000).toISOString();
  }

  /** Best-effort final snapshot on shutdown, bounded by `timeoutMs`. */
  async finalSnapshot(timeoutMs = 8000): Promise<SnapshotOutcome> {
    if (!this.telegram.configured) return { success: false, skipped: true, reason: "Telegram is not configured." };
    this.log.log("💾 Taking a final snapshot before shutdown…");
    const timeout = new Promise<SnapshotOutcome>((resolve) =>
      setTimeout(() => resolve({ success: false, error: "Final snapshot timed out." }), timeoutMs)
    );
    try {
      return await Promise.race([this.snapshot({ reason: "shutdown" }), timeout]);
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  // -- mirroring ------------------------------------------------------------

  /** Mirror one record change to the channel (fire-and-forget, never throws). */
  mirror(collection: string, recordId: string | number, payload: any): void {
    if (!this.telegram.configured) return;
    this.telegram
      .saveRecord(collection, recordId, { operation: "upsert", collection, record_id: String(recordId), ...payload })
      .then((r) => {
        try {
          this.db
            .prepare(
              "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
            )
            .run(collection, String(recordId), r.messageId, null);
        } catch (e: any) {
          this.log.warn("⚠️  Could not index the mirrored record:", e.message);
        }
      })
      .catch((err) => {
        this.lastError = err?.message || String(err);
        this.log.warn(`⚠️  Telegram mirror failed for ${collection}#${recordId}:`, this.lastError);
      });
  }

  /** Mirror a DELETE as a tombstone message so the channel stays authoritative. */
  mirrorDelete(collection: string, recordId: string | number): void {
    if (!this.telegram.configured) return;
    const tombstone = {
      operation: "delete",
      collection,
      record_id: String(recordId),
      deleted_at: new Date().toISOString(),
    };
    this.telegram
      .saveRecord(`${collection}_tombstone`, recordId, tombstone)
      .then((r) => {
        try {
          this.db
            .prepare(
              "INSERT INTO telegram_index (collection, record_id, telegram_message_id, telegram_file_id) VALUES (?, ?, ?, ?)"
            )
            .run(`${collection}_tombstone`, String(recordId), r.messageId, null);
        } catch {
          /* best-effort */
        }
      })
      .catch((err) => {
        this.lastError = err?.message || String(err);
        this.log.warn(`⚠️  Telegram tombstone failed for ${collection}#${recordId}:`, this.lastError);
      });
  }

  // -- status ---------------------------------------------------------------

  statusPayload(): Record<string, any> {
    return {
      state: this.state,
      autoRestoreEnabled: this.autoRestore,
      autoSnapshotEnabled: this.autoSnapshot,
      restoreOnEmptyOnly: this.restoreOnEmptyOnly,
      snapshotIntervalMinutes: this.snapshotIntervalMinutes,
      lastSnapshotAt: this.lastSnapshotAt,
      lastRestoreAt: this.lastRestoreAt,
      latestSnapshotFileId: this.latestSnapshotFileId,
      latestSnapshotMessageId: this.latestSnapshotMessageId,
      nextSnapshotAt: this.nextSnapshotAt,
      snapshotInProgress: this.snapshotRunning,
      restoreInProgress: this.restoreRunning,
      lastError: this.lastError,
      tableCounts: tableCounts(this.db),
    };
  }
}
