// tests/unit/worker/meta.spec.ts — the ENG-104 meta author. Channel create/rename/
// archive, member add/remove, and DM creation each AUTHOR the right workspace-meta
// event worker-side (correct type/payload/homing), POST it to /v1/events/batch,
// assert acceptance, and reconcile via /v1/sync. Rejections surface as coded
// errors. MemoryDb + a fake authed HTTP — no browser, no real network.

import { describe, expect, it, vi } from 'vitest'

import { hashEvent, IdKind, isValidTypedId, newStreamId, newUserId } from '../../../src/core'
import { MemoryDb } from '../../../src/worker/db'
import { MetaAuthor } from '../../../src/worker/meta'
import { META_DEVICE_ID, type AuthStatus, type StreamRow } from '../../../src/worker/types'

import { FakeHttpClient, FakeSyncServer } from './helpers'

const MY_USER = newUserId()
const WS = 'w_00000000000000000000000000'
const META_STREAM = newStreamId()
const AUTH: AuthStatus = { authenticated: true, my_user_id: MY_USER, workspace_id: WS }

function makeAuthor(opts: { authStatus?: () => AuthStatus } = {}): {
  db: MemoryDb
  http: FakeHttpClient
  server: FakeSyncServer
  author: MetaAuthor
  readonly refreshed: number
  readonly changed: number
} {
  const db = new MemoryDb()
  void db.metaPut(META_DEVICE_ID, 'd_me')
  const metaRow: StreamRow = {
    stream_id: META_STREAM,
    kind: 'workspace-meta',
    head_seq: 1,
    member: false,
  }
  void db.putStreams([metaRow])
  const server = new FakeSyncServer()
  server.addStream({ stream_id: META_STREAM, kind: 'workspace-meta' })
  const http = new FakeHttpClient(server)
  const counters = { refreshed: 0, changed: 0 }
  const author = new MetaAuthor({
    db,
    http,
    authStatus: opts.authStatus ?? ((): AuthStatus => AUTH),
    refreshStreams: async () => {
      counters.refreshed++
      await http.get('/v1/sync')
    },
    onStreamsChanged: () => {
      counters.changed++
    },
  })
  return {
    db,
    http,
    server,
    author,
    get refreshed() {
      return counters.refreshed
    },
    get changed() {
      return counters.changed
    },
  }
}

/** The single batch POST body the author just sent. */
function lastBatchBody(http: FakeHttpClient): {
  body: Record<string, unknown>
  event_hash: string
} {
  const post = http.postCalls.filter((p) => p.path.startsWith('/v1/events/batch')).at(-1)
  expect(post).toBeDefined()
  const { events } = post!.body as {
    events: { body: Record<string, unknown>; event_hash: string }[]
  }
  expect(events).toHaveLength(1)
  return events[0]!
}

describe('MetaAuthor.createChannel', () => {
  it('authors a hash-honest public channel.created homed in workspace-meta', async () => {
    const t = makeAuthor()
    const res = await t.author.createChannel({
      m: 'channel.create',
      name: 'general',
      visibility: 'public',
    })

    expect(isValidTypedId(res.stream_id, IdKind.STREAM)).toBe(true)
    const { body, event_hash } = lastBatchBody(t.http)
    expect(body.type).toBe('channel.created')
    expect(body.type_version).toBe(1)
    // Worker-owned identity — never from a tab.
    expect(body.author_user_id).toBe(MY_USER)
    expect(body.author_device_id).toBe('d_me')
    // Public homing: the genesis lands in workspace-meta, NOT the channel's stream.
    expect(body.stream_id).toBe(META_STREAM)
    expect(body.payload).toEqual({
      channel_stream_id: res.stream_id,
      name: 'general',
      visibility: 'public',
    })
    // The hash is honest over the verbatim body (JCS + SHA-256).
    expect(await hashEvent(body as unknown as Parameters<typeof hashEvent>[0])).toBe(event_hash)
    // Reconciled: /v1/sync refresh + a streams-changed signal.
    expect(t.refreshed).toBe(1)
    expect(t.changed).toBe(1)
  })

  it('self-homes a private channel.created in its own stream', async () => {
    const t = makeAuthor()
    const res = await t.author.createChannel({
      m: 'channel.create',
      name: 'secret',
      visibility: 'private',
    })
    const { body } = lastBatchBody(t.http)
    expect(body.type).toBe('channel.created')
    expect(body.stream_id).toBe(res.stream_id) // self-homed
    expect((body.payload as { visibility: string }).visibility).toBe('private')
  })
})

describe('MetaAuthor.createDm', () => {
  it('authors a dm.created self-homed with the author included as a participant', async () => {
    const t = makeAuthor()
    const other = newUserId()
    const res = await t.author.createDm({ m: 'dm.create', user_ids: [other] })

    const { body, event_hash } = lastBatchBody(t.http)
    expect(body.type).toBe('dm.created')
    // Self-homed in the DM's own stream (never workspace-meta — no roster leak).
    expect(body.stream_id).toBe(res.stream_id)
    const payload = body.payload as { dm_stream_id: string; member_user_ids: string[] }
    expect(payload.dm_stream_id).toBe(res.stream_id)
    // The author is ALWAYS a participant (server requires it).
    expect(payload.member_user_ids).toContain(MY_USER)
    expect(payload.member_user_ids).toContain(other)
    expect(await hashEvent(body as unknown as Parameters<typeof hashEvent>[0])).toBe(event_hash)
    expect(t.refreshed).toBe(1)
  })

  it('deduplicates the author out of the participant list', async () => {
    const t = makeAuthor()
    const res = await t.author.createDm({ m: 'dm.create', user_ids: [MY_USER] })
    const { body } = lastBatchBody(t.http)
    const payload = body.payload as { member_user_ids: string[] }
    expect(payload.member_user_ids).toEqual([MY_USER])
    expect(isValidTypedId(res.stream_id, IdKind.STREAM)).toBe(true)
  })
})

describe('MetaAuthor rename / archive / members', () => {
  async function seedPrivateChannel(t: ReturnType<typeof makeAuthor>): Promise<string> {
    const { stream_id } = await t.author.createChannel({
      m: 'channel.create',
      name: 'proj',
      visibility: 'private',
    })
    // Mirror the reducer: the channel now exists in the local streams projection.
    await t.db.putStreams([
      {
        stream_id,
        kind: 'channel',
        name: 'proj',
        visibility: 'private',
        head_seq: 1,
        member: true,
      },
    ])
    return stream_id
  }

  it('rename self-homes a private channel.renamed and carries the new name', async () => {
    const t = makeAuthor()
    const streamId = await seedPrivateChannel(t)
    await t.author.renameChannel({ m: 'channel.rename', stream_id: streamId, name: 'renamed' })
    const { body } = lastBatchBody(t.http)
    expect(body.type).toBe('channel.renamed')
    expect(body.stream_id).toBe(streamId) // private → self-homed
    expect(body.payload).toEqual({ channel_stream_id: streamId, name: 'renamed' })
  })

  it('archive authors channel.archived', async () => {
    const t = makeAuthor()
    const streamId = await seedPrivateChannel(t)
    await t.author.archiveChannel({ m: 'channel.archive', stream_id: streamId })
    const { body } = lastBatchBody(t.http)
    expect(body.type).toBe('channel.archived')
    expect(body.payload).toEqual({ channel_stream_id: streamId })
  })

  it('member add/remove author the membership events', async () => {
    const t = makeAuthor()
    const streamId = await seedPrivateChannel(t)
    const user = newUserId()
    await t.author.addMember({ m: 'channel.addMember', stream_id: streamId, user_id: user })
    expect(lastBatchBody(t.http).body.type).toBe('channel.member_added')
    await t.author.removeMember({ m: 'channel.removeMember', stream_id: streamId, user_id: user })
    const { body } = lastBatchBody(t.http)
    expect(body.type).toBe('channel.member_removed')
    expect(body.payload).toEqual({ channel_stream_id: streamId, user_id: user })
  })

  it('a public channel lifecycle event homes in workspace-meta', async () => {
    const t = makeAuthor()
    const { stream_id } = await t.author.createChannel({
      m: 'channel.create',
      name: 'pub',
      visibility: 'public',
    })
    await t.db.putStreams([
      { stream_id, kind: 'channel', name: 'pub', visibility: 'public', head_seq: 1, member: true },
    ])
    await t.author.renameChannel({ m: 'channel.rename', stream_id, name: 'pub2' })
    const { body } = lastBatchBody(t.http)
    expect(body.stream_id).toBe(META_STREAM) // public → homed in workspace-meta
  })
})

describe('MetaAuthor failure surfaces', () => {
  it('throws not_authenticated with no session (identity never leaks from a tab)', async () => {
    const t = makeAuthor({ authStatus: (): AuthStatus => ({ authenticated: false }) })
    await expect(
      t.author.createChannel({ m: 'channel.create', name: 'x', visibility: 'public' }),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
  })

  it('surfaces a server rejection as a coded error', async () => {
    const t = makeAuthor()
    const spy = vi.spyOn(t.server, 'processBatch').mockReturnValue({
      accepted: [],
      rejected: [{ event_id: 'e', code: 'permission_denied' }],
    })
    await expect(
      t.author.createChannel({ m: 'channel.create', name: 'x', visibility: 'public' }),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    spy.mockRestore()
  })
})
