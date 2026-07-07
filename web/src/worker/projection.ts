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
  DirectoryListResult,
  DirectoryUser,
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

// ---------------------------------------------------------------------------
// M3 stateful handlers (ENG-100). Unlike `message.created` (a PURE row builder),
// reactions/edits/deletes/threads read + write the projection, so they run
// against `db` inside `applyEventsToProjection`. Each MIRRORS the server's
// `apply.py` handler so client rebuild ≡ incremental AND client ≡ server on the
// shared fields. Every handler is a D9-safe no-op on a malformed/missing target
// (skip, never throw) and idempotent (re-apply is a no-op) so replay is safe.
// ---------------------------------------------------------------------------

/** Extract a non-empty-string field from a payload, or `undefined`. */
function strField(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const v = (payload as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * `reaction.added` v1 — idempotent set-insert of the membership
 * `(message_id, author_user_id, emoji)` (mirrors `_apply_reaction_added`). The
 * reactor is the ENVELOPE `author_user_id` (not the payload); `emoji` is an
 * exact-byte key (opaque — no grapheme normalization). Already-present membership
 * is a no-op, so the derived count is a pure function of the log.
 */
export async function applyReactionAdded(db: MsgDb, body: EventBody): Promise<void> {
  const messageId = strField(body.payload, 'message_id')
  const emoji = strField(body.payload, 'emoji')
  const author = typeof body.author_user_id === 'string' ? body.author_user_id : ''
  if (messageId === undefined || emoji === undefined || author === '') return // D9 skip
  await db.putReactions([{ message_id: messageId, author_user_id: author, emoji }])
}

/**
 * `reaction.removed` v1 — idempotent set-delete of the membership (mirrors
 * `_apply_reaction_removed`). Removing an absent reaction deletes nothing. Exported
 * so the optimistic outbox overlay applies the SAME effect (a pending reaction is
 * identical to its eventual settled one — no seq/LWW — so settle is a no-op).
 */
export async function applyReactionRemoved(db: MsgDb, body: EventBody): Promise<void> {
  const messageId = strField(body.payload, 'message_id')
  const emoji = strField(body.payload, 'emoji')
  const author = typeof body.author_user_id === 'string' ? body.author_user_id : ''
  if (messageId === undefined || emoji === undefined || author === '') return // D9 skip
  await db.deleteReaction(messageId, author, emoji)
}

/**
 * `message.edited` v1 — LWW by `server_sequence` (mirrors `_apply_message_edited`).
 * Applies `text`+`format`+`edited_seq` only when this event out-ranks the current
 * state — `server_sequence > coalesce(edited_seq, created_seq)` — AND the row is
 * NOT deleted (delete is terminal: an edit after a delete, any order, is skipped
 * so it never un-deletes/un-redacts). The single guard makes the apply
 * order-independent (converges to the highest-seq edit). Unlike the server the
 * CLIENT also stores `format` (the payload carries it). A missing/older/deleted
 * target is a safe no-op.
 */
async function applyMessageEdited(db: MsgDb, event: EventRow, body: EventBody): Promise<void> {
  const messageId = strField(body.payload, 'message_id')
  if (messageId === undefined) return // D9 skip
  const existing = await db.getMessage(messageId)
  if (existing === undefined || existing.deleted === true) return // no row / terminal
  const floor = existing.edited_seq ?? existing.created_seq
  if (event.server_sequence <= floor) return // LWW: older/equal → skip
  const p = body.payload as Record<string, unknown>
  const updated: MessageRow = {
    ...existing,
    text: typeof p.text === 'string' ? p.text : '',
    format: p.format === 'plain' ? 'plain' : 'markdown',
    edited_seq: event.server_sequence,
  }
  await db.putMessages([updated])
}

/**
 * OPTIMISTIC (pending-overlay) edit (ENG-100). Unlike the settled
 * {@link applyMessageEdited}, this has NO `server_sequence`, so it force-applies
 * `text`+`format` and DELIBERATELY LEAVES `edited_seq` untouched — the eventual
 * settled edit (real seq) then wins the LWW guard cleanly (real_seq >
 * coalesce(edited_seq, created_seq)) and stamps the real `edited_seq`, converging
 * to one effect. Guarded on `deleted` (an optimistic edit of a tombstoned message
 * is a no-op, same terminal rule). A missing target is a no-op. Applied identically
 * by the incremental send path AND the rebuild-step-2 overlay, so the two agree.
 */
export async function applyPendingEdit(db: MsgDb, body: EventBody): Promise<void> {
  const messageId = strField(body.payload, 'message_id')
  if (messageId === undefined) return
  const existing = await db.getMessage(messageId)
  if (existing === undefined || existing.deleted === true) return
  const p = body.payload as Record<string, unknown>
  const updated: MessageRow = {
    ...existing,
    text: typeof p.text === 'string' ? p.text : '',
    format: p.format === 'plain' ? 'plain' : 'markdown',
  }
  await db.putMessages([updated])
}

/**
 * `message.deleted` v1 — tombstone + content REDACTION (mirrors
 * `_apply_message_deleted`). Sets `deleted=true` AND `text=''` UNCONDITIONALLY
 * (delete always wins over any edit, any replay order; delete-after-delete
 * re-sets the same tombstone). The projected content is redacted so the client
 * cannot render/serve deleted text — the raw event still lives in the `events`
 * cache (event-sourcing reality; ENG-111 owns cache redaction). When the deleted
 * message was itself a REPLY, recompute the root's thread state (delete-side of
 * the reply counter). A delete of a message with no projected row is a no-op.
 */
export async function applyMessageDeleted(db: MsgDb, body: EventBody): Promise<void> {
  const messageId = strField(body.payload, 'message_id')
  if (messageId === undefined) return // D9 skip
  const existing = await db.getMessage(messageId)
  if (existing === undefined) return // no row → no-op
  const updated: MessageRow = { ...existing, deleted: true, text: '' }
  await db.putMessages([updated])
  if (existing.thread_root_id !== undefined) {
    await recomputeThreadRoot(db, existing.thread_root_id)
  }
}

/**
 * RECOMPUTE a thread root's `reply_count` / `last_reply_seq` / participants from
 * the CURRENT `messages` table (mirrors `_recompute_thread_root`, D7). Given a
 * `rootMessageId` it derives ALL thread state from that root's replies that are
 * NOT deleted AND SETTLED (`state === undefined` — a pending/failed reply does
 * not bump a settled counter, so incremental and rebuild-step-2 agree):
 *   • `reply_count`    = count of those replies (on the root's own row);
 *   • `last_reply_seq` = max `created_seq` among them (absent when none);
 *   • participants     = their DISTINCT `author_user_id` set (sorted; delete-all-
 *     then-insert so it is a pure function of the current reply set).
 *
 * WHY RECOMPUTE not `+1`: a reply can be deleted after being counted, so a blind
 * increment is not invertible. Recomputing makes every value a pure function of
 * the `messages` table (whose state is itself rebuild ≡ incremental), triggered on
 * exactly the events that change a root's non-deleted-reply set (reply create /
 * reply delete) — so the last such event leaves the derived state equal to a full
 * replay's, in any order.
 */
export async function recomputeThreadRoot(db: MsgDb, rootMessageId: string): Promise<void> {
  const replies = (await db.listRepliesByRoot(rootMessageId)).filter(
    (r) => r.deleted !== true && r.state === undefined,
  )
  const root = await db.getMessage(rootMessageId)
  if (root !== undefined) {
    const replyCount = replies.length
    const updated: MessageRow = { ...root, reply_count: replyCount }
    if (replies.length > 0) {
      updated.last_reply_seq = Math.max(...replies.map((r) => r.created_seq))
    } else {
      delete updated.last_reply_seq
    }
    await db.putMessages([updated])
  }
  // Rebuild the participant set for this root from the current non-deleted replies.
  await db.deleteThreadParticipantsForRoot(rootMessageId)
  const authors = [...new Set(replies.map((r) => r.author_user_id))].sort()
  if (authors.length > 0) {
    await db.putThreadParticipants(
      authors.map((user_id) => ({ root_message_id: rootMessageId, user_id })),
    )
  }
}

/**
 * `message.created` v1 apply (via the monkeypatchable {@link HANDLERS} registry,
 * so the ENG-61 teeth pattern still bites). Builds the row, then:
 *   • upserts it UNLESS an already-MUTATED row exists (edited or deleted) — the
 *     client analogue of the server `ON CONFLICT DO NOTHING`: a duplicate delivery
 *     must not clobber a later edit/delete. A pending optimistic row is never
 *     mutated, so it still settles in place (created_seq: sentinel → server_seq);
 *   • if it is a REPLY, recomputes its ROOT's thread state (the reply must land
 *     first so it is included in the count) — mirroring `_apply_message_created`.
 *
 * Like the server, a NON-reply message gets no thread recompute: a valid reply is
 * always in the same stream as its root (cross-stream/reply-of-reply are server-
 * rejected — the client only sees valid replies), so the root's `message.created`
 * always applies before its replies' and no "reply before root" recompute is
 * needed. `reply_count`/`last_reply_seq` therefore exist only on a root that has
 * received a reply (absent ⇒ 0 in the dump).
 */
async function applyMessageCreated(db: MsgDb, event: EventRow, body: EventBody): Promise<void> {
  const handler = HANDLERS['message.created@1']
  const row = handler ? handler(event, body) : null
  if (row === null) return // malformed-known → skip (warned inside the builder)
  const existing = await db.getMessage(row.message_id)
  const mutated =
    existing !== undefined && (existing.deleted === true || existing.edited_seq !== undefined)
  if (!mutated) await db.putMessages([row])
  if (row.thread_root_id !== undefined) await recomputeThreadRoot(db, row.thread_root_id)
}

/**
 * Incrementally apply a per-stream batch of events into the derived projection
 * (`messages` + ENG-100's `reactions` / `thread_participants`) — the seam ENG-79
 * calls after it has written the events into `events` and advanced `cursors`.
 * Idempotent, D9-safe (skip, never throw). Dispatch is keyed `(type@version)`
 * (mirrors the server `_HANDLERS`); an unknown type / above-max version / meta
 * event has no handler and is skipped.
 *
 * `db` first, then `streamId`, then the new events (the pinned seam signature).
 */
export async function applyEventsToProjection(
  db: MsgDb,
  streamId: string,
  events: readonly EventRow[],
): Promise<void> {
  // Fixed apply order (ascending server_sequence) — LWW/thread recompute read the
  // current state, so a deterministic order keeps a run reproducible.
  const ordered = [...events].sort((a, b) => a.server_sequence - b.server_sequence)
  for (const event of ordered) {
    // Defensive: the seam is per-stream; a foreign-stream event is not this
    // batch's to project (never throw — just skip).
    if (event.stream_id !== streamId) continue
    const body = event.envelope?.body
    // Defensive skip if ENG-79 handed a body-less row (degrades to a no-op).
    if (body === undefined) continue
    switch (`${event.type}@${body.type_version}`) {
      case 'message.created@1':
        await applyMessageCreated(db, event, body)
        break
      case 'reaction.added@1':
        await applyReactionAdded(db, body)
        break
      case 'reaction.removed@1':
        await applyReactionRemoved(db, body)
        break
      case 'message.edited@1':
        await applyMessageEdited(db, event, body)
        break
      case 'message.deleted@1':
        await applyMessageDeleted(db, body)
        break
      default:
        break // D9: unknown type / v>=2 / meta → skip
    }
  }
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

/** Kinds excluded from the `#channel` autocomplete (DMs + infra). */
const NON_CHANNEL_KINDS = new Set(['dm', 'workspace-meta'])

/**
 * The `@mention` / `#channel` autocomplete source (ENG-101). Users are folded
 * from the cached `workspace-meta` events (`user.joined` adds, `user.left`
 * removes, `user.profile_updated` renames) and channels come from the member
 * `streams`. A pure LOCAL projection read — it touches only the Dexie cache, never
 * the network — so the composer's autocomplete is instant and stays inside the
 * token boundary. Both lists are sorted for a stable, predictable dropdown.
 */
export async function listDirectory(db: MsgDb): Promise<DirectoryListResult> {
  const streams = await db.listStreams()

  const channels = streams
    .filter((s) => s.member && !NON_CHANNEL_KINDS.has(s.kind))
    .map((s) => ({ stream_id: s.stream_id, name: s.name ?? s.stream_id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const byId = new Map<string, string>() // user_id → display_name
  const metaStreams = streams.filter((s) => s.kind === 'workspace-meta')
  for (const meta of metaStreams) {
    const events = await db.getEventsForStream(meta.stream_id) // ascending server_sequence
    for (const event of events) {
      const payload = event.envelope?.body?.payload
      if (payload === null || typeof payload !== 'object') continue
      const p = payload as Record<string, unknown>
      const userId = typeof p.user_id === 'string' ? p.user_id : undefined
      if (userId === undefined) continue
      const displayName = typeof p.display_name === 'string' ? p.display_name : undefined
      switch (event.type) {
        case 'user.joined':
          byId.set(userId, displayName ?? userId)
          break
        case 'user.left':
          byId.delete(userId)
          break
        case 'user.profile_updated':
          // A rename only applies to a still-present member; ignore if they left.
          if (byId.has(userId) && displayName !== undefined) byId.set(userId, displayName)
          break
      }
    }
  }

  const users: DirectoryUser[] = [...byId.entries()]
    .map(([user_id, display_name]) => ({ user_id, display_name }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name))

  return { users, channels }
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
