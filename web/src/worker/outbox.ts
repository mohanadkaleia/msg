// worker/outbox.ts — the Outbox: optimistic send + the drain loop (ENG-81).
//
// The write half of M2 sync (the read/replicate half is sync.ts). It turns a
// tab `mutate outbox.send` into (1) a PENDING `messages` row that renders
// instantly and (2) a durable `outbox` row, then drains the outbox to
// `POST /v1/events/batch` oldest-first, settling each accepted event into the
// SAME `messages` projection row (keyed on `message_id`) the live WS frame
// settles into — so the two converge to exactly one row in any interleaving.
//
// Transport-agnostic + browser-free like the sync engine: everything (db, http,
// clock, publish, auth snapshot, drain-gate) is injected, so the whole thing is
// unit-testable against MemoryDb + a fake authed HttpClient with no socket.
//
// Identity (workspace/user/device) is read WORKER-SIDE at send — never from the
// tab. The drain body carries only `{body, event_hash}`; the bearer token rides
// the shared http client's worker-side `Authorization` header and never crosses
// the RPC surface or a log.

import {
  buildFileUploadedBody,
  buildMessageCreatedBody,
  buildMessageDeletedBody,
  buildMessageEditedBody,
  buildReactionAddedBody,
  buildReactionRemovedBody,
  finalizeEnvelope,
  type Body,
} from '../core'

import { backoffDelay, OUTBOX_BASE_MS, OUTBOX_CAP_MS } from './backoff'
import type { HttpClient } from './http'
import {
  applyEventsToProjection,
  applyMessageCreatedV1,
  applyMessageDeleted,
  applyPendingEdit,
  applyPendingReaction,
  recomputeThreadRoot,
} from './projection'
import type { TimerId } from './sync'
import {
  META_DEVICE_ID,
  RpcCodedError,
  type AuthStatus,
  type EventBody,
  type EventRow,
  type MessageRow,
  type MsgDb,
  type MutateParams,
  type OutboxRow,
  type SendResult,
} from './types'

/** Server batch cap (ENG-66) — one drain sends at most this many events. */
export const MAX_BATCH = 100

/** The worker-owned identity snapshot every authored event is stamped with. */
export interface WorkerIdentity {
  my_user_id: string
  workspace_id: string
  deviceId: string
}

/**
 * Read the worker-owned identity (workspace/user/device) — NEVER from a tab. Used
 * by the outbox send arms AND the ENG-104 meta author. Throws `not_authenticated`
 * (coded) when there is no session.
 */
export async function resolveWorkerIdentity(
  db: MsgDb,
  authStatus: () => AuthStatus,
): Promise<WorkerIdentity> {
  const status = authStatus()
  if (!status.authenticated || !status.my_user_id || !status.workspace_id) {
    throw new RpcCodedError(
      'not_authenticated',
      'a durable mutation requires an authenticated session',
    )
  }
  const deviceId = (await db.metaGet<string>(META_DEVICE_ID)) ?? ''
  return { my_user_id: status.my_user_id, workspace_id: status.workspace_id, deviceId }
}

/** One accepted event in a `POST /v1/events/batch` 200 (ENG-66). */
interface AcceptedEvent {
  event_id: string
  stream_id: string
  server_sequence: number
  server_received_at: string
}

/** One rejected event in a `POST /v1/events/batch` 200 (ENG-66). */
interface RejectedEvent {
  event_id: string
  code: string
  detail?: string
}

/** The `POST /v1/events/batch` 200 body (ENG-66). */
interface BatchResponse {
  accepted: AcceptedEvent[]
  rejected: RejectedEvent[]
}

/** Everything the outbox needs, injected → fully unit-testable. */
export interface OutboxDeps {
  db: MsgDb
  http: HttpClient
  /** Worker-owned identity snapshot (never from a tab). */
  authStatus: () => AuthStatus
  /** Async "outbox/projection changed for stream X" signal — WorkerCore fans `{kind:'stream'}`. */
  publishStream: (streamId: string) => void
  /**
   * Gate: only drain when the sync engine is `live` (§4). WorkerCore wires this
   * to its tracked sync state; a message composed while not-live sits `queued`
   * and the rising-edge-into-`live` kick sends it. Default `() => true` (the
   * direct-construction unit tests always drain).
   */
  canDrain?: () => boolean
  /** Injectable clock (tests advance backoff timers). */
  setTimeout?: (cb: () => void, ms: number) => TimerId
  /** [0,1) jitter source; inject a stub for deterministic backoff assertions. */
  random?: () => number
  /** `created_at` clock; default `Date.now`. */
  now?: () => number
}

export class Outbox {
  private readonly db: MsgDb
  private readonly http: HttpClient
  private readonly authStatus: () => AuthStatus
  private readonly publishStream: (streamId: string) => void
  private readonly canDrain: () => boolean
  private readonly setTimer: (cb: () => void, ms: number) => TimerId
  private readonly random: () => number
  private readonly now: () => number

  /** One drain sequence in flight at a time (§4 coalescing). */
  private draining = false
  /** A `send`/kick during an in-flight drain requests a re-run on completion. */
  private rerun = false
  /** Consecutive transient-failure count → backoff exponent. Reset on success. */
  private attempt = 0
  private retryTimer: TimerId | undefined

  constructor(deps: OutboxDeps) {
    this.db = deps.db
    this.http = deps.http
    this.authStatus = deps.authStatus
    this.publishStream = deps.publishStream
    this.canDrain = deps.canDrain ?? ((): boolean => true)
    this.setTimer =
      deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown as TimerId)
    this.random = deps.random ?? Math.random
    this.now = deps.now ?? Date.now
  }

  // -- RPC arms (dispatched from WorkerCore.mutate) ------------------------

  /**
   * Build a `message.created` v1 envelope + `event_hash` in the worker (via the
   * ENG-76 core spine — no JCS/hash/id reimplementation), insert a PENDING
   * `messages` row (renders instantly) AND an `outbox` row, publish, kick the
   * drain. Returns the ids + the pending `created_seq` so the tab can locate its
   * optimistic row. Throws `not_authenticated` (coded) if there is no session.
   */
  async send(params: Extract<MutateParams, { m: 'outbox.send' }>): Promise<SendResult> {
    const { my_user_id, workspace_id, deviceId } = await this.identity()
    const body = buildMessageCreatedBody({
      workspace_id,
      stream_id: params.stream_id,
      author_user_id: my_user_id,
      author_device_id: deviceId,
      client_created_at: new Date(this.now()).toISOString(),
      text: params.text,
      ...(params.format !== undefined ? { format: params.format } : {}),
      ...(params.thread_root_id !== undefined ? { thread_root_id: params.thread_root_id } : {}),
      ...(params.mentions !== undefined ? { mentions: params.mentions } : {}),
      ...(params.file_ids !== undefined ? { file_ids: params.file_ids } : {}),
    })
    return this.enqueue(body)
  }

  /**
   * Optimistic reaction (ENG-100). Builds a `reaction.added`/`reaction.removed`
   * v1 event (the reactor is the worker-side `my_user_id`), applies the membership
   * overlay instantly, and settles under the hash-bound stream_id. The `message_id`
   * denormalized onto the outbox row is the REACTION TARGET.
   */
  async react(params: Extract<MutateParams, { m: 'outbox.react' }>): Promise<SendResult> {
    const { my_user_id, workspace_id, deviceId } = await this.identity()
    const opts = {
      workspace_id,
      stream_id: params.stream_id,
      author_user_id: my_user_id,
      author_device_id: deviceId,
      client_created_at: new Date(this.now()).toISOString(),
      message_id: params.message_id,
      emoji: params.emoji,
    }
    const body = params.remove ? buildReactionRemovedBody(opts) : buildReactionAddedBody(opts)
    return this.enqueue(body)
  }

  /** Optimistic edit (ENG-100): a `message.edited` v1 event; overlay forces text/format. */
  async edit(params: Extract<MutateParams, { m: 'outbox.edit' }>): Promise<SendResult> {
    const { my_user_id, workspace_id, deviceId } = await this.identity()
    const body = buildMessageEditedBody({
      workspace_id,
      stream_id: params.stream_id,
      author_user_id: my_user_id,
      author_device_id: deviceId,
      client_created_at: new Date(this.now()).toISOString(),
      message_id: params.message_id,
      text: params.text,
      ...(params.format !== undefined ? { format: params.format } : {}),
    })
    return this.enqueue(body)
  }

  /** Optimistic delete (ENG-100): a `message.deleted` v1 event; overlay tombstones + redacts. */
  async remove(params: Extract<MutateParams, { m: 'outbox.remove' }>): Promise<SendResult> {
    const { my_user_id, workspace_id, deviceId } = await this.identity()
    const body = buildMessageDeletedBody({
      workspace_id,
      stream_id: params.stream_id,
      author_user_id: my_user_id,
      author_device_id: deviceId,
      client_created_at: new Date(this.now()).toISOString(),
      message_id: params.message_id,
    })
    return this.enqueue(body)
  }

  /** Worker-side identity snapshot for the send arms (never from a tab). */
  private identity(): Promise<WorkerIdentity> {
    return resolveWorkerIdentity(this.db, this.authStatus)
  }

  /**
   * The shared send tail for every optimistic op (ENG-81 machinery, generalized by
   * ENG-100): finalize (hash) the body, persist the durable `outbox` row, apply the
   * PENDING projection overlay (renders instantly — a message row for `message.created`,
   * a membership for reactions, an in-place text/tombstone for edit/delete), publish,
   * and kick the drain. `message_id` is the payload's message id (the created message,
   * or the reaction/edit/delete TARGET).
   */
  private async enqueue(body: Body): Promise<SendResult> {
    const { body: finalBody, event_hash } = await finalizeEnvelope(body)
    const createdAt = this.now()
    const messageId = (finalBody.payload as unknown as { message_id: string }).message_id
    const outboxRow: OutboxRow = {
      event_id: finalBody.event_id,
      created_at: createdAt,
      body: finalBody,
      event_hash,
      message_id: messageId,
      stream_id: finalBody.stream_id,
      state: 'queued',
    }
    await this.db.putOutbox([outboxRow])
    await applyPendingOutboxRow(this.db, outboxRow)
    this.publishStream(outboxRow.stream_id)
    this.drain()
    return { message_id: messageId, event_id: outboxRow.event_id, created_seq: createdAt }
  }

  /**
   * Enqueue a `file.uploaded` v1 event (ENG-119) — the durable log record of an
   * already-uploaded blob, built + hashed worker-side from the ENG-76 core spine.
   * Called by the {@link FileManager} at the `emitting` step. Under the ENG-121
   * DECOUPLE (Option A) an upload is INDEPENDENT of message-send: it enqueues ONLY
   * this record and kicks its own drain; the referencing `message.created` is
   * authored LATER, once, by the composer's `outbox.send` on Send. This is safe under
   * ENG-117 because the drain has already homed+PUT the blob (present + homed file
   * ROW) before the chip reaches `done`, so any later `message.created.file_ids`
   * referencing it passes the referential check and never `unknown_file`.
   *
   * Two deliberate deviations from {@link enqueue}:
   *   • `file.uploaded` has NO `payload.message_id`, so it can't ride the send tail
   *     that reads it — the outbox row's `message_id` slot is keyed on the `file_id`
   *     SENTINEL instead (a stable, unique link for settle/reapply bookkeeping);
   *   • NO optimistic projection overlay is applied here — the client projection of
   *     `file.uploaded` (ENG-120) lands when the event SETTLES from the server;
   *     `applyPendingOutboxRow` DEFAULT-SKIPs the type, so the pending overlay is inert.
   *
   * Kicks the drain itself (no companion send to piggyback on). Returns the minted
   * `event_id` (the server-dedup key on retry).
   */
  async enqueueFileUploaded(opts: {
    stream_id: string
    file_id: string
    sha256: string
    name: string
    mime_type: string
    size_bytes: number
  }): Promise<{ event_id: string }> {
    const { my_user_id, workspace_id, deviceId } = await this.identity()
    const body = buildFileUploadedBody({
      workspace_id,
      stream_id: opts.stream_id,
      author_user_id: my_user_id,
      author_device_id: deviceId,
      client_created_at: new Date(this.now()).toISOString(),
      file_id: opts.file_id,
      sha256: opts.sha256,
      name: opts.name,
      mime_type: opts.mime_type,
      size_bytes: opts.size_bytes,
    })
    const { body: finalBody, event_hash } = await finalizeEnvelope(body)
    const outboxRow: OutboxRow = {
      event_id: finalBody.event_id,
      created_at: this.now(),
      body: finalBody,
      event_hash,
      // No payload.message_id on file.uploaded — key the row on the file_id sentinel.
      message_id: opts.file_id,
      stream_id: finalBody.stream_id,
      state: 'queued',
    }
    await this.db.putOutbox([outboxRow])
    // Deliberately NO applyPendingOutboxRow (no optimistic overlay — ENG-120 projects
    // on settle). Kick the drain: the upload is decoupled from message-send, so there
    // is no companion send to flush this record for us (ENG-121).
    this.publishStream(outboxRow.stream_id)
    this.drain()
    return { event_id: outboxRow.event_id }
  }

  /** Re-queue a `rejected` send: clear the failed marker, re-apply the overlay, kick the drain. */
  async retry(eventId: string): Promise<{ ok: true }> {
    const row = await this.db.getOutbox(eventId)
    if (row && row.state === 'rejected') {
      const requeued: OutboxRow = { ...row, state: 'queued' }
      delete requeued.error_code
      await this.db.putOutbox([requeued])
      await applyPendingOutboxRow(this.db, requeued)
      this.publishStream(requeued.stream_id)
      this.drain()
    }
    return { ok: true }
  }

  /**
   * Drop a queued/failed send + REVERT its optimistic overlay. For a
   * `message.created` this deletes the (unsettled) pending row. For an M3 op
   * (react/edit/delete) the overlay MUTATED an existing message/reaction, so we
   * REVERT by recomputing the target's derived state from the settled `events`
   * cache + any REMAINING pending overlays for it (the "recompute from state"
   * discipline). A settled event keeps living in `events`; only the pending echo
   * is undone.
   */
  async delete(eventId: string): Promise<{ ok: true }> {
    const row = await this.db.getOutbox(eventId)
    await this.db.deleteOutbox(eventId)
    if (row) {
      const settled = await this.db.hasEvent(eventId)
      const type = (row.body as { type?: unknown }).type
      if (type === 'message.created') {
        if (!settled) await this.db.deleteMessage(row.message_id)
      } else {
        // An M3 op mutated existing state — recompute the target from scratch.
        await recomputeMessageProjection(this.db, row.stream_id, row.message_id)
      }
      this.publishStream(row.stream_id)
    }
    return { ok: true }
  }

  // -- drain loop (§4) -----------------------------------------------------

  /**
   * Kick the drain (fire-and-forget, coalesced). At most one batch sequence runs
   * at a time; a kick during an in-flight run sets `rerun` so the loop re-enters
   * on completion. A no-op while the gate says the sync engine is not `live`.
   */
  drain(): void {
    if (!this.canDrain()) return
    if (this.draining) {
      this.rerun = true
      return
    }
    this.draining = true
    void this.runDrain().finally(() => {
      this.draining = false
      if (this.rerun) {
        this.rerun = false
        this.drain()
      }
    })
  }

  /** One batch attempt: mark → POST → settle/reject/backoff. */
  private async runDrain(): Promise<void> {
    const all = await this.db.listOutbox()
    // Skip parked (rejected) rows so a poison event never wedges the queue; a
    // crash-orphaned `sending` row re-sends (dumb retry — the server is idempotent).
    const pending = all
      .filter((r) => r.state !== 'rejected')
      .sort((a, b) => a.created_at - b.created_at)
    if (pending.length === 0) return
    const batch = pending.slice(0, MAX_BATCH)

    await this.db.putOutbox(batch.map((r): OutboxRow => ({ ...r, state: 'sending' })))

    const res = await this.http.post<BatchResponse>('/v1/events/batch', {
      events: batch.map((r) => ({ body: r.body, event_hash: r.event_hash })),
    })

    if (!res.ok) {
      // Transient whole-request failure: revert the in-flight rows so the next
      // drain re-sends them. A 401 already cleared the session app-wide via the
      // shared http client's `onUnauthorized` — stop, do not reschedule.
      await this.db.putOutbox(batch.map((r): OutboxRow => ({ ...r, state: 'queued' })))
      if (res.error.status !== 401) this.scheduleRetry()
      return
    }

    this.attempt = 0
    const byId = new Map(batch.map((r) => [r.event_id, r]))
    for (const acc of res.value.accepted) {
      const row = byId.get(acc.event_id)
      if (row) await this.settle(acc, row)
    }
    for (const rej of res.value.rejected) {
      const row = byId.get(rej.event_id)
      if (row) await this.reject(rej, row)
    }
    // More queued than one batch could carry (or new sends arrived) → re-enter.
    if (pending.length > batch.length) this.rerun = true
  }

  /**
   * Settle an accepted event (§6): store the `EventRow` (the SAME shape a WS
   * frame stores, so a later frame is a true idempotent duplicate), project it
   * into `messages` via `applyEventsToProjection` (replaces the pending row IN
   * PLACE by `message_id`, `created_seq = server_sequence`, no `state`), then
   * drop the outbox row. Idempotent on every key, so re-running is a no-op.
   *
   * The stream binding is the CLIENT's `row.stream_id` — the value the client
   * minted and hashed the body against — NOT the server's `acc.stream_id`. The
   * server assigns `server_sequence` (its to assign); it does not get to move a
   * message into a different stream. A server whose accepted entry disagrees on
   * `stream_id` (or `event_id`) is a protocol violation: we never blind-apply it
   * (same discipline as the WS delivery contract) — the row is parked instead of
   * silently misfiling the user's own message into the server-claimed stream.
   */
  private async settle(acc: AcceptedEvent, row: OutboxRow): Promise<void> {
    if (acc.event_id !== row.event_id || acc.stream_id !== row.stream_id) {
      await this.reject({ event_id: row.event_id, code: 'stream_mismatch' }, row)
      return
    }
    const body = row.body as unknown as EventBody
    const eventRow: EventRow = {
      stream_id: row.stream_id,
      server_sequence: acc.server_sequence,
      event_id: acc.event_id,
      type: typeof body.type === 'string' ? body.type : 'message.created',
      envelope: {
        body,
        event_hash: row.event_hash,
        server: {
          server_sequence: acc.server_sequence,
          server_received_at: acc.server_received_at,
        },
      },
    }
    await this.db.putEvents([eventRow])
    await applyEventsToProjection(this.db, row.stream_id, [eventRow])
    await this.db.deleteOutbox(row.event_id)
    // De-flicker (ENG-100 nit): settling a `message.created` re-writes the base
    // message row, which can transiently clobber a STILL-PENDING edit/delete overlay
    // on the same message (e.g. an optimistic edit sent before its create acked, then
    // the create settles earlier in the same drain). Re-derive the remaining overlay
    // for this message so the pending effect is restored WITHIN the settle, removing
    // the sub-drain flicker. Idempotent; a no-op when no other overlay targets it.
    await this.reapplyOverlaysFor(row.message_id)
    this.publishStream(row.stream_id)
  }

  /** Re-apply the still-pending outbox overlays targeting `messageId` (created_at order). */
  private async reapplyOverlaysFor(messageId: string): Promise<void> {
    const remaining = (await this.db.listOutbox())
      .filter((o) => o.message_id === messageId)
      .sort((a, b) => a.created_at - b.created_at)
    for (const o of remaining) {
      if (await this.db.hasEvent(o.event_id)) continue // already settled
      await applyPendingOutboxRow(this.db, o)
    }
  }

  /**
   * Park a rejected event (§4): mark the outbox row `rejected` + the projection
   * row `failed` (surfacing the code). Future drains skip it — a poison event
   * never wedges the queue, and the rest of the batch still settles.
   */
  private async reject(rej: RejectedEvent, row: OutboxRow): Promise<void> {
    const parked: OutboxRow = { ...row, state: 'rejected', error_code: rej.code }
    await this.db.putOutbox([parked])
    // Re-apply the overlay in its parked form: for `message.created` this surfaces
    // the `failed` marker + error_code on the projection row; for an M3 op the
    // effect is already applied and stays visible (idempotent re-apply) — parked,
    // not reverted, so the user can retry or explicitly discard (outbox.delete).
    await applyPendingOutboxRow(this.db, parked)
    this.publishStream(parked.stream_id)
  }

  /** Schedule the next drain on the injected clock via the shared backoff (§4). */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return
    const delay = backoffDelay(this.attempt, {
      baseMs: OUTBOX_BASE_MS,
      capMs: OUTBOX_CAP_MS,
      random: this.random,
    })
    this.attempt++
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined
      this.drain()
    }, delay)
  }
}

// ---------------------------------------------------------------------------
// Pure derivations (shared by the incremental send path AND the rebuild path).
// ---------------------------------------------------------------------------

/**
 * Derive the optimistic `MessageRow` for an outbox row — the pending (or failed)
 * echo that renders before the server acks. `created_seq = created_at` (the
 * ms-epoch sentinel: orders after every settled row, §2). Reuses
 * `applyMessageCreatedV1` for the body→row map so a pending row is byte-identical
 * to what its eventual settled row would be MINUS `created_seq`/`state` — which is
 * exactly what keeps rebuild ≡ incremental. Returns `null` on a malformed body
 * (mirrors the projection skip), so a junk outbox row never crashes the rebuild.
 */
export function buildPendingMessageRow(row: OutboxRow): MessageRow | null {
  const body = row.body as unknown as EventBody
  const eventRow: EventRow = {
    stream_id: row.stream_id,
    server_sequence: row.created_at, // pending sentinel (client-only ordering)
    event_id: row.event_id,
    type: typeof body.type === 'string' ? body.type : 'message.created',
    envelope: { body },
  }
  const base = applyMessageCreatedV1(eventRow, body)
  if (!base) return null
  const pending: MessageRow = { ...base, state: row.state === 'rejected' ? 'failed' : 'pending' }
  if (row.state === 'rejected' && row.error_code !== undefined) {
    pending.error_code = row.error_code
  }
  return pending
}

/**
 * Apply ONE outbox row's optimistic PENDING OVERLAY (ENG-100 generalization of
 * ENG-81's `buildPendingMessageRow`). Dispatched on the event `type`:
 *   • `message.created`  → the pending/failed `MessageRow` echo (renders instantly);
 *   • `reaction.added/removed` → force the `present` disposition, LEAVING the stored
 *     `last_event_seq` so the settled reaction's real seq wins the LWW on settle;
 *   • `message.edited`   → force `text`/`format` (leaving `edited_seq` so the settled
 *     edit's real seq wins the LWW cleanly on settle);
 *   • `message.deleted`  → tombstone + redact + delete-aware thread recompute.
 *
 * The SAME function runs on the incremental send/reject/retry path AND on the
 * rebuild-step-2 overlay, so `incremental ≡ rebuild` holds by construction:
 * `state = f(settled events) + g(pending outbox)` with an identical `g` both ways.
 * A junk body is a skip (never a crash).
 */
export async function applyPendingOutboxRow(db: MsgDb, row: OutboxRow): Promise<void> {
  const body = row.body as unknown as EventBody
  switch (body.type) {
    case 'message.created': {
      const pending = buildPendingMessageRow(row)
      if (pending) await db.putMessages([pending])
      return
    }
    case 'reaction.added':
      await applyPendingReaction(db, body, true)
      return
    case 'reaction.removed':
      await applyPendingReaction(db, body, false)
      return
    case 'message.edited':
      await applyPendingEdit(db, body)
      return
    case 'message.deleted':
      await applyMessageDeleted(db, body)
      return
    default:
      return // unknown type → skip (D9)
  }
}

/**
 * Rebuild step 2 (§8): re-derive the still-pending overlay from the `outbox` source
 * table, replayed in `created_at` order (so multiple pending edits of one message
 * apply last-wins, matching the incremental order). An outbox row whose `event_id`
 * is already in `events` (crash between `putEvents` + `deleteOutbox`) is SKIPPED —
 * the settled event replay already applied its effect. Uses the SAME
 * {@link applyPendingOutboxRow} as the incremental path, so the two agree.
 */
export async function applyOutboxToProjection(db: MsgDb): Promise<void> {
  const rows = [...(await db.listOutbox())].sort((a, b) => a.created_at - b.created_at)
  for (const row of rows) {
    if (await db.hasEvent(row.event_id)) continue // already settled — skip
    await applyPendingOutboxRow(db, row)
  }
}

/**
 * Recompute a single message's derived projection (row + reactions + its thread
 * state) from the settled `events` cache + any REMAINING pending overlays — the
 * "recompute from state" revert used when an M3 optimistic op is discarded
 * (outbox.delete). Wipes the target's derived state, replays only the settled
 * events REFERENCING it (create/edit/delete/reactions, ascending server_sequence)
 * through the real handlers, then re-applies the remaining pending overlays for it.
 * Because it reuses the exact incremental handlers, the recomputed state equals a
 * full rebuild's for that message.
 */
export async function recomputeMessageProjection(
  db: MsgDb,
  streamId: string,
  messageId: string,
): Promise<void> {
  const old = await db.getMessage(messageId)
  // Wipe the target's derived state (row + its reactions).
  await db.deleteMessage(messageId)
  await db.deleteReactionsForMessage(messageId)
  // Replay the settled events that reference this message, in server order.
  const events = await db.getEventsForStream(streamId)
  const relevant = events.filter((e) => {
    const p = e.envelope?.body?.payload
    return (
      p !== null &&
      typeof p === 'object' &&
      (p as { message_id?: unknown }).message_id === messageId
    )
  })
  await applyEventsToProjection(db, streamId, relevant)
  // Re-apply the still-pending overlays for this message (created_at order).
  const pending = [...(await db.listOutbox())]
    .filter((o) => o.message_id === messageId)
    .sort((a, b) => a.created_at - b.created_at)
  for (const o of pending) {
    if (await db.hasEvent(o.event_id)) continue
    await applyPendingOutboxRow(db, o)
  }
  // Keep the thread counters consistent if this message participates in a thread.
  if (old?.thread_root_id !== undefined) await recomputeThreadRoot(db, old.thread_root_id)
  await recomputeThreadRoot(db, messageId)
}
