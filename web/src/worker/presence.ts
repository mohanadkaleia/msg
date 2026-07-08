// worker/presence.ts — EphemeralState: presence + typing (ENG-126, ENG-125).
//
// Presence (workspace-wide `user_id → online|offline`) and typing (per-stream
// `user_id → expiresAt`, ~5 s TTL) are EPHEMERAL: they are re-derived from live
// WS frames on every (re)connect and MUST NEVER be persisted. This module is
// constructed WITHOUT an `MsgDb`/`db` handle — a STRUCTURAL guarantee that it
// cannot write Dexie (enforced by presence.spec's negative guard: a burst of
// presence/typing frames leaves every table's row count unchanged). Contrast the
// synced-KV read-state/prefs managers, which DO hold a db handle and persist.
//
// The three orthogonal timings here:
//   • typing TTL         — a typing entry auto-expires 5 s after its last frame
//                          (lazy sweep on read + a periodic sweeper that drops
//                          stale entries and republishes the affected stream).
//   • outbound throttle  — `sendTyping` fires at most once per ~333 ms per stream
//                          (leading edge), matching the server's 1/3 s throttle.
//   • clearAll on drop   — leaving `live` wipes BOTH maps (ephemeral state does
//                          not survive a socket drop) + notifies subscribers.

import type { PresenceEntry, PresencePush, PresenceStatus, TypingPush } from './types'

/** Typing entry TTL: a typing signal is "live" for 5 s after the last frame. */
export const TYPING_TTL_MS = 5_000
/** Sweeper cadence — drops expired typing entries + republishes affected streams. */
export const TYPING_SWEEP_MS = 1_000
/** Outbound `typing.send` leading-edge throttle per stream (matches the server 1/3 s). */
export const TYPING_SEND_THROTTLE_MS = 333

/** Injected interval handle — a number in browser/worker; tests supply their own. */
type IntervalId = number

export interface EphemeralStateDeps {
  /** Fan a `{kind:'presence'}` push (the FULL current snapshot) to subscribers. */
  publishPresence: (payload: PresencePush) => void
  /** Fan a `{kind:'typing',stream_id}` push (the stream's current typing set). */
  publishTyping: (streamId: string, payload: TypingPush) => void
  /** Emit the outbound typing WS signal (SyncEngine.sendTyping — live-only, drop otherwise). */
  sendTyping: (streamId: string) => void
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number
  /** Injectable interval scheduler (tests). Default global `setInterval`/`clearInterval`. */
  setInterval?: (cb: () => void, ms: number) => IntervalId
  clearInterval?: (id: IntervalId) => void
}

export class EphemeralState {
  // Workspace-wide presence. Memory-only — never a Dexie table.
  private readonly presence = new Map<string, PresenceStatus>()
  // stream_id → (user_id → expiresAt ms). Memory-only.
  private readonly typing = new Map<string, Map<string, number>>()
  // stream_id → last outbound-send timestamp (leading-edge throttle state).
  private readonly lastSent = new Map<string, number>()

  private readonly publishPresence: (payload: PresencePush) => void
  private readonly publishTyping: (streamId: string, payload: TypingPush) => void
  private readonly sendTypingSignal: (streamId: string) => void
  private readonly now: () => number
  private readonly setIntervalFn: (cb: () => void, ms: number) => IntervalId
  private readonly clearIntervalFn: (id: IntervalId) => void
  private sweeper: IntervalId | undefined

  constructor(deps: EphemeralStateDeps) {
    this.publishPresence = deps.publishPresence
    this.publishTyping = deps.publishTyping
    this.sendTypingSignal = deps.sendTyping
    this.now = deps.now ?? (() => Date.now())
    this.setIntervalFn =
      deps.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms) as unknown as IntervalId)
    this.clearIntervalFn =
      deps.clearInterval ??
      ((id) => {
        globalThis.clearInterval(id as unknown as ReturnType<typeof setInterval>)
      })
  }

  // -- inbound frames ------------------------------------------------------

  /** Apply `{t:'presence',user_id,status}` → update + publish the full snapshot. */
  applyPresence(frame: { user_id: string; status: PresenceStatus }): void {
    this.presence.set(frame.user_id, frame.status)
    this.publishPresence({ presence: this.snapshotPresence() })
  }

  /** Apply `{t:'typing',stream_id,user_id}` → (re)arm the 5 s TTL + publish the set. */
  applyTyping(frame: { stream_id: string; user_id: string }): void {
    let inner = this.typing.get(frame.stream_id)
    if (!inner) {
      inner = new Map<string, number>()
      this.typing.set(frame.stream_id, inner)
    }
    inner.set(frame.user_id, this.now() + TYPING_TTL_MS)
    this.ensureSweeper()
    this.publishTyping(frame.stream_id, {
      stream_id: frame.stream_id,
      user_ids: this.snapshotTyping(frame.stream_id),
    })
  }

  // -- snapshots (late-subscriber seed) ------------------------------------

  /** The full current presence snapshot (seeds a late `{kind:'presence'}` subscriber). */
  snapshotPresence(): PresenceEntry[] {
    return [...this.presence.entries()].map(([user_id, status]) => ({ user_id, status }))
  }

  /**
   * A stream's CURRENT (non-expired) typing user set — lazy-sweeps expired entries
   * as a side effect, so a read never reports a stale typer even between sweeps.
   */
  snapshotTyping(streamId: string): string[] {
    const inner = this.typing.get(streamId)
    if (!inner) return []
    const now = this.now()
    for (const [user, expiresAt] of inner) {
      if (expiresAt <= now) inner.delete(user)
    }
    if (inner.size === 0) this.typing.delete(streamId)
    return [...inner.keys()]
  }

  // -- outbound signal -----------------------------------------------------

  /**
   * `typing.send` — CLIENT leading-edge throttle (~333 ms per stream, matching the
   * server), then hand to the injected `sendTyping` (SyncEngine.sendTyping), which
   * emits the WS frame ONLY while `live` (drops silently otherwise). A second call
   * inside the window is swallowed here; the first call after the window fires again.
   */
  sendTyping(streamId: string): void {
    const now = this.now()
    const last = this.lastSent.get(streamId)
    if (last !== undefined && now - last < TYPING_SEND_THROTTLE_MS) return
    this.lastSent.set(streamId, now)
    this.sendTypingSignal(streamId)
  }

  // -- lifecycle -----------------------------------------------------------

  /**
   * Wipe BOTH maps on leaving `live` (ENG-126): ephemeral state does not survive a
   * socket drop — presence is re-derived from live frames on reconnect and typing
   * simply lapses. Notifies subscribers (empty presence snapshot + empty typing per
   * previously-active stream) so a UI that is still mounted clears immediately, and
   * stops the sweeper. Idempotent.
   */
  clearAll(): void {
    const typingStreams = [...this.typing.keys()]
    this.presence.clear()
    this.typing.clear()
    this.lastSent.clear()
    this.stopSweeper()
    this.publishPresence({ presence: [] })
    for (const streamId of typingStreams) {
      this.publishTyping(streamId, { stream_id: streamId, user_ids: [] })
    }
  }

  // -- sweeper -------------------------------------------------------------

  private ensureSweeper(): void {
    if (this.sweeper !== undefined) return
    this.sweeper = this.setIntervalFn(() => this.sweep(), TYPING_SWEEP_MS)
  }

  private stopSweeper(): void {
    if (this.sweeper !== undefined) {
      this.clearIntervalFn(this.sweeper)
      this.sweeper = undefined
    }
  }

  /**
   * Drop expired typing entries and republish every stream whose set shrank. When
   * no typing remains, stop the sweeper (it re-arms on the next `applyTyping`).
   */
  private sweep(): void {
    const now = this.now()
    for (const [streamId, inner] of this.typing) {
      let dropped = false
      for (const [user, expiresAt] of inner) {
        if (expiresAt <= now) {
          inner.delete(user)
          dropped = true
        }
      }
      if (inner.size === 0) this.typing.delete(streamId)
      if (dropped) {
        this.publishTyping(streamId, { stream_id: streamId, user_ids: [...inner.keys()] })
      }
    }
    if (this.typing.size === 0) this.stopSweeper()
  }
}
