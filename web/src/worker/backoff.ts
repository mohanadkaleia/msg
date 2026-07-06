// worker/backoff.ts — the ONE exponential-backoff helper (ENG-81, DRY).
//
// Extracted from the sync engine's private copy so BOTH the reconnect loop
// (sync.ts) and the outbox drain (outbox.ts) share a single formula — no
// divergent duplication. Pure: the only non-determinism is `random`, injectable
// so tests assert an exact jitter window against a stubbed RNG.

/** Outbox drain backoff floor / ceiling — mirrors the sync `RECONNECT_*` numbers. */
export const OUTBOX_BASE_MS = 1_000
export const OUTBOX_CAP_MS = 30_000

/** Knobs for {@link backoffDelay}. `random` defaults to `Math.random`. */
export interface BackoffOptions {
  baseMs: number
  capMs: number
  /** [0,1) source; inject a stub for deterministic tests. */
  random?: () => number
}

/**
 * `min(cap, base·2^attempt)` with full-ish jitter into `[delay/2, delay]` — the
 * de-correlated exponential backoff both the reconnect loop and the outbox drain
 * use. `attempt` is 0-based: attempt 0 → `[base/2, base]`, growing to the cap.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const random = opts.random ?? Math.random
  const base = Math.min(opts.capMs, opts.baseMs * 2 ** attempt)
  return Math.round(base / 2 + random() * (base / 2))
}
