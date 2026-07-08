// worker/readstate.ts — the ReadStateManager (ENG-126, ENG-123).
//
// Read-state is SYNCED-KV, not derived: the server owns a per-user
// `(stream_id → last_read_seq)` map (monotonic under GREATEST), the client keeps
// a local mirror in the `read_state` Dexie table, and the unread/mention badge
// (badges.ts) reads that mirror at query time. This module funnels EVERY write —
// bootstrap pull, optimistic mark, PUT-result, and inbound WS echo — through one
// monotonic upsert, so the four paths reconcile idempotently and the badge never
// rewinds (a late lower-seq echo can't un-read a stream).
//
// The `read_state` table is REBUILD-EXEMPT (types.ts D3): a projection-version
// bump must NOT wipe it, or badges would silently un-read on a shape-skew boot.
// This manager holds a db handle (it PERSISTS) — contrast the ephemeral
// presence/typing module, which structurally cannot.

import type { HttpClient } from './http'
import type { MsgDb, ReadStateRow } from './types'

/** `GET /v1/read-state` row — we read only `stream_id`/`last_read_seq`; badges compute unread locally. */
interface ReadStateServerRow {
  stream_id: string
  last_read_seq: number
  head_seq?: number
  unread?: number
}
interface ReadStateGetResponse {
  streams: ReadStateServerRow[]
}
/** `PUT /v1/read-state` result — the EFFECTIVE (server GREATEST) value. */
interface ReadStatePutResponse {
  stream_id: string
  last_read_seq: number
}

export interface ReadStateManagerDeps {
  db: MsgDb
  http: HttpClient
  /** Fan a `{kind:'stream'}` push so the sidebar re-derives the badge (reactivity). */
  publishStream: (streamId: string) => void
}

export class ReadStateManager {
  private readonly db: MsgDb
  private readonly http: HttpClient
  private readonly publishStream: (streamId: string) => void

  constructor(deps: ReadStateManagerDeps) {
    this.db = deps.db
    this.http = deps.http
    this.publishStream = deps.publishStream
  }

  /**
   * The ONE write path. Mirrors the server GREATEST via the db's ATOMIC
   * compare-and-set ({@link MsgDb.upsertReadStateMonotonic}): persist `seq` for
   * `streamId` ONLY when it strictly exceeds the stored value, with the read + write
   * in a single transaction. That atomicity matters because two chains reconcile the
   * same marker concurrently — an RPC `mark` and a `void applyEcho` off a WS frame —
   * and a non-atomic read-modify-write could let the later WRITE (by order) clobber a
   * higher VALUE. Returns whether it advanced; callers publish on a change.
   */
  private upsertMonotonic(streamId: string, seq: number): Promise<boolean> {
    return this.db.upsertReadStateMonotonic(streamId, seq)
  }

  /**
   * Seed the local mirror from `GET /v1/read-state` (rising-edge-into-`live`).
   * Monotonic-upsert each stream's `last_read_seq`; `head_seq`/`unread` are IGNORED
   * (badges recompute unread locally off `streams.head_seq`). A failed fetch is a
   * no-op — the next live edge retries. Publishes each stream whose value advanced.
   */
  async bootstrap(): Promise<void> {
    const res = await this.http.get<ReadStateGetResponse>('/v1/read-state')
    if (!res.ok) return
    for (const row of res.value.streams) {
      if (typeof row.stream_id !== 'string' || typeof row.last_read_seq !== 'number') continue
      if (await this.upsertMonotonic(row.stream_id, row.last_read_seq)) {
        this.publishStream(row.stream_id)
      }
    }
  }

  /**
   * `readState.mark` — record `seq` as read for `streamId`. OPTIMISTIC FIRST:
   * monotonic-upsert + publish so the badge clears instantly, THEN `PUT` and
   * monotonic-upsert the effective (GREATEST) value the server echoes. Returns the
   * current mirror row. A failed PUT keeps the optimistic value (the echo/next
   * bootstrap reconciles) — never throws past the RPC boundary for a transient blip.
   */
  async mark(streamId: string, seq: number): Promise<ReadStateRow> {
    await this.upsertMonotonic(streamId, seq)
    this.publishStream(streamId)

    const res = await this.http.put<ReadStatePutResponse>('/v1/read-state', {
      stream_id: streamId,
      last_read_seq: seq,
    })
    if (res.ok && typeof res.value.last_read_seq === 'number') {
      if (await this.upsertMonotonic(streamId, res.value.last_read_seq)) {
        this.publishStream(streamId)
      }
    }
    const row = await this.db.getReadState(streamId)
    return row ?? { stream_id: streamId, last_read_seq: seq }
  }

  /**
   * Apply an inbound `{t:'read_state',stream_id,last_read_seq}` WS echo (a mark from
   * ANOTHER device of the same user). Monotonic-upsert + publish on a change — a
   * lower-seq echo is ignored (idempotent), a higher-seq echo advances the badge.
   */
  async applyEcho(echo: { stream_id: string; last_read_seq: number }): Promise<void> {
    if (await this.upsertMonotonic(echo.stream_id, echo.last_read_seq)) {
      this.publishStream(echo.stream_id)
    }
  }
}
