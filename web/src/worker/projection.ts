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

import { IdKind, isValidTypedId } from '../core/ids'

import { computeStreamBadge } from './badges'
import type {
  AttachmentsResult,
  DirectoryListResult,
  DirectoryUser,
  DmParticipants,
  EventBody,
  EventRow,
  FileRow,
  FilesListResult,
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
  WorkspaceInfoResult,
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

/** Builds a `FileRow` from a `file.uploaded` event + body, or `null` to skip (D9). */
export type FileHandler = (event: EventRow, body: EventBody) => FileRow | null

/**
 * Projection dispatch for the ENG-120 `files` set, keyed `` `${type}@${version}` ``.
 * SEPARATE from {@link HANDLERS} (which builds `MessageRow`s) purely for type
 * safety — a `file.uploaded` builder returns a `FileRow`, a different shape. Like
 * `HANDLERS` it is exported + mutable so a rebuild-pass-only teeth patch can swap
 * a handler (the ENG-61 discipline). Only `file.uploaded` v1 projects a row.
 */
export const FILE_HANDLERS: Record<string, FileHandler> = {
  'file.uploaded@1': applyFileUploadedV1,
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
    // ENG-120: the attachment linkage, projected VERBATIM from the body (default
    // `[]` when absent/invalid). A pure per-event field — no cross-event state —
    // so it is trivially order-independent. CLIENT-ONLY: deliberately kept OUT of
    // `dumpMessages` (the ENG-83 cross-language surface); see `serializeRow`.
    file_ids: Array.isArray(p.file_ids)
      ? p.file_ids.filter((f): f is string => typeof f === 'string')
      : [],
  }
  // `thread_root_id` is optional: present values are indexed, root messages omit it.
  if (typeof p.thread_root_id === 'string') {
    row.thread_root_id = p.thread_root_id
  }
  return row
}

/**
 * Materialize a `file.uploaded` v1 event into a {@link FileRow}, or skip (`null`)
 * on a malformed-known payload (D9: log + skip, NEVER throw). The five business
 * fields come from the payload body; `stream_id` from the event ENVELOPE (the
 * payload carries no stream_id).
 *
 * ORDER-INDEPENDENCE COMES FOR FREE (unlike the ENG-100 reactions/threads/edits
 * handlers, which need seq-aware LWW / recompute-from-state to converge). A file
 * is uploaded EXACTLY ONCE and its `file.uploaded` event is IMMUTABLE, so this is
 * a pure keyed row builder: every field is a deterministic function of the single
 * event, a re-derived row is byte-identical to the stored one (idempotent upsert =
 * no-op), and delivery order does not matter — arriving before or after its
 * referencing `message.created` changes nothing (the row is keyed by `file_id`;
 * the attachments query reads whatever is present). Hence NO recompute is needed
 * and client rebuild ≡ incremental holds trivially.
 */
export function applyFileUploadedV1(event: EventRow, body: EventBody): FileRow | null {
  const payload = body.payload
  const at = `${event.stream_id}#${event.server_sequence}`
  if (payload === null || typeof payload !== 'object') {
    console.warn(`projection: file.uploaded v1 with a non-object payload at ${at} — skipping`)
    return null
  }
  const p = payload as Record<string, unknown>
  const fileId = p.file_id
  if (typeof fileId !== 'string' || !isValidTypedId(fileId, IdKind.FILE)) {
    console.warn(`projection: file.uploaded v1 with missing/invalid file_id at ${at} — skipping`)
    return null
  }
  // The remaining required fields must be well-typed (the server already
  // format-validated them; this is the D9 defensive skip, not a re-validation).
  if (
    typeof p.sha256 !== 'string' ||
    typeof p.name !== 'string' ||
    typeof p.mime_type !== 'string' ||
    typeof p.size_bytes !== 'number'
  ) {
    console.warn(
      `projection: file.uploaded v1 (${fileId}) missing required fields at ${at} — skipping`,
    )
    return null
  }
  return {
    file_id: fileId,
    sha256: p.sha256,
    name: p.name,
    mime_type: p.mime_type,
    size_bytes: p.size_bytes,
    stream_id: event.stream_id, // from the ENVELOPE, not the payload
    // ENG-152 display fields, from the hashed BODY (not the payload) — both
    // deterministic functions of the event, so rebuild ≡ incremental holds.
    uploaded_by: typeof body.author_user_id === 'string' ? body.author_user_id : '',
    created_at: typeof body.client_created_at === 'string' ? body.client_created_at : '',
  }
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
 * `file.uploaded` v1 apply (ENG-120) — via the monkeypatchable {@link FILE_HANDLERS}
 * registry, so the teeth pattern bites. Builds the row (or skips on malformed) and
 * UPSERTS it by `file_id`. This is an IDEMPOTENT KEYED UPSERT: a duplicate delivery
 * writes the byte-identical row (no-op on the dump), and because the row is keyed by
 * `file_id` — independent of any `message.created` — it lands the same whether it
 * arrives before OR after (even across a backfill boundary) the message that
 * references it. No recompute / LWW is needed (contrast the M3 handlers).
 */
async function applyFileUploaded(db: MsgDb, event: EventRow, body: EventBody): Promise<void> {
  const handler = FILE_HANDLERS['file.uploaded@1']
  const row = handler ? handler(event, body) : null
  if (row === null) return // malformed-known → skip (warned inside the builder)
  await db.putFiles([row])
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
      case 'file.uploaded@1':
        await applyFileUploaded(db, event, body)
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
  //
  // ENG-120: `MessageRow.file_ids` is INTENTIONALLY OMITTED here. This dump is the
  // ENG-83 cross-language byte-equality surface (client-incremental == client-
  // rebuild, asserted byte-for-byte against the FROZEN server dump). The SERVER has
  // no message→attachment projection (ENG-117: `messages_proj` is search-only, no
  // `file_ids`), so its dump has no such field; adding `file_ids` here would break
  // parity. `file_ids` is a client-only display field (a pure per-event row-builder
  // field, trivially order-independent) and the `files` set has its own rebuild≡
  // incremental gate via {@link dumpFiles} — so leaving this dump unchanged is safe.
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

/** Serialize one {@link FileRow} as a compact JSON object with a canonical key order. */
function serializeFileRow(row: FileRow): string {
  // Same discipline as `serializeRow`: explicit key order (never JSON.stringify(row)),
  // compact + raw-non-ASCII. `name` is opaque user content — serialized verbatim.
  const ordered = {
    file_id: row.file_id,
    stream_id: row.stream_id,
    sha256: row.sha256,
    name: row.name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  }
  return JSON.stringify(ordered)
}

/**
 * The canonical `files` serialization (ENG-120) — the NEW rebuild ≡ incremental
 * surface for the client `file.uploaded` projection. All rows sorted by `file_id`
 * (a total order — `file_id` is the PK), each a compact JSON object with fixed key
 * order, `\n`-joined. The windowed invariant-6 gate asserts
 * `dumpFiles(rebuilt) === dumpFiles(incremental)` on this. Because `file.uploaded`
 * is an immutable keyed upsert, this holds trivially under any delivery order.
 *
 * NOTE: this is a CLIENT-INTERNAL rebuild surface, NOT a cross-language one — the
 * server has no client-shaped `files` projection to compare against (contrast
 * `dumpMessages`, whose byte form is frozen against the server dump).
 */
export async function dumpFiles(db: MsgDb): Promise<string> {
  const rows = await db.getAllFiles()
  rows.sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0))
  return rows.map(serializeFileRow).join('\n')
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

/**
 * Resolve a message's ATTACHMENTS (ENG-120, `attachments.forMessage`) — the
 * `FileRow`s for the message's `file_ids`, read from the local `files` projection.
 * A pure LOCAL projection READ (zero network) — the client only holds data it is
 * authorized for. Returns the resolved `files` in the SAME ORDER as the message's
 * `file_ids` (stable UI), plus `pending_file_ids` for ids that have not yet
 * projected (their `file.uploaded` has not been delivered/backfilled) — so the UI
 * can show a pending placeholder. An unknown message or an empty `file_ids` yields
 * both arrays empty. ENG-121 pairs each returned FileRow with a download/thumbnail
 * handle via `client.files.download/thumbnail`.
 */
export async function listAttachments(db: MsgDb, messageId: string): Promise<AttachmentsResult> {
  const message = await db.getMessage(messageId)
  const fileIds = message?.file_ids ?? []
  if (fileIds.length === 0) return { message_id: messageId, files: [], pending_file_ids: [] }
  const rows = await db.getFilesByIds(fileIds)
  const byId = new Map(rows.map((r) => [r.file_id, r]))
  const files: FileRow[] = []
  const pending_file_ids: string[] = []
  for (const id of fileIds) {
    const row = byId.get(id)
    if (row !== undefined) files.push(row)
    else pending_file_ids.push(id)
  }
  return { message_id: messageId, files, pending_file_ids }
}

/**
 * Whether a locally-cached stream row is READABLE-shaped for the signed-in user:
 * a stream they are a member of, or a public channel. Mirrors the server's
 * `readable_streams_predicate` branches the client can evaluate locally.
 */
function isReadableStream(stream: StreamRow): boolean {
  return stream.member || (stream.kind === 'channel' && stream.visibility === 'public')
}

/**
 * The workspace file listing (`files.list`, ENG-152) — every projected `FileRow`,
 * newest-first (`created_at` desc, `file_id` desc tiebreak). A pure LOCAL
 * projection read (zero network): the `files` table only ever holds
 * `file.uploaded` events the server's sync ALREADY scoped to the caller's
 * readable streams (`readable_streams_predicate`), so the server enforced
 * read-authz at delivery time. The join against the local `streams` table is a
 * DEFENSIVE second layer: a file whose stream row is missing or no longer
 * readable-shaped (e.g. the user left a private channel and the row flipped
 * `member:false`) is dropped rather than listed.
 */
export async function listFiles(db: MsgDb): Promise<FilesListResult> {
  const [rows, streams] = await Promise.all([db.getAllFiles(), db.listStreams()])
  const readable = new Set(streams.filter(isReadableStream).map((s) => s.stream_id))
  const files = rows.filter((f) => readable.has(f.stream_id))
  files.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
    return a.file_id < b.file_id ? 1 : a.file_id > b.file_id ? -1 : 0
  })
  return { files }
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

  const users: DirectoryUser[] = [...byId.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  )

  return { users, channels }
}

/**
 * The workspace identity fold (ENG-152): name + description from the cached
 * `workspace-meta` events. `workspace.created` names the workspace (genesis);
 * each server-authored `workspace.updated` applies EXACTLY the fields present
 * in its payload (LWW by ascending server_sequence — an absent field means
 * "unchanged", so `description: ''` (cleared) never aliases "untouched").
 * A pure LOCAL projection read, mirroring `buildUserDirectory` — a rename
 * reaches every member through normal meta-event sync, no admin RPC involved.
 * Forged uploads of `workspace.updated` are rejected server-side
 * (SERVER_AUTHORED_EVENT_TYPES), so any stored instance is admin-authored.
 * `name` stays `null` until the genesis event is synced; the shell falls back
 * to its neutral default.
 */
export async function getWorkspaceInfo(db: MsgDb): Promise<WorkspaceInfoResult> {
  const streams = await db.listStreams()
  let name: string | null = null
  let description: string | null = null
  for (const meta of streams.filter((s) => s.kind === 'workspace-meta')) {
    const events = await db.getEventsForStream(meta.stream_id) // ascending server_sequence
    for (const event of events) {
      const payload = event.envelope?.body?.payload
      if (payload === null || typeof payload !== 'object') continue
      const p = payload as Record<string, unknown>
      if (event.type === 'workspace.created' || event.type === 'workspace.updated') {
        if (typeof p.name === 'string') name = p.name
        if (event.type === 'workspace.updated' && typeof p.description === 'string')
          description = p.description
      }
    }
  }
  return { name, description }
}

/**
 * Resolve a user's display name from the folded directory (`user_id` fallback)
 * — the ONE-LINER every name consumer goes through (ENG-164 made the directory
 * value a record, so `.get(id) ?? id` alone would leak `[object Object]`).
 * Exported for direct unit coverage.
 */
export function displayNameOf(
  directory: ReadonlyMap<string, DirectoryUser>,
  userId: string,
): string {
  return directory.get(userId)?.display_name ?? userId
}

/** The ENG-164 profile fields a `user.profile_updated` payload may carry. */
const PROFILE_FIELDS = [
  'title',
  'description',
  'status_emoji',
  'status_text',
  'status_expires_at',
] as const

/**
 * Fold the cached `workspace-meta` events into a `user_id → DirectoryUser`
 * record map (`user.joined` adds, `user.left` removes, `user.profile_updated`
 * updates — LWW in ascending `server_sequence`) — the shared source both the
 * @mention directory (ENG-101) and the reaction who-reacted tooltip (ENG-102)
 * resolve names from, extended by ENG-164 with title/description/status.
 *
 * A `user.profile_updated` payload carries the RESULTING profile values: a
 * key holding a string sets the field, an explicit `null` CLEARS it, and an
 * ABSENT key leaves it untouched (pre-ENG-164 rename events carry only
 * `display_name`). `status_expires_at` is kept RAW — the fold NEVER consults
 * the wall clock (rebuild ≡ incremental stays deterministic); expired-status
 * suppression happens at render time (`lib/status.ts`).
 *
 * A pure LOCAL projection read. `streams` is passed in when the caller
 * already has it (one fewer read).
 */
async function buildUserDirectory(
  db: MsgDb,
  streams?: readonly StreamRow[],
): Promise<Map<string, DirectoryUser>> {
  const all = streams ?? (await db.listStreams())
  const byId = new Map<string, DirectoryUser>() // user_id → folded profile record
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
      const authorUserId =
        typeof event.envelope?.body?.author_user_id === 'string'
          ? event.envelope.body.author_user_id
          : undefined
      switch (event.type) {
        case 'user.joined':
          byId.set(userId, { user_id: userId, display_name: displayName ?? userId })
          break
        case 'user.left':
          byId.delete(userId)
          break
        case 'user.profile_updated': {
          // SECURITY (PR #91 review) — defense-in-depth behind the server upload-path
          // reject: a user may only update THEIR OWN profile, so apply a
          // profile_updated ONLY when the author IS the subject. Any event whose
          // author_user_id !== payload.user_id (a forged cross-user update, whether
          // already stored or future) is ignored. An update also only applies to a
          // still-present member; ignore if they left. This is a pure filter on
          // author==subject, so the fold stays deterministic + rebuild ≡ incremental.
          const record = byId.get(userId)
          if (authorUserId !== userId || record === undefined) break
          if (displayName !== undefined) record.display_name = displayName
          for (const field of PROFILE_FIELDS) {
            if (!(field in p)) continue // absent → untouched (old events)
            const value = p[field]
            if (value === null)
              delete record[field] // explicit null → cleared
            else if (typeof value === 'string') record[field] = value
            // any other type: malformed — ignored (D9 tolerance, never a throw)
          }
          break
        }
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
          display_names: user_ids.map((id) => displayNameOf(directory, id)),
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
  directory: Map<string, DirectoryUser>,
): Promise<ThreadParticipant[]> {
  const rows = await db.listThreadParticipantsByRoot(rootMessageId)
  return rows
    .map((r): ThreadParticipant => ({
      user_id: r.user_id,
      display_name: displayNameOf(directory, r.user_id),
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

/**
 * A DM stream's participant ids from its cached `dm.created` v1 genesis event
 * (ENG-149). A `dm.created` is SELF-HOMED in the DM's own stream (§2.2), so the
 * event sits in the local `events` cache like any other stream event — this is a
 * PURE fold over that cache (zero network, no schema change). D9 discipline: a
 * missing/malformed genesis (wrong version, non-object payload, non-array or
 * empty `member_user_ids`) yields `undefined`, never a throw — the UI keeps the
 * id fallback for that row. Exported for direct unit coverage.
 */
export function dmMemberIdsFromEvents(events: readonly EventRow[]): string[] | undefined {
  for (const event of events) {
    if (event.type !== 'dm.created') continue
    const body = event.envelope?.body
    if (body === undefined || body.type_version !== 1) continue
    const payload = body.payload
    if (payload === null || typeof payload !== 'object') continue
    const raw = (payload as Record<string, unknown>).member_user_ids
    if (!Array.isArray(raw)) continue
    const ids = raw.filter((m): m is string => typeof m === 'string' && m.length > 0)
    if (ids.length > 0) return ids
  }
  return undefined
}

/** The sidebar: every stream merged with its unread/mention badge (`streams.list`). */
export async function listStreamsForSidebar(
  db: MsgDb,
  myUserId: string,
): Promise<Array<StreamRow & StreamBadge & DmParticipants>> {
  const streams = await db.listStreams()
  return Promise.all(
    streams.map(async (stream) => {
      const badge = await computeStreamBadge(db, stream.stream_id, myUserId)
      if (stream.kind !== 'dm') return { ...stream, ...badge }
      // ENG-149: attach the DM's participant ids (from its cached genesis event)
      // so the tab can show the OTHER participant's name + presence. Query-time
      // only — nothing is stored, so rebuild ≡ incremental is untouched.
      const dmUserIds = dmMemberIdsFromEvents(await db.getEventsForStream(stream.stream_id))
      return dmUserIds === undefined
        ? { ...stream, ...badge }
        : { ...stream, ...badge, dm_user_ids: dmUserIds }
    }),
  )
}
