// tests/unit/worker/files.spec.ts — the ENG-119 FileManager suite, updated for the
// ENG-121 DECOUPLE (Option A): an upload homes+PUTs the blob and enqueues ONLY the
// durable `file.uploaded` record — NO `message.created` (the composer authors that
// once, on Send, via outbox.send). Covers the upload state machine (hash → initiate
// → PUT → emit file.uploaded → done), server-side dedup, idempotent retry-on-blip,
// hard-failure + explicit retry, the download LRU, and the token boundary. MemoryDb
// + a real Outbox + a fake Files-API server — no browser, no real network, no token.

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { sha256Hex } from '../../../src/core'
import { FileManager } from '../../../src/worker/files'
import type { BlobCache } from '../../../src/worker/mirror/seams'
import { MemoryDb } from '../../../src/worker/db'
import { Outbox } from '../../../src/worker/outbox'
import { META_DEVICE_ID, type AuthStatus, type UploadProgress } from '../../../src/worker/types'

import { FakeClock, FakeHttpClient, FakeSyncServer, flush, until } from './helpers'

const AUTH: AuthStatus = { authenticated: true, my_user_id: 'u_me', workspace_id: 'w_me' }

function makeFiles(
  opts: { authStatus?: () => AuthStatus; cacheMax?: number; cacheMaxBytes?: number } = {},
): {
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
    ...(opts.cacheMax !== undefined ? { cacheMax: opts.cacheMax } : {}),
    ...(opts.cacheMaxBytes !== undefined ? { cacheMaxBytes: opts.cacheMaxBytes } : {}),
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

describe('FileManager upload — end-to-end (hash → initiate → PUT → emit)', () => {
  it('completes the PUT before emitting ONLY file.uploaded (no message.created)', async () => {
    const { db, server, http, outbox, manager, frames } = makeFiles()
    server.pauseBatch() // hold the drain so the pre-drain state is observable

    // Record the real-time ORDER of the load-bearing calls: the REAL invariant is
    // that initiate + PUT complete BEFORE `file.uploaded` is enqueued, so by the time
    // the composer's later `outbox.send` references this file, its ROW is present +
    // homed. NO outbox.send happens HERE (the upload is decoupled from message-send).
    const order: string[] = []
    const origPost = http.post.bind(http)
    vi.spyOn(http, 'post').mockImplementation((path, body) => {
      if (path === '/v1/files/initiate') order.push('initiate')
      return origPost(path, body)
    })
    const origPut = http.putBlob.bind(http)
    vi.spyOn(http, 'putBlob').mockImplementation((...args) => {
      order.push('putBlob')
      return origPut(...args)
    })
    const origEnqueue = outbox.enqueueFileUploaded.bind(outbox)
    vi.spyOn(outbox, 'enqueueFileUploaded').mockImplementation((...args) => {
      order.push('enqueue')
      return origEnqueue(...args)
    })
    const sendSpy = vi.spyOn(outbox, 'send')

    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile() })
    await until(() => frames.some((f) => f.phase === 'done'))

    // The phase machine ran in order, uploading included (no dedup).
    expect(phases(frames)).toEqual(['hashing', 'initiating', 'uploading', 'emitting', 'done'])

    // Real invariant: initiate + PUT strictly precede the file.uploaded enqueue, and
    // the upload NEVER authors a message.created (that is the composer's job on Send).
    expect(order).toEqual(['initiate', 'putBlob', 'enqueue'])
    expect(sendSpy).not.toHaveBeenCalled()

    // Exactly one initiate + one PUT to the file's own blob path.
    expect(http.postCalls.filter((p) => p.path === '/v1/files/initiate')).toHaveLength(1)
    expect(http.putBlobCalls).toHaveLength(1)
    const fileId = frames.find((f) => f.file_id)?.file_id
    expect(fileId).toBeDefined()
    expect(http.putBlobCalls[0]?.path).toBe(`/v1/files/${fileId}/blob`)

    // ONLY file.uploaded is enqueued — no message row, no message.created.
    const outboxTypes = (await db.listOutbox()).map((r) => (r.body as { type: string }).type)
    expect(outboxTypes).toEqual(['file.uploaded'])
    expect(await db.getAllMessages()).toHaveLength(0)

    // Resume: the file.uploaded record drains cleanly.
    server.resumeBatch()
    await flush()
    expect(await db.listOutbox()).toHaveLength(0)
    const batchTypes = batchBody(http)?.events.map((e) => e.body.type)
    expect(batchTypes).toEqual(['file.uploaded'])
  })
})

describe('FileManager upload — server-side dedup (upload_needed:false)', () => {
  it('skips the PUT entirely but still emits file.uploaded', async () => {
    const { http, server, db, manager, frames } = makeFiles()
    // Pre-mark the content present so initiate reports the blob is already there.
    const sha = await sha256Hex(await makeFile().arrayBuffer())
    server.markShaPresent(sha)

    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile() })
    await until(() => frames.some((f) => f.phase === 'done'))

    // uploading is SKIPPED — no PUT — yet file.uploaded is emitted and drains.
    expect(phases(frames)).toEqual(['hashing', 'initiating', 'emitting', 'done'])
    expect(http.putBlobCalls).toHaveLength(0)
    await flush()
    expect(batchBody(http)?.events.map((e) => e.body.type)).toEqual(['file.uploaded'])
    expect(await db.getAllMessages()).toHaveLength(0)
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

    // No duplicate events — exactly one file.uploaded, no message.created.
    await flush()
    const batchTypes = batchBody(http)?.events.map((e) => e.body.type) ?? []
    expect(batchTypes).toEqual(['file.uploaded'])
    expect(await db.getAllMessages()).toHaveLength(0)
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

describe('FileManager upload — cancel mid-PUT', () => {
  it('aborts the in-flight PUT, schedules no retry, and leaves no job', async () => {
    const { http, manager, frames, clock } = makeFiles()
    http.pausePutBlob() // hold the PUT so we can cancel while it is in flight

    void manager.startUpload({ upload_id: 'up1', stream_id: 's_1', file: makeFile() })
    await until(() => http.putBlobCalls.length === 1) // PUT dispatched, gated
    expect(manager.activeUploads).toBe(1)

    await manager.cancel('up1')
    expect(http.lastPutSignal?.aborted).toBe(true) // the AbortController fired
    expect(manager.activeUploads).toBe(0) // no orphaned job

    // Release the gate: the resolving PUT must NOT resume the machine or schedule a retry.
    http.resumePutBlob()
    await flush()
    clock.advance(60_000) // fire any (wrongly) scheduled backoff timer — there is none
    await flush()

    expect(clock.pending).toBe(0) // no retry timer was ever scheduled
    expect(http.putBlobCalls).toHaveLength(1) // no re-PUT
    expect(http.postCalls.some((p) => p.path.startsWith('/v1/events/batch'))).toBe(false) // no emit
    expect(frames.some((f) => f.phase === 'done' || f.phase === 'failed')).toBe(false)
  })
})

describe('FileManager upload — concurrency', () => {
  it('runs two independent uploads to completion', async () => {
    const { db, http, manager, frames } = makeFiles()

    void manager.startUpload({ upload_id: 'a', stream_id: 's_a', file: makeFile('aaa', 'a.txt') })
    void manager.startUpload({ upload_id: 'b', stream_id: 's_b', file: makeFile('bbb', 'b.txt') })
    await until(() => frames.filter((f) => f.phase === 'done').length === 2)
    await flush()

    // Each upload reached done independently, under its own upload_id.
    expect(frames.filter((f) => f.upload_id === 'a').some((f) => f.phase === 'done')).toBe(true)
    expect(frames.filter((f) => f.upload_id === 'b').some((f) => f.phase === 'done')).toBe(true)
    // Two initiates, two PUTs, two file.uploaded records — no cross-contamination.
    expect(http.postCalls.filter((p) => p.path === '/v1/files/initiate')).toHaveLength(2)
    expect(http.putBlobCalls).toHaveLength(2)
    expect(manager.activeUploads).toBe(0) // both terminal → dropped
    expect(await db.getAllMessages()).toHaveLength(0) // no message.created (decoupled)
    // Two file.uploaded records reached the server; no message.created anywhere.
    const sentTypes = http.postCalls
      .filter((p) => p.path.startsWith('/v1/events/batch'))
      .flatMap((p) => (p.body as { events: { body: { type: string } }[] }).events)
      .map((e) => e.body.type)
    expect(sentTypes.filter((t) => t === 'file.uploaded')).toHaveLength(2)
    expect(sentTypes).not.toContain('message.created')
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

  it('evicts the oldest entry past the COUNT cap (re-fetch re-hits the server)', async () => {
    const { server, manager, http } = makeFiles({ cacheMax: 2, cacheMaxBytes: 1_000_000 })
    const [f1, f2, f3] = [server.presentFile(), server.presentFile(), server.presentFile()]

    await manager.fetch({ file_id: f1, variant: 'blob' }) // cache: [f1]
    await manager.fetch({ file_id: f2, variant: 'blob' }) // cache: [f1, f2]
    await manager.fetch({ file_id: f3, variant: 'blob' }) // over cap → evict f1 → [f2, f3]
    expect(http.getBlobCalls).toHaveLength(3)

    await manager.fetch({ file_id: f2, variant: 'blob' }) // still cached — no new GET
    expect(http.getBlobCalls).toHaveLength(3)
    await manager.fetch({ file_id: f1, variant: 'blob' }) // evicted — re-hits the server
    expect(http.getBlobCalls).toHaveLength(4)
  })

  it('evicts the oldest entry past the BYTE budget; a lone over-budget blob is kept', async () => {
    // Count cap generous; byte budget = 10. Each file is 6 bytes → two together overflow.
    const { server, manager, http } = makeFiles({ cacheMax: 100, cacheMaxBytes: 10 })
    const f1 = server.presentFile({ size_bytes: 6 })
    const f2 = server.presentFile({ size_bytes: 6 })

    await manager.fetch({ file_id: f1, variant: 'blob' }) // 6 bytes, under budget
    await manager.fetch({ file_id: f2, variant: 'blob' }) // 12 > 10 → evict f1 → 6 bytes
    expect(http.getBlobCalls).toHaveLength(2)
    await manager.fetch({ file_id: f1, variant: 'blob' }) // evicted → re-hits the server
    expect(http.getBlobCalls).toHaveLength(3)

    // A single blob larger than the whole budget is kept TRANSIENTLY (served from cache).
    const big = server.presentFile({ size_bytes: 50 })
    await manager.fetch({ file_id: big, variant: 'blob' }) // 50 > 10, but lone → kept
    const before = http.getBlobCalls.length
    await manager.fetch({ file_id: big, variant: 'blob' }) // served from cache, no new GET
    expect(http.getBlobCalls).toHaveLength(before)
  })
})

describe('FileManager avatars (ENG-152) — worker-side fetch + LRU', () => {
  it('fetches a member avatar once per (user, sha); a NEW sha re-fetches', async () => {
    const { server, http, manager } = makeFiles()
    server.meProfile = {
      user_id: 'u_alice',
      display_name: 'Alice',
      email: 'a@example.com',
      role: 'member',
      is_bot: false,
      title: null,
      description: null,
      status_emoji: null,
      status_text: null,
      status_expires_at: null,
      avatar_sha256: null,
    }
    server.respondUploadAvatar() // Alice now has avatar v1
    const sha1 = server.meProfile.avatar_sha256 ?? ''

    const first = await manager.fetchAvatar({ user_id: 'u_alice', avatar_sha256: sha1 })
    const second = await manager.fetchAvatar({ user_id: 'u_alice', avatar_sha256: sha1 })
    expect(first.blob).toBeInstanceOf(Blob)
    expect(second.blob).toBe(first.blob) // same cached instance
    expect(http.getBlobCalls).toEqual(['/v1/users/u_alice/avatar'])

    // The avatar CHANGES (new sha) → a new cache key → a fresh fetch.
    server.respondUploadAvatar()
    const sha2 = server.meProfile.avatar_sha256 ?? ''
    expect(sha2).not.toBe(sha1)
    const updated = await manager.fetchAvatar({ user_id: 'u_alice', avatar_sha256: sha2 })
    expect(updated.blob).toBeInstanceOf(Blob)
    expect(updated.blob).not.toBe(first.blob)
    expect(http.getBlobCalls).toHaveLength(2)
  })

  it('returns a null blob (uncached) on the server uniform 404', async () => {
    const { manager, http } = makeFiles()

    const res = await manager.fetchAvatar({ user_id: 'u_nobody', avatar_sha256: 'x'.repeat(64) })
    expect(res.blob).toBeNull()
    // Not cached: a later fetch (e.g. after the user uploads) re-hits the server.
    await manager.fetchAvatar({ user_id: 'u_nobody', avatar_sha256: 'x'.repeat(64) })
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
    const allowed = new Set(['upload_id', 'phase', 'file_id', 'code'])
    for (const frame of frames) {
      for (const key of Object.keys(frame)) expect(allowed.has(key)).toBe(true)
    }
    // The fetch result is only opaque bytes + a mime type.
    expect(Object.keys(fetched).sort()).toEqual(['blob', 'mime_type'])
    // The bearer never crossed the RPC surface — it lives only behind the http client.
    expect(JSON.stringify(http.getBlobCalls)).not.toContain('Bearer')
  })
})

describe('FileManager — M6-3 offline blob tee (ENG-167)', () => {
  // jsdom's Blob lacks `arrayBuffer()` (a real worker Blob has it) — polyfill
  // it over FileReader, mirroring the makeFile() polyfill above.
  beforeAll(() => {
    if (typeof Blob.prototype.arrayBuffer !== 'function') {
      Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        configurable: true,
        value(this: Blob): Promise<ArrayBuffer> {
          return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as ArrayBuffer)
            reader.onerror = () => reject(reader.error ?? new Error('read failed'))
            reader.readAsArrayBuffer(this)
          })
        },
      })
    }
  })

  class MemoryBlobCache implements BlobCache {
    readonly blobs = new Map<string, Uint8Array>()
    put(sha256: string, bytes: Uint8Array): Promise<void> {
      this.blobs.set(sha256, bytes)
      return Promise.resolve()
    }
    get(sha256: string): Promise<Uint8Array | null> {
      return Promise.resolve(this.blobs.get(sha256) ?? null)
    }
    has(sha256: string): Promise<boolean> {
      return Promise.resolve(this.blobs.has(sha256))
    }
  }

  function makeTeeing(sha: string | undefined): {
    server: FakeSyncServer
    manager: FileManager
    store: MemoryBlobCache
  } {
    const db = new MemoryDb()
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const outbox = new Outbox({ db, http, authStatus: () => AUTH, publishStream: () => {} })
    const store = new MemoryBlobCache()
    const manager = new FileManager({
      http,
      outbox,
      authStatus: () => AUTH,
      publishUpload: () => {},
      blobStore: store,
      lookupFileSha: () => Promise.resolve(sha),
    })
    return { server, manager, store }
  }

  it('tees VERIFIED full-blob bytes into the store, keyed by the projected sha', async () => {
    // presentFile serves `size` zero bytes — key the lookup by their true sha.
    const sha = await sha256Hex(new Uint8Array(4))
    const { server, manager, store } = makeTeeing(sha)
    const fileId = server.presentFile({ size_bytes: 4, sha256: sha })
    const res = await manager.fetch({ file_id: fileId, variant: 'blob' })
    expect(res.blob).not.toBeNull()
    await flush()
    expect(await store.has(sha)).toBe(true)
    expect((await store.get(sha))?.length).toBe(4)
  })

  it('never stores bytes that fail the sha verification (fail-closed tee)', async () => {
    const wrongSha = 'b'.repeat(64) // the projection claims a different digest
    const { server, manager, store } = makeTeeing(wrongSha)
    const fileId = server.presentFile({ size_bytes: 4, sha256: wrongSha })
    const res = await manager.fetch({ file_id: fileId, variant: 'blob' })
    expect(res.blob).not.toBeNull() // the fetch itself still serves the tab
    await flush()
    expect(store.blobs.size).toBe(0) // …but the offline store took nothing
  })

  it('stays inert without a configured store (web default) and for misses', async () => {
    const db = new MemoryDb()
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const outbox = new Outbox({ db, http, authStatus: () => AUTH, publishStream: () => {} })
    const manager = new FileManager({
      http,
      outbox,
      authStatus: () => AUTH,
      publishUpload: () => {},
    })
    const fileId = server.presentFile({ size_bytes: 2 })
    const res = await manager.fetch({ file_id: fileId, variant: 'blob' })
    expect(res.blob).not.toBeNull()
    await flush() // nothing to assert beyond "no crash" — no store exists
  })
})
