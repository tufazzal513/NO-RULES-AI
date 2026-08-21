/**
 * In-memory ring buffer of recent log entries for the control panel.
 * ----------------------------------------------------------------
 * Keeps the last N entries (default 500) so the web UI can show what
 * happened recently (research events, Telegram sync, HTTP requests…)
 * without reading any file. Never logs secrets or tokens.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  at: string;
  level: LogLevel;
  source: string;
  message: string;
}

const MAX_ENTRIES = 500;
let seq = 0;
const entries: LogEntry[] = [];

/** Append one entry (bounded ring buffer — old entries fall off). */
export function pushLog(level: LogLevel, source: string, message: string): void {
  seq++;
  entries.push({ id: seq, at: new Date().toISOString(), level, source, message: String(message).slice(0, 2000) });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Most recent entries, newest first. */
export function recentLogs(limit = 200): LogEntry[] {
  return entries.slice(-limit).reverse();
}
