// worker/mirror/rebuild.ts — rebuild-from-disk (M6-3, ENG-167): §12
// invariant 6 EXTENDED to the on-disk NDJSON log, the desktop analogue of
// `msgctl rebuild`.
//
// The durable log is the source of truth: this path re-derives the ENTIRE
// local database — the `events` cache AND every derived projection — from
// `streams/<id>/*.ndjson` alone, re-verifying each event's `event_hash`
// (SHA-256 over the JCS canonicalization of the RAW body, D1) before a single
// row lands. The replay then runs through the SAME `rebuildProjections` /
// `applyEventsToProjection` the incremental path uses, which is what makes
// rebuild-from-disk ≡ incremental true by construction (asserted byte-for-byte
// on `dumpMessages`/`dumpFiles` by the M6-3 gate).
//
// FAIL-CLOSED: the whole log is parsed + hash-verified BEFORE anything is
// dropped. A single tampered/torn line aborts the rebuild with the database
// untouched — a flipped body byte must never be laundered into a projection.
//
// Pure TS over the injected EventLog seam — no platform globals; the same
// function serves the Node-fs impls today and the Tauri impls in M6-5.

import { hashEvent, type JSONValue } from '../../core'
import { rebuildProjections } from '../db'
import type { EventRow, MsgDb, StoredEnvelope } from '../types'

import type { EventLog } from './seams'

/** Rebuild summary — what was replayed (test/diagnostic surface). */
export interface RebuildFromDiskResult {
  streams: number
  events: number
}

/**
 * Drop `events` + the derived tables, repopulate `events` from the on-disk
 * NDJSON log (hash-reverified, fail-closed), and replay the projections.
 *
 * @throws {Error} on the first unparseable line, malformed envelope, or
 *   `event_hash` mismatch — BEFORE any local state is dropped.
 */
export async function rebuildFromEventLog(
  db: MsgDb,
  log: EventLog,
): Promise<RebuildFromDiskResult> {
  // Pass 1 — read + verify EVERYTHING first (fail-closed, db untouched).
  const streamIds = await log.listStreams()
  const rowsByStream = new Map<string, EventRow[]>()
  let total = 0
  for (const sid of streamIds) {
    const lines = await log.readAll(sid)
    const rows: EventRow[] = []
    for (const line of lines) {
      rows.push(await verifyLine(sid, line, rows.length))
    }
    rowsByStream.set(sid, rows)
    total += rows.length
  }

  // Pass 2 — drop the events cache + derived tables, then repopulate + replay.
  for (const sid of await db.listStreamIds()) {
    await db.deleteEventsBySequence(sid, await db.listEventSequences(sid))
  }
  await db.clearDerivedTables()
  for (const rows of rowsByStream.values()) {
    if (rows.length > 0) await db.putEvents(rows)
  }
  // The SAME replay the incremental path uses (invariant 6). This also
  // re-derives still-pending rows from `outbox` — outbox rows are
  // source-of-truth and are deliberately NOT touched by this rebuild.
  await rebuildProjections(db)
  return { streams: rowsByStream.size, events: total }
}

/** Parse + hash-verify one NDJSON line into its EventRow (throws on any fault). */
async function verifyLine(streamId: string, line: string, index: number): Promise<EventRow> {
  const at = `${streamId} line ${index + 1}`
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    throw new Error(`rebuildFromEventLog: unparseable NDJSON line at ${at}`)
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`rebuildFromEventLog: line is not a JSON object at ${at}`)
  }
  const env = obj as StoredEnvelope
  const seq = env.server?.server_sequence
  const eventId = env.body?.event_id
  const type = env.body?.type
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    throw new Error(`rebuildFromEventLog: missing/invalid server_sequence at ${at}`)
  }
  if (typeof eventId !== 'string' || typeof type !== 'string') {
    throw new Error(`rebuildFromEventLog: missing body.event_id/body.type at ${at}`)
  }
  // The D1 hash check, on the RAW parsed body (never a re-serialized model):
  // recompute sha256 over JCS(body) and compare to the stored string.
  let computed: string
  try {
    computed = await hashEvent(env.body as unknown as JSONValue)
  } catch (err) {
    throw new Error(
      `rebuildFromEventLog: body not canonicalizable at ${at} (seq ${seq}): ${String(err)}`,
    )
  }
  if (computed !== env.event_hash) {
    throw new Error(
      `rebuildFromEventLog: event_hash mismatch at ${at} (seq ${seq}) — ` +
        `the on-disk log failed verification; refusing to rebuild from it`,
    )
  }
  return {
    stream_id: streamId,
    server_sequence: seq,
    event_id: eventId,
    type,
    envelope: env,
  }
}
