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
  MessageReactions,
  MessageRow,
  MessagesListResult,
  MsgDb,
  ReactionAggregate,
  ReactionsListResult,
  StreamBadge,
  StreamRow,
  ThreadParticipant,
  ThreadResult,
  ThreadsListResult,
  ThreadSummary,
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
 * Seq-aware LWW core for a reaction event (ENG-100 out-of-order fix). For the key
 * `(message_id, author_user_id, emoji)`, apply the event ONLY if its
 * `server_sequence` OUT-RANKS the stored last-event seq — `seq > last_event_seq`
 * (or no row yet) — then stamp `{ last_event_seq: seq, present }`. A `remove`
 * writes a TOMBSTONE (`present:false`) rather than deleting the row, so a later
 * LOWER-seq add cannot resurrect it. This mirrors the edit LWW and makes a
 * reaction "present iff its highest-seq event is an add" — order-independent, so
 * client rebuild ≡ incremental under any (out-of-order) delivery.
 */
async function applyReactionLww(
  db: MsgDb,
  body: EventBody,
  seq: number,
  present: boolean,
): Promise<void> {
  const messageId = strField(body.payload, 'message_id')
  const emoji = strField(body.payload, 'emoji')
  const author = typeof body.author_user_id === 'string' ? body.author_user_id : ''
  if (messageId === undefined || emoji === undefined || author === '') return // D9 skip
  const existing = await db.getReaction(messageId, author, emoji)
  if (existing !== undefined && seq <= existing.last_event_seq) return // LWW: older/equal → skip
  await db.putReactions([
    { message_id: messageId, author_user_id: author, emoji, last_event_seq: seq, present },
  ])
}

/** `reaction.added` v1 — seq-aware LWW add (mirrors `_apply_reaction_added` + out-of-order safety). */
export async function applyReactionAdded(
  db: MsgDb,
  event: EventRow,
  body: EventBody,
): Promise<void> {
  await applyReactionLww(db, body, event.server_sequence, true)
}

/** `reaction.removed` v1 — seq-aware LWW remove (writes a tombstone, never a bare delete). */
export async function applyReactionRemoved(
  db: MsgDb,
  event: EventRow,
  body: EventBody,
): Promise<void> {
  await applyReactionLww(db, body, event.server_sequence, false)
}

/**
 * OPTIMISTIC (pending-overlay) reaction (ENG-100). Like the pending EDIT, this has
 * NO `server_sequence`: it force-sets `present` (renders instantly) but LEAVES the
 * stored `last_event_seq` untouched (0 for a fresh key), so the eventual settled
 * reaction event's real seq wins the LWW cleanly on settle and stamps the real seq.
 * Applied identically on the incremental send path AND the rebuild-step-2 overlay.
 */
export async function applyPendingReaction(
  db: MsgDb,
  body: EventBody,
  present: boolean,
): Promise<void> {
  const messageId = strField(body.payload, 'message_id')
  const emoji = strField(body.payload, 'emoji')
  const author = typeof body.author_user_id === 'string' ? body.author_user_id : ''
  if (messageId === undefined || emoji === undefined || author === '') return
  const existing = await db.getReaction(messageId, author, emoji)
  await db.putReactions([
    {
      message_id: messageId,
      author_user_id: author,
      emoji,
      last_event_seq: existing?.last_event_seq ?? 0,
      present,
    },
  ])
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
    // Only STAMP the counter when the message actually is a thread root: it has
    // replies now, OR it already carries a `reply_count` (so a decrement to 0 after
    // a reply delete still writes). A plain (never-a-root) message is left with an
    // absent `reply_count` (⇒ 0 in the dump) — this is what makes an unconditional
    // recompute-self on EVERY message.created cheap AND non-shape-changing, while
    // still converging (0 stored vs absent both dump 0).
    if (replies.length > 0 || root.reply_count !== undefined) {
      const updated: MessageRow = { ...root, reply_count: replies.length }
      if (replies.length > 0) {
        updated.last_reply_seq = Math.max(...replies.map((r) => r.created_seq))
      } else {
        delete updated.last_reply_seq
      }
      await db.putMessages([updated])
    }
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
 * Reconcile a just-created message with edit/delete events for it that arrived
 * EARLIER (ENG-100 out-of-order fix). The client does NOT receive events in
 * server order: cold-start pulls the newest window first, then backfills older
 * pages (sync.ts §7/§10, both call the projection seam). So a recent edit/delete
 * of an OLD message — or a recent reply to an OLD root — is applied BEFORE its
 * target's `message.created`, where it is a no-op (no row yet). When the target
 * finally backfills, we replay its already-cached `message.edited`/`message.deleted`
 * events (ascending seq) onto the fresh row. LWW + terminal-delete make the replay
 * idempotent and order-independent, so incremental (any delivery order) ≡ the
 * in-order rebuild. Reactions need no replay here: they are keyed on
 * `(message_id, author, emoji)` INDEPENDENT of the message row and are themselves
 * seq-aware LWW (see {@link applyReactionLww}), so they converge out-of-order on
 * their own; replies are handled by the recompute-self on the root's create.
 */
async function replayCachedMutations(
  db: MsgDb,
  streamId: string,
  messageId: string,
): Promise<void> {
  const events = await db.getEventsForStream(streamId) // ascending server_sequence
  for (const event of events) {
    const body = event.envelope?.body
    if (body === undefined) continue
    if (strField(body.payload, 'message_id') !== messageId) continue
    if (event.type === 'message.edited' && body.type_version === 1) {
      await applyMessageEdited(db, event, body)
    } else if (event.type === 'message.deleted' && body.type_version === 1) {
      await applyMessageDeleted(db, body)
    }
  }
}

/**
 * `message.created` v1 apply (via the monkeypatchable {@link HANDLERS} registry,
 * so the ENG-61 teeth pattern still bites). Builds the row, then:
 *   • upserts it UNLESS an already-MUTATED row exists (edited or deleted) — the
 *     client analogue of the server `ON CONFLICT DO NOTHING`: a duplicate delivery
 *     must not clobber a later edit/delete. A pending optimistic row is never
 *     mutated, so it still settles in place (created_seq: sentinel → server_seq);
 *   • REPLAYS any of this message's edit/delete events already cached (they arrived
 *     BEFORE this create under the client's newest-window-then-backfill delivery —
 *     see {@link replayCachedMutations}); and
 *   • RECOMPUTES this message AS A ROOT (recompute-self) so a reply that arrived
 *     before its root is picked up when the root finally backfills, AND — if this
 *     message is itself a reply — recomputes its ROOT.
 *
 * Unlike the server (which applies in strict server order and needs no reconcile),
 * the client receives events OUT OF ORDER, so the recompute-self + replay make
 * every cross-message reference (reply/edit/delete) order-independent: incremental
 * under ANY delivery order ≡ the in-order rebuild.
 */
async function applyMessageCreated(db: MsgDb, event: EventRow, body: EventBody): Promise<void> {
  const handler = HANDLERS['message.created@1']
  const row = handler ? handler(event, body) : null
  if (row === null) return // malformed-known → skip (warned inside the builder)
  const existing = await db.getMessage(row.message_id)
  const mutated =
    existing !== undefined && (existing.deleted === true || existing.edited_seq !== undefined)
  if (!mutated) {
    await db.putMessages([row])
    // Out-of-order reconcile: fold in edits/deletes for this message that landed
    // before its create (a recent edit/delete of an OLD message, backfilled create).
    await replayCachedMutations(db, row.stream_id, row.message_id)
  }
  // recompute-self: a reply that arrived before this (now-backfilled) root is
  // counted once the root exists. Cheap + order-independent.
  await recomputeThreadRoot(db, row.message_id)
  // If this message is itself a reply, (re)compute its root too.
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
        await applyReactionAdded(db, event, body)
        break
      case 'reaction.removed@1':
        await applyReactionRemoved(db, event, body)
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

  const byId = await buildUserDirectory(db, streams)

  const users: DirectoryUser[] = [...byId.entries()]
    .map(([user_id, display_name]) => ({ user_id, display_name }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name))

  return { users, channels }
}

/**
 * Fold the cached `workspace-meta` events into a `user_id → display_name` map
 * (`user.joined` adds, `user.left` removes, `user.profile_updated` renames) — the
 * shared source both the @mention directory (ENG-101) and the reaction who-reacted
 * tooltip (ENG-102) resolve names from. A pure LOCAL projection read. `streams` is
 * passed in when the caller already has it (one fewer read).
 */
async function buildUserDirectory(
  db: MsgDb,
  streams?: readonly StreamRow[],
): Promise<Map<string, string>> {
  const all = streams ?? (await db.listStreams())
  const byId = new Map<string, string>() // user_id → display_name
  const metaStreams = all.filter((s) => s.kind === 'workspace-meta')
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
  return byId
}

/**
 * The reaction chips for a set of messages (ENG-102) — the read the M3 message-list
 * UI renders. For each requested `message_id` it reads the OBSERVABLE (present-only)
 * reactions from the seq-aware `reactions` table and aggregates them by `emoji`:
 * count, the reactor `user_ids` (sorted), their resolved `display_names` (folded
 * from the workspace directory, `user_id` fallback), and `mine` (whether
 * `myUserId` reacted — drives the idempotent toggle). Chips are sorted by `emoji`
 * bytes for a stable order. A LOCAL projection read (zero network). `emoji` /
 * display names are OPAQUE user content — the tab renders them ONLY via Vue text
 * interpolation, so no escaping happens here.
 */
export async function listReactions(
  db: MsgDb,
  messageIds: readonly string[],
  myUserId: string,
): Promise<ReactionsListResult> {
  const directory = await buildUserDirectory(db)
  const messages: MessageReactions[] = []
  for (const messageId of messageIds) {
    const rows = await db.getReactionsForMessage(messageId) // present-only
    const byEmoji = new Map<string, string[]>() // emoji → reactor user_ids
    for (const r of rows) {
      const list = byEmoji.get(r.emoji) ?? []
      list.push(r.author_user_id)
      byEmoji.set(r.emoji, list)
    }
    const reactions: ReactionAggregate[] = [...byEmoji.entries()]
      .map(([emoji, ids]): ReactionAggregate => {
        const user_ids = [...ids].sort()
        return {
          emoji,
          count: user_ids.length,
          user_ids,
          display_names: user_ids.map((id) => directory.get(id) ?? id),
          mine: myUserId !== '' && user_ids.includes(myUserId),
        }
      })
      .sort((a, b) => (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0))
    messages.push({ message_id: messageId, reactions })
  }
  return { messages }
}

/**
 * Resolve a root's participant set (ENG-103) from the derived
 * `thread_participants` store (the DISTINCT authors of its non-deleted settled
 * replies — recomputed projection-side, delete-aware), each name resolved from
 * the shared workspace `directory` (`user_id` fallback). Sorted by display name
 * for a stable avatar order. A LOCAL projection read; names are OPAQUE user
 * content rendered ONLY via Vue text interpolation tab-side.
 */
async function resolveParticipants(
  db: MsgDb,
  rootMessageId: string,
  directory: Map<string, string>,
): Promise<ThreadParticipant[]> {
  const rows = await db.listThreadParticipantsByRoot(rootMessageId)
  return rows
    .map((r): ThreadParticipant => ({
      user_id: r.user_id,
      display_name: directory.get(r.user_id) ?? r.user_id,
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
}

/**
 * A thread's replies + root + participants (ENG-103, `messages.thread`) — the
 * thread pane's read (D7 flat-channel threads). Replies are the messages whose
 * `thread_root_id` is this root, paginated newest-first by `created_seq` (older
 * pages via `beforeSeq`, `limit + 1` to decide `has_more`) and returned ASC for
 * render. Includes tombstoned + pending replies (the pane renders both, same as
 * the main list). A LOCAL projection read (zero network for already-synced
 * replies); the participant set comes from the derived store. `root` is `null`
 * when the root is not (yet) in the projection.
 */
export async function listThread(
  db: MsgDb,
  rootMessageId: string,
  opts: { beforeSeq?: number; limit?: number } = {},
): Promise<ThreadResult> {
  const directory = await buildUserDirectory(db)
  const root = (await db.getMessage(rootMessageId)) ?? null
  const limit = clampLimit(opts.limit)
  const beforeSeq = Number.isFinite(opts.beforeSeq) ? opts.beforeSeq : undefined
  const all = await db.listRepliesByRoot(rootMessageId)
  const desc = [...all].sort((a, b) => b.created_seq - a.created_seq)
  const filtered = beforeSeq !== undefined ? desc.filter((m) => m.created_seq < beforeSeq) : desc
  const page = filtered.slice(0, limit + 1)
  const has_more = page.length > limit
  const replies = (has_more ? page.slice(0, limit) : page).reverse() // ASC render order
  const participants = await resolveParticipants(db, rootMessageId, directory)
  return { root, replies, has_more, participants }
}

/**
 * Batch thread summaries (ENG-103, `messages.threads`) — the reply count +
 * participant set for a set of roots, so the main message list renders the
 * reply-count + participant-avatar affordance. Mirrors `messages.reactions`:
 * one directory build, then a per-root participant read. `reply_count` mirrors
 * the root row's counter (non-deleted settled replies); a missing/plain root
 * yields `0`. A LOCAL projection read (zero network).
 */
export async function listThreadSummaries(
  db: MsgDb,
  rootMessageIds: readonly string[],
): Promise<ThreadsListResult> {
  const directory = await buildUserDirectory(db)
  const threads: ThreadSummary[] = []
  for (const rootMessageId of rootMessageIds) {
    const root = await db.getMessage(rootMessageId)
    const participants = await resolveParticipants(db, rootMessageId, directory)
    threads.push({
      root_message_id: rootMessageId,
      reply_count: root?.reply_count ?? 0,
      participants,
    })
  }
  return { threads }
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
