// tests/unit/worker/helpers.ts — hermetic fakes for the worker unit suites.
// fake-indexeddb is injected via an IDBFactory (not the `/auto` global) so
// tests stay isolated; the leader tests get fake locks + a fake channel bus.

import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'
import type { DexieOptions } from 'dexie'

import { buildMessageCreatedBody, hashEvent, newFileId } from '../../../src/core'
import { DexieDb, MsgDB } from '../../../src/worker/db'
import type { ApiError, ApiResult, HttpClient } from '../../../src/worker/http'
import type { ChannelLike, LockManagerLike } from '../../../src/worker/leader'
import type {
  EventBody,
  FromWorker,
  MessageSink,
  SearchResult,
  StoredEvent,
  SyncStreamMeta,
  WireEvent,
} from '../../../src/worker/types'
import type { TimerId } from '../../../src/worker/sync'
import type { WsClientFrame, WsConnection, WsFactory, WsFrame } from '../../../src/worker/ws'

/** A fresh in-memory IndexedDB layer for a single test's Dexie DB. */
export function fakeIdbOptions(): DexieOptions {
  return {
    indexedDB: new IDBFactory(),
    IDBKeyRange: FakeIDBKeyRange,
  }
}

/** A persistent DexieDb on a private fake-indexeddb instance. */
export function makeFakeMsgDB(): MsgDB {
  return new MsgDB(fakeIdbOptions())
}

export function makeFakeDexieDb(): DexieDb {
  return new DexieDb(makeFakeMsgDB())
}

/** A MessageSink that records every frame it is handed. */
export function collectingSink(): {
  sink: MessageSink
  frames: Array<{ clientId: string; msg: FromWorker }>
} {
  const frames: Array<{ clientId: string; msg: FromWorker }> = []
  const sink: MessageSink = (clientId, msg) => {
    frames.push({ clientId, msg })
  }
  return { sink, frames }
}

/**
 * Yield a real macrotask. Needed because `hashEvent` (WebCrypto `crypto.subtle`)
 * settles on a macrotask, not a microtask — pure `await Promise.resolve()` loops
 * never drain it. This uses the GLOBAL `setTimeout` (the engine's own timers are
 * driven by the injected {@link FakeClock}, so nothing here fires them).
 */
export function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Drain the task queue a few times so async plumbing (incl. crypto) settles. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await tick()
}

/** Poll `fn` across task ticks until it is true (or throw). */
export async function until(fn: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return
    await tick()
  }
  throw new Error('until(): condition never became true')
}

/** Poll an async predicate across task ticks until it resolves true. */
export async function untilAsync(fn: () => Promise<boolean>, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return
    await tick()
  }
  throw new Error('untilAsync(): condition never became true')
}

// ---------------------------------------------------------------------------
// Fake Web Locks — models a single exclusive lock per name with a FIFO queue.
// A waiter's callback runs only once it holds the lock; releasing (the callback
// promise settling) promotes the next waiter. Exactly one holder at a time.
// ---------------------------------------------------------------------------

export class FakeLockManager implements LockManagerLike {
  private readonly held = new Set<string>()
  private readonly queues = new Map<string, Array<() => void>>()

  request(
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void> {
    void options
    return new Promise<void>((resolveRequest) => {
      const release = (): void => {
        this.held.delete(name)
        resolveRequest()
        const next = this.queues.get(name)?.shift()
        if (next) next()
      }
      const attempt = (): void => {
        this.held.add(name)
        void Promise.resolve(callback(null)).finally(release)
      }
      if (this.held.has(name)) {
        const q = this.queues.get(name) ?? []
        q.push(attempt)
        this.queues.set(name, q)
      } else {
        attempt()
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Fake BroadcastChannel bus — postMessage fans out to every OTHER channel on
// the bus (never the sender), asynchronously and structured-cloned, like the
// real API.
// ---------------------------------------------------------------------------

export class FakeChannelBus {
  private readonly channels = new Set<FakeChannel>()

  create(): ChannelLike {
    const ch = new FakeChannel(this)
    this.channels.add(ch)
    return ch
  }

  deliver(from: FakeChannel, data: unknown): void {
    for (const ch of this.channels) {
      if (ch !== from) ch.receive(data)
    }
  }

  remove(ch: FakeChannel): void {
    this.channels.delete(ch)
  }
}

class FakeChannel implements ChannelLike {
  private readonly listeners = new Set<(ev: MessageEvent) => void>()

  constructor(private readonly bus: FakeChannelBus) {}

  postMessage(data: unknown): void {
    const clone = structuredClone(data)
    queueMicrotask(() => {
      this.bus.deliver(this, clone)
    })
  }

  addEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  close(): void {
    this.listeners.clear()
    this.bus.remove(this)
  }

  receive(data: unknown): void {
    const ev = { data } as MessageEvent
    for (const l of this.listeners) l(ev)
  }
}

// ===========================================================================
// ENG-79 sync-engine test doubles: a hermetic HTTP server model, a WS fake, a
// deterministic clock, and real-envelope builders (genuine hashes so the
// hash-verify path is exercised for real).
// ===========================================================================

/** Build a real, hash-valid wire event for `streamId` at `seq` (§7 shape). */
export async function buildWireEvent(opts: {
  streamId: string
  seq: number
  workspaceId?: string
  authorUserId?: string
  text?: string
  receivedAt?: string
}): Promise<WireEvent> {
  const body = buildMessageCreatedBody({
    workspace_id: opts.workspaceId ?? 'ws_test',
    stream_id: opts.streamId,
    author_user_id: opts.authorUserId ?? 'u_author',
    author_device_id: 'd_test',
    client_created_at: new Date(1_700_000_000_000 + opts.seq).toISOString(),
    text: opts.text ?? `msg ${opts.seq}`,
  })
  const event_hash = await hashEvent(body)
  return {
    body: body as unknown as EventBody,
    event_hash,
    signature: null,
    server: {
      server_sequence: opts.seq,
      server_received_at: opts.receivedAt ?? new Date(1_700_000_000_000 + opts.seq).toISOString(),
      payload_redacted: false,
    },
  }
}

/** Build a gapless run of real wire events with sequences `1..count`. */
export async function buildEventRun(streamId: string, count: number): Promise<WireEvent[]> {
  const events: WireEvent[] = []
  for (let seq = 1; seq <= count; seq++) {
    events.push(await buildWireEvent({ streamId, seq }))
  }
  return events
}

/** Return a shallow copy of `ev` with a corrupted `event_hash` (verify-reject test). */
export function corruptHash(ev: WireEvent): WireEvent {
  return { ...ev, event_hash: 'sha256:deadbeef' }
}

/** The server sequence of a wire event (test builders always populate `server`). */
export function wireSeq(ev: WireEvent): number {
  return ev.server?.server_sequence ?? 0
}

interface FakeStream {
  meta: Omit<SyncStreamMeta, 'head_seq'>
  events: WireEvent[]
  headOverride?: number
}

/** A reserved file row in the {@link FakeSyncServer} Files API model (ENG-119). */
interface FakeFileRow {
  file_id: string
  sha256: string
  name: string
  mime_type: string
  size_bytes: number
  stream_id: string
  present: boolean
  thumbnail: boolean
  /** The bytes stored by a successful PUT (streamed back on download). */
  bytes?: Blob | ArrayBuffer
}

/**
 * A hermetic model of the read-side server: answers `GET /v1/sync` and
 * `GET /v1/events` from an in-memory, gapless-per-stream event log. Tests mutate
 * it (add streams, append events, corrupt a hash) and assert the engine
 * converges the local cache to this truth.
 */
/** A `POST /v1/events/batch` upload item (ENG-66 wire shape). */
export interface BatchUploadEvent {
  body: EventBody
  event_hash: string
}

/** One accepted event in the batch 200 (ENG-66). */
export interface AcceptedBatchEvent {
  event_id: string
  stream_id: string
  server_sequence: number
  server_received_at: string
}

/** One rejected event in the batch 200 (ENG-66). */
export interface RejectedBatchEvent {
  event_id: string
  code: string
  detail?: string
}

export class FakeSyncServer {
  private readonly streams = new Map<string, FakeStream>()
  private gate: Promise<void> | undefined
  private releaseGate: (() => void) | undefined
  /** Gate for `POST /v1/events/batch` (drain-ordering control, mirrors {@link pauseEvents}). */
  private batchGate: Promise<void> | undefined
  private releaseBatchGate: (() => void) | undefined
  /** `event_id` → its original accepted record (UNIQUE-per-workspace idempotency). */
  private readonly acceptedById = new Map<string, AcceptedBatchEvent>()
  /** `event_id` → rejection code, configured by {@link rejectEvent}. */
  private readonly rejects = new Map<string, string>()
  syncError: ApiError | undefined
  eventsError: ApiError | undefined
  /** When set, every `POST /v1/events/batch` fails transiently with this error. */
  batchError: ApiError | undefined

  // -- ENG-126 read-state / prefs / search model --------------------------
  /** `stream_id` → server `last_read_seq` (GREATEST-merged on PUT). */
  readonly readState = new Map<string, number>()
  /** `stream_id` → notification `level` (LWW-replaced on PUT). */
  readonly prefs = new Map<string, string>()
  /** The canned `GET /v1/search` response tests configure (default empty). */
  searchResult: SearchResult = { hits: [], next_cursor: null }

  // -- ENG-119 Files API model --------------------------------------------
  /** `file_id` → the reserved file row (models the server `files` table). */
  private readonly files = new Map<string, FakeFileRow>()
  /** Shas whose bytes are PRESENT anywhere (drives the dedup `upload_needed` answer). */
  private readonly presentShas = new Set<string>()
  /** Consumed by the NEXT `POST /v1/files/initiate` (a hard 413/quota/etc. arm). */
  nextInitiateError: ApiError | undefined

  addStream(meta: Partial<SyncStreamMeta> & { stream_id: string; kind?: string }): void {
    this.streams.set(meta.stream_id, {
      meta: {
        stream_id: meta.stream_id,
        kind: meta.kind ?? 'channel',
        name: meta.name ?? 'general',
        visibility: meta.visibility ?? 'public',
        member: meta.member ?? true,
      },
      events: [],
      ...(meta.head_seq !== undefined ? { headOverride: meta.head_seq } : {}),
    })
  }

  /** Append pre-built wire events (must be for this stream). */
  append(streamId: string, events: readonly WireEvent[]): void {
    const s = this.get(streamId)
    s.events.push(...events)
    s.events.sort((a, b) => wireSeq(a) - wireSeq(b))
  }

  /** Build + append a gapless run `1..count` (real hashes). */
  async seed(streamId: string, count: number): Promise<void> {
    this.append(streamId, await buildEventRun(streamId, count))
  }

  /** Append `count` further events continuing from the current head (real hashes). */
  async extend(streamId: string, count: number): Promise<void> {
    const from = this.head(streamId) + 1
    const events: WireEvent[] = []
    for (let seq = from; seq < from + count; seq++) {
      events.push(await buildWireEvent({ streamId, seq }))
    }
    this.append(streamId, events)
  }

  events(streamId: string): WireEvent[] {
    return this.get(streamId).events
  }

  head(streamId: string): number {
    const s = this.get(streamId)
    if (s.headOverride !== undefined) return s.headOverride
    const last = s.events[s.events.length - 1]
    return last ? wireSeq(last) : 0
  }

  /** Hold every subsequent `/v1/events` response until {@link resumeEvents}. */
  pauseEvents(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve
    })
  }

  resumeEvents(): void {
    this.releaseGate?.()
    this.gate = undefined
    this.releaseGate = undefined
  }

  /** Hold every subsequent `POST /v1/events/batch` until {@link resumeBatch}. */
  pauseBatch(): void {
    this.batchGate = new Promise<void>((resolve) => {
      this.releaseBatchGate = resolve
    })
  }

  resumeBatch(): void {
    this.releaseBatchGate?.()
    this.batchGate = undefined
    this.releaseBatchGate = undefined
  }

  /** Configure a per-event rejection (drain reject test). */
  rejectEvent(eventId: string, code: string): void {
    this.rejects.set(eventId, code)
  }

  /** Clear a configured rejection so a retried event is accepted next time. */
  allowEvent(eventId: string): void {
    this.rejects.delete(eventId)
  }

  /**
   * The `POST /v1/events/batch` core (ENG-66): assign a per-stream sequence to
   * each new event, enforce `event_id` UNIQUE (a re-POST returns the ORIGINAL
   * accepted record — same sequence — never a duplicate), honor configured
   * rejects, and store accepted events so a WS frame / pull can also serve them.
   * Ungated — tests call it directly to pre-register an event (simulate the
   * server having processed it before the client's batch POST completes).
   */
  processBatch(events: readonly BatchUploadEvent[]): {
    accepted: AcceptedBatchEvent[]
    rejected: RejectedBatchEvent[]
  } {
    const accepted: AcceptedBatchEvent[] = []
    const rejected: RejectedBatchEvent[] = []
    for (const ev of events) {
      const eventId = ev.body.event_id as string
      const streamId = ev.body.stream_id as string
      const rejectCode = this.rejects.get(eventId)
      if (rejectCode !== undefined) {
        rejected.push({ event_id: eventId, code: rejectCode })
        continue
      }
      const existing = this.acceptedById.get(eventId)
      if (existing) {
        accepted.push(existing) // idempotent: original sequence, never a dup
        continue
      }
      if (!this.streams.has(streamId)) this.addStream({ stream_id: streamId })
      const s = this.get(streamId)
      const seq = this.head(streamId) + 1
      const receivedAt = new Date(1_700_000_000_000 + seq).toISOString()
      const wire: WireEvent = {
        body: ev.body,
        event_hash: ev.event_hash,
        signature: null,
        server: { server_sequence: seq, server_received_at: receivedAt, payload_redacted: false },
      }
      s.events.push(wire)
      s.events.sort((a, b) => wireSeq(a) - wireSeq(b))
      const acc: AcceptedBatchEvent = {
        event_id: eventId,
        stream_id: streamId,
        server_sequence: seq,
        server_received_at: receivedAt,
      }
      this.acceptedById.set(eventId, acc)
      accepted.push(acc)
    }
    return { accepted, rejected }
  }

  /** Gated batch responder (the drain's `POST /v1/events/batch` path). */
  async respondBatch(
    events: readonly BatchUploadEvent[],
  ): Promise<ApiResult<{ accepted: AcceptedBatchEvent[]; rejected: RejectedBatchEvent[] }>> {
    if (this.batchGate) await this.batchGate
    if (this.batchError) return { ok: false, error: this.batchError }
    return { ok: true, value: this.processBatch(events) }
  }

  // -- ENG-119 Files API responders ---------------------------------------

  /** Pre-mark a sha as PRESENT so the next initiate dedups (`upload_needed:false`). */
  markShaPresent(sha256: string): void {
    this.presentShas.add(sha256)
  }

  /**
   * Directly reserve a PRESENT file row (bypassing initiate/PUT) so a download test
   * can populate many files cheaply. Returns the minted `file_id`. `size_bytes`
   * controls the served `Blob` size (drives the cache byte-budget tests).
   */
  presentFile(
    opts: {
      stream_id?: string
      sha256?: string
      mime_type?: string
      name?: string
      size_bytes?: number
    } = {},
  ): string {
    const file_id = newFileId()
    const size = opts.size_bytes ?? 1
    this.files.set(file_id, {
      file_id,
      sha256: opts.sha256 ?? file_id,
      name: opts.name ?? 'f',
      mime_type: opts.mime_type ?? 'application/octet-stream',
      size_bytes: size,
      stream_id: opts.stream_id ?? 's_1',
      present: true,
      thumbnail: false,
      bytes: new ArrayBuffer(size),
    })
    return file_id
  }

  /**
   * `POST /v1/files/initiate`: reserve a NEW file row (server mints the id — even a
   * re-used sha gets a fresh row) and report whether bytes are still needed
   * (`upload_needed:false` only when this sha is already present — the dedup path).
   * A configured {@link nextInitiateError} (413/quota/…) is returned once instead.
   */
  respondInitiate(body: {
    sha256: string
    name: string
    mime_type: string
    size_bytes: number
    stream_id: string
  }): ApiResult<{ file_id: string; upload_needed: boolean }> {
    if (this.nextInitiateError) {
      const error = this.nextInitiateError
      this.nextInitiateError = undefined
      return { ok: false, error }
    }
    const present = this.presentShas.has(body.sha256)
    const file_id = newFileId()
    this.files.set(file_id, {
      file_id,
      sha256: body.sha256,
      name: body.name,
      mime_type: body.mime_type,
      size_bytes: body.size_bytes,
      stream_id: body.stream_id,
      present,
      thumbnail: present && body.mime_type.startsWith('image/'),
    })
    return { ok: true, value: { file_id, upload_needed: !present } }
  }

  /**
   * `PUT /v1/files/{file_id}/blob`: store the raw bytes, flip the row PRESENT
   * (idempotent — a repeat PUT is a safe success), and record the sha as present so
   * a later initiate of the same content dedups. Best-effort thumbnail for images.
   */
  respondPutBlob(fileId: string, body: Blob | ArrayBuffer): ApiResult<void> {
    const row = this.files.get(fileId)
    if (!row) return { ok: false, error: { status: 404, code: 'not-found', title: 'Not found' } }
    row.bytes = body
    row.present = true
    if (row.mime_type.startsWith('image/')) row.thumbnail = true
    this.presentShas.add(row.sha256)
    return { ok: true, value: undefined }
  }

  /**
   * `GET /v1/files/{file_id}[/thumbnail]`: stream the present blob back as an opaque
   * `application/octet-stream` attachment (or the WEBP thumbnail inline). A missing /
   * not-present file, or a missing thumbnail, is the uniform 404 (no existence oracle).
   */
  respondGetBlob(path: string): ApiResult<{ blob: Blob; mimeType: string }> {
    const notFound = {
      ok: false as const,
      error: { status: 404, code: 'not-found', title: 'Not found' },
    }
    const thumb = path.endsWith('/thumbnail')
    const fileId = thumb
      ? path.slice('/v1/files/'.length, -'/thumbnail'.length)
      : path.slice('/v1/files/'.length)
    const row = this.files.get(fileId)
    if (!row || !row.present) return notFound
    if (thumb) {
      if (!row.thumbnail) return notFound
      return { ok: true, value: { blob: new Blob([new Uint8Array([1])]), mimeType: 'image/webp' } }
    }
    const bytes = row.bytes ?? new Uint8Array()
    return {
      ok: true,
      value: { blob: new Blob([bytes]), mimeType: 'application/octet-stream' },
    }
  }

  // -- ENG-126 read-state / prefs / search responders ---------------------

  /** `GET /v1/search` — return the canned {@link searchResult} (filters ride the query). */
  respondSearch(): ApiResult<SearchResult> {
    return { ok: true, value: this.searchResult }
  }

  /** `GET /v1/read-state` — `{streams:[{stream_id,last_read_seq,head_seq,unread}]}`. */
  respondGetReadState(): ApiResult<{
    streams: { stream_id: string; last_read_seq: number; head_seq: number; unread: number }[]
  }> {
    const streams = [...this.readState].map(([stream_id, last_read_seq]) => ({
      stream_id,
      last_read_seq,
      head_seq: last_read_seq,
      unread: 0,
    }))
    return { ok: true, value: { streams } }
  }

  /** `PUT /v1/read-state` — GREATEST-merge, echo the effective value (mirrors ENG-123). */
  respondPutReadState(body: {
    stream_id: string
    last_read_seq: number
  }): ApiResult<{ stream_id: string; last_read_seq: number }> {
    const prev = this.readState.get(body.stream_id) ?? -1
    const effective = Math.max(prev, body.last_read_seq)
    this.readState.set(body.stream_id, effective)
    return { ok: true, value: { stream_id: body.stream_id, last_read_seq: effective } }
  }

  /** `GET /v1/prefs` — `{prefs:[{stream_id,level}]}`. */
  respondGetPrefs(): ApiResult<{ prefs: { stream_id: string; level: string }[] }> {
    const prefs = [...this.prefs].map(([stream_id, level]) => ({ stream_id, level }))
    return { ok: true, value: { prefs } }
  }

  /** `PUT /v1/prefs` — LWW-replace, echo the level (mirrors ENG-124). */
  respondPutPrefs(body: {
    stream_id: string
    level: string
  }): ApiResult<{ stream_id: string; level: string }> {
    this.prefs.set(body.stream_id, body.level)
    return { ok: true, value: { stream_id: body.stream_id, level: body.level } }
  }

  /** The stored wire event for an `event_id` (to emit as a WS frame in a test). */
  wireFor(eventId: string): WireEvent | undefined {
    for (const s of this.streams.values()) {
      const found = s.events.find((e) => e.body.event_id === eventId)
      if (found) return found
    }
    return undefined
  }

  private get(streamId: string): FakeStream {
    const s = this.streams.get(streamId)
    if (!s) throw new Error(`FakeSyncServer: unknown stream ${streamId}`)
    return s
  }

  async respond(path: string): Promise<ApiResult<unknown>> {
    if (path.startsWith('/v1/search')) return this.respondSearch()
    if (path.startsWith('/v1/read-state')) return this.respondGetReadState()
    if (path.startsWith('/v1/prefs')) return this.respondGetPrefs()
    if (path.startsWith('/v1/sync')) {
      if (this.syncError) return { ok: false, error: this.syncError }
      const streams: SyncStreamMeta[] = [...this.streams.values()].map((s) => ({
        ...s.meta,
        head_seq: this.head(s.meta.stream_id),
      }))
      return { ok: true, value: { streams } }
    }
    if (path.startsWith('/v1/events')) {
      if (this.gate) await this.gate
      if (this.eventsError) return { ok: false, error: this.eventsError }
      return { ok: true, value: this.eventsPage(path) }
    }
    return { ok: false, error: { status: 404, code: 'not-found', title: 'Not found' } }
  }

  private eventsPage(path: string): { events: WireEvent[]; has_more: boolean } {
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
    const streamId = query.get('stream_id') ?? ''
    const s = this.streams.get(streamId)
    if (!s) return { events: [], has_more: false }
    const limit = Math.min(Number(query.get('limit') ?? '500'), 500)
    const beforeRaw = query.get('before')
    const afterRaw = query.get('after')
    const asc = [...s.events].sort((a, b) => wireSeq(a) - wireSeq(b))
    if (beforeRaw !== null) {
      const before = Number(beforeRaw)
      const below = asc.filter((e) => wireSeq(e) < before)
      const page = below.slice(Math.max(0, below.length - limit))
      return { events: page, has_more: below.length > page.length }
    }
    const after = afterRaw !== null ? Number(afterRaw) : 0
    const above = asc.filter((e) => wireSeq(e) > after)
    const page = above.slice(0, limit)
    return { events: page, has_more: above.length > page.length }
  }
}

/** An {@link HttpClient} backed by a {@link FakeSyncServer}, recording GET paths. */
export class FakeHttpClient implements HttpClient {
  readonly getCalls: string[] = []
  readonly postCalls: { path: string; body: unknown }[] = []
  /** Every `put` call — the JSON body (synced-KV writes: read-state / prefs). */
  readonly putCalls: { path: string; body: unknown }[] = []
  /** Every `putBlob` call — the raw body + declared content type (never JSON). */
  readonly putBlobCalls: { path: string; body: Blob | ArrayBuffer; contentType?: string }[] = []
  readonly getBlobCalls: string[] = []
  inFlight = 0
  maxInFlight = 0
  /** Queued transient failures — one per `putBlob` (a blip injector for retry tests). */
  private readonly putBlips: ApiError[] = []
  /** The `signal` of the most recent `putBlob` — lets a test assert cancel aborted it. */
  lastPutSignal: AbortSignal | undefined
  /** Gate for `putBlob` (hold an in-flight upload so a test can cancel mid-PUT). */
  private putBlobGate: Promise<void> | undefined
  private releasePutBlobGate: (() => void) | undefined

  constructor(private readonly server: FakeSyncServer) {}

  /** Make the NEXT `putBlob` fail transiently (default a `network` blip). */
  failNextPutBlob(error: ApiError = { status: 0, code: 'network', title: 'Network error' }): void {
    this.putBlips.push(error)
  }

  /** Hold every subsequent `putBlob` response until {@link resumePutBlob}. */
  pausePutBlob(): void {
    this.putBlobGate = new Promise<void>((resolve) => {
      this.releasePutBlobGate = resolve
    })
  }

  resumePutBlob(): void {
    this.releasePutBlobGate?.()
    this.putBlobGate = undefined
    this.releasePutBlobGate = undefined
  }

  async get<T>(path: string): Promise<ApiResult<T>> {
    this.getCalls.push(path)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      return (await this.server.respond(path)) as ApiResult<T>
    } finally {
      this.inFlight--
    }
  }

  async post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    this.postCalls.push({ path, body })
    if (path.startsWith('/v1/events/batch')) {
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      try {
        const events = (body as { events: BatchUploadEvent[] }).events
        return (await this.server.respondBatch(events)) as ApiResult<T>
      } finally {
        this.inFlight--
      }
    }
    if (path.startsWith('/v1/files/initiate')) {
      return this.server.respondInitiate(
        body as {
          sha256: string
          name: string
          mime_type: string
          size_bytes: number
          stream_id: string
        },
      ) as ApiResult<T>
    }
    return { ok: true, value: undefined as T }
  }

  put<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    this.putCalls.push({ path, body })
    if (path.startsWith('/v1/read-state')) {
      return Promise.resolve(
        this.server.respondPutReadState(body as { stream_id: string; last_read_seq: number }),
      ) as Promise<ApiResult<T>>
    }
    if (path.startsWith('/v1/prefs')) {
      return Promise.resolve(
        this.server.respondPutPrefs(body as { stream_id: string; level: string }),
      ) as Promise<ApiResult<T>>
    }
    return Promise.resolve({ ok: true, value: undefined as T })
  }

  del(): Promise<ApiResult<void>> {
    return Promise.resolve({ ok: true, value: undefined })
  }

  async putBlob(
    path: string,
    body: Blob | ArrayBuffer,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<ApiResult<void>> {
    this.putBlobCalls.push({
      path,
      body,
      ...(opts?.contentType ? { contentType: opts.contentType } : {}),
    })
    this.lastPutSignal = opts?.signal
    if (this.putBlobGate) await this.putBlobGate
    const blip = this.putBlips.shift()
    if (blip) return { ok: false, error: blip }
    // A cancel while the PUT was gated aborts the signal — model the real fetch reject.
    if (opts?.signal?.aborted) {
      return { ok: false, error: { status: 0, code: 'network', title: 'Network error' } }
    }
    // path = /v1/files/{file_id}/blob
    const fileId = path.slice('/v1/files/'.length, -'/blob'.length)
    return this.server.respondPutBlob(fileId, body)
  }

  getBlob(path: string): Promise<ApiResult<{ blob: Blob; mimeType: string }>> {
    this.getBlobCalls.push(path)
    return Promise.resolve(this.server.respondGetBlob(path))
  }

  /** Count of GET calls whose path matches `pattern`. */
  countGets(pattern: string | RegExp): number {
    return this.getCalls.filter((p) =>
      typeof pattern === 'string' ? p.includes(pattern) : pattern.test(p),
    ).length
  }
}

/** A driveable {@link WsConnection}: a test feeds frames in, inspects sends/closes. */
export class FakeWsConnection implements WsConnection {
  readonly sent: WsClientFrame[] = []
  readonly closeCodes: (number | undefined)[] = []
  private frameCb: ((f: WsFrame) => void) | undefined
  private openCb: (() => void) | undefined
  private closeCb: ((info: { code: number; wasClean: boolean }) => void) | undefined
  private errorCb: (() => void) | undefined

  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  send(frame: WsClientFrame): void {
    this.sent.push(frame)
  }
  close(code?: number): void {
    this.closeCodes.push(code)
  }
  onFrame(cb: (f: WsFrame) => void): void {
    this.frameCb = cb
  }
  onOpen(cb: () => void): void {
    this.openCb = cb
  }
  onClose(cb: (info: { code: number; wasClean: boolean }) => void): void {
    this.closeCb = cb
  }
  onError(cb: () => void): void {
    this.errorCb = cb
  }

  // -- test drivers --
  get closed(): boolean {
    return this.closeCodes.length > 0
  }
  open(): void {
    this.openCb?.()
  }
  emit(frame: WsFrame): void {
    this.frameCb?.(frame)
  }
  emitEvent(event: WireEvent): void {
    this.frameCb?.({ t: 'event', event })
  }
  serverPing(): void {
    this.frameCb?.({ t: 'ping' })
  }
  serverClose(code = 1006): void {
    this.closeCb?.({ code, wasClean: false })
  }
  serverError(): void {
    this.errorCb?.()
  }
}

/** A {@link WsFactory} that records every connection it mints. */
export function makeFakeWsFactory(): {
  wsFactory: WsFactory
  sockets: FakeWsConnection[]
  last: () => FakeWsConnection
} {
  const sockets: FakeWsConnection[] = []
  const wsFactory: WsFactory = (url, token) => {
    const socket = new FakeWsConnection(url, token)
    sockets.push(socket)
    return socket
  }
  return {
    wsFactory,
    sockets,
    last: () => {
      const s = sockets[sockets.length - 1]
      if (!s) throw new Error('no WS connection created yet')
      return s
    },
  }
}

/** A deterministic clock: tests advance time to fire backoff / watchdog timers. */
export class FakeClock {
  private t = 0
  private nextId = 1
  private timers: { id: number; at: number; cb: () => void }[] = []

  now = (): number => this.t

  setTimeout = (cb: () => void, ms: number): TimerId => {
    const id = this.nextId++
    this.timers.push({ id, at: this.t + ms, cb })
    return id
  }

  clearTimeout = (handle: TimerId): void => {
    this.timers = this.timers.filter((x) => x.id !== handle)
  }

  /** Advance `ms`, firing every timer due within the window in chronological order. */
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)
      const next = due[0]
      if (!next) break
      this.timers = this.timers.filter((x) => x.id !== next.id)
      this.t = next.at
      next.cb()
    }
    this.t = target
  }

  get pending(): number {
    return this.timers.length
  }
}

/** An inert {@link WsFactory} that never opens — keeps auth/core tests socket-free. */
export const inertWsFactory: WsFactory = () => ({
  send: () => undefined,
  close: () => undefined,
  onFrame: () => undefined,
  onOpen: () => undefined,
  onClose: () => undefined,
  onError: () => undefined,
})

/** A cheap, synchronous placeholder envelope for tests that don't verify hashes. */
export function stubEnvelope(seq: number): StoredEvent {
  return {
    body: { type: 'stub', type_version: 1, author_user_id: '', payload: null },
    event_hash: 'sha256:stub',
    signature: null,
    server: { server_sequence: seq, server_received_at: '', payload_redacted: false },
  }
}
