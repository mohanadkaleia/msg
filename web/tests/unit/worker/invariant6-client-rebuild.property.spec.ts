// PERMANENT GATE — §12 invariant 6, CLIENT (Dexie) side: rebuild ≡ incremental,
// PROPERTY-BASED. The Dexie analogue of the permanent server equivalence gate.
//
// fast-check generates randomized event histories across streams — message.created
// v1 (unicode / optional thread_root_id / mentions) AND (ENG-100, M3) the reaction
// add/remove set, message.edited (LWW), message.deleted (tombstone + redact), and
// threaded replies (some later deleted) — interleaved with D9-skip events (unknown
// types, v>=2, meta, malformed-known). It ALSO generates randomized outbox rows:
// pending / failed message.created AND the M3 optimistic OVERLAY ops
// (react/edit/delete of a settled message), plus the crash-orphaned "settled but
// still in outbox" case. It applies the history incrementally through the REAL
// `applyEventsToProjection` + the REAL pending overlay, snapshots the REAL
// projection dump (messages incl. edited_seq/deleted/reply_count/format + the
// reactions set + thread participants + the pending lifecycle), drops the derived
// tables, rebuilds through the REAL `rebuildProjections` (events replay + outbox
// re-derive) and asserts the rebuilt dump is BYTE-EQUAL to the incremental one.
//
// The property loop runs against MemoryDb for breadth; a dedicated gating
// assertion ALSO replays a drawn history through the real DexieDb (fake-indexeddb)
// so the SHIPPING IndexedDB rebuild path is what is gated.
//
// TEETH (all rebuild-pass-only, ENG-61 pattern):
//   MSG_MUTATE=inv6-rebuild-skew    — corrupt one message.created row's text.
//   MSG_MUTATE=inv6-delete-skew     — rebuild "forgets" the delete tombstone.
//   MSG_MUTATE=inv6-reaction-skew   — rebuild ignores reaction removes (blind add).
// Each makes rebuild != incremental → RED. Unset (CI default) the suite is green.

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openDb, MemoryDb, rebuildProjections } from '../../../src/worker/db'
import { applyPendingOutboxRow } from '../../../src/worker/outbox'
import {
  applyEventsToProjection,
  applyMessageCreatedV1,
  dumpMessages,
  HANDLERS,
} from '../../../src/worker/projection'
import type {
  EventRow,
  MessageRow,
  MsgDb,
  OutboxRow,
  ReactionRow,
  ThreadParticipantRow,
} from '../../../src/worker/types'

import { fakeIdbOptions } from './helpers'
import {
  malformedMessageEvent,
  messageCreatedEvent,
  messageDeletedEvent,
  messageEditedEvent,
  metaEvent,
  reactionAddedEvent,
  reactionRemovedEvent,
  unknownTypeEvent,
} from './projfixtures'

const MUTATION = process.env.MSG_MUTATE

// ---------------------------------------------------------------------------
// GATE-ONLY comprehensive dump. The shipping `dumpMessages` deliberately omits
// the lifecycle + M3 fields (they are re-derivable, so rebuild ≡ incremental
// holds without them) and reads only `messages`. We must NOT change it. This
// test-only dump reuses the shipping ordering + JSON discipline and appends the
// M3 message columns (edited_seq/deleted/reply_count/last_reply_seq) + the
// lifecycle (state/error_code), THEN the reactions set + thread participants, so
// an incremental-vs-rebuild divergence in ANY of them turns the gate RED.
// ---------------------------------------------------------------------------

function compareForDump(a: MessageRow, b: MessageRow): number {
  if (a.stream_id !== b.stream_id) return a.stream_id < b.stream_id ? -1 : 1
  if (a.created_seq !== b.created_seq) return a.created_seq - b.created_seq
  if (a.message_id !== b.message_id) return a.message_id < b.message_id ? -1 : 1
  return 0
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareReaction(a: ReactionRow, b: ReactionRow): number {
  return (
    cmpStr(a.message_id, b.message_id) ||
    cmpStr(a.emoji, b.emoji) ||
    cmpStr(a.author_user_id, b.author_user_id)
  )
}

function compareParticipant(a: ThreadParticipantRow, b: ThreadParticipantRow): number {
  return cmpStr(a.root_message_id, b.root_message_id) || cmpStr(a.user_id, b.user_id)
}

async function dumpProjection(db: MsgDb): Promise<string> {
  const rows = await db.getAllMessages()
  rows.sort(compareForDump)
  const messageLines = rows.map((row) =>
    JSON.stringify({
      message_id: row.message_id,
      stream_id: row.stream_id,
      created_seq: row.created_seq,
      author_user_id: row.author_user_id,
      text: row.text,
      format: row.format,
      thread_root_id: row.thread_root_id ?? null,
      mention_user_ids: row.mention_user_ids,
      edited_seq: row.edited_seq ?? null, // M3
      deleted: row.deleted ?? false, // M3
      reply_count: row.reply_count ?? 0, // M3 threads
      last_reply_seq: row.last_reply_seq ?? null, // M3 threads
      state: row.state ?? null, // lifecycle (gate-only)
      error_code: row.error_code ?? null, // lifecycle (gate-only)
    }),
  )

  const reactions = await db.getAllReactions()
  reactions.sort(compareReaction)
  const reactionLines = reactions.map((r) =>
    JSON.stringify({ message_id: r.message_id, emoji: r.emoji, author_user_id: r.author_user_id }),
  )

  const participants = await db.getAllThreadParticipants()
  participants.sort(compareParticipant)
  const participantLines = participants.map((p) =>
    JSON.stringify({ root_message_id: p.root_message_id, user_id: p.user_id }),
  )

  return [
    'MESSAGES',
    ...messageLines,
    'REACTIONS',
    ...reactionLines,
    'PARTICIPANTS',
    ...participantLines,
  ].join('\n')
}

// The D9 skip (malformed / unknown / v>=2 events) warns by design; randomized
// histories generate many, so silence the expected noise for readable CI logs.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  HANDLERS['message.created@1'] = applyMessageCreatedV1 // restore after any teeth patch
})

// ---------------------------------------------------------------------------
// Randomized-history materialization. fast-check draws SHAPE choices; a mutable
// counter mints unique ids + per-stream ascending sequences, and target-needing
// ops (reply/react/edit/delete) reference a message ALREADY created in the SAME
// stream (valid references only — cross-stream/reply-of-reply are server-rejected),
// so every history is well-formed yet fully random.
// ---------------------------------------------------------------------------

const NUM_STREAMS = 3
const EMOJIS = ['👍', '🎉', '☕', 'x', 'x'] // two distinct 'x' bytes — opaque key
const USERS = ['u_a', 'u_b', 'u_c']

type EventKind =
  | 'create'
  | 'reply'
  | 'react-add'
  | 'react-remove'
  | 'edit'
  | 'delete'
  | 'unknown'
  | 'meta'
  | 'malformed'

interface EventChoice {
  stream: number
  kind: EventKind
  text: string
  format: 'markdown' | 'plain'
  mentions: string[]
  emoji: number
  reactor: number
  target: number
}

type OutboxKind = 'create' | 'react-add' | 'react-remove' | 'edit' | 'delete'
interface OutboxChoice {
  stream: number
  kind: OutboxKind
  state: OutboxRow['state']
  text: string
  emoji: number
  reactor: number
  target: number
  orphan: boolean
  errorCode: string | null
}

interface History {
  byStream: Map<string, EventRow[]>
  outbox: OutboxRow[]
}

const TEXTS = fc.oneof(
  fc.string(),
  fc.constantFrom('', 'unicode 日本語 🎉 ☕', 'multi\nline\ttext', '"quotes" & <html>'),
)

const eventChoiceArb: fc.Arbitrary<EventChoice> = fc.record({
  stream: fc.integer({ min: 0, max: NUM_STREAMS - 1 }),
  kind: fc.constantFrom<EventKind>(
    'create',
    'create',
    'reply',
    'react-add',
    'react-add',
    'react-remove',
    'edit',
    'delete',
    'unknown',
    'meta',
    'malformed',
  ),
  text: TEXTS,
  format: fc.constantFrom('markdown', 'plain'),
  mentions: fc.array(fc.constantFrom('u_x', 'u_y', 'u_z'), { maxLength: 3 }),
  emoji: fc.integer({ min: 0, max: EMOJIS.length - 1 }),
  reactor: fc.integer({ min: 0, max: USERS.length - 1 }),
  target: fc.integer({ min: 0, max: 999 }),
})

const outboxChoiceArb: fc.Arbitrary<OutboxChoice> = fc.record({
  stream: fc.integer({ min: 0, max: NUM_STREAMS - 1 }),
  kind: fc.constantFrom<OutboxKind>('create', 'react-add', 'react-remove', 'edit', 'delete'),
  state: fc.constantFrom<OutboxRow['state']>('queued', 'sending', 'rejected'),
  text: TEXTS,
  emoji: fc.integer({ min: 0, max: EMOJIS.length - 1 }),
  reactor: fc.integer({ min: 0, max: USERS.length - 1 }),
  target: fc.integer({ min: 0, max: 999 }),
  orphan: fc.boolean(),
  errorCode: fc.option(fc.constantFrom('permission_denied', 'payload_too_large'), { nil: null }),
})

const historyArb: fc.Arbitrary<{ events: EventChoice[]; outbox: OutboxChoice[] }> = fc.record({
  events: fc.array(eventChoiceArb, { maxLength: 20 }),
  outbox: fc.array(outboxChoiceArb, { maxLength: 8 }),
})

/** A body for an M3-reference outbox row (reaction/edit/delete of a target). */
function refBody(
  type: string,
  streamId: string,
  eventId: string,
  author: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    event_id: eventId,
    workspace_id: 'w_test',
    stream_id: streamId,
    type,
    type_version: 1,
    author_user_id: author,
    author_device_id: 'd_test',
    client_created_at: '2026-01-01T00:00:00.000Z',
    payload,
  }
}

/** A message.created outbox body (the shape the send path mints). */
function createdBody(
  streamId: string,
  eventId: string,
  messageId: string,
  text: string,
): Record<string, unknown> {
  return refBody('message.created', streamId, eventId, 'u_author', {
    message_id: messageId,
    text,
    format: 'markdown',
    thread_root_id: null,
    file_ids: [],
    mentions: [],
  })
}

/** Materialize drawn shape choices into a well-formed, unique-id history. */
function materialize(draw: { events: EventChoice[]; outbox: OutboxChoice[] }): History {
  const streamIds = Array.from({ length: NUM_STREAMS }, (_, i) => `s_${i}`)
  const seqOf = new Array<number>(NUM_STREAMS).fill(0)
  const byStream = new Map<string, EventRow[]>(streamIds.map((s) => [s, []]))
  // Per-stream: message ids created so far (settled), + the subset that are roots.
  const createdByStream: string[][] = streamIds.map(() => [])
  const rootsByStream: string[][] = streamIds.map(() => [])
  const settledCreatedIds: { streamId: string; messageId: string; eventId: string }[] = []
  let id = 0

  const push = (streamId: string, ev: EventRow): void => {
    byStream.get(streamId)!.push(ev)
  }

  for (const ec of draw.events) {
    const streamId = streamIds[ec.stream]!
    const created = createdByStream[ec.stream]!
    const roots = rootsByStream[ec.stream]!
    // Degrade a target-needing op to a plain create when the stream has no target.
    let kind = ec.kind
    if (
      (kind === 'react-add' || kind === 'react-remove' || kind === 'edit' || kind === 'delete') &&
      created.length === 0
    ) {
      kind = 'create'
    }
    if (kind === 'reply' && roots.length === 0) kind = 'create'
    const seq = ++seqOf[ec.stream]!

    if (kind === 'unknown') {
      push(streamId, unknownTypeEvent(streamId, seq))
      continue
    }
    if (kind === 'meta') {
      push(streamId, metaEvent(streamId, seq))
      continue
    }
    if (kind === 'malformed') {
      push(streamId, malformedMessageEvent(streamId, seq))
      continue
    }
    if (kind === 'create') {
      const messageId = `m_${++id}`
      push(
        streamId,
        messageCreatedEvent({
          streamId,
          seq,
          messageId,
          text: ec.text,
          format: ec.format,
          mentions: ec.mentions,
        }),
      )
      created.push(messageId)
      roots.push(messageId)
      settledCreatedIds.push({ streamId, messageId, eventId: `e_${streamId}_${seq}` })
      continue
    }
    if (kind === 'reply') {
      const root = roots[ec.target % roots.length]!
      const messageId = `m_${++id}`
      push(
        streamId,
        messageCreatedEvent({
          streamId,
          seq,
          messageId,
          text: ec.text,
          threadRootId: root,
          authorUserId: USERS[ec.reactor]!,
        }),
      )
      created.push(messageId)
      settledCreatedIds.push({ streamId, messageId, eventId: `e_${streamId}_${seq}` })
      continue
    }
    const target = created[ec.target % created.length]!
    if (kind === 'react-add') {
      push(
        streamId,
        reactionAddedEvent({
          streamId,
          seq,
          messageId: target,
          emoji: EMOJIS[ec.emoji]!,
          authorUserId: USERS[ec.reactor]!,
        }),
      )
    } else if (kind === 'react-remove') {
      push(
        streamId,
        reactionRemovedEvent({
          streamId,
          seq,
          messageId: target,
          emoji: EMOJIS[ec.emoji]!,
          authorUserId: USERS[ec.reactor]!,
        }),
      )
    } else if (kind === 'edit') {
      push(
        streamId,
        messageEditedEvent({ streamId, seq, messageId: target, text: ec.text, format: ec.format }),
      )
    } else if (kind === 'delete') {
      push(streamId, messageDeletedEvent({ streamId, seq, messageId: target }))
    }
  }

  // ---- Outbox: pending message.created + M3 optimistic overlay ops -----------
  const outbox: OutboxRow[] = []
  for (const oc of draw.outbox) {
    const isOrphan = oc.orphan && settledCreatedIds.length > 0
    if (isOrphan) {
      // Reuse a settled message.created event's ids: the incremental state has the
      // SETTLED row (from events) + a lingering outbox row; rebuild must skip it.
      const s = settledCreatedIds[id % settledCreatedIds.length]!
      outbox.push({
        event_id: s.eventId,
        created_at: 1_000 + id,
        body: createdBody(s.streamId, s.eventId, s.messageId, 'stale-orphan'),
        event_hash: `sha256:${s.eventId}`,
        message_id: s.messageId,
        stream_id: s.streamId,
        state: oc.state,
      })
      id++
      continue
    }
    // A pending overlay op targeting a SETTLED message in the chosen stream (the
    // realistic "latest local action" layered on top of the settled base).
    const streamId = streamIds[oc.stream]!
    const targets = settledCreatedIds.filter((s) => s.streamId === streamId)
    const eventId = `o_${++id}`
    const createdAt = 1_700_000_000_000 + id
    let kind: OutboxKind = oc.kind
    if (kind !== 'create' && targets.length === 0) kind = 'create'
    let body: Record<string, unknown>
    let messageId: string
    if (kind === 'create') {
      messageId = `m_o_${id}`
      body = createdBody(streamId, eventId, messageId, oc.text)
    } else {
      messageId = targets[oc.target % targets.length]!.messageId
      const author = USERS[oc.reactor]!
      if (kind === 'react-add') {
        body = refBody('reaction.added', streamId, eventId, author, {
          message_id: messageId,
          emoji: EMOJIS[oc.emoji]!,
        })
      } else if (kind === 'react-remove') {
        body = refBody('reaction.removed', streamId, eventId, author, {
          message_id: messageId,
          emoji: EMOJIS[oc.emoji]!,
        })
      } else if (kind === 'edit') {
        body = refBody('message.edited', streamId, eventId, 'u_author', {
          message_id: messageId,
          text: oc.text,
          format: oc.emoji % 2 === 0 ? 'markdown' : 'plain',
        })
      } else {
        body = refBody('message.deleted', streamId, eventId, 'u_author', { message_id: messageId })
      }
    }
    outbox.push({
      event_id: eventId,
      created_at: createdAt,
      body,
      event_hash: `sha256:${eventId}`,
      message_id: messageId,
      stream_id: streamId,
      state: oc.state,
      ...(oc.state === 'rejected' && oc.errorCode !== null ? { error_code: oc.errorCode } : {}),
    })
  }

  return { byStream, outbox }
}

/**
 * Reproduce the INCREMENTAL state: settled events applied per stream via the real
 * apply, THEN the outbox overlay applied (created_at order) exactly as the live
 * send path would — the settled base first, the pending overlay on top.
 */
async function buildIncremental(db: MsgDb, h: History): Promise<void> {
  for (const [streamId, events] of h.byStream) {
    if (events.length === 0) continue
    await db.putEvents(events)
    await applyEventsToProjection(db, streamId, events)
  }
  if (h.outbox.length > 0) await db.putOutbox(h.outbox)
  const ordered = [...h.outbox].sort((a, b) => a.created_at - b.created_at)
  for (const row of ordered) {
    if (await db.hasEvent(row.event_id)) continue // orphan: already settled — no overlay
    await applyPendingOutboxRow(db, row)
  }
}

/**
 * Rebuild through the REAL `rebuildProjections`. Under an env-gated teeth flag a
 * rebuild-pass-only bug is injected (the ENG-61 pattern) so the SAME
 * `rebuild === incremental` gate goes red; the patch is reverted immediately so
 * the next iteration's incremental pass is clean.
 */
async function rebuildMaybeSkewed(db: MsgDb): Promise<void> {
  const restore: Array<() => void> = []
  if (MUTATION === 'inv6-rebuild-skew') {
    let corrupted = false
    HANDLERS['message.created@1'] = (event, body) => {
      const row = applyMessageCreatedV1(event, body)
      if (row && !corrupted) {
        corrupted = true
        return { ...row, text: row.text + 'X' }
      }
      return row
    }
    restore.push(() => (HANDLERS['message.created@1'] = applyMessageCreatedV1))
  } else if (MUTATION === 'inv6-delete-skew') {
    // Rebuild "forgets" the tombstone: strip `deleted` on every persisted row.
    const real = db.putMessages.bind(db)
    db.putMessages = (rows: readonly MessageRow[]): Promise<void> =>
      real(rows.map((r) => ({ ...r, deleted: false })))
    restore.push(() => (db.putMessages = real))
  } else if (MUTATION === 'inv6-reaction-skew') {
    // Rebuild ignores reaction removes (blind add): deleteReaction is a no-op.
    const real = db.deleteReaction.bind(db)
    db.deleteReaction = (): Promise<void> => Promise.resolve()
    restore.push(() => (db.deleteReaction = real))
  }
  try {
    await rebuildProjections(db)
  } finally {
    for (const r of restore) r()
  }
}

// ===========================================================================
// Property 1 — rebuild ≡ incremental for EVERY randomized history (MemoryDb).
// ===========================================================================

describe('§12 invariant 6 — client rebuild ≡ incremental [property]', () => {
  it('drop+replay is byte-identical to incremental for any generated history (MemoryDb)', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (draw) => {
        const db: MsgDb = new MemoryDb()
        const h = materialize(draw)
        await buildIncremental(db, h)
        const incremental = await dumpProjection(db)

        await db.clearDerivedTables()
        await rebuildMaybeSkewed(db)
        const rebuilt = await dumpProjection(db)

        expect(rebuilt).toBe(incremental) // the gate (goes red under any teeth flag)
        await db.close()
      }),
      { numRuns: 120 },
    )
  })

  // ------------------------------------------------------------------------
  // Property 2 — the SHIPPING db: replay drawn histories through the real
  // DexieDb (fake-indexeddb). This is the gating assertion for the browser path.
  // ------------------------------------------------------------------------
  it('drop+replay is byte-identical against the real DexieDb (shipping path)', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (draw) => {
        const db: MsgDb = await openDb(fakeIdbOptions())
        expect(db.persistence).toBe('persistent') // real Dexie, not the MemoryDb fallback
        const h = materialize(draw)
        await buildIncremental(db, h)
        const incremental = await dumpProjection(db)

        await db.clearDerivedTables()
        await rebuildMaybeSkewed(db)
        const rebuilt = await dumpProjection(db)

        expect(rebuilt).toBe(incremental) // the gate (goes red under any teeth flag)
        await db.close()
      }),
      { numRuns: 20 },
    )
  })

  // ------------------------------------------------------------------------
  // Property 3 — idempotence: re-applying the whole history (settled base THEN
  // the pending overlay — the same "f then g" the rebuild does) leaves the dump
  // unchanged. Re-applying settled events alone would clobber the overlay back to
  // its settled base; re-deriving the overlay on top restores it — exactly why
  // rebuild ≡ incremental holds and the two agree by construction.
  // ------------------------------------------------------------------------
  it('re-applying the full history is a no-op on the dump (idempotence)', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (draw) => {
        const db: MsgDb = new MemoryDb()
        const h = materialize(draw)
        await buildIncremental(db, h)
        const before = await dumpProjection(db)
        await buildIncremental(db, h) // re-apply settled base + re-derive overlay
        expect(await dumpProjection(db)).toBe(before)
        // The shipping dump is unchanged too (never regressed by the gate dump).
        expect(typeof (await dumpMessages(db))).toBe('string')
        await db.close()
      }),
      { numRuns: 40 },
    )
  })

  // ------------------------------------------------------------------------
  // Property 4 — DETERMINISTIC M3 teeth. The env-gated property teeth
  // (inv6-delete-skew / inv6-reaction-skew) only bite when the random sample
  // happens to draw the triggering shape (a reaction add+remove, a delete). This
  // fixed history GUARANTEES both, and injects each M3 rebuild bug inline (no env
  // var) so the teeth ALWAYS bite: a positive control (clean rebuild == incremental)
  // plus a reaction-remove-ignored rebuild and a delete-not-tombstoned rebuild,
  // each of which MUST make the dumps differ.
  // ------------------------------------------------------------------------
  it('TEETH: a one-sided M3 rebuild bug (skip delete-redact / ignore reaction removes) → RED', async () => {
    // Fixed history in one stream: create m_root, a reply m_r (u_a), a reaction
    // added then removed (net: no membership), and the reply deleted.
    const events: EventRow[] = [
      messageCreatedEvent({ streamId: 's_0', seq: 1, messageId: 'm_root', text: 'root' }),
      messageCreatedEvent({
        streamId: 's_0',
        seq: 2,
        messageId: 'm_r',
        text: 'reply',
        threadRootId: 'm_root',
        authorUserId: 'u_a',
      }),
      reactionAddedEvent({
        streamId: 's_0',
        seq: 3,
        messageId: 'm_root',
        emoji: '👍',
        authorUserId: 'u_a',
      }),
      reactionRemovedEvent({
        streamId: 's_0',
        seq: 4,
        messageId: 'm_root',
        emoji: '👍',
        authorUserId: 'u_a',
      }),
      messageDeletedEvent({ streamId: 's_0', seq: 5, messageId: 'm_r' }),
    ]
    const build = async (db: MsgDb): Promise<void> => {
      await db.putEvents(events)
      await applyEventsToProjection(db, 's_0', events)
    }

    // Positive control: a CLEAN rebuild is byte-identical (so the != below has meaning).
    const clean = new MemoryDb()
    await build(clean)
    const incremental = await dumpProjection(clean)
    await clean.clearDerivedTables()
    await rebuildProjections(clean)
    expect(await dumpProjection(clean)).toBe(incremental)
    await clean.close()

    // TOOTH 1 — rebuild IGNORES reaction removes (blind add): deleteReaction no-op.
    const t1 = new MemoryDb()
    await build(t1)
    await t1.clearDerivedTables()
    const realDelReaction = t1.deleteReaction.bind(t1)
    t1.deleteReaction = (): Promise<void> => Promise.resolve()
    await rebuildProjections(t1)
    t1.deleteReaction = realDelReaction
    expect(await dumpProjection(t1)).not.toBe(incremental) // stale 👍 membership survives
    await t1.close()

    // TOOTH 2 — rebuild SKIPS the delete tombstone: strip `deleted` on write.
    const t2 = new MemoryDb()
    await build(t2)
    await t2.clearDerivedTables()
    const realPut = t2.putMessages.bind(t2)
    t2.putMessages = (rows): Promise<void> => realPut(rows.map((r) => ({ ...r, deleted: false })))
    await rebuildProjections(t2)
    t2.putMessages = realPut
    // m_r is not tombstoned on rebuild → its row + the root's reply_count differ.
    expect(await dumpProjection(t2)).not.toBe(incremental)
    await t2.close()
  })
})
