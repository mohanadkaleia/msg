// tests/unit/worker/msgdb-conformance.spec.ts — the parametrized MsgDb
// CONFORMANCE suite (ENG-165, M6-1).
//
// One spec, three backends: every `describe.each` below runs the IDENTICAL
// assertions over MemoryDb (Map), DexieDb (fake-indexeddb) and SqliteDb
// (better-sqlite3 via the Node SqlDriver). The point is behavioral equality:
// SqliteDb must be indistinguishable from the two existing impls through the
// MsgDb interface — same return shapes, byte-identical row round-trips, same
// monotonic-CAS semantics, same wipe scopes, and the same
// checkProjectionVersion → clearDerivedTables → rebuildProjections path
// (invariant 6). A focused SqliteDb-only rebuild-equivalence block closes with
// the dump-level proof.

import { describe, expect, it } from 'vitest'

import {
  checkProjectionVersion,
  MemoryDb,
  openDb,
  rebuildProjections,
} from '../../../src/worker/db'
import { applyEventsToProjection, dumpFiles, dumpMessages } from '../../../src/worker/projection'
import { NodeSqlDriver } from '../../../src/worker/sqlite/node-driver'
import { openSqliteDb, SqliteDb } from '../../../src/worker/sqlite/sqlite-db'
import {
  PROJECTION_VERSION,
  type CursorRow,
  type EventRow,
  type FileRow,
  type MessageRow,
  type MsgDb,
  type OutboxRow,
  type ReactionRow,
  type StreamRow,
  type TableName,
} from '../../../src/worker/types'

import { fakeIdbOptions, stubEnvelope } from './helpers'
import {
  fileId,
  fileUploadedEvent,
  messageCreatedEvent,
  messageDeletedEvent,
  messageEditedEvent,
  metaEvent,
  reactionAddedEvent,
  reactionRemovedEvent,
  unknownTypeEvent,
} from './projfixtures'

// ---------------------------------------------------------------------------
// The three implementations under test.
// ---------------------------------------------------------------------------

const impls = [
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
  { name: 'SqliteDb', make: (): Promise<MsgDb> => openSqliteDb(new NodeSqlDriver(':memory:')) },
]

// ---------------------------------------------------------------------------
// Row builders — deliberately exercising BOTH the minimal shape (optional
// fields absent — a JSON/clone round-trip must not invent keys) and the maximal
// shape (every optional field set).
// ---------------------------------------------------------------------------

function eventRow(streamId: string, seq: number, over: Partial<EventRow> = {}): EventRow {
  return {
    stream_id: streamId,
    server_sequence: seq,
    event_id: `e_${streamId}_${seq}`,
    type: 'message.created',
    envelope: stubEnvelope(seq),
    ...over,
  }
}

function minimalMessage(id: string, streamId: string, seq: number): MessageRow {
  return {
    message_id: id,
    stream_id: streamId,
    created_seq: seq,
    author_user_id: 'u_author',
    text: `text ${seq}`,
    format: 'markdown',
    mention_user_ids: [],
    file_ids: [],
  }
}

function maximalMessage(id: string, streamId: string, seq: number): MessageRow {
  return {
    message_id: id,
    stream_id: streamId,
    created_seq: seq,
    author_user_id: 'u_author',
    text: 'unicode 日本語 🎉 ☕',
    format: 'plain',
    thread_root_id: 'm_root',
    mention_user_ids: ['u_x', 'u_y'],
    file_ids: [fileId(1)],
    edited_seq: seq + 5,
    deleted: false,
    reply_count: 3,
    last_reply_seq: seq + 9,
    state: 'failed',
    error_code: 'permission_denied',
  }
}

function fileRow(id: string, over: Partial<FileRow> = {}): FileRow {
  return {
    file_id: id,
    sha256: 'a'.repeat(64),
    name: 'photo.png',
    mime_type: 'image/png',
    size_bytes: 1234,
    stream_id: 's1',
    uploaded_by: 'u_author',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function streamRow(id: string, over: Partial<StreamRow> = {}): StreamRow {
  return { stream_id: id, kind: 'channel', head_seq: 0, member: true, ...over }
}

function outboxRow(eventId: string, over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    event_id: eventId,
    created_at: 1_750_000_000_000,
    body: {
      event_id: eventId,
      stream_id: 's1',
      type: 'message.created',
      type_version: 1,
      payload: { message_id: `m_${eventId}`, text: 'hi', mentions: [] },
    },
    event_hash: `sha256:${eventId}`,
    message_id: `m_${eventId}`,
    stream_id: 's1',
    state: 'queued',
    ...over,
  }
}

function reactionRow(
  messageId: string,
  author: string,
  emoji: string,
  seq: number,
  present: boolean,
): ReactionRow {
  return { message_id: messageId, author_user_id: author, emoji, last_event_seq: seq, present }
}

/** Seed one row into every table (the wipe-scope + count fixtures). */
async function seedAllTables(db: MsgDb): Promise<void> {
  await db.putEvents([eventRow('s1', 1)])
  await db.putOutbox([outboxRow('o1')])
  await db.putMessages([minimalMessage('m1', 's1', 1)])
  await db.putReactions([reactionRow('m1', 'u1', '👍', 1, true)])
  await db.putThreadParticipants([{ root_message_id: 'm1', user_id: 'u1' }])
  await db.putFiles([fileRow(fileId(1))])
  await db.putStreams([streamRow('s1', { head_seq: 1 })])
  await db.putCursors([{ stream_id: 's1', last_contiguous_seq: 1, oldest_loaded_seq: 1 }])
  await db.putReadState([{ stream_id: 's1', last_read_seq: 1 }])
  await db.putPrefs([{ stream_id: 's1', level: 'mute' }])
  await db.metaPut('k', 'v')
}

const ALL_TABLES: readonly TableName[] = [
  'events',
  'messages',
  'reactions',
  'thread_participants',
  'files',
  'streams',
  'cursors',
  'outbox',
  'read_state',
  'prefs',
  'meta',
]

describe.each(impls)('MsgDb conformance [$name]', ({ make }) => {
  // -- identity ---------------------------------------------------------------

  it('advertises capabilities (fts=false pre-M6-2) and a persistence mode', async () => {
    const db = await make()
    expect(db.capabilities).toEqual({ fts: false })
    expect(['persistent', 'memory']).toContain(db.persistence)
    await db.close()
  })

  // -- meta ---------------------------------------------------------------------

  it('meta: round-trips strings, numbers and nested objects; overwrites; misses are undefined', async () => {
    const db = await make()
    expect(await db.metaGet('absent')).toBeUndefined()
    await db.metaPut('s', 'v-1')
    await db.metaPut('n', 42)
    const nested = { a: [1, 2, { b: 'c' }], d: null }
    await db.metaPut('o', nested)
    expect(await db.metaGet<string>('s')).toBe('v-1')
    expect(await db.metaGet<number>('n')).toBe(42)
    expect(await db.metaGet('o')).toStrictEqual(nested)
    await db.metaPut('s', 'v-2') // overwrite by key
    expect(await db.metaGet<string>('s')).toBe('v-2')
    expect(await db.count('meta')).toBe(3)
    await db.close()
  })

  // -- events (source cache) ------------------------------------------------------

  it('events: rows round-trip byte-identically and read back ascending by server_sequence', async () => {
    const db = await make()
    const rows = [eventRow('s1', 3), eventRow('s1', 1), eventRow('s1', 2), eventRow('s2', 7)]
    await db.putEvents(rows) // deliberately out of order
    const got = await db.getEventsForStream('s1')
    expect(got).toStrictEqual([eventRow('s1', 1), eventRow('s1', 2), eventRow('s1', 3)])
    expect(await db.listEventSequences('s1')).toEqual([1, 2, 3])
    expect(await db.listEventSequences('s2')).toEqual([7])
    expect(await db.listEventSequences('s_absent')).toEqual([])
    expect(new Set(await db.listStreamIds())).toEqual(new Set(['s1', 's2']))
    await db.close()
  })

  it('events: putEvents upserts by (stream_id, server_sequence) — a re-put replaces, never duplicates', async () => {
    const db = await make()
    await db.putEvents([eventRow('s1', 1)])
    await db.putEvents([eventRow('s1', 1, { event_id: 'e_replaced', type: 'message.edited' })])
    expect(await db.count('events')).toBe(1)
    const got = await db.getEventsForStream('s1')
    expect(got[0]?.event_id).toBe('e_replaced')
    expect(got[0]?.type).toBe('message.edited')
    await db.close()
  })

  it('events: minStoredSeq, hasEvent, deleteEventsBySequence (eviction)', async () => {
    const db = await make()
    expect(await db.minStoredSeq('s1')).toBeUndefined()
    await db.putEvents([eventRow('s1', 5), eventRow('s1', 6), eventRow('s1', 7)])
    expect(await db.minStoredSeq('s1')).toBe(5)
    expect(await db.hasEvent('e_s1_6')).toBe(true)
    expect(await db.hasEvent('e_nope')).toBe(false)
    await db.deleteEventsBySequence('s1', [5, 6])
    expect(await db.listEventSequences('s1')).toEqual([7])
    expect(await db.minStoredSeq('s1')).toBe(7)
    expect(await db.hasEvent('e_s1_6')).toBe(false)
    await db.close()
  })

  // -- messages (derived) -----------------------------------------------------------

  it('messages: minimal AND maximal rows round-trip byte-identically (no keys invented or lost)', async () => {
    const db = await make()
    const min = minimalMessage('m_min', 's1', 1)
    const max = maximalMessage('m_max', 's1', 2)
    await db.putMessages([min, max])
    expect(await db.getMessage('m_min')).toStrictEqual(min)
    expect(await db.getMessage('m_max')).toStrictEqual(max)
    expect(await db.getMessage('m_absent')).toBeUndefined()
    // upsert by message_id: a re-put replaces the row
    await db.putMessages([{ ...min, text: 'edited' }])
    expect((await db.getMessage('m_min'))?.text).toBe('edited')
    expect(await db.count('messages')).toBe(2)
    await db.close()
  })

  it('messages: listMessagesByStream pages DESC with an EXCLUSIVE before_seq bound', async () => {
    const db = await make()
    await db.putMessages([1, 2, 3, 4, 5].map((s) => minimalMessage(`m${s}`, 's1', s)))
    await db.putMessages([minimalMessage('m_other', 's2', 3)])
    // newest first, capped
    const page1 = await db.listMessagesByStream('s1', { limit: 2 })
    expect(page1.map((m) => m.created_seq)).toEqual([5, 4])
    // before_seq is EXCLUSIVE: created_seq < 4
    const page2 = await db.listMessagesByStream('s1', { beforeSeq: 4, limit: 10 })
    expect(page2.map((m) => m.created_seq)).toEqual([3, 2, 1])
    expect(await db.listMessagesByStream('s1', { beforeSeq: 1, limit: 10 })).toEqual([])
    await db.close()
  })

  it('messages: listStreamMessagesAfter is EXCLUSIVE and ascending (mention scan)', async () => {
    const db = await make()
    await db.putMessages([1, 2, 3, 4].map((s) => minimalMessage(`m${s}`, 's1', s)))
    const after = await db.listStreamMessagesAfter('s1', 2)
    expect(after.map((m) => m.created_seq)).toEqual([3, 4])
    expect(await db.listStreamMessagesAfter('s1', 99)).toEqual([])
    await db.close()
  })

  it('messages: listRepliesByRoot selects by thread_root_id; getAllMessages returns everything', async () => {
    const db = await make()
    const root = minimalMessage('m_root', 's1', 1)
    const r1 = { ...minimalMessage('m_r1', 's1', 2), thread_root_id: 'm_root' }
    const r2 = { ...minimalMessage('m_r2', 's1', 3), thread_root_id: 'm_root' }
    const other = { ...minimalMessage('m_r3', 's1', 4), thread_root_id: 'm_other' }
    await db.putMessages([root, r1, r2, other])
    const replies = await db.listRepliesByRoot('m_root')
    expect(new Set(replies.map((m) => m.message_id))).toEqual(new Set(['m_r1', 'm_r2']))
    expect((await db.getAllMessages()).length).toBe(4)
    await db.close()
  })

  it('messages: deleteMessage removes exactly the row (outbox.delete of an unsettled send)', async () => {
    const db = await make()
    await db.putMessages([minimalMessage('m1', 's1', 1), minimalMessage('m2', 's1', 2)])
    await db.deleteMessage('m1')
    expect(await db.getMessage('m1')).toBeUndefined()
    expect(await db.getMessage('m2')).toBeDefined()
    expect(await db.count('messages')).toBe(1)
    await db.deleteMessage('m_absent') // deleting a miss is a no-op, never a throw
    expect(await db.count('messages')).toBe(1)
    await db.close()
  })

  // -- reactions (seq-aware LWW; tombstones kept) --------------------------------------

  it('reactions: keyed upsert round-trips; observable reads filter present; tombstones kept for the dump', async () => {
    const db = await make()
    const add = reactionRow('m1', 'u1', '👍', 4, true)
    const tomb = reactionRow('m1', 'u2', '🎉', 6, false)
    await db.putReactions([add, tomb])
    expect(await db.getReaction('m1', 'u1', '👍')).toStrictEqual(add)
    expect(await db.getReaction('m1', 'u2', '🎉')).toStrictEqual(tomb)
    expect(await db.getReaction('m1', 'u1', '🎉')).toBeUndefined()
    // observable = present only
    expect(await db.getReactionsForMessage('m1')).toStrictEqual([add])
    // dump source = everything, tombstones included
    expect(new Set((await db.getAllReactions()).map((r) => r.author_user_id))).toEqual(
      new Set(['u1', 'u2']),
    )
    // LWW upsert by the (message_id, author, emoji) key
    await db.putReactions([{ ...add, last_event_seq: 9, present: false }])
    expect(await db.count('reactions')).toBe(2)
    expect((await db.getReaction('m1', 'u1', '👍'))?.present).toBe(false)
    await db.close()
  })

  it('reactions: emoji is an EXACT-BYTE key component (no normalization; skin tones are distinct)', async () => {
    const db = await make()
    await db.putReactions([
      reactionRow('m1', 'u1', '👍', 1, true),
      reactionRow('m1', 'u1', '👍🏽', 2, true), // same base + modifier = a DIFFERENT key
    ])
    expect(await db.count('reactions')).toBe(2)
    expect((await db.getReaction('m1', 'u1', '👍'))?.last_event_seq).toBe(1)
    expect((await db.getReaction('m1', 'u1', '👍🏽'))?.last_event_seq).toBe(2)
    await db.close()
  })

  it('reactions: deleteReactionsForMessage wipes present + tombstone rows for that message only', async () => {
    const db = await make()
    await db.putReactions([
      reactionRow('m1', 'u1', '👍', 1, true),
      reactionRow('m1', 'u2', '👍', 2, false),
      reactionRow('m2', 'u1', '👍', 3, true),
    ])
    await db.deleteReactionsForMessage('m1')
    expect(await db.getReactionsForMessage('m1')).toEqual([])
    expect(await db.getAllReactions()).toStrictEqual([reactionRow('m2', 'u1', '👍', 3, true)])
    await db.close()
  })

  // -- thread participants ----------------------------------------------------------

  it('thread_participants: keyed set round-trips; per-root reads and the recompute wipe', async () => {
    const db = await make()
    await db.putThreadParticipants([
      { root_message_id: 'm_root', user_id: 'u1' },
      { root_message_id: 'm_root', user_id: 'u2' },
      { root_message_id: 'm_other', user_id: 'u3' },
    ])
    // keyed upsert: a re-put of an existing pair is a no-op, not a duplicate
    await db.putThreadParticipants([{ root_message_id: 'm_root', user_id: 'u1' }])
    expect(await db.count('thread_participants')).toBe(3)
    expect(
      new Set((await db.listThreadParticipantsByRoot('m_root')).map((p) => p.user_id)),
    ).toEqual(new Set(['u1', 'u2']))
    await db.deleteThreadParticipantsForRoot('m_root')
    expect(await db.listThreadParticipantsByRoot('m_root')).toEqual([])
    expect(await db.getAllThreadParticipants()).toStrictEqual([
      { root_message_id: 'm_other', user_id: 'u3' },
    ])
    await db.close()
  })

  // -- files --------------------------------------------------------------------------

  it('files: keyed upsert round-trips; getFilesByIds keeps input order and omits misses', async () => {
    const db = await make()
    const f1 = fileRow(fileId(1))
    const f2 = fileRow(fileId(2), { name: 'doc.pdf', mime_type: 'application/pdf' })
    await db.putFiles([f1, f2])
    expect(await db.getFile(fileId(1))).toStrictEqual(f1)
    expect(await db.getFile('f_absent')).toBeUndefined()
    expect(await db.getFilesByIds([fileId(2), 'f_absent', fileId(1)])).toStrictEqual([f2, f1])
    expect(await db.getFilesByIds([])).toEqual([])
    // idempotent keyed upsert (a re-apply is byte-identical)
    await db.putFiles([f1])
    expect(await db.count('files')).toBe(2)
    expect((await db.getAllFiles()).length).toBe(2)
    await db.close()
  })

  // -- streams + bumpStreamHead ----------------------------------------------------------

  it('streams: rows round-trip (optional name/visibility/archived included)', async () => {
    const db = await make()
    const bare = streamRow('s_bare')
    const full = streamRow('s_full', {
      kind: 'dm',
      name: 'general',
      visibility: 'public',
      head_seq: 12,
      archived: true,
    })
    await db.putStreams([bare, full])
    expect(await db.getStream('s_bare')).toStrictEqual(bare)
    expect(await db.getStream('s_full')).toStrictEqual(full)
    expect(await db.getStream('s_absent')).toBeUndefined()
    expect((await db.listStreams()).length).toBe(2)
    await db.close()
  })

  it('bumpStreamHead: GREATEST CAS — up only, equal/lower are no-ops, other columns survive', async () => {
    const db = await make()
    await db.putStreams([streamRow('s1', { name: 'general', head_seq: 5 })])
    expect(await db.bumpStreamHead('s1', 7)).toBe(true) // higher → advances
    expect((await db.getStream('s1'))?.head_seq).toBe(7)
    expect(await db.bumpStreamHead('s1', 6)).toBe(false) // lower → no write
    expect(await db.bumpStreamHead('s1', 7)).toBe(false) // equal → no write
    expect((await db.getStream('s1'))?.head_seq).toBe(7)
    // the bump is a targeted head_seq write — the rest of the row is untouched
    expect(await db.getStream('s1')).toStrictEqual(
      streamRow('s1', { name: 'general', head_seq: 7 }),
    )
    await db.close()
  })

  it('bumpStreamHead: a missing stream is a no-op (rows are authored by /v1/sync, never fabricated)', async () => {
    const db = await make()
    expect(await db.bumpStreamHead('s_missing', 3)).toBe(false)
    expect(await db.getStream('s_missing')).toBeUndefined()
    expect(await db.count('streams')).toBe(0)
    await db.close()
  })

  it('bumpStreamHead: concurrent bumps converge to the MAX regardless of settle order', async () => {
    const db = await make()
    await db.putStreams([streamRow('s1', { head_seq: 0 })])
    await Promise.all([3, 11, 7, 2].map((seq) => db.bumpStreamHead('s1', seq)))
    expect((await db.getStream('s1'))?.head_seq).toBe(11)
    await db.close()
  })

  // -- cursors -------------------------------------------------------------------------

  it('cursors: keyed upsert round-trips; getCursor/listCursors', async () => {
    const db = await make()
    const c1: CursorRow = { stream_id: 's1', last_contiguous_seq: 9, oldest_loaded_seq: 2 }
    const c2: CursorRow = { stream_id: 's2', last_contiguous_seq: 4, oldest_loaded_seq: 1 }
    await db.putCursors([c1, c2])
    expect(await db.getCursor('s1')).toStrictEqual(c1)
    expect(await db.getCursor('s_absent')).toBeUndefined()
    await db.putCursors([{ ...c1, last_contiguous_seq: 10 }]) // upsert by stream_id
    expect((await db.getCursor('s1'))?.last_contiguous_seq).toBe(10)
    expect((await db.listCursors()).length).toBe(2)
    await db.close()
  })

  // -- outbox (queue → drain) --------------------------------------------------------------

  it('outbox: rows round-trip byte-identically (hashed body verbatim); queue → settle drains', async () => {
    const db = await make()
    const queued = outboxRow('e1')
    const rejected = outboxRow('e2', {
      created_at: 1_750_000_000_001,
      state: 'rejected',
      error_code: 'permission_denied',
    })
    await db.putOutbox([queued, rejected])
    expect(await db.getOutbox('e1')).toStrictEqual(queued)
    expect(await db.getOutbox('e2')).toStrictEqual(rejected)
    expect(await db.getOutbox('e_absent')).toBeUndefined()
    expect(new Set((await db.listOutbox()).map((r) => r.event_id))).toEqual(new Set(['e1', 'e2']))
    // drain lifecycle: queued → sending (upsert by event_id) → settled (delete)
    await db.putOutbox([{ ...queued, state: 'sending' }])
    expect((await db.getOutbox('e1'))?.state).toBe('sending')
    expect(await db.count('outbox')).toBe(2)
    await db.deleteOutbox('e1')
    expect(await db.getOutbox('e1')).toBeUndefined()
    expect(await db.count('outbox')).toBe(1)
    await db.close()
  })

  // -- read_state + prefs (synced-KV) ---------------------------------------------------------

  it('read_state: putReadState replaces; getReadState/listReadState round-trip', async () => {
    const db = await make()
    await db.putReadState([
      { stream_id: 's1', last_read_seq: 3 },
      { stream_id: 's2', last_read_seq: 8 },
    ])
    expect(await db.getReadState('s1')).toStrictEqual({ stream_id: 's1', last_read_seq: 3 })
    expect(await db.getReadState('s_absent')).toBeUndefined()
    // putReadState is the server-snapshot write — NOT monotonic (it may lower)
    await db.putReadState([{ stream_id: 's2', last_read_seq: 5 }])
    expect((await db.getReadState('s2'))?.last_read_seq).toBe(5)
    expect((await db.listReadState()).length).toBe(2)
    await db.close()
  })

  it('upsertReadStateMonotonic: GREATEST CAS — strictly-higher writes; equal/lower are no-ops', async () => {
    const db = await make()
    expect(await db.upsertReadStateMonotonic('s1', 5)).toBe(true) // insert
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(5)
    expect(await db.upsertReadStateMonotonic('s1', 3)).toBe(false) // lower → no write
    expect(await db.upsertReadStateMonotonic('s1', 5)).toBe(false) // equal → no write
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(5)
    expect(await db.upsertReadStateMonotonic('s1', 9)).toBe(true) // higher → advances
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(9)
    await db.close()
  })

  it('upsertReadStateMonotonic: concurrent CAS bursts converge to the MAX', async () => {
    const db = await make()
    await Promise.all([3, 11, 7, 2].map((seq) => db.upsertReadStateMonotonic('s1', seq)))
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(11)
    await db.close()
  })

  it('prefs: LWW keyed upsert; getPrefs/listPrefs round-trip', async () => {
    const db = await make()
    await db.putPrefs([
      { stream_id: 's1', level: 'mute' },
      { stream_id: 's2', level: 'mentions' },
    ])
    expect(await db.getPrefs('s1')).toStrictEqual({ stream_id: 's1', level: 'mute' })
    expect(await db.getPrefs('s_absent')).toBeUndefined()
    await db.putPrefs([{ stream_id: 's1', level: 'all' }]) // LWW replace
    expect((await db.getPrefs('s1'))?.level).toBe('all')
    expect((await db.listPrefs()).length).toBe(2)
    await db.close()
  })

  // -- wipe scopes + count ------------------------------------------------------------------

  it('count: reports every table after a full seed', async () => {
    const db = await make()
    await seedAllTables(db)
    for (const table of ALL_TABLES) {
      expect(await db.count(table), `count(${table})`).toBe(1)
    }
    await db.close()
  })

  it('clearDerivedTables: wipes ONLY the derived set — events/outbox/read_state/prefs/meta survive', async () => {
    const db = await make()
    await seedAllTables(db)
    await db.clearDerivedTables()
    // derived → dropped
    for (const table of [
      'messages',
      'reactions',
      'thread_participants',
      'files',
      'streams',
      'cursors',
    ] as const) {
      expect(await db.count(table), `count(${table})`).toBe(0)
    }
    // sources + synced-KV + meta → preserved
    for (const table of ['events', 'outbox', 'read_state', 'prefs', 'meta'] as const) {
      expect(await db.count(table), `count(${table})`).toBe(1)
    }
    await db.close()
  })

  it('clearSyncedKv: wipes ONLY read_state + prefs (logout hygiene) — everything else survives', async () => {
    const db = await make()
    await seedAllTables(db)
    await db.clearSyncedKv()
    expect(await db.count('read_state')).toBe(0)
    expect(await db.count('prefs')).toBe(0)
    for (const table of ALL_TABLES.filter((t) => t !== 'read_state' && t !== 'prefs')) {
      expect(await db.count(table), `count(${table})`).toBe(1)
    }
    await db.close()
  })

  // -- checkProjectionVersion (invariant 6 plumbing) ---------------------------------------------

  it('checkProjectionVersion: stale version → drop derived + REPLAY messages from events; sources preserved', async () => {
    const db = await make()
    const events = [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm1', text: 'hello' }),
      unknownTypeEvent('s1', 2), // D9 skip
      messageCreatedEvent({ streamId: 's1', seq: 3, messageId: 'm3', text: 'world' }),
    ]
    await db.putEvents(events)
    await applyEventsToProjection(db, 's1', events)
    await db.putOutbox([outboxRow('o1', { body: { text: 'no message_id → no row' } })])
    await db.putReadState([{ stream_id: 's1', last_read_seq: 7 }])
    await db.putPrefs([{ stream_id: 's1', level: 'mute' }])
    await db.metaPut('projection_version', 0) // stale ⇒ mismatch

    const { rebuilt } = await checkProjectionVersion(db)

    expect(rebuilt).toBe(true)
    // messages were dropped AND replayed from the events cache (not merely cleared)
    expect(await db.count('messages')).toBe(2)
    expect((await db.getMessage('m1'))?.text).toBe('hello')
    // source + synced-KV tables preserved
    expect(await db.count('events')).toBe(3)
    expect(await db.count('outbox')).toBe(1)
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(7)
    expect((await db.getPrefs('s1'))?.level).toBe('mute')
    // version stamped forward
    expect(await db.metaGet<number>('projection_version')).toBe(PROJECTION_VERSION)
    await db.close()
  })

  it('checkProjectionVersion: a matching version is a no-op', async () => {
    const db = await make()
    await seedAllTables(db)
    await db.metaPut('projection_version', PROJECTION_VERSION)
    const { rebuilt } = await checkProjectionVersion(db)
    expect(rebuilt).toBe(false)
    expect(await db.count('messages')).toBe(1)
    await db.close()
  })
})

// ---------------------------------------------------------------------------
// Focused SqliteDb rebuild-equivalence (invariant 6 on the NEW backend): the
// full M3 event mix (creates, edits, deletes, reactions incl. tombstones,
// threads, files, D9 skips) applied INCREMENTALLY must equal a drop + replay
// REBUILD — byte-identical dumps, identical reaction/participant sets — and
// must ALSO equal the same plan applied on MemoryDb (cross-backend equality).
// ---------------------------------------------------------------------------

function m3Plan(): EventRow[] {
  return [
    messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm1', text: 'root 日本語 🎉' }),
    messageCreatedEvent({
      streamId: 's1',
      seq: 2,
      messageId: 'm2',
      text: 'reply',
      threadRootId: 'm1',
      authorUserId: 'u_replier',
      mentions: ['u_x'],
    }),
    reactionAddedEvent({
      streamId: 's1',
      seq: 3,
      messageId: 'm1',
      emoji: '👍',
      authorUserId: 'u_a',
    }),
    reactionAddedEvent({
      streamId: 's1',
      seq: 4,
      messageId: 'm1',
      emoji: '🎉',
      authorUserId: 'u_b',
    }),
    messageEditedEvent({ streamId: 's1', seq: 5, messageId: 'm1', text: 'root (edited)' }),
    reactionRemovedEvent({
      streamId: 's1',
      seq: 6,
      messageId: 'm1',
      emoji: '🎉',
      authorUserId: 'u_b',
    }),
    messageCreatedEvent({ streamId: 's1', seq: 7, messageId: 'm3', text: 'doomed' }),
    messageDeletedEvent({ streamId: 's1', seq: 8, messageId: 'm3' }),
    fileUploadedEvent({ streamId: 's1', seq: 9, fileId: fileId(1) }),
    unknownTypeEvent('s1', 10), // D9 skip
    metaEvent('s1', 11), // D9 skip
  ]
}

/** A stable, comparable snapshot of the derived state. */
async function derivedSnapshot(db: MsgDb): Promise<{
  messages: string
  files: string
  reactions: ReactionRow[]
  participants: { root_message_id: string; user_id: string }[]
}> {
  const key = (r: ReactionRow): string => JSON.stringify([r.message_id, r.author_user_id, r.emoji])
  return {
    messages: await dumpMessages(db),
    files: await dumpFiles(db),
    reactions: (await db.getAllReactions()).sort((a, b) => key(a).localeCompare(key(b))),
    participants: (await db.getAllThreadParticipants()).sort((a, b) =>
      JSON.stringify([a.root_message_id, a.user_id]).localeCompare(
        JSON.stringify([b.root_message_id, b.user_id]),
      ),
    ),
  }
}

describe('SqliteDb rebuild ≡ incremental (invariant 6, ENG-165)', () => {
  it('drop + replay reproduces the incrementally-built projection exactly (and matches MemoryDb)', async () => {
    const events = m3Plan()

    // Incremental on SqliteDb.
    const sqlite = await openSqliteDb(new NodeSqlDriver(':memory:'))
    await sqlite.putEvents(events)
    await applyEventsToProjection(sqlite, 's1', events)
    const incremental = await derivedSnapshot(sqlite)

    // Sanity on the plan itself: edit + delete + tombstone all took effect.
    expect((await sqlite.getMessage('m1'))?.text).toBe('root (edited)')
    expect((await sqlite.getMessage('m3'))?.deleted).toBe(true)
    expect((await sqlite.getMessage('m3'))?.text).toBe('') // redacted on delete
    expect((await sqlite.getReactionsForMessage('m1')).map((r) => r.emoji)).toEqual(['👍'])
    expect((await sqlite.getMessage('m1'))?.reply_count).toBe(1)

    // Rebuild (drop + replay) on the SAME SqliteDb — the checkProjectionVersion path.
    await sqlite.metaPut('projection_version', 0)
    const { rebuilt } = await checkProjectionVersion(sqlite)
    expect(rebuilt).toBe(true)
    expect(await derivedSnapshot(sqlite)).toStrictEqual(incremental)

    // And a manual clear + rebuildProjections lands identically too.
    await sqlite.clearDerivedTables()
    await rebuildProjections(sqlite)
    expect(await derivedSnapshot(sqlite)).toStrictEqual(incremental)

    // Cross-backend: the identical plan on MemoryDb yields the identical state.
    const memory = new MemoryDb()
    await memory.putEvents(events)
    await applyEventsToProjection(memory, 's1', events)
    expect(await derivedSnapshot(memory)).toStrictEqual(incremental)

    await sqlite.close()
    await memory.close()
  })

  it('openSqliteDb accepts a path string (the Node convenience branch) and is re-openable-safe DDL', async () => {
    const db = await openSqliteDb(':memory:')
    expect(db).toBeInstanceOf(SqliteDb)
    expect(db.capabilities.fts).toBe(false)
    await db.putMessages([minimalMessage('m1', 's1', 1)])
    expect((await db.getMessage('m1'))?.text).toBe('text 1')
    await db.close()
  })
})
