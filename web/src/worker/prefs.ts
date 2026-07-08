// worker/prefs.ts — the PrefsManager (ENG-126, ENG-124).
//
// Notification prefs are SYNCED-KV, not derived: the server owns a per-user
// `(stream_id → level)` map with LAST-WRITE-WINS semantics (all | mentions |
// mute), and the client mirrors it in the `prefs` Dexie table. Unlike read-state
// (monotonic GREATEST), prefs are LWW: a set/echo/PUT-result REPLACES the stored
// level unconditionally (no ordering). Absent ⇒ `all` (the default).
//
// The `prefs` table is REBUILD-EXEMPT synced state (types.ts D3): its Dexie
// `version(4)` table is an additive INDEX-layout bump that MUST NOT bump
// PROJECTION_VERSION, and a projection rebuild PRESERVES it. This manager holds a
// db handle (it PERSISTS) — contrast the ephemeral presence/typing module.

import type { HttpClient } from './http'
import type { MsgDb, PrefLevel, PrefsRow } from './types'

/** `GET /v1/prefs` response. */
interface PrefsGetResponse {
  prefs: Array<{ stream_id: string; level: PrefLevel }>
}
/** `PUT /v1/prefs` result — the echoed (LWW) level. */
interface PrefsPutResponse {
  stream_id: string
  level: PrefLevel
}

/** The three legal notification levels — used to reject malformed inbound levels (D9). */
const LEVELS: readonly PrefLevel[] = ['all', 'mentions', 'mute']
export function isPrefLevel(v: unknown): v is PrefLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
}

export interface PrefsManagerDeps {
  db: MsgDb
  http: HttpClient
  /** Fan a `{kind:'prefs'}` push (the full snapshot) so the UI re-reads on change. */
  publishPrefs: () => void
}

export class PrefsManager {
  private readonly db: MsgDb
  private readonly http: HttpClient
  private readonly publishPrefs: () => void

  constructor(deps: PrefsManagerDeps) {
    this.db = deps.db
    this.http = deps.http
    this.publishPrefs = deps.publishPrefs
  }

  /** LWW upsert: replace the stored level for `streamId` unconditionally. */
  private async put(streamId: string, level: PrefLevel): Promise<void> {
    await this.db.putPrefs([{ stream_id: streamId, level }])
  }

  /**
   * Seed the local mirror from `GET /v1/prefs` (rising-edge-into-`live`). LWW-upsert
   * each row; a failed fetch is a no-op (the next live edge retries). Publishes once.
   */
  async bootstrap(): Promise<void> {
    const res = await this.http.get<PrefsGetResponse>('/v1/prefs')
    if (!res.ok) return
    let changed = false
    for (const row of res.value.prefs) {
      if (typeof row.stream_id !== 'string' || !isPrefLevel(row.level)) continue
      await this.put(row.stream_id, row.level)
      changed = true
    }
    if (changed) this.publishPrefs()
  }

  /**
   * `prefs.set` — set `streamId`'s notification level. OPTIMISTIC local LWW set +
   * publish, then `PUT /v1/prefs` and LWW-upsert from the echoed result. Returns the
   * effective row. A failed PUT keeps the optimistic value (echo/next bootstrap
   * reconciles) — never throws past the RPC boundary for a transient blip.
   */
  async set(streamId: string, level: PrefLevel): Promise<PrefsRow> {
    await this.put(streamId, level)
    this.publishPrefs()

    const res = await this.http.put<PrefsPutResponse>('/v1/prefs', {
      stream_id: streamId,
      level,
    })
    let effective = level
    if (res.ok && isPrefLevel(res.value.level)) {
      effective = res.value.level
      await this.put(streamId, effective)
      this.publishPrefs()
    }
    return { stream_id: streamId, level: effective }
  }

  /**
   * Apply an inbound `{t:'prefs',stream_id,level}` WS echo (a set from ANOTHER
   * device of the same user). Unconditional LWW replace + publish (no ordering).
   */
  async applyEcho(echo: { stream_id: string; level: PrefLevel }): Promise<void> {
    await this.put(echo.stream_id, echo.level)
    this.publishPrefs()
  }

  /** The stored level for a stream, defaulting to `all` when absent. */
  async getLevel(streamId: string): Promise<PrefLevel> {
    const row = await this.db.getPrefs(streamId)
    return row?.level ?? 'all'
  }

  /** The full pref snapshot (`prefs.get`). Absent streams are `all` by convention. */
  list(): Promise<PrefsRow[]> {
    return this.db.listPrefs()
  }
}
