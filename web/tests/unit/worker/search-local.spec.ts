// tests/unit/worker/search-local.spec.ts — local FTS5 message search
// (ENG-166, M6-2) over SqliteDb + the Node better-sqlite3 driver.
//
// Covers: the MATCH grammar compile (quoted units, implicit AND, phrase,
// operator neutralization), the `in`/`from`/`before`/`after` WHERE filters,
// bm25 ranking + created_seq DESC tie-break, the integer-offset cursor,
// index maintenance through putMessages/deleteMessage (create/edit/delete/
// tombstone), the rebuild-index-equivalence check (invariant 6 for search:
// a projection rebuild reconstructs the FTS index so results are identical),
// SearchResult shape parity with the HTTP `searchMessages`, and the
// capability routing in WorkerCore (SqliteDb local, Dexie/Memory HTTP —
// the web path unchanged).

import { describe, expect, it } from 'vitest'

import { WorkerCore } from '../../../src/worker/core'
import { checkProjectionVersion, MemoryDb, rebuildProjections } from '../../../src/worker/db'
import { applyEventsToProjection } from '../../../src/worker/projection'
import { buildFtsMatch, searchLocalMessages, searchMessages } from '../../../src/worker/search'
import { NodeSqlDriver } from '../../../src/worker/sqlite/node-driver'
import { openSqliteDb, type SqliteDb } from '../../../src/worker/sqlite/sqlite-db'
import type { FromWorker, MessageRow, SearchResult } from '../../../src/worker/types'

import { collectingSink, FakeHttpClient, FakeSyncServer, inertWsFactory } from './helpers'
import { messageCreatedEvent, messageDeletedEvent, messageEditedEvent } from './projfixtures'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(opts: {
  id: string
  seq: number
  text: string
  stream?: string
  author?: string
  deleted?: boolean
  state?: 'pending' | 'failed'
  threadRootId?: string
}): MessageRow {
  return {
    message_id: opts.id,
    stream_id: opts.stream ?? 's_1',
    created_seq: opts.seq,
    author_user_id: opts.author ?? 'u_1',
    text: opts.text,
    format: 'markdown',
    mention_user_ids: [],
    file_ids: [],
    ...(opts.threadRootId !== undefined ? { thread_root_id: opts.threadRootId } : {}),
    ...(opts.deleted !== undefined ? { deleted: opts.deleted } : {}),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
  }
}

async function makeDb(rows: readonly MessageRow[] = []): Promise<SqliteDb> {
  const db = await openSqliteDb(new NodeSqlDriver(':memory:'))
  if (rows.length > 0) await db.putMessages([...rows])
  return db
}

function ids(res: SearchResult): string[] {
  return res.hits.map((h) => h.message_id)
}

function lastRes(frames: Array<{ clientId: string; msg: FromWorker }>, id: string): FromWorker {
  const found = frames.find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!found) throw new Error(`no res frame for id ${id}`)
  return found
}

// ---------------------------------------------------------------------------
// buildFtsMatch — the sanitized MATCH grammar compile
// ---------------------------------------------------------------------------

describe('buildFtsMatch (ENG-166 FTS5 query compile)', () => {
  it('quotes a single term', () => {
    expect(buildFtsMatch('zebra')).toBe('"zebra"')
  })

  it('joins multiple terms with a space (implicit AND)', () => {
    expect(buildFtsMatch('alpha beta')).toBe('"alpha" "beta"')
  })

  it('keeps a double-quoted phrase as ONE unit', () => {
    expect(buildFtsMatch('alpha "big dog"')).toBe('"alpha" "big dog"')
  })

  it('neutralizes FTS operators/keywords into literal quoted units', () => {
    expect(buildFtsMatch('a OR b')).toBe('"a" "OR" "b"')
    expect(buildFtsMatch('NEAR(a b)')).toBe('"NEAR(a" "b)"')
    expect(buildFtsMatch('text:alpha')).toBe('"text:alpha"')
  })

  it('doubles embedded quotes (an unbalanced quote cannot escape the string)', () => {
    expect(buildFtsMatch('wild"card')).toBe('"wild""card"')
  })

  it('drops punctuation-only units and returns "" when nothing queryable remains', () => {
    expect(buildFtsMatch('foo !!!')).toBe('"foo"')
    expect(buildFtsMatch('***')).toBe('')
    expect(buildFtsMatch('   ')).toBe('')
    expect(buildFtsMatch('""')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// searchLocalMessages — grammar over real FTS5
// ---------------------------------------------------------------------------

describe('searchLocalMessages — query grammar (SqliteDb + FTS5)', () => {
  it('finds a message by a single term and returns the full SearchHit shape', async () => {
    const db = await makeDb([
      msg({ id: 'm1', seq: 1, text: 'the zebra crossed the road', threadRootId: 'm0' }),
      msg({ id: 'm2', seq: 2, text: 'nothing to see here' }),
    ])
    const res = await searchLocalMessages(db, { q: 'zebra' })
    expect(ids(res)).toEqual(['m1'])
    expect(res.hits[0]).toMatchObject({
      message_id: 'm1',
      stream_id: 's_1',
      author_user_id: 'u_1',
      text: 'the zebra crossed the road',
      created_seq: 1,
      thread_root_id: 'm0',
    })
    expect(typeof res.hits[0]?.rank).toBe('number')
    expect(res.next_cursor).toBeNull()
    await db.close()
  })

  it('multi-term is an implicit AND (all terms must match)', async () => {
    const db = await makeDb([
      msg({ id: 'm1', seq: 1, text: 'red apple pie' }),
      msg({ id: 'm2', seq: 2, text: 'red car' }),
      msg({ id: 'm3', seq: 3, text: 'green apple' }),
    ])
    expect(ids(await searchLocalMessages(db, { q: 'red apple' }))).toEqual(['m1'])
    await db.close()
  })

  it('a quoted phrase matches adjacency, not just co-occurrence', async () => {
    const db = await makeDb([
      msg({ id: 'm1', seq: 1, text: 'the big bad dog barked' }),
      msg({ id: 'm2', seq: 2, text: 'bad day for the big dog' }),
    ])
    expect(ids(await searchLocalMessages(db, { q: '"bad dog"' }))).toEqual(['m1'])
    await db.close()
  })

  it('neutralizes FTS operators: `OR` is a literal token, never a union', async () => {
    const db = await makeDb([
      msg({ id: 'm1', seq: 1, text: 'zebra or lion' }),
      msg({ id: 'm2', seq: 2, text: 'zebra lion' }),
      msg({ id: 'm3', seq: 3, text: 'lion alone' }),
    ])
    // Operator semantics would return m1+m2+m3; literal AND semantics: m1 only.
    expect(ids(await searchLocalMessages(db, { q: 'zebra OR lion' }))).toEqual(['m1'])
    await db.close()
  })

  it('hostile operator/quote input never crashes (no injection surface)', async () => {
    const db = await makeDb([msg({ id: 'm1', seq: 1, text: 'plain text' })])
    const hostile = [
      'text*',
      '"unbalanced',
      'a AND (b',
      'NEAR(a b, 5)',
      'col : value ^ 2',
      '-negated',
      'x "" y',
      '"" OR ""',
    ]
    for (const q of hostile) {
      const res = await searchLocalMessages(db, { q })
      expect(Array.isArray(res.hits)).toBe(true)
    }
    await db.close()
  })

  it('whitespace-only and punctuation-only q return an empty page (never an error)', async () => {
    const db = await makeDb([msg({ id: 'm1', seq: 1, text: 'anything' })])
    expect(await searchLocalMessages(db, { q: '   ' })).toEqual({ hits: [], next_cursor: null })
    expect(await searchLocalMessages(db, { q: '!!! ???' })).toEqual({ hits: [], next_cursor: null })
    await db.close()
  })
})

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('searchLocalMessages — filters', () => {
  const rows = [
    msg({ id: 'm1', seq: 10, text: 'quarterly report draft', stream: 's_a', author: 'u_1' }),
    msg({ id: 'm2', seq: 20, text: 'quarterly report final', stream: 's_a', author: 'u_2' }),
    msg({ id: 'm3', seq: 30, text: 'quarterly numbers report', stream: 's_b', author: 'u_1' }),
  ]

  it('`in` scopes to one stream', async () => {
    const db = await makeDb(rows)
    expect(ids(await searchLocalMessages(db, { q: 'report', in: 's_b' }))).toEqual(['m3'])
    await db.close()
  })

  it('`from` scopes to one author', async () => {
    const db = await makeDb(rows)
    const res = await searchLocalMessages(db, { q: 'report', from: 'u_1' })
    expect(ids(res).sort()).toEqual(['m1', 'm3'])
    await db.close()
  })

  it('`before`/`after` bound created_seq STRICTLY (mirrors the server)', async () => {
    const db = await makeDb(rows)
    expect(ids(await searchLocalMessages(db, { q: 'report', before: 30 })).sort()).toEqual([
      'm1',
      'm2',
    ])
    expect(ids(await searchLocalMessages(db, { q: 'report', after: 10 })).sort()).toEqual([
      'm2',
      'm3',
    ])
    // Strict bounds: seq 20 excluded by both before:20 and after:20.
    expect(ids(await searchLocalMessages(db, { q: 'report', before: 20, after: 20 }))).toEqual([])
    await db.close()
  })

  it('filters compose (in + from + bounds)', async () => {
    const db = await makeDb(rows)
    const res = await searchLocalMessages(db, { q: 'report', in: 's_a', from: 'u_2', after: 10 })
    expect(ids(res)).toEqual(['m2'])
    await db.close()
  })
})

// ---------------------------------------------------------------------------
// Ranking + pagination
// ---------------------------------------------------------------------------

describe('searchLocalMessages — ranking and pagination', () => {
  it('ranks by bm25 (a denser/shorter match outranks a diluted one)', async () => {
    const db = await makeDb([
      // m_lo: one hit among many tokens; m_hi: the term IS the message.
      msg({
        id: 'm_lo',
        seq: 99,
        text: 'quux among many many other completely unrelated filler words here',
      }),
      msg({ id: 'm_hi', seq: 1, text: 'quux' }),
    ])
    const res = await searchLocalMessages(db, { q: 'quux' })
    expect(ids(res)).toEqual(['m_hi', 'm_lo'])
    const [first, second] = res.hits
    expect(first !== undefined && second !== undefined && first.rank > second.rank).toBe(true)
    await db.close()
  })

  it('breaks bm25 ties by created_seq DESC (newest first)', async () => {
    const db = await makeDb([
      msg({ id: 'm_old', seq: 5, text: 'identical tie text' }),
      msg({ id: 'm_new', seq: 9, text: 'identical tie text' }),
    ])
    expect(ids(await searchLocalMessages(db, { q: 'tie' }))).toEqual(['m_new', 'm_old'])
    await db.close()
  })

  it('paginates with the integer cursor: disjoint, complete, order-preserving pages', async () => {
    const db = await makeDb(
      [1, 2, 3, 4, 5].map((n) => msg({ id: `m${n}`, seq: n, text: `pager item ${n}` })),
    )
    const all = await searchLocalMessages(db, { q: 'pager', limit: 50 })
    expect(all.hits).toHaveLength(5)
    expect(all.next_cursor).toBeNull()

    const p1 = await searchLocalMessages(db, { q: 'pager', limit: 2 })
    expect(p1.hits).toHaveLength(2)
    expect(p1.next_cursor).toBe('2')
    const p2 = await searchLocalMessages(db, { q: 'pager', limit: 2, cursor: '2' })
    expect(p2.hits).toHaveLength(2)
    expect(p2.next_cursor).toBe('4')
    const p3 = await searchLocalMessages(db, { q: 'pager', limit: 2, cursor: '4' })
    expect(p3.hits).toHaveLength(1)
    expect(p3.next_cursor).toBeNull()

    // The paged walk reproduces the single-page order exactly.
    expect([...ids(p1), ...ids(p2), ...ids(p3)]).toEqual(ids(all))
    await db.close()
  })

  it('rejects a malformed cursor with the same invalid-cursor code the server uses', async () => {
    const db = await makeDb([msg({ id: 'm1', seq: 1, text: 'anything' })])
    await expect(searchLocalMessages(db, { q: 'anything', cursor: 'nope' })).rejects.toMatchObject({
      code: 'invalid-cursor',
    })
    await expect(searchLocalMessages(db, { q: 'anything', cursor: '-1' })).rejects.toMatchObject({
      code: 'invalid-cursor',
    })
    await db.close()
  })

  it('clamps limit into the server contract [1, 50]', async () => {
    const db = await makeDb([
      msg({ id: 'm1', seq: 1, text: 'clamp me' }),
      msg({ id: 'm2', seq: 2, text: 'clamp me too' }),
    ])
    const res = await searchLocalMessages(db, { q: 'clamp', limit: 0 })
    expect(res.hits).toHaveLength(1) // 0 → MIN_LIMIT (1)
    expect(res.next_cursor).toBe('1')
    await db.close()
  })
})

// ---------------------------------------------------------------------------
// Index maintenance — putMessages / deleteMessage / tombstones / rebuild
// ---------------------------------------------------------------------------

describe('messages_fts maintenance (put/delete/rebuild)', () => {
  it('putMessages makes a message findable; an edit re-indexes (old text stops matching)', async () => {
    const db = await makeDb()
    await db.putMessages([msg({ id: 'm1', seq: 1, text: 'original wording' })])
    expect(ids(await searchLocalMessages(db, { q: 'original' }))).toEqual(['m1'])

    // The edit path re-puts the same message_id with new text (projection.ts).
    await db.putMessages([msg({ id: 'm1', seq: 1, text: 'revised wording' })])
    expect(ids(await searchLocalMessages(db, { q: 'original' }))).toEqual([])
    expect(ids(await searchLocalMessages(db, { q: 'revised' }))).toEqual(['m1'])
    // Exactly one hit — the re-index never leaves a stale duplicate behind.
    expect((await searchLocalMessages(db, { q: 'wording' })).hits).toHaveLength(1)
    await db.close()
  })

  it('deleteMessage removes the message from results', async () => {
    const db = await makeDb([msg({ id: 'm1', seq: 1, text: 'ephemeral pending row' })])
    await db.deleteMessage('m1')
    expect(ids(await searchLocalMessages(db, { q: 'ephemeral' }))).toEqual([])
    await db.close()
  })

  it('a tombstoned message (deleted:true, text redacted) never surfaces', async () => {
    const db = await makeDb([msg({ id: 'm1', seq: 1, text: 'secret plans' })])
    // The message.deleted fold re-puts the row redacted (projection.ts).
    await db.putMessages([msg({ id: 'm1', seq: 1, text: '', deleted: true })])
    expect(ids(await searchLocalMessages(db, { q: 'secret' }))).toEqual([])
    await db.close()
  })

  it('a pending optimistic row is excluded (the server FTS could never return one)', async () => {
    const db = await makeDb([
      msg({ id: 'm1', seq: 1, text: 'settled findable' }),
      msg({ id: 'm2', seq: 1767225600000, text: 'findable but pending', state: 'pending' }),
    ])
    expect(ids(await searchLocalMessages(db, { q: 'findable' }))).toEqual(['m1'])
    await db.close()
  })

  it('rebuildProjections reconstructs the FTS index — search results identical before/after (invariant 6 for search)', async () => {
    const db = await makeDb()
    const events = [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm1', text: 'zebra crossing' }),
      messageCreatedEvent({ streamId: 's1', seq: 2, messageId: 'm2', text: 'zebra herd photo' }),
      messageEditedEvent({ streamId: 's1', seq: 3, messageId: 'm2', text: 'lion herd photo' }),
      messageCreatedEvent({ streamId: 's1', seq: 4, messageId: 'm3', text: 'gazelle sighting' }),
      messageDeletedEvent({ streamId: 's1', seq: 5, messageId: 'm3' }),
    ]
    await db.putEvents(events)
    await applyEventsToProjection(db, 's1', events)

    const snapshot = async (): Promise<Record<string, SearchResult>> => ({
      zebra: await searchLocalMessages(db, { q: 'zebra' }),
      lion: await searchLocalMessages(db, { q: 'lion' }),
      gazelle: await searchLocalMessages(db, { q: 'gazelle' }),
      herd: await searchLocalMessages(db, { q: 'herd photo' }),
    })
    const incremental = await snapshot()
    // Sanity on the incremental state itself: edit re-indexed, delete removed.
    expect(ids(incremental['zebra'] as SearchResult)).toEqual(['m1'])
    expect(ids(incremental['lion'] as SearchResult)).toEqual(['m2'])
    expect(ids(incremental['gazelle'] as SearchResult)).toEqual([])

    // The checkProjectionVersion drop-and-replay path.
    await db.metaPut('projection_version', 0)
    const { rebuilt } = await checkProjectionVersion(db)
    expect(rebuilt).toBe(true)
    expect(await snapshot()).toStrictEqual(incremental)

    // And an explicit clear + rebuild: the clear also empties the FTS index...
    await db.clearDerivedTables()
    expect(ids(await searchLocalMessages(db, { q: 'zebra' }))).toEqual([])
    // ...and the rebuild reconstructs it to the identical search state.
    await rebuildProjections(db)
    expect(await snapshot()).toStrictEqual(incremental)
    await db.close()
  })
})

// ---------------------------------------------------------------------------
// Shape parity with the HTTP path + capability routing
// ---------------------------------------------------------------------------

describe('parity and routing (local FTS vs HTTP search)', () => {
  it('searchLocalMessages returns the identical SearchResult/SearchHit shape as searchMessages', async () => {
    const server = new FakeSyncServer()
    server.searchResult = {
      hits: [
        {
          message_id: 'm_1',
          stream_id: 's_1',
          author_user_id: 'u_1',
          text: 'hello world',
          created_seq: 42,
          rank: 0.9,
          thread_root_id: null,
        },
      ],
      next_cursor: null,
    }
    const httpRes = await searchMessages(new FakeHttpClient(server), { q: 'hello' })

    const db = await makeDb([msg({ id: 'm_1', seq: 42, text: 'hello world' })])
    const localRes = await searchLocalMessages(db, { q: 'hello' })

    expect(Object.keys(localRes).sort()).toEqual(Object.keys(httpRes).sort())
    const localHit = localRes.hits[0]
    const httpHit = httpRes.hits[0]
    expect(localHit).toBeDefined()
    expect(httpHit).toBeDefined()
    expect(Object.keys(localHit as object).sort()).toEqual(Object.keys(httpHit as object).sort())
    // Field-for-field equal except rank (backend-specific score, number both ways).
    expect(localHit).toMatchObject({
      message_id: 'm_1',
      stream_id: 's_1',
      author_user_id: 'u_1',
      text: 'hello world',
      created_seq: 42,
      thread_root_id: null,
    })
    expect(typeof localHit?.rank).toBe('number')
    await db.close()
  })

  it('WorkerCore routes `search` to the LOCAL index on an fts-capable db (no HTTP)', async () => {
    const db = await makeDb()
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink, { http, wsFactory: inertWsFactory })
    await core.init()
    // Seed AFTER init — checkProjectionVersion rebuilds (wipes derived) on a
    // fresh db, exactly as it will in production before any messages sync.
    await db.putMessages([msg({ id: 'm_local', seq: 7, text: 'desktop local search' })])

    await core.handle('c1', {
      t: 'req',
      id: 's1',
      clientId: 'c1',
      req: { method: 'search', params: { q: 'desktop', in: 's_1' } },
    })

    const res = lastRes(frames, 's1')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as SearchResult
      expect(result.hits[0]?.message_id).toBe('m_local')
      expect(result.next_cursor).toBeNull()
    }
    // The crux: nothing hit the network — /v1/search was never called.
    expect(http.getCalls.some((p) => p.includes('/v1/search'))).toBe(false)
    await core.handle('c1', { t: 'bye', clientId: 'c1' })
    await db.close()
  })

  it('REGRESSION: a non-fts db (MemoryDb, the web path) still routes `search` to HTTP', async () => {
    const server = new FakeSyncServer()
    server.searchResult = {
      hits: [
        {
          message_id: 'm_http',
          stream_id: 's_1',
          author_user_id: 'u_1',
          text: 'served by the server',
          created_seq: 1,
          rank: 0.5,
          thread_root_id: null,
        },
      ],
      next_cursor: 'c9',
    }
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 's1',
      clientId: 'c1',
      req: { method: 'search', params: { q: 'anything', in: 's_1' } },
    })

    const res = lastRes(frames, 's1')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as SearchResult
      expect(result.hits[0]?.message_id).toBe('m_http')
      expect(result.next_cursor).toBe('c9')
    }
    // Unchanged web behavior: the filter rode the /v1/search query string.
    expect(http.getCalls.some((p) => p.includes('/v1/search?') && p.includes('in=s_1'))).toBe(true)
  })
})
