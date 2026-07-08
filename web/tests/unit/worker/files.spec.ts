// tests/unit/worker/files.spec.ts — the ENG-119 FileManager suite. The upload
// state machine (hash → initiate → PUT → file.uploaded + message.created, in one
// ordered batch), server-side dedup, idempotent retry-on-blip, hard-failure +
// explicit retry, the download LRU, and the token boundary. MemoryDb + a real
// Outbox + a fake Files-API server — no browser, no real network, no token.

import { describe, expect, it } from 'vitest'

import { sha256Hex } from '../../../src/core'
import { FileManager } from '../../../src/worker/files'
import { MemoryDb } from '../../../src/worker/db'
import { Outbox } from '../../../src/worker/outbox'
import { META_DEVICE_ID, type AuthStatus, type UploadProgress } from '../../../src/worker/types'

import { FakeClock, FakeHttpClient, FakeSyncServer, flush, until } from './helpers'

const AUTH: AuthStatus = { authenticated: true, my_user_id: 'u_me', workspace_id: 'w_me' }

function makeFiles(opts: { authStatus?: () => AuthStatus } = {}): {
  db: MemoryDb
  server: FakeSyncServer
  http: FakeHttpClient
  outbox: Outbox
  manager: FileManager
  frames: UploadProgress[]
  clock: FakeClock
} {
  const db = new MemoryDb()
  void db.metaPut(META_DEVICE_ID, 'd_me')
  const server = new FakeSyncServer()
  const http = new FakeHttpClient(server)
  const clock = new FakeClock()
  const authStatus = opts.authStatus ?? ((): AuthStatus => AUTH)
  const outbox = new Outbox({ db, http, authStatus, publishStream: () => {} })
  const frames: UploadProgress[] = []
  const manager = new FileManager({
    http,
    outbox,
    authStatus,
    publishUpload: (_id, progress) => frames.push(progress),
    setTimeout: clock.setTimeout,
    random: () => 0, // deterministic backoff (delay = base/2)
  })
  return { db, server, http, outbox, manager, frames, clock }
}

/**
 * A small text `File`. The vitest env is jsdom, whose `File` lacks `arrayBuffer()`
 * (a real browser worker's `File` has it) — so we polyfill it deterministically over
 * the same bytes, keeping the FileManager's hash reproducible across a retry.
 */
function makeFile(text = 'the file bytes', name = 'note.txt', type = 'text/plain'): File {
  const bytes = new TextEncoder().encode(text)
  const file = new File([bytes], name, { type })
  if (typeof file.arrayBuffer !== 'function') {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(buffer) })
  }
  return file
}

const batchBody = (http: FakeHttpClient): { events: { body: { type: string } }[] } | undefined => {
  const call = http.postCalls.find((p) => p.path.startsWith('/v1/events/batch'))
  return call?.body as { events: { body: { type: string } }[] } | undefined
}

const phases = (frames: UploadProgress[]): string[] => frames.map((f) => f.phase)

describe('FileManager upload — end-to-end (hash → initiate → PUT → emit, ordered batch)', () => {
  it('walks the phases and enqueues file.uploaded THEN message.created in one batch', async () => {
    const { db, server, http, manager, frames } = makeFiles()
    server.pauseBatch() // hold the drain so the pending state is observable

    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile(), text: 'hi' })
    await until(() => frames.some((f) => f.phase === 'done'))

    // The phase machine ran in order, uploading included (no dedup).
    expect(phases(frames)).toEqual(['hashing', 'initiating', 'uploading', 'emitting', 'done'])

    // Exactly one initiate + one PUT to the file's own blob path.
    expect(http.postCalls.filter((p) => p.path === '/v1/files/initiate')).toHaveLength(1)
    expect(http.putBlobCalls).toHaveLength(1)
    const fileId = frames.find((f) => f.file_id)?.file_id
    expect(fileId).toBeDefined()
    expect(http.putBlobCalls[0]?.path).toBe(`/v1/files/${fileId}/blob`)

    // The outbox holds BOTH events; the batch body is file.uploaded THEN message.created.
    const outbox = await db.listOutbox()
    expect(outbox.map((r) => (r.body as { type: string }).type).sort()).toEqual([
      'file.uploaded',
      'message.created',
    ])
    expect(batchBody(http)?.events.map((e) => e.body.type)).toEqual([
      'file.uploaded',
      'message.created',
    ])

    // The optimistic (pending) message row appears meanwhile.
    const pending = await db.getAllMessages()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.state).toBe('pending')

    // Resume: both settle, the outbox drains, the message row is no longer pending.
    server.resumeBatch()
    await flush()
    expect(await db.listOutbox()).toHaveLength(0)
    const settled = await db.getAllMessages()
    expect(settled[0]?.state).toBeUndefined()
  })
})

describe('FileManager upload — server-side dedup (upload_needed:false)', () => {
  it('skips the PUT entirely but still emits both events', async () => {
    const { http, server, db, manager, frames } = makeFiles()
    // Pre-mark the content present so initiate reports the blob is already there.
    const sha = await sha256Hex(await makeFile().arrayBuffer())
    server.markShaPresent(sha)

    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile(), text: 'hi' })
    await until(() => frames.some((f) => f.phase === 'done'))

    // uploading is SKIPPED — no PUT — yet both events are emitted and settle.
    expect(phases(frames)).toEqual(['hashing', 'initiating', 'emitting', 'done'])
    expect(http.putBlobCalls).toHaveLength(0)
    await flush()
    expect(batchBody(http)?.events.map((e) => e.body.type)).toEqual([
      'file.uploaded',
      'message.created',
    ])
    expect(await db.getAllMessages()).toHaveLength(1)
  })
})

describe('FileManager upload — idempotent retry on a transient blip', () => {
  it('re-PUTs the SAME file_id after a network blip; one file, no duplicate events', async () => {
    const { http, manager, frames, clock, db } = makeFiles()
    http.failNextPutBlob() // the first PUT fails with a network error (transient)

    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile() })
    await until(() => http.putBlobCalls.length === 1) // first PUT attempted + blipped
    expect(frames.some((f) => f.phase === 'done')).toBe(false)

    clock.advance(1_000) // fire the backoff retry timer
    await until(() => frames.some((f) => f.phase === 'done'))

    // Exactly one initiate (one file row), two PUTs to the SAME blob path.
    expect(http.postCalls.filter((p) => p.path === '/v1/files/initiate')).toHaveLength(1)
    expect(http.putBlobCalls).toHaveLength(2)
    expect(http.putBlobCalls[0]?.path).toBe(http.putBlobCalls[1]?.path)

    // No duplicate events — exactly one file.uploaded + one message.created.
    await flush()
    const batchTypes = batchBody(http)?.events.map((e) => e.body.type) ?? []
    expect(batchTypes).toEqual(['file.uploaded', 'message.created'])
    expect(await db.getAllMessages()).toHaveLength(1)
  })
})

describe('FileManager upload — hard failure + explicit retry', () => {
  it('parks failed{code} on a 413, then file.retry restarts the job to done', async () => {
    const { http, server, manager, frames } = makeFiles()
    server.nextInitiateError = { status: 413, code: 'file-too-large', title: 'Too large' }

    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile() })
    await until(() => frames.some((f) => f.phase === 'failed'))

    const failed = frames.find((f) => f.phase === 'failed')
    expect(failed?.code).toBe('file-too-large')
    expect(http.putBlobCalls).toHaveLength(0) // never reached the PUT

    // Retry: the initiate error was consumed, so the restart runs clean to done.
    void manager.retry('up1')
    await until(() => frames.filter((f) => f.phase === 'done').length === 1)
    expect(frames.some((f) => f.phase === 'done')).toBe(true)
  })
})

describe('FileManager download — worker-side LRU', () => {
  it('serves a repeated fetch from the cache (getBlob hit once)', async () => {
    const { http, manager, frames } = makeFiles()
    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile() })
    await until(() => frames.some((f) => f.phase === 'done'))
    await flush()
    const fileId = frames.find((f) => f.file_id)?.file_id ?? ''

    const first = await manager.fetch({ file_id: fileId, variant: 'blob' })
    const second = await manager.fetch({ file_id: fileId, variant: 'blob' })

    expect(first.blob).toBeInstanceOf(Blob)
    expect(second.blob).toBe(first.blob) // same cached instance
    expect(http.getBlobCalls).toHaveLength(1) // second served from the LRU
  })

  it('returns a null blob (uncached) for a 404', async () => {
    const { manager, http } = makeFiles()

    const res = await manager.fetch({ file_id: 'f_missing0000000000000000000', variant: 'blob' })

    expect(res.blob).toBeNull()
    // A miss is not cached: a second fetch re-hits the server.
    await manager.fetch({ file_id: 'f_missing0000000000000000000', variant: 'blob' })
    expect(http.getBlobCalls).toHaveLength(2)
  })
})

describe('FileManager — token boundary', () => {
  it('never surfaces a token in a progress frame or a fetch result', async () => {
    const { manager, frames, http } = makeFiles()
    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile() })
    await until(() => frames.some((f) => f.phase === 'done'))
    await flush()
    const fileId = frames.find((f) => f.file_id)?.file_id ?? ''
    const fetched = await manager.fetch({ file_id: fileId, variant: 'blob' })

    // Progress frames carry only clone-safe upload state — never a token.
    const serialized = JSON.stringify(frames)
    expect(serialized.toLowerCase()).not.toContain('bearer')
    expect(serialized.toLowerCase()).not.toContain('token')
    const allowed = new Set(['upload_id', 'phase', 'file_id', 'message_id', 'event_id', 'code'])
    for (const frame of frames) {
      for (const key of Object.keys(frame)) expect(allowed.has(key)).toBe(true)
    }
    // The fetch result is only opaque bytes + a mime type.
    expect(Object.keys(fetched).sort()).toEqual(['blob', 'mime_type'])
    // The bearer never crossed the RPC surface — it lives only behind the http client.
    expect(JSON.stringify(http.getBlobCalls)).not.toContain('Bearer')
  })
})
