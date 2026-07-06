// worker/projection.ts — the client `messages` projection (ENG-80): events →
// `messages` incremental apply (the seam ENG-79 calls), the client-side rebuild
// from cached `events`, the deterministic dump, and the projection query helpers.
//
// PERMANENT: this is the client (Dexie) side of §12 invariant 6 — "rebuild ≡
// incremental". `rebuildMessagesProjection` replays `events` through the SAME
// `applyEventsToProjection` the incremental path uses, so the two are equal by
// construction. `dumpMessages` is the byte-equality surface ENG-83 asserts on
// (client-incremental == client-rebuild, WITHIN the client — NOT client == server;
// this dump deliberately includes `format` + `mention_user_ids`, which the server
// projection (ENG-69) drops).
//
// D9 + client robustness (deliberate divergence from ENG-69's server hard-error):
// apply NEVER throws. Unknown types, `message.created` v>=2 (above-max version),
// meta events, and a MALFORMED-known payload (structurally valid envelope, known
// (type, version), but a missing/invalid `message_id`) all SKIP — the last with a
// `console.warn`, not a throw. On the client a throw here would wedge ENG-79's
// apply loop AND the boot rebuild; skipping is deterministic (both incremental and
// rebuild skip identically), so equivalence still holds. Do NOT "fix" the skip to
// a throw.

import { computeStreamBadge } from './badges'
import type {
  EventBody,
  EventRow,
  MessageRow,
  MessagesListResult,
  MsgDb,
  StreamBadge,
  StreamRow,
} from './types'

/** Default page size for `messages.list` when the caller omits `limit`. */
export const DEFAULT_MESSAGE_PAGE = 50

/** Hard cap on a `messages.list` page (mirrors the server's page cap). */
export const MAX_MESSAGE_PAGE = 500

/**
 * Clamp a requested page size into `[1, MAX_MESSAGE_PAGE]`. A missing/NaN limit
 * falls to the default; Infinity / oversize clamps to the cap; 0 / negative
 * clamps to 1. This keeps the `fetch limit+1` has_more sentinel meaningful — an
 * unclamped `Infinity` limit makes `limit + 1` still `Infinity`, so
 * `rows.length > limit` is always false and pagination silently breaks.
 */
function clampLimit(requested: number | undefined): number {
  if (requested === undefined || Number.isNaN(requested)) return DEFAULT_MESSAGE_PAGE
  if (requested >= MAX_MESSAGE_PAGE) return MAX_MESSAGE_PAGE // clamps Infinity + oversize
  if (requested < 1) return 1 // clamps 0, negatives, -Infinity
  return Math.floor(requested)
}

/** Builds a `MessageRow` from an event + its body, or `null` to skip (D9/malformed). */
export type MessageHandler = (event: EventRow, body: EventBody) => MessageRow | null

/**
 * Projection dispatch, keyed `` `${type}@${type_version}` `` (mirrors ENG-58's
 * `_HANDLERS` / ENG-69's registry). Only `message.created` v1 projects a row.
 * Exported (mutable) so the equivalence gate can monkeypatch a handler for the
 * rebuild pass only (the ENG-61 "teeth" discipline).
 */
export const HANDLERS: Record<string, MessageHandler> = {
  'message.created@1': applyMessageCreatedV1,
}

/**
 * Materialize a `message.created` v1 event into a `MessageRow`, or skip (`null`)
 * on a malformed-known payload. Every field is a deterministic pure function of
 * the event, so a re-derived row is byte-identical to the stored one (idempotent
 * upsert = no-op) and rebuild ≡ incremental holds.
 */
export function applyMessageCreatedV1(event: EventRow, body: EventBody): MessageRow | null {
  const payload = body.payload
  if (payload === null || typeof payload !== 'object') {
    console.warn(
      `projection: message.created v1 with a non-object payload at ${event.stream_id}#${event.server_sequence} — skipping`,
    )
    return null
  }
  const p = payload as Record<string, unknown>
  const messageId = p.message_id
  if (typeof messageId !== 'string' || messageId.length === 0) {
    console.warn(
      `projection: message.created v1 with missing/invalid message_id at ${event.stream_id}#${event.server_sequence} — skipping`,
    )
    return null
  }

  const row: MessageRow = {
    message_id: messageId,
    stream_id: event.stream_id,
    created_seq: event.server_sequence,
    author_user_id: typeof body.author_user_id === 'string' ? body.author_user_id : '',
    text: typeof p.text === 'string' ? p.text : '',
    format: p.format === 'plain' ? 'plain' : 'markdown',
    mention_user_ids: Array.isArray(p.mentions)
      ? p.mentions.filter((m): m is string => typeof m === 'string')
      : [],
  }
  // `thread_root_id` is optional: present values are indexed, root messages omit it.
  if (typeof p.thread_root_id === 'string') {
    row.thread_root_id = p.thread_root_id
  }
  return row
}

/**
 * Incrementally apply a per-stream batch of events into `messages` — the seam
 * ENG-79 calls after it has written the events into `events` and advanced
 * `cursors`. Idempotent (upsert by `message_id`), D9-safe (skip, never throw),
 * writes ONLY the `messages` table.
 *
 * `db` first, then `streamId`, then the new events (the pinned seam signature).
 */
export async function applyEventsToProjection(
  db: MsgDb,
  streamId: string,
  events: readonly EventRow[],
): Promise<void> {
  // Fixed apply order (ascending server_sequence). State is order-independent
  // (immutable message_id keys), but a fixed order keeps a run reproducible.
  const ordered = [...events].sort((a, b) => a.server_sequence - b.server_sequence)
  const rows: MessageRow[] = []
  for (const event of ordered) {
    // Defensive: the seam is per-stream; a foreign-stream event is not this
    // batch's to project (never throw — just skip).
    if (event.stream_id !== streamId) continue
    const body = event.envelope?.body
    // Defensive skip if ENG-79 handed a body-less row (shape-mismatch degrades to
    // "no rows", caught loudly by the equivalence + query tests, not a crash).
    if (body === undefined) continue
    const handler = HANDLERS[`${event.type}@${body.type_version}`]
    if (handler === undefined) continue // D9: unknown type / v>=2 / meta → skip
    const row = handler(event, body)
    if (row !== null) rows.push(row)
  }
  if (rows.length > 0) await db.putMessages(rows)
}

/**
 * Client-side rebuild (§12 invariant 6): replay the cached `events` into
 * `messages`, stream by stream. Reuses `applyEventsToProjection` verbatim, so
 * the rebuilt state is byte-identical to the incremental one.
 */
export async function rebuildMessagesProjection(db: MsgDb): Promise<void> {
  const streamIds = await db.listStreamIds()
  for (const streamId of [...streamIds].sort()) {
    const events = await db.getEventsForStream(streamId) // ascending server_sequence
    await applyEventsToProjection(db, streamId, events)
  }
}

// ---------------------------------------------------------------------------
// Deterministic dump (Ruling 3) — the ENG-83 equivalence surface.
// ---------------------------------------------------------------------------

/** Serialize one row as a compact JSON object with the canonical key order. */
function serializeRow(row: MessageRow): string {
  // Explicit ordered projection — NEVER JSON.stringify(row) (field order is not
  // guaranteed). JSON.stringify preserves string-key insertion order and emits
  // compact output (= ENG-58's separators=(",",":")) and raw non-ASCII (= ensure_ascii=False).
  const ordered = {
    message_id: row.message_id,
    stream_id: row.stream_id,
    created_seq: row.created_seq,
    author_user_id: row.author_user_id,
    text: row.text,
    format: row.format,
    thread_root_id: row.thread_root_id ?? null, // stable: null when absent
    mention_user_ids: row.mention_user_ids,
  }
  return JSON.stringify(ordered)
}

/** Total, stable order: (stream_id, created_seq, message_id). */
function compareRows(a: MessageRow, b: MessageRow): number {
  if (a.stream_id !== b.stream_id) return a.stream_id < b.stream_id ? -1 : 1
  if (a.created_seq !== b.created_seq) return a.created_seq - b.created_seq
  if (a.message_id !== b.message_id) return a.message_id < b.message_id ? -1 : 1
  return 0
}

/**
 * The canonical `messages` serialization (Dexie analogue of ENG-58's
 * `dump_messages`): all rows sorted by `(stream_id, created_seq, message_id)`,
 * each one compact JSON object with fixed key order, `\n`-joined. ENG-83 asserts
 * `client-incremental === client-rebuild` on this.
 */
export async function dumpMessages(db: MsgDb): Promise<string> {
  const rows = await db.getAllMessages()
  rows.sort(compareRows)
  return rows.map(serializeRow).join('\n')
}

// ---------------------------------------------------------------------------
// Projection query helpers (Ruling 5) — the read surface the `query` RPC serves.
// ---------------------------------------------------------------------------

/**
 * A page of a stream's messages, newest-first, paginated by `created_seq`
 * (older pages via `beforeSeq`). Fetches `limit + 1` to decide `has_more`.
 */
export async function listMessages(
  db: MsgDb,
  streamId: string,
  opts: { beforeSeq?: number; limit?: number } = {},
): Promise<MessagesListResult> {
  const limit = clampLimit(opts.limit)
  // A missing / NaN / Infinity before_seq degrades to "from the head" (undefined).
  const beforeSeq = Number.isFinite(opts.beforeSeq) ? opts.beforeSeq : undefined
  const rows = await db.listMessagesByStream(streamId, {
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    limit: limit + 1,
  })
  const has_more = rows.length > limit
  return { messages: has_more ? rows.slice(0, limit) : rows, has_more }
}

/** A single projected message by id, or `null` on a miss (`message.get`). */
export async function getMessage(db: MsgDb, messageId: string): Promise<MessageRow | null> {
  return (await db.getMessage(messageId)) ?? null
}

/** The sidebar: every stream merged with its unread/mention badge (`streams.list`). */
export async function listStreamsForSidebar(
  db: MsgDb,
  myUserId: string,
): Promise<Array<StreamRow & StreamBadge>> {
  const streams = await db.listStreams()
  return Promise.all(
    streams.map(async (stream) => {
      const badge = await computeStreamBadge(db, stream.stream_id, myUserId)
      return { ...stream, ...badge }
    }),
  )
}
