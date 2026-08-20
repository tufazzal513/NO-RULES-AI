/**
 * Per-host circuit breaker for the online research layer.
 * --------------------------------------------------------
 * Every research source lives on its OWN hostname, so a rate limit on one
 * host must never slow down the others. When a host fails (HTTP 429/5xx,
 * network error, or an unparsable/blocked page) we "open" its circuit for an
 * exponentially growing cooldown:
 *
 *     1 min → 2 min → 4 min → 8 min → 15 min (cap) …
 *
 * A `Retry-After` header from the server is honoured: the cooldown is never
 * shorter than the value the server itself asks for.
 */

export const MIN_BACKOFF_MS = 60_000; // 1 minute
export const MAX_BACKOFF_MS = 15 * 60_000; // 15 minutes (cap)

export interface CircuitState {
  failures: number;
  /** Epoch ms until which the host is skipped. */
  openUntil: number;
  /** Last Retry-After (ms) we were asked to wait, if any. */
  lastRetryAfterMs: number | null;
  /** Epoch ms of the last recorded failure. */
  lastFailureAt: number;
}

export interface CircuitCheck {
  allowed: boolean;
  /** How long (ms) until the host can be tried again (0 when allowed). */
  retryInMs: number;
}

const fresh = (): CircuitState => ({
  failures: 0,
  openUntil: 0,
  lastRetryAfterMs: null,
  lastFailureAt: 0,
});

export class CircuitBreaker {
  private states = new Map<string, CircuitState>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Is the host currently in a cooldown? */
  isOpen(host: string): boolean {
    const s = this.states.get(host);
    return Boolean(s && this.now() < s.openUntil);
  }

  /** Should a request to `host` be allowed right now? */
  check(host: string): CircuitCheck {
    const s = this.states.get(host);
    if (s && this.now() < s.openUntil) {
      return { allowed: false, retryInMs: s.openUntil - this.now() };
    }
    return { allowed: true, retryInMs: 0 };
  }

  /** A successful (or clean, empty-result) response closes the circuit again. */
  recordSuccess(host: string): void {
    this.states.set(host, fresh());
  }

  /**
   * Record a failure and open the circuit with exponential backoff
   * (1 → 15 minutes), never shorter than an explicit Retry-After.
   */
  recordFailure(host: string, retryAfterMs?: number | null): void {
    const prev = this.states.get(host) ?? fresh();
    const failures = prev.failures + 1;
    const exponential = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (failures - 1));
    const wait = retryAfterMs && retryAfterMs > exponential ? retryAfterMs : exponential;
    this.states.set(host, {
      failures,
      openUntil: this.now() + wait,
      lastRetryAfterMs: retryAfterMs ?? null,
      lastFailureAt: this.now(),
    });
  }

  /** Snapshot of one host's circuit (for /api/v1/research/status and the UI). */
  state(host: string): CircuitState & { ready: boolean; cooldownRemainingMs: number } {
    const s = this.states.get(host) ?? fresh();
    const cooldownRemainingMs = this.now() < s.openUntil ? s.openUntil - this.now() : 0;
    return { ...s, ready: cooldownRemainingMs === 0, cooldownRemainingMs };
  }

  /** Reopen every circuit (the "Reset Cooldowns" button). */
  resetAll(): void {
    this.states.clear();
  }
}
