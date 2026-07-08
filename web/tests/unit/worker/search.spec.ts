import { describe, expect, it } from 'vitest'

import { WorkerCore } from '../../../src/worker/core'
import { searchMessages } from '../../../src/worker/search'
import { MemoryDb } from '../../../src/worker/db'
import type { FromWorker, SearchHit, SearchResult } from '../../../src/worker/types'

import { collectingSink, FakeHttpClient, FakeSyncServer, inertWsFactory } from './helpers'

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    message_id: 'm_1',
    stream_id: 's_1',
    author_user_id: 'u_1',
    text: 'hello world',
    created_seq: 42,
    rank: 0.9,
    thread_root_id: null,
    ...overrides,
  }
}

describe('searchMessages (ENG-126 HTTP FTS, token worker-side)', () => {
  it('round-trips hits + next_cursor from GET /v1/search', async () => {
    const server = new FakeSyncServer()
    server.searchResult = { hits: [hit(), hit({ message_id: 'm_2' })], next_cursor: 'c_next' }
    const http = new FakeHttpClient(server)

    const res = await searchMessages(http, { q: 'hello' })

    expect(res.hits).toHaveLength(2)
    expect(res.hits[0]?.message_id).toBe('m_1')
    expect(res.next_cursor).toBe('c_next')
  })

  it('normalizes an absent next_cursor to null', async () => {
    const server = new FakeSyncServer()
    server.searchResult = { hits: [], next_cursor: null }
    const http = new FakeHttpClient(server)

    const res = await searchMessages(http, { q: 'nothing' })
    expect(res.next_cursor).toBeNull()
  })

  it('lands every filter in the query string (and only defined ones)', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    await searchMessages(http, {
      q: 'hello world',
      in: 's_9',
      from: 'u_7',
      before: 100,
      after: 5,
      limit: 25,
      cursor: 'c_prev',
    })

    const url = http.getCalls[0] ?? ''
    expect(url.startsWith('/v1/search?')).toBe(true)
    expect(url).toContain('q=hello+world')
    expect(url).toContain('in=s_9')
    expect(url).toContain('from=u_7')
    expect(url).toContain('before=100')
    expect(url).toContain('after=5')
    expect(url).toContain('limit=25')
    expect(url).toContain('cursor=c_prev')
  })

  it('omits undefined filters from the query string', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    await searchMessages(http, { q: 'bare' })

    const url = http.getCalls[0] ?? ''
    expect(url).toBe('/v1/search?q=bare')
    expect(url).not.toContain('in=')
    expect(url).not.toContain('cursor=')
  })

  it('never carries a token/identity field in the search params', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    await searchMessages(http, { q: 'x' })

    const url = http.getCalls[0] ?? ''
    expect(url).not.toMatch(/token|bearer|authorization/i)
  })
})

describe('search RPC (WorkerCore round trip)', () => {
  it('answers the `search` method with hits + next_cursor', async () => {
    const server = new FakeSyncServer()
    server.searchResult = { hits: [hit()], next_cursor: 'c9' }
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 's1',
      clientId: 'c1',
      req: { method: 'search', params: { q: 'hello', in: 's_1' } },
    })

    const res = lastRes(frames, 's1')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as SearchResult
      expect(result.hits[0]?.message_id).toBe('m_1')
      expect(result.next_cursor).toBe('c9')
    }
    // The filter rode the query string, not the RPC params → token never crossed.
    expect(http.getCalls.some((p) => p.includes('/v1/search?') && p.includes('in=s_1'))).toBe(true)
  })
})

function lastRes(frames: Array<{ clientId: string; msg: FromWorker }>, id: string): FromWorker {
  const found = frames.find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!found) throw new Error(`no res frame for id ${id}`)
  return found
}
