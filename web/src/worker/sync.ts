// worker/sync.ts — the SyncEngine: the worker's replication loop (ENG-79, §3.3).
//
// The brain of M2 client sync. It turns cursors + pulls + WS push into a
// gapless, self-healing local `events` log:
//
//   connecting → syncing → live → degraded
//
// On every (re)connect it runs `GET /v1/sync`, diffs each readable stream's
// head against the local cursor, and pulls the gap closed. Then it holds a
// WebSocket open and applies `{"t":"event"}` frames — but ONLY when contiguous;
// any sequence discontinuity triggers a targeted pull instead of blind
// application (the delivery contract). Every envelope, pulled or pushed, is
// hash-verified before storage. Verified envelopes go verbatim into `events`;
// `cursors.last_contiguous_seq` advances only across a gapless run; then the
// injected projection seam (ENG-80) is called.
//
// Nothing platform-specific is referenced directly — no `WebSocket`, no `fetch`,
// no `self`, no `navigator`. All side effects are injected, so the whole engine
// is unit-testable in vitest with fakes (see tests/unit/worker/{ws,sync}.spec.ts).

import { hashEvent, JCSError, type JSONValue } from '../core'

import { backoffDelay } from './backoff'
import type { HttpClient } from './http'
import {
  noopApplyToProjection,
  type ApplyEventsToProjection,
  type BackfillResult,
  type EventRow,
  type EventsPageResponse,
  type MsgDb,
  type StreamRow,
  type SyncResponse,
  type SyncState,
  type SyncStatus,
  type SyncStreamMeta,
  type WireEvent,
} from './types'
import {
  deriveWsUrl,
  WS_CLOSE_CLIENT_GOING_AWAY,
  type WsConnection,
  type WsFactory,
  type WsFrame,
} from './ws'

/** Max page size — the server clamps to 500 (§4.3); ask for the biggest legal page. */
export const PULL_LIMIT = 500
/** Bounded parallelism ACROSS streams during bootstrap (§7 item 4). */
export const BOOTSTRAP_CONCURRENCY = 4
/** Watchdog window — must exceed the server's 30 s heartbeat interval (§6 / risk 2). */
export const HEARTBEAT_TIMEOUT_MS = 40_000
/** Reconnect backoff: 1 s → 30 s cap with jitter (§6, mirrors the outbox numbers). */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_CAP_MS = 30_000
/** A live gap-pull retries a few times (with backoff) before it reports stalled. */
export const LIVE_PULL_MAX_RETRIES = 3

/** Injected timer handle — a number in browser/worker; tests supply their own. */
export type TimerId = number

/** Everything the engine needs, injected → fully unit-testable (§5). */
export interface SyncEngineDeps {
  http: HttpClient
  wsFactory: WsFactory
  db: MsgDb
  /** Worker-held bearer token (R8). Null when unauthenticated → engine idle. */
  getToken: () => string | null
  /** ENG-80's projection build; default no-op so ENG-79 ships + tests standalone. */
  applyToProjection?: ApplyEventsToProjection
  /** Called on every state transition — WorkerCore fans it to `{kind:'sync'}`. */
  emitStatus: (status: SyncStatus) => void
  /** Async "events changed for stream X" signal — WorkerCore fans `{kind:'stream'}`. */
  publishStream: (streamId: string) => void
  /**
   * ENG-126 signal-frame sink. Inbound `read_state`/`prefs`/`presence`/`typing`
   * frames are routed here INSTEAD of the event-sync path (no cursor, no
   * invariant-5/6, no `applyForward`). Optional so ENG-79 tests run without it;
   * WorkerCore injects a router that shape-validates each arm (D9).
   */
  onSignalFrame?: (frame: WsFrame) => void
  /** Injectable clock (tests advance backoff / watchdog / retry timers). */
  setTimeout?: (cb: () => void, ms: number) => TimerId
  clearTimeout?: (handle: TimerId) => void
  /** Snapshot of `navigator.onLine`; default assumes online. */
  isOnline?: () => boolean
  /** Injectable WS URL (tests); default derived from `location`. */
  wsUrl?: string
  /** Watchdog window override (tests). */
  heartbeatTimeoutMs?: number
}

/** Thrown to unwind a bootstrap that has already transitioned to `degraded`. */
class BootstrapAborted extends Error {
  constructor() {
    super('bootstrap aborted')
    this.name = 'BootstrapAborted'
  }
}

/** Thrown by a LIVE catch-up pull page fetch so the caller can bound-retry it. */
class PullFailed extends Error {
  constructor(readonly code: string) {
    super(`pull failed: ${code}`)
    this.name = 'PullFailed'
  }
}

export class SyncEngine {
  private state: SyncState = 'idle'
  private online: boolean
  private lastError: string | undefined
  private streamsTotal: number | undefined
  private streamsSynced: number | undefined

  private ws: WsConnection | undefined
  /**
   * Monotonic connection generation. Every (re)connect and every teardown bumps
   * it; async work captures its epoch and bails the moment it goes stale — this
   * is how a reconnect / stop aborts in-flight bootstrap pulls (§6).
   */
  private epoch = 0
  private stopped = true

  private reconnectAttempt = 0
  private reconnectTimer: TimerId | undefined
  private watchdogTimer: TimerId | undefined

  /** One in-flight catch-up pull per stream (gap coalescing, §9). */
  private readonly inflightPulls = new Set<string>()
  /** Per-stream serialization of the fast apply path so frames never race. */
  private readonly streamLocks = new Map<string, Promise<unknown>>()

  private readonly http: HttpClient
  private readonly wsFactory: WsFactory
  private readonly db: MsgDb
  private readonly getToken: () => string | null
  private readonly applyToProjection: ApplyEventsToProjection
  private readonly emitStatus: (status: SyncStatus) => void
  private readonly publishStream: (streamId: string) => void
  private readonly onSignalFrame: ((frame: WsFrame) => void) | undefined
  private readonly setTimer: (cb: () => void, ms: number) => TimerId
  private readonly clearTimer: (handle: TimerId) => void
  private readonly isOnlineFn: () => boolean
  private readonly wsUrl: string | undefined
  private readonly heartbeatTimeoutMs: number

  constructor(deps: SyncEngineDeps) {
    this.http = deps.http
    this.wsFactory = deps.wsFactory
    this.db = deps.db
    this.getToken = deps.getToken
    this.applyToProjection = deps.applyToProjection ?? noopApplyToProjection
    this.emitStatus = deps.emitStatus
    this.publishStream = deps.publishStream
    this.onSignalFrame = deps.onSignalFrame
    this.setTimer =
      deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown as TimerId)
    this.clearTimer =
      deps.clearTimeout ??
      ((handle) => {
        globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
      })
    this.isOnlineFn = deps.isOnline ?? (() => true)
    this.wsUrl = deps.wsUrl
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    this.online = this.isOnlineFn()
  }

  // -- lifecycle -----------------------------------------------------------

  /** Idempotent. Begin the connect→syncing→live loop (after auth restore/login). */
  start(): void {
    if (this.state !== 'idle') return
    if (!this.getToken()) return // unauthenticated — nothing to sync
    this.stopped = false
    this.reconnectAttempt = 0
    this.online = this.isOnlineFn()
    if (!this.online) {
      this.setState('degraded', 'offline')
      return
    }
    this.openConnection()
  }

  /** Idempotent. Close the socket, cancel timers, and return to idle (logout). */
  stop(): void {
    this.stopped = true
    this.epoch++
    this.cancelReconnect()
    this.clearWatchdog()
    this.closeWs()
    this.inflightPulls.clear()
    this.streamsTotal = undefined
    this.streamsSynced = undefined
    this.setState('idle')
  }

  /** Current status snapshot (the `sync.status` RPC). */
  status(): SyncStatus {
    return this.snapshot()
  }

  /** `navigator` offline → drop to degraded and hold until online (§6). */
  notifyOffline(): void {
    this.online = false
    if (this.stopped || this.state === 'idle') {
      this.emitStatus(this.snapshot())
      return
    }
    this.cancelReconnect()
    this.epoch++
    this.clearWatchdog()
    this.closeWs()
    this.inflightPulls.clear()
    this.setState('degraded', 'offline')
  }

  /** `navigator` online → reconnect immediately (§6). */
  notifyOnline(): void {
    this.online = true
    if (this.stopped) {
      this.emitStatus(this.snapshot())
      return
    }
    if (this.state === 'degraded') {
      this.cancelReconnect()
      this.openConnection()
    } else {
      this.emitStatus(this.snapshot())
    }
  }

  // -- connection ----------------------------------------------------------

  private openConnection(): void {
    const token = this.getToken()
    if (!token) {
      this.stop()
      return
    }
    const epoch = ++this.epoch
    this.setState('connecting')
    const url = this.wsUrl ?? deriveWsUrl()
    const ws = this.wsFactory(url, token)
    this.ws = ws
    ws.onOpen(() => {
      if (this.isStale(epoch)) return
      void this.onWsOpen(epoch)
    })
    ws.onFrame((frame) => {
      if (this.isStale(epoch)) return
      this.onFrame(frame)
    })
    ws.onClose(() => this.onWsDown(epoch))
    ws.onError(() => this.onWsDown(epoch))
  }

  private async onWsOpen(epoch: number): Promise<void> {
    if (this.isStale(epoch)) return
    this.setState('syncing')
    this.resetWatchdog()
    try {
      await this.bootstrap(epoch)
    } catch (err) {
      if (err instanceof BootstrapAborted) return // already degraded
      if (this.isStale(epoch)) return
      this.handleDegraded(`bootstrap: ${errText(err)}`)
      return
    }
    if (this.isStale(epoch)) return
    if (this.state === 'syncing') {
      this.reconnectAttempt = 0 // a clean live resets the backoff (§6)
      this.streamsTotal = undefined
      this.streamsSynced = undefined
      this.setState('live')
    }
  }

  private onWsDown(epoch: number): void {
    if (this.isStale(epoch) || this.stopped) return
    if (this.state === 'degraded' || this.state === 'idle') return
    this.handleDegraded('connection closed')
  }

  private onFrame(frame: WsFrame): void {
    // ANY inbound frame proves the socket is alive — reset the watchdog first.
    this.resetWatchdog()
    switch (frame.t) {
      case 'ping':
        this.ws?.send({ t: 'pong' })
        return
      case 'pong':
        return
      case 'event':
        // While still `syncing` the cursor does not yet reflect reality; ignore
        // live frames and let bootstrap + the next gap-check reconcile (risk 3).
        if (this.state !== 'live') return
        if ('event' in frame && frame.event) {
          const event = frame.event
          void this.onEventFrame(event).catch((err: unknown) => {
            console.warn('[sync] event frame handling failed', errText(err))
          })
        }
        return
      case 'read_state':
      case 'prefs':
      case 'presence':
      case 'typing':
        // ENG-126: signal frames NEVER touch the event-sync path (no cursor
        // advance, no invariant-5/6, no projection call). Hand off to the
        // injected router, which shape-validates each arm + ignores malformed (D9).
        this.onSignalFrame?.(frame)
        return
      default:
        // Every other / reserved / unknown frame is ignored (D9 tolerance).
        return
    }
  }

  /**
   * ENG-126 outbound typing signal. Sends `{t:'typing',stream_id}` ONLY while
   * `live` (a socket exists + is open); otherwise SILENTLY dropped — typing is
   * ephemeral, so a signal that cannot be delivered is simply lost (never queued).
   * The per-stream leading-edge throttle lives in `EphemeralState` (matching the
   * server's 1/3 s window); this method is the pure transport gate.
   */
  sendTyping(streamId: string): void {
    if (this.state !== 'live') return
    this.ws?.send({ t: 'typing', stream_id: streamId })
  }

  private handleDegraded(reason: string): void {
    this.epoch++ // invalidate all in-flight async work for the dead connection
    this.clearWatchdog()
    this.closeWs()
    this.inflightPulls.clear()
    this.streamsTotal = undefined
    this.streamsSynced = undefined
    this.setState('degraded', reason)
    if (this.online) this.scheduleReconnect()
  }

  // -- reconnect + watchdog ------------------------------------------------

  private scheduleReconnect(): void {
    this.cancelReconnect()
    const delay = this.backoffDelay(this.reconnectAttempt)
    this.reconnectAttempt++
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined
      if (this.stopped || !this.online) return
      this.openConnection()
    }, delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      this.clearTimer(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private backoffDelay(attempt: number): number {
    // The ONE shared backoff (backoff.ts) — same 1s→30s+jitter formula the
    // outbox drain uses; no divergent local copy.
    return backoffDelay(attempt, { baseMs: RECONNECT_BASE_MS, capMs: RECONNECT_CAP_MS })
  }

  private resetWatchdog(): void {
    this.clearWatchdog()
    const epoch = this.epoch
    this.watchdogTimer = this.setTimer(() => {
      this.watchdogTimer = undefined
      if (this.isStale(epoch) || this.stopped) return
      // No inbound frame within the window — treat the socket as dead (a
      // half-open TCP socket may never fire onClose), close + reconnect (§6).
      this.handleDegraded('heartbeat timeout')
    }, this.heartbeatTimeoutMs)
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      this.clearTimer(this.watchdogTimer)
      this.watchdogTimer = undefined
    }
  }

  // -- bootstrap (§7) ------------------------------------------------------

  private async bootstrap(epoch: number): Promise<void> {
    const res = await this.http.get<SyncResponse>('/v1/sync')
    if (this.isStale(epoch)) throw new BootstrapAborted()
    if (!res.ok) {
      this.handleDegraded(`sync ${res.error.code}`)
      throw new BootstrapAborted()
    }
    const streams = res.value.streams
    await this.db.putStreams(streams.map(toStreamRow))
    // Post-rebuild self-heal (ENG-80 contract): a projection-version bump drops
    // `cursors` but keeps `events`. Re-derive each absent cursor from the local
    // `events` cache FIRST so the head-diff below pulls only the missing tail,
    // never a wasteful full re-pull from seq 1.
    await this.rederiveCursorsFromEvents(streams)

    this.streamsTotal = streams.length
    this.streamsSynced = 0
    this.emitStatus(this.snapshot())

    await runPool(streams, BOOTSTRAP_CONCURRENCY, async (stream) => {
      if (this.isStale(epoch)) throw new BootstrapAborted()
      await this.syncOneStream(stream, epoch)
      if (this.isStale(epoch)) throw new BootstrapAborted()
      this.streamsSynced = (this.streamsSynced ?? 0) + 1
      if (this.state === 'syncing') this.emitStatus(this.snapshot())
    })
  }

  /**
   * For every stream WITHOUT a cursor but WITH local events, reconstruct
   * `last_contiguous_seq` = the top of the newest gapless run present locally,
   * and `oldest_loaded_seq` = the bottom of that run. This is the rebuild
   * self-heal step: it lets a dropped-cursors rebuild resume from the events
   * cache instead of refetching history from seq 1.
   */
  private async rederiveCursorsFromEvents(streams: readonly SyncStreamMeta[]): Promise<void> {
    for (const stream of streams) {
      const existing = await this.db.getCursor(stream.stream_id)
      if (existing) continue
      const seqs = await this.db.listEventSequences(stream.stream_id)
      const run = topContiguousRun(seqs)
      if (!run) continue
      await this.db.putCursors([
        {
          stream_id: stream.stream_id,
          last_contiguous_seq: run.last,
          oldest_loaded_seq: run.oldest,
        },
      ])
    }
  }

  private async syncOneStream(stream: SyncStreamMeta, epoch: number): Promise<void> {
    const cursor = await this.db.getCursor(stream.stream_id)
    const last = cursor?.last_contiguous_seq ?? 0

    if (stream.kind === 'workspace-meta') {
      // Always synced forward from seq 1 (after = last, 0 if cold): the client
      // needs the full channel/member state; small by construction (§7).
      await this.catchUp(stream.stream_id, last, epoch, 'bootstrap')
      return
    }
    if (!cursor) {
      // Brand-new stream → newest-page pull for cold-start render (§3.2); do NOT
      // walk from seq 1. Empty streams (head 0) need nothing.
      if (stream.head_seq > 0) await this.coldNewestPage(stream, epoch, 'bootstrap')
      return
    }
    if (stream.head_seq > last) {
      await this.catchUp(stream.stream_id, last, epoch, 'bootstrap')
    }
    // else up-to-date — nothing to pull.
  }

  /** Cold-start newest page: `before = head+1`, set cursor to the stored frontier (§7). */
  private async coldNewestPage(
    stream: SyncStreamMeta,
    epoch: number,
    context: 'bootstrap' | 'live',
  ): Promise<void> {
    const path = `/v1/events?stream_id=${encodeURIComponent(stream.stream_id)}&before=${
      stream.head_seq + 1
    }&limit=${PULL_LIMIT}`
    const res = await this.http.get<EventsPageResponse>(path)
    if (this.isStale(epoch)) throw new BootstrapAborted()
    if (!res.ok) {
      if (context === 'bootstrap') {
        this.handleDegraded(`events ${res.error.code}`)
        throw new BootstrapAborted()
      }
      throw new PullFailed(res.error.code)
    }
    const rows = await this.verifyAndStore(stream.stream_id, res.value.events)
    const firstRow = rows[0]
    if (!firstRow) return // nothing verified (empty page or every event dropped)

    // Cold-start cursor = "contiguous from the newest-loaded window forward". The
    // frontier is the top of the run that is ACTUALLY gapless from the bottom of
    // the stored page — NOT head_seq unconditionally. Server pages are gapless, so
    // with nothing dropped this == head_seq; but a hash-mismatch skip (e.g. the
    // page's top event) must NOT be claimed contiguous, or forward catch-up
    // (after=head) would never re-request it and backfill only descends below
    // oldest_loaded → a permanent hole. Mirrors how `applyForward` wedges before a
    // hole. The skipped seq is re-obtained by the next catch-up/reconnect (which
    // pulls after=frontier) or a live gap frame.
    const firstSeq = firstRow.server_sequence
    let frontier = firstSeq
    const applied: EventRow[] = [firstRow]
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (row && row.server_sequence === frontier + 1) {
        frontier = row.server_sequence
        applied.push(row)
      } else break
    }
    await this.db.putCursors([
      {
        stream_id: stream.stream_id,
        last_contiguous_seq: frontier,
        oldest_loaded_seq: firstSeq,
      },
    ])
    // Seam only over the contiguous run the cursor now covers (its contract).
    await this.callSeam(stream.stream_id, applied)
    this.publishStream(stream.stream_id)
  }

  /**
   * Forward catch-up loop: page `after = N` until `has_more == false`, applying
   * each page. Pages by the last-returned seq (not the cursor) so a persistent
   * bad-hash hole still fetches everything above it (stored, cursor wedged) and
   * the loop always terminates.
   */
  private async catchUp(
    streamId: string,
    startAfter: number,
    epoch: number,
    context: 'bootstrap' | 'live',
  ): Promise<void> {
    let after = startAfter
    for (;;) {
      if (this.isStale(epoch)) {
        if (context === 'bootstrap') throw new BootstrapAborted()
        return
      }
      const path = `/v1/events?stream_id=${encodeURIComponent(streamId)}&after=${after}&limit=${PULL_LIMIT}`
      const res = await this.http.get<EventsPageResponse>(path)
      if (this.isStale(epoch)) {
        if (context === 'bootstrap') throw new BootstrapAborted()
        return
      }
      if (!res.ok) {
        if (context === 'bootstrap') {
          this.handleDegraded(`events ${res.error.code}`)
          throw new BootstrapAborted()
        }
        // A live gap-pull page failure: throw so the driver can bound-retry it
        // (don't tear the socket down for one bad page, but don't wedge silently).
        throw new PullFailed(res.error.code)
      }
      const page = res.value
      if (page.events.length > 0) await this.applyForward(streamId, page.events)
      const lastEvent = page.events[page.events.length - 1]
      const maxSeq = lastEvent?.server ? lastEvent.server.server_sequence : after
      if (!page.has_more) return
      if (maxSeq <= after) return // no forward progress — avoid an infinite loop
      after = maxSeq
    }
  }

  // -- apply + verify + cursor (§8) ---------------------------------------

  /**
   * Verify + store one stream's ascending run, then advance the cursor across
   * the leading gapless verified run and call the projection seam. Used by
   * catch-up pages AND single live frames.
   */
  private async applyForward(streamId: string, wire: readonly WireEvent[]): Promise<void> {
    const cursor = await this.db.getCursor(streamId)
    const startLast = cursor?.last_contiguous_seq ?? 0
    const rows = await this.verifyAndStore(streamId, wire)
    if (rows.length === 0) return

    // Advance only across the contiguous run from the current frontier. A gap
    // (or a skipped bad-hash seq) stops the advance; later events stay stored.
    let next = startLast + 1
    const applied: EventRow[] = []
    for (const row of rows) {
      if (row.server_sequence < next) continue // duplicate / already applied
      if (row.server_sequence === next) {
        applied.push(row)
        next++
      } else break // gap — stop; the cursor does not jump the hole
    }
    const newLast = next - 1
    const firstRow = rows[0]
    const firstSeq = firstRow ? firstRow.server_sequence : startLast
    const oldest = Math.min(cursor?.oldest_loaded_seq ?? firstSeq, firstSeq)
    await this.db.putCursors([
      { stream_id: streamId, last_contiguous_seq: newLast, oldest_loaded_seq: oldest },
    ])
    if (applied.length > 0) {
      await this.callSeam(streamId, applied)
      this.publishStream(streamId)
    }
  }

  /**
   * Hash-verify each envelope (recompute `hashEvent(body)` == `event_hash`),
   * dropping any mismatch with a warning (never stored, never crashes, §8 step
   * 1), then `bulkPut` the verified rows. Returns the stored rows ascending.
   */
  private async verifyAndStore(streamId: string, wire: readonly WireEvent[]): Promise<EventRow[]> {
    const rows: EventRow[] = []
    for (const ev of wire) {
      if (!ev.server || typeof ev.server.server_sequence !== 'number') {
        console.warn('[sync] event missing server metadata, skipping', { streamId })
        continue
      }
      if (!(await this.verify(streamId, ev))) continue
      rows.push(toEventRow(streamId, ev))
    }
    rows.sort((a, b) => a.server_sequence - b.server_sequence)
    if (rows.length > 0) await this.db.putEvents(rows)
    return rows
  }

  private async verify(streamId: string, ev: WireEvent): Promise<boolean> {
    let computed: string
    try {
      computed = await hashEvent(ev.body as unknown as JSONValue)
    } catch (err) {
      // Out-of-domain body (JCSError) or any hashing fault → skip + warn (§8).
      console.warn('[sync] event hash failed, skipping', {
        streamId,
        seq: ev.server?.server_sequence,
        error: err instanceof JCSError ? err.message : errText(err),
      })
      return false
    }
    if (computed !== ev.event_hash) {
      console.warn('[sync] event hash mismatch, skipping', {
        streamId,
        seq: ev.server?.server_sequence,
        expected: ev.event_hash,
        got: computed,
      })
      return false
    }
    return true
  }

  private async callSeam(streamId: string, events: readonly EventRow[]): Promise<void> {
    try {
      await this.applyToProjection(streamId, events)
    } catch (err) {
      // A projection error must not corrupt the cursor (already committed truth);
      // ENG-80 recovers via a rebuild. Log + continue.
      console.warn('[sync] projection apply failed', { streamId, error: errText(err) })
    }
  }

  // -- WS live delivery contract (§9) -------------------------------------

  private onEventFrame(ev: WireEvent): Promise<void> {
    if (!ev.server || typeof ev.server.server_sequence !== 'number') return Promise.resolve()
    const sid = typeof ev.body?.stream_id === 'string' ? ev.body.stream_id : undefined
    if (!sid) return Promise.resolve()
    const seq = ev.server.server_sequence
    // Serialize the fast apply path per stream so two frames never both read a
    // stale cursor and each fire a redundant pull.
    return this.withStreamLock(sid, async () => {
      const cursor = await this.db.getCursor(sid)
      if (!cursor) {
        // No cursor. If we've also never seen this stream's metadata it is a
        // channel created (or made visible to us) mid-session (§9): do a
        // newest-page cold-start pull AND refresh /v1/sync so its `streams` row
        // lands immediately — NOT a walk-from-1 of full history.
        const known = await this.db.getStream(sid)
        if (!known) {
          this.triggerNewChannel(sid, seq)
          return
        }
      }
      const cur = cursor?.last_contiguous_seq ?? 0
      if (seq === cur + 1) {
        await this.applyForward(sid, [ev]) // contiguous — the fast path
      } else if (seq > cur + 1) {
        this.triggerPull(sid, cur) // GAP — targeted catch-up, never blind-apply
      }
      // else seq <= cur → duplicate / old → ignore
    })
  }

  /**
   * Start a coalesced, bound-retried live catch-up pull for `sid` (§9). Runs
   * DETACHED from the per-stream apply lock: safe because WS frames are delivered
   * in order, so a frame observed after this pull started reflects a seq the pull
   * already covers (or re-triggers, coalesced). One in-flight pull per stream.
   */
  private triggerPull(streamId: string, after: number): void {
    if (this.inflightPulls.has(streamId)) return // an existing pull will cover it
    this.inflightPulls.add(streamId)
    const epoch = this.epoch
    void this.runLiveGapPull(streamId, after, epoch).finally(() => {
      this.inflightPulls.delete(streamId)
    })
  }

  /** Drive a live gap pull with a few backoff retries before reporting stalled. */
  private async runLiveGapPull(streamId: string, after: number, epoch: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (this.isStale(epoch)) return
      try {
        await this.catchUp(streamId, after, epoch, 'live')
        return // drained cleanly
      } catch (err) {
        if (err instanceof BootstrapAborted) return
        if (!(err instanceof PullFailed)) {
          console.warn('[sync] gap pull failed', { streamId, error: errText(err) })
          return
        }
        if (attempt >= LIVE_PULL_MAX_RETRIES) {
          // Persistent failure on a healthy socket: reflect the stalled stream in
          // status rather than wedging silently. The next frame / reconnect retries.
          console.warn('[sync] gap pull stalled', { streamId, code: err.code })
          this.lastError = `gap pull stalled (${streamId}): ${err.code}`
          this.emitStatus(this.snapshot())
          return
        }
        await this.delay(this.backoffDelay(attempt))
      }
    }
  }

  /** Trigger a coalesced newest-page pull + `/v1/sync` refresh for a new channel. */
  private triggerNewChannel(streamId: string, seq: number): void {
    if (this.inflightPulls.has(streamId)) return
    this.inflightPulls.add(streamId)
    const epoch = this.epoch
    void (async () => {
      try {
        const res = await this.http.get<SyncResponse>('/v1/sync')
        if (this.isStale(epoch) || !res.ok) return
        await this.db.putStreams(res.value.streams.map(toStreamRow))
        const meta =
          res.value.streams.find((s) => s.stream_id === streamId) ??
          ({
            stream_id: streamId,
            kind: 'channel',
            name: null,
            visibility: null,
            head_seq: seq,
            member: false,
          } satisfies SyncStreamMeta)
        if (meta.head_seq > 0) await this.coldNewestPage(meta, epoch, 'live')
      } catch (err) {
        if (!(err instanceof BootstrapAborted) && !(err instanceof PullFailed)) {
          console.warn('[sync] new-channel pull failed', { streamId, error: errText(err) })
        }
      } finally {
        this.inflightPulls.delete(streamId)
      }
    })()
  }

  /** A cancellable-by-epoch delay on the injected clock (backoff between retries). */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setTimer(() => resolve(), ms)
    })
  }

  // -- backward backfill (§10) --------------------------------------------

  /**
   * Extend a stream's window backward one page (`before = oldest_loaded`) for
   * scrollback. Touches ONLY `oldest_loaded_seq` — the forward frontier
   * (`last_contiguous_seq`) is untouched. Called by the `sync.backfill` RPC.
   */
  async backfill(streamId: string): Promise<BackfillResult> {
    const cursor = await this.db.getCursor(streamId)
    const oldest = cursor?.oldest_loaded_seq ?? (await this.db.minStoredSeq(streamId)) ?? 0
    if (oldest <= 1) {
      return { events: 0, has_more: false, oldest_loaded_seq: Math.max(oldest, 0) }
    }
    const path = `/v1/events?stream_id=${encodeURIComponent(streamId)}&before=${oldest}&limit=${PULL_LIMIT}`
    const res = await this.http.get<EventsPageResponse>(path)
    if (!res.ok) {
      return { events: 0, has_more: false, oldest_loaded_seq: oldest }
    }
    const rows = await this.verifyAndStore(streamId, res.value.events)
    let newOldest = oldest
    const firstRow = rows[0]
    const lastRow = rows[rows.length - 1]
    if (firstRow && lastRow) {
      newOldest = firstRow.server_sequence
      const lastContiguous = cursor?.last_contiguous_seq ?? lastRow.server_sequence
      await this.db.putCursors([
        { stream_id: streamId, last_contiguous_seq: lastContiguous, oldest_loaded_seq: newOldest },
      ])
      await this.callSeam(streamId, rows)
      this.publishStream(streamId)
    }
    return { events: rows.length, has_more: res.value.has_more, oldest_loaded_seq: newOldest }
  }

  /**
   * Re-fetch `GET /v1/sync` and upsert the `streams` table (ENG-104). Called after
   * the client AUTHORS a workspace-meta event (channel create/rename/archive/
   * member, DM create) so the new/changed stream row + its authoritative
   * `member` / `archived` / `head_seq` land immediately — the sidebar's push
   * subscription then re-queries. A no-op on a failed fetch (the next bootstrap /
   * new-channel trigger reconciles). Does NOT touch cursors or pull events; those
   * ride the normal WS/new-channel path.
   */
  async refreshStreams(): Promise<void> {
    const res = await this.http.get<SyncResponse>('/v1/sync')
    if (!res.ok) return
    await this.db.putStreams(res.value.streams.map(toStreamRow))
  }

  // -- internals -----------------------------------------------------------

  private withStreamLock<T>(streamId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.streamLocks.get(streamId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.streamLocks.set(
      streamId,
      next.catch(() => undefined),
    )
    return next
  }

  private closeWs(): void {
    if (this.ws) {
      this.ws.close(WS_CLOSE_CLIENT_GOING_AWAY)
      this.ws = undefined
    }
  }

  private isStale(epoch: number): boolean {
    return this.stopped || epoch !== this.epoch
  }

  private setState(state: SyncState, lastError?: string): void {
    this.state = state
    if (lastError !== undefined) this.lastError = lastError
    if (state === 'idle' || state === 'live') this.lastError = undefined
    this.emitStatus(this.snapshot())
  }

  private snapshot(): SyncStatus {
    const status: SyncStatus = { state: this.state, online: this.online }
    if (this.streamsTotal !== undefined) status.streamsTotal = this.streamsTotal
    if (this.streamsSynced !== undefined) status.streamsSynced = this.streamsSynced
    if (this.lastError !== undefined) status.lastError = this.lastError
    return status
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Map a wire event to its denormalized `EventRow` (envelope stored verbatim).
 * Only ever called on events that passed the `verifyAndStore` server guard, so
 * `server.server_sequence` is present — `?? 0` just satisfies the optional type.
 */
function toEventRow(streamId: string, ev: WireEvent): EventRow {
  return {
    stream_id: streamId,
    server_sequence: ev.server?.server_sequence ?? 0,
    event_id: typeof ev.body?.event_id === 'string' ? ev.body.event_id : '',
    type: typeof ev.body?.type === 'string' ? ev.body.type : '',
    envelope: ev,
  }
}

function toStreamRow(stream: SyncStreamMeta): StreamRow {
  const row: StreamRow = {
    stream_id: stream.stream_id,
    kind: stream.kind,
    head_seq: stream.head_seq,
    member: stream.member,
    archived: stream.archived === true,
  }
  if (stream.name !== null) row.name = stream.name
  if (stream.visibility !== null) row.visibility = stream.visibility
  return row
}

/**
 * The newest gapless run in an ascending seq list: `last` = the maximum stored
 * seq (the forward frontier), `oldest` = the bottom of the contiguous block
 * ending at that maximum. `undefined` for an empty list.
 */
export function topContiguousRun(
  seqs: readonly number[],
): { last: number; oldest: number } | undefined {
  const n = seqs.length
  if (n === 0) return undefined
  const last = seqs[n - 1]
  if (last === undefined) return undefined
  let oldest = last
  for (let i = n - 2; i >= 0; i--) {
    const cur = seqs[i]
    const above = seqs[i + 1]
    if (cur !== undefined && above !== undefined && cur === above - 1) oldest = cur
    else break
  }
  return { last, oldest }
}

/** Run `worker` over `items` with at most `limit` concurrent invocations. */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const runNext = async (): Promise<void> => {
    while (index < items.length) {
      const current = items[index++]
      if (current !== undefined) await worker(current)
    }
  }
  const workers = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workers }, () => runNext()))
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
