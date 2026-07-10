// @vitest-environment node
//
// M6-6 (ENG-169) — test_m6_exit_gate: THE M6 EXIT GATE. The single named,
// permanent CI check for the desktop milestone (§13), sibling of
// `test_m4_exit_gate` / `test_m5_exit_gate`. It PROMOTES AND CONSOLIDATES the
// M6-3 workspace-mirror gate and the M6-4 offline gate (their spec files were
// removed — this file carries their full coverage) into ONE headless flow that
// proves the milestone's substance: drive the REAL WorkerCore + SyncEngine in
// full-mirror mode (SqliteDb + the Node-fs mirror seams + an injected
// SecretStore — the desktop stack minus Tauri) against a FakeSyncServer into a
// temp directory, and assert, in order:
//
//   1. VERIFY-GREEN FOLDER (§12 invariant-9): the mirrored workspace passes
//      the REAL `msgctl verify --json <dir>` — exit 0, zero failures — plus
//      events-table ≡ NDJSON (same envelopes, same order, each line
//      byte-equal to `eventNdjsonLine`).
//   2. TRUE OFFLINE: a cold boot with the network dead restores the session
//      from the SecretStore (zero dial), EVERY `client.query` verb answers
//      from SQLite, `client.search` answers from local FTS5 (zero
//      `/v1/search`), a send QUEUES in the outbox, `readState.mark` advances
//      locally — and each server-required verb degrades to the CODED
//      `offline` error (never an unhandled throw).
//   3. RECONNECT: the rising edge into `live` drains the outbox, the drained
//      event appends to the NDJSON log via the mirror, the offline read
//      marker re-pushes — and the folder STILL verifies exit 0.
//   4. REBUILD ≡ INCREMENTAL (§12 invariant-6 extended to the on-disk log):
//      dumpMessages/dumpFiles are byte-equal across `core.rebuildFromDisk()`.
//   5. NO SECRETS IN THE FOLDER (§12 invariant-9): a byte-scan of every file
//      (including projections.sqlite3 + WAL sidecars) finds the session token
//      NOWHERE, proven against a positive control.
//
// Durability teeth carried over from the M6-3 gate, re-verified in the same
// flow: tampered-log fail-closed (hash re-verified on rebuild), crash-resume
// between the NDJSON fsync and the cursor persist (converges, no duplicate
// lines), and torn-tail repair (a partial trailing line is truncated on the
// next open) — each followed by `msgctl verify` exit 0.
//
// TOOLCHAIN GATING: spawning msgctl needs `uv` (the repo's Python runner, the
// same entrypoint the CLI e2e suite uses). Where uv is absent the suite
// self-skips — EXCEPT under CI, where it hard-fails instead: the gate must
// never silently vanish from the pipeline (the web CI job installs uv for it).
// Run locally from web/:  pnpm test tests/integration/m6-exit-gate.spec.ts

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  buildChannelCreatedBody,
  buildFileUploadedBody,
  buildMessageCreatedBody,
  buildMessageDeletedBody,
  buildMessageEditedBody,
  buildReactionAddedBody,
  buildReactionRemovedBody,
  hashEvent,
  newDeviceId,
  newFileId,
  newStreamId,
  newUserId,
  newWorkspaceId,
  sha256Hex,
  type Body,
} from '../../src/core'
import { WorkerCore } from '../../src/worker/core'
import type { ApiResult, HttpClient } from '../../src/worker/http'
import { NodeBlobCache, NodeEventLog, NodeManifestStore } from '../../src/worker/mirror/node-fs'
import { eventNdjsonLine } from '../../src/worker/mirror/serialize'
import { WorkspaceMirror } from '../../src/worker/mirror/workspace-mirror'
import { dumpFiles, dumpMessages } from '../../src/worker/projection'
import { MemorySecretStore } from '../../src/worker/secret-store'
import { openSqliteDb, type SqliteDb } from '../../src/worker/sqlite/sqlite-db'
import {
  META_DEVICE_ID,
  META_MY_USER_ID,
  META_PROJECTION_VERSION,
  META_ROLE,
  META_SESSION_EXPIRES_AT,
  META_SESSION_TOKEN,
  META_WORKSPACE_ID,
  PROJECTION_VERSION,
  type EventBody,
  type FromWorker,
  type MessagesListResult,
  type QueryParams,
  type RpcError,
  type RpcRequest,
  type SearchResult,
  type SendResult,
  type StreamsListResult,
  type SyncStatus,
  type WireEvent,
} from '../../src/worker/types'
import {
  collectingSink,
  FakeHttpClient,
  FakeSyncServer,
  makeFakeWsFactory,
  untilAsync,
} from '../unit/worker/helpers'

// ---------------------------------------------------------------------------
// Toolchain gating (uv → msgctl)
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const uvAvailable = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0

if (!uvAvailable && process.env.CI) {
  // The M6 exit gate MUST run in CI. If uv is missing there, fail loudly
  // rather than skip — a silently-skipped verify gate is a hole in the
  // invariant wall (§12 invariant-9 is asserted here and nowhere else).
  throw new Error(
    'test_m6_exit_gate: `uv` is not on PATH under CI. The web CI job must ' +
      'install uv (astral-sh/setup-uv) so `msgctl verify` can be spawned.',
  )
}

interface VerifyJson {
  ok: boolean
  workspace_id: string | null
  summary: { streams: number; events: number; failures: number; warnings: number }
  findings: { severity: string; class: string; detail: string }[]
}

/** Spawn the REAL `msgctl verify --json <dir>` through uv; return exit + report. */
function msgctlVerify(dir: string): { status: number; report: VerifyJson } {
  const res = spawnSync('uv', ['run', '--project', repoRoot, 'msgctl', 'verify', '--json', dir], {
    encoding: 'utf8',
    cwd: repoRoot,
    timeout: 180_000,
  })
  if (res.error) throw res.error
  let report: VerifyJson
  try {
    report = JSON.parse(res.stdout) as VerifyJson
  } catch {
    throw new Error(
      `msgctl verify emitted no JSON (exit ${res.status})\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    )
  }
  return { status: res.status ?? -1, report }
}

// ---------------------------------------------------------------------------
// Offline-switchable HTTP: online → the FakeSyncServer; offline → every call
// is the transport-level fetch reject (status 0 / `network`), exactly what a
// dead link produces through the real createHttpClient.
// ---------------------------------------------------------------------------

class OfflineSwitchHttp implements HttpClient {
  online = true

  constructor(readonly inner: FakeHttpClient) {}

  private down<T>(): Promise<ApiResult<T>> {
    return Promise.resolve({
      ok: false,
      error: { status: 0, code: 'network', title: 'Network error' },
    })
  }

  get<T>(path: string): Promise<ApiResult<T>> {
    return this.online ? this.inner.get<T>(path) : this.down<T>()
  }
  post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    return this.online ? this.inner.post<T>(path, body) : this.down<T>()
  }
  put<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    return this.online ? this.inner.put<T>(path, body) : this.down<T>()
  }
  patch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    return this.online ? this.inner.patch<T>(path, body) : this.down<T>()
  }
  del<T = void>(path: string): Promise<ApiResult<T>> {
    return this.online ? this.inner.del<T>(path) : this.down<T>()
  }
  putBlob(...args: Parameters<HttpClient['putBlob']>): ReturnType<HttpClient['putBlob']> {
    return this.online ? this.inner.putBlob(...args) : this.down<void>()
  }
  postBlob<T>(...args: Parameters<HttpClient['postBlob']>): Promise<ApiResult<T>> {
    return this.online ? this.inner.postBlob<T>(...args) : this.down<T>()
  }
  getBlob(path: string): ReturnType<HttpClient['getBlob']> {
    return this.online ? this.inner.getBlob(path) : this.down<{ blob: Blob; mimeType: string }>()
  }
}

// ---------------------------------------------------------------------------
// Workspace seed — real typed ULIDs (msgctl verify validates envelope shape).
// Months are strictly BEFORE the fake server's batch-accept month (2023-11),
// so live-drained events extend the log in month order.
// ---------------------------------------------------------------------------

const wsId = newWorkspaceId()
const meUserId = newUserId()
const otherUserId = newUserId()
const deviceId = newDeviceId()
const sMeta = newStreamId()
const sGeneral = newStreamId()
const sRandom = newStreamId()
const fileIdCached = newFileId()
const fileIdUncached = newFileId()
const UNCACHED_SHA = 'b'.repeat(64)
const CACHED_BYTES = new Uint8Array([10, 20, 30, 40, 50])

/** The secret under test: must NEVER appear anywhere in the workspace folder. */
const TOKEN = 'tok_SECRET_M6_exit_gate_do_not_leak_1f2e3d'
/** Positive control: a string that MUST appear (proves the scan reads content). */
const CONTROL_TEXT = 'offline search target'

/** Wrap a hashed body into the served wire envelope at (seq, received_at). */
async function serve(body: Body, seq: number, receivedAt: string): Promise<WireEvent> {
  return {
    body: body as unknown as EventBody,
    event_hash: await hashEvent(body),
    signature: null,
    server: {
      server_sequence: seq,
      server_received_at: receivedAt,
      payload_redacted: false,
    },
  }
}

function at(month: string, second: number): string {
  return `${month}-05T10:00:${String(second).padStart(2, '0')}.000Z`
}

const common = {
  workspace_id: wsId,
  author_user_id: meUserId,
  author_device_id: deviceId,
}

/**
 * Seed: 3 streams (meta + 2 channels), 2 months, edits/reactions/deletes,
 * one file whose bytes get cached locally ("viewed while online") and one
 * never viewed, plus a message referencing the cached file. 12 events total.
 */
async function seedServer(server: FakeSyncServer, cachedSha: string): Promise<{ total: number }> {
  server.addStream({ stream_id: sMeta, kind: 'workspace-meta', name: null })
  server.addStream({ stream_id: sGeneral, name: 'general' })
  server.addStream({ stream_id: sRandom, name: 'random' })

  // workspace-meta: the two channel.created records.
  server.append(sMeta, [
    await serve(
      buildChannelCreatedBody({
        ...common,
        stream_id: sMeta,
        client_created_at: at('2023-08', 0),
        channel_stream_id: sGeneral,
        name: 'general',
        visibility: 'public',
      }),
      1,
      at('2023-08', 0),
    ),
    await serve(
      buildChannelCreatedBody({
        ...common,
        stream_id: sMeta,
        client_created_at: at('2023-08', 1),
        channel_stream_id: sRandom,
        name: 'random',
        visibility: 'public',
      }),
      2,
      at('2023-08', 1),
    ),
  ])

  // general: creates in 2023-08, then a reaction, an edit, a delete and a
  // reaction-remove rolling into 2023-09 (multi-month within one stream).
  const msgA = buildMessageCreatedBody({
    ...common,
    stream_id: sGeneral,
    client_created_at: at('2023-08', 2),
    text: 'first — héllo 😀',
  })
  const msgB = buildMessageCreatedBody({
    ...common,
    stream_id: sGeneral,
    author_user_id: otherUserId,
    client_created_at: at('2023-08', 3),
    text: 'second',
  })
  const idA = (msgA.payload as { message_id: string }).message_id
  const idB = (msgB.payload as { message_id: string }).message_id
  server.append(sGeneral, [
    await serve(msgA, 1, at('2023-08', 2)),
    await serve(msgB, 2, at('2023-08', 3)),
    await serve(
      buildReactionAddedBody({
        ...common,
        stream_id: sGeneral,
        client_created_at: at('2023-08', 4),
        message_id: idA,
        emoji: '👍',
      }),
      3,
      at('2023-08', 4),
    ),
    await serve(
      buildMessageEditedBody({
        ...common,
        stream_id: sGeneral,
        author_user_id: otherUserId,
        client_created_at: at('2023-09', 0),
        message_id: idB,
        text: 'second (edited)',
      }),
      4,
      at('2023-09', 0),
    ),
    await serve(
      buildMessageDeletedBody({
        ...common,
        stream_id: sGeneral,
        client_created_at: at('2023-09', 1),
        message_id: idA,
      }),
      5,
      at('2023-09', 1),
    ),
    await serve(
      buildReactionRemovedBody({
        ...common,
        stream_id: sGeneral,
        client_created_at: at('2023-09', 2),
        message_id: idA,
        emoji: '👍',
      }),
      6,
      at('2023-09', 2),
    ),
  ])

  // random: the FTS anchor message (also the byte-scan positive control), a
  // file upload whose bytes will be cached, a referencing message, and a file
  // never viewed (offline `file.fetch` must degrade to the coded error).
  server.append(sRandom, [
    await serve(
      buildMessageCreatedBody({
        ...common,
        stream_id: sRandom,
        client_created_at: at('2023-08', 5),
        text: CONTROL_TEXT,
      }),
      1,
      at('2023-08', 5),
    ),
    await serve(
      buildFileUploadedBody({
        ...common,
        stream_id: sRandom,
        client_created_at: at('2023-08', 6),
        file_id: fileIdCached,
        sha256: cachedSha,
        name: 'photo.bin',
        mime_type: 'application/octet-stream',
        size_bytes: CACHED_BYTES.length,
      }),
      2,
      at('2023-08', 6),
    ),
    await serve(
      buildMessageCreatedBody({
        ...common,
        stream_id: sRandom,
        client_created_at: at('2023-09', 3),
        text: 'with attachment',
        file_ids: [fileIdCached],
      }),
      3,
      at('2023-09', 3),
    ),
    await serve(
      buildFileUploadedBody({
        ...common,
        stream_id: sRandom,
        client_created_at: at('2023-09', 4),
        file_id: fileIdUncached,
        sha256: UNCACHED_SHA,
        name: 'never-viewed.bin',
        mime_type: 'application/octet-stream',
        size_bytes: 9,
      }),
      4,
      at('2023-09', 4),
    ),
  ])
  return { total: 12 }
}

/** Extend a stream with `count` more valid message.created events in `month`. */
async function extendStream(
  server: FakeSyncServer,
  streamId: string,
  from: number,
  count: number,
  month: string,
): Promise<void> {
  const events: WireEvent[] = []
  for (let i = 0; i < count; i++) {
    const seq = from + i
    const body = buildMessageCreatedBody({
      ...common,
      stream_id: streamId,
      client_created_at: at(month, 10 + i),
      text: `extension ${seq}`,
    })
    events.push(await serve(body, seq, at(month, 10 + i)))
  }
  server.append(streamId, events)
}

// ---------------------------------------------------------------------------
// Harness — REAL WorkerCore over SqliteDb + Node-fs seams + SecretStore
// ---------------------------------------------------------------------------

interface Harness {
  core: WorkerCore
  http: OfflineSwitchHttp
  ws: ReturnType<typeof makeFakeWsFactory>
  frames: Array<{ clientId: string; msg: FromWorker }>
}

let root: string
let db: SqliteDb
let server: FakeSyncServer
let blobCache: NodeBlobCache
const secrets = new MemorySecretStore()
let warnSpy: ReturnType<typeof vi.spyOn>

function boot(online: boolean): Harness {
  const mirror = new WorkspaceMirror(new NodeEventLog(root), new NodeManifestStore(root), {
    workspaceId: wsId,
    workspaceName: 'acme',
    myUserId: meUserId,
    deviceId,
  })
  const http = new OfflineSwitchHttp(new FakeHttpClient(server))
  http.online = online
  const ws = makeFakeWsFactory()
  const { sink, frames } = collectingSink()
  const core = new WorkerCore(db, sink, {
    http,
    wsFactory: ws.wsFactory,
    fullMirror: true,
    mirror,
    blobStore: blobCache,
    secretStore: secrets, // M6-4: the token rests OUTSIDE the folder
    isOnline: () => http.online,
  })
  return { core, http, ws, frames }
}

/** Boot a live session: init (restores the seeded session → sync.start) + open WS. */
async function bootOnline(): Promise<Harness> {
  const h = boot(true)
  await h.core.init()
  h.ws.last().open()
  return h
}

let rpcN = 0
async function rpc(
  h: Harness,
  req: RpcRequest,
): Promise<{ ok: true; result: unknown } | { ok: false; error: RpcError }> {
  const id = `r${++rpcN}`
  await h.core.handle('gate', { t: 'req', id, clientId: 'gate', req })
  const frame = h.frames.find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!frame || frame.t !== 'res') throw new Error(`no rpc response for ${req.method}`)
  return frame
}

async function rpcOk(h: Harness, req: RpcRequest): Promise<unknown> {
  const res = await rpc(h, req)
  if (!res.ok) throw new Error(`${req.method} failed: ${JSON.stringify(res.error)}`)
  return res.result
}

async function rpcErrCode(h: Harness, req: RpcRequest): Promise<string> {
  const res = await rpc(h, req)
  if (res.ok) throw new Error(`${req.method} unexpectedly succeeded`)
  return res.error.code
}

async function stopSync(h: Harness): Promise<void> {
  await rpcOk(h, { method: 'sync.stop', params: {} })
}

async function cursorAt(streamId: string, seq: number): Promise<boolean> {
  return (await db.getCursor(streamId))?.last_contiguous_seq === seq
}

function logSeqs(streamId: string, month: string): number[] {
  const text = readFileSync(join(root, 'streams', streamId, `${month}.ndjson`), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { server: { server_sequence: number } }).server.server_sequence)
}

function allLogSeqs(streamId: string, months: string[]): number[] {
  return months.flatMap((m) => logSeqs(streamId, m))
}

/** Every file under `dir` (recursive) whose RAW BYTES contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = []
  const walk = (p: string): void => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (readFileSync(full).includes(needle)) hits.push(full)
    }
  }
  walk(dir)
  return hits
}

// ---------------------------------------------------------------------------
// The gate — one flow, assertions 1..5 in order, then the durability teeth.
// ---------------------------------------------------------------------------

describe.skipIf(!uvAvailable)(
  'test_m6_exit_gate — M6 exit gate: full-mirror + offline + verify-green folder',
  () => {
    let hOffline: Harness

    beforeAll(async () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      // Node env has no `location`; WorkerCore's SyncEngine derives the WS URL
      // from it (the fake ws factory never dials, so any origin works).
      vi.stubGlobal('location', { protocol: 'http:', host: 'gate.test' })
      root = mkdtempSync(join(tmpdir(), 'msg-m6-exit-gate-'))
      // The projections DB lives AT the workspace root, exactly like the desktop
      // will place it — msgctl verify explicitly ignores root projections.sqlite3.
      db = await openSqliteDb(join(root, 'projections.sqlite3'))
      blobCache = new NodeBlobCache(root)

      // Session seed: identity in meta (non-secret), the TOKEN in the SecretStore.
      await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION)
      await secrets.set(META_SESSION_TOKEN, TOKEN)
      await db.metaPut(META_MY_USER_ID, meUserId)
      await db.metaPut(META_WORKSPACE_ID, wsId)
      await db.metaPut(META_ROLE, 'member')
      await db.metaPut(META_SESSION_EXPIRES_AT, '2099-01-01T00:00:00Z')
      await db.metaPut(META_DEVICE_ID, deviceId)

      server = new FakeSyncServer()
      await seedServer(server, await sha256Hex(CACHED_BYTES))
    }, 60_000)

    afterAll(async () => {
      warnSpy.mockRestore()
      vi.unstubAllGlobals()
      await db.close()
      rmSync(root, { recursive: true, force: true })
    })

    // -----------------------------------------------------------------------
    // ONLINE SEED + ASSERTION 1 — verify-green mirrored folder
    // -----------------------------------------------------------------------

    it('ONLINE SEED: live full-mirror sync writes the on-disk workspace (NDJSON ≡ events)', async () => {
      const h = await bootOnline()
      await untilAsync(
        async () =>
          (await cursorAt(sMeta, 2)) &&
          (await cursorAt(sGeneral, 6)) &&
          (await cursorAt(sRandom, 4)),
      )
      await stopSync(h)

      // On-disk layout: registered manifest + month-split logs.
      expect(existsSync(join(root, 'workspace.json'))).toBe(true)
      expect(allLogSeqs(sGeneral, ['2023-08', '2023-09'])).toEqual([1, 2, 3, 4, 5, 6])
      expect(logSeqs(sGeneral, '2023-08')).toEqual([1, 2, 3])
      expect(logSeqs(sRandom, '2023-08')).toEqual([1, 2])

      // events table ≡ the parsed NDJSON lines (same envelopes, same order) and
      // each line byte-equals the canonical serializer output.
      const log = new NodeEventLog(root)
      for (const sid of [sMeta, sGeneral, sRandom]) {
        const lines = await log.readAll(sid)
        const events = await db.getEventsForStream(sid)
        expect(lines.length).toBe(events.length)
        lines.forEach((line, i) => {
          expect(JSON.parse(line)).toEqual(events[i]?.envelope)
          expect(line + '\n').toBe(eventNdjsonLine(events[i]!.envelope!))
        })
      }

      // The "user viewed this attachment while online" state — the M6-3 tee's
      // outcome, written through the same content-addressed store it fills.
      await blobCache.put(await sha256Hex(CACHED_BYTES), CACHED_BYTES)
      expect(await blobCache.has(await sha256Hex(CACHED_BYTES))).toBe(true)
    }, 120_000)

    it('ASSERTION 1: msgctl verify exits 0 with zero failures on the mirrored folder', () => {
      const { status, report } = msgctlVerify(root)
      expect(report.findings.filter((f) => f.severity === 'failure')).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.summary.failures).toBe(0)
      expect(report.summary.events).toBe(12)
      expect(report.summary.streams).toBe(3)
      expect(report.workspace_id).toBe(wsId)
      expect(status).toBe(0)
    }, 120_000)

    // -----------------------------------------------------------------------
    // ASSERTION 2 — true offline: SQLite reads, FTS5 search, queued send
    // -----------------------------------------------------------------------

    it('ASSERTION 2a: cold OFFLINE boot restores the session from the SecretStore, no dial', async () => {
      hOffline = boot(false)
      await hOffline.core.init()

      expect(hOffline.ws.sockets).toHaveLength(0) // never dialed
      const status = (await rpcOk(hOffline, { method: 'auth.status', params: {} })) as {
        ok: boolean
        status: { authenticated: boolean; my_user_id?: string }
      }
      expect(status.status.authenticated).toBe(true)
      expect(status.status.my_user_id).toBe(meUserId)

      const sync = (await rpcOk(hOffline, { method: 'sync.status', params: {} })) as SyncStatus
      expect(sync.state).toBe('degraded')
      expect(sync.online).toBe(false)
    })

    it('ASSERTION 2b: offline, every query verb answers from SQLite (full-mirror history)', async () => {
      const streams = (await rpcOk(hOffline, {
        method: 'query',
        params: { q: 'streams.list' },
      })) as StreamsListResult
      expect(streams.streams.map((s) => s.stream_id).sort()).toEqual(
        [sGeneral, sMeta, sRandom].sort(),
      )

      // The multi-month general history folded correctly: the edit landed…
      const general = (await rpcOk(hOffline, {
        method: 'query',
        params: { q: 'messages.list', stream_id: sGeneral },
      })) as MessagesListResult
      expect(general.messages.map((m) => m.text)).toContain('second (edited)')
      // …and the deleted message serves no content.
      expect(general.messages.map((m) => m.text)).not.toContain('first — héllo 😀')

      const messages = (await rpcOk(hOffline, {
        method: 'query',
        params: { q: 'messages.list', stream_id: sRandom },
      })) as MessagesListResult
      expect(messages.messages.map((m) => m.text)).toContain(CONTROL_TEXT)
      const anchor = messages.messages.find((m) => m.text === CONTROL_TEXT)
      if (!anchor) throw new Error('anchor message missing')

      // The full local read surface — each verb must ANSWER offline (ok frame).
      const queries: QueryParams[] = [
        { q: 'message.get', message_id: anchor.message_id },
        { q: 'directory.list' },
        { q: 'workspace.info' },
        { q: 'files.list' },
        { q: 'attachments.forMessage', message_id: anchor.message_id },
        { q: 'messages.reactions', message_ids: [anchor.message_id] },
        { q: 'messages.threads', root_message_ids: [anchor.message_id] },
        { q: 'messages.thread', root_message_id: anchor.message_id },
      ]
      for (const params of queries) {
        await rpcOk(hOffline, { method: 'query', params })
      }

      const files = (await rpcOk(hOffline, {
        method: 'query',
        params: { q: 'files.list' },
      })) as { files: { file_id: string }[] }
      expect(files.files.map((f) => f.file_id).sort()).toEqual(
        [fileIdCached, fileIdUncached].sort(),
      )
    })

    it('ASSERTION 2c: offline, `search` answers from local FTS5 with zero network', async () => {
      const result = (await rpcOk(hOffline, {
        method: 'search',
        params: { q: 'target' },
      })) as SearchResult
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]?.text).toBe(CONTROL_TEXT)
      expect(hOffline.http.inner.countGets('/v1/search')).toBe(0)
    })

    it('ASSERTION 2d: offline, a send QUEUES; the pending row renders; readState.mark advances locally', async () => {
      const send = (await rpcOk(hOffline, {
        method: 'mutate',
        params: { m: 'outbox.send', stream_id: sGeneral, text: 'sent while offline' },
      })) as SendResult
      expect(send.message_id).toBeTruthy()
      expect(await db.count('outbox')).toBe(1)

      const messages = (await rpcOk(hOffline, {
        method: 'query',
        params: { q: 'messages.list', stream_id: sGeneral },
      })) as MessagesListResult
      const pending = messages.messages.find((m) => m.message_id === send.message_id)
      expect(pending?.state).toBe('pending')

      const marked = (await rpcOk(hOffline, {
        method: 'readState.mark',
        params: { stream_id: sGeneral, last_read_seq: 6 },
      })) as { stream_id: string; last_read_seq: number }
      expect(marked).toEqual({ stream_id: sGeneral, last_read_seq: 6 })
      expect((await db.getReadState(sGeneral))?.last_read_seq).toBe(6)

      // Ephemeral signals stay structural no-ops offline — never an error.
      expect(
        await rpcOk(hOffline, { method: 'typing.send', params: { stream_id: sGeneral } }),
      ).toEqual({ ok: true })
    })

    it('offline degradation matrix: server-required verbs return the CODED `offline` error', async () => {
      expect(await rpcErrCode(hOffline, { method: 'admin.members.list', params: {} })).toBe(
        'offline',
      )
      expect(await rpcErrCode(hOffline, { method: 'admin.invites.list', params: {} })).toBe(
        'offline',
      )
      expect(
        await rpcErrCode(hOffline, {
          method: 'admin.invites.create',
          params: { role: 'member' },
        }),
      ).toBe('offline')
      expect(await rpcErrCode(hOffline, { method: 'me.get', params: {} })).toBe('offline')
      expect(
        await rpcErrCode(hOffline, {
          method: 'me.update',
          params: { display_name: 'New Name' },
        }),
      ).toBe('offline')
      // An attachment never viewed online → its bytes are simply not here.
      expect(
        await rpcErrCode(hOffline, {
          method: 'file.fetch',
          params: { file_id: fileIdUncached, variant: 'blob' },
        }),
      ).toBe('offline')
    })

    it('offline: a previously-viewed attachment serves from the content-addressed store', async () => {
      const result = (await rpcOk(hOffline, {
        method: 'file.fetch',
        params: { file_id: fileIdCached, variant: 'blob' },
      })) as { blob: Blob | null; mime_type?: string }
      expect(result.blob).not.toBeNull()
      expect(result.blob?.size).toBe(CACHED_BYTES.length)
      expect(result.mime_type).toBe('application/octet-stream')
      expect(hOffline.http.inner.getBlobCalls).toHaveLength(0)
    })

    // -----------------------------------------------------------------------
    // ASSERTION 3 — reconnect: drain, NDJSON append, still verify-green
    // -----------------------------------------------------------------------

    it('ASSERTION 3: reconnect drains the outbox, appends to NDJSON, re-pushes the read marker', async () => {
      hOffline.http.online = true
      hOffline.core.notifyOnline() // degraded → connecting (dials the fake ws)
      hOffline.ws.last().open() // → syncing → live → rising edge

      // Rising edge into live: the queued send drains…
      await untilAsync(async () => (await db.count('outbox')) === 0)
      // …and the offline read marker re-pushes (server had never seen it).
      await untilAsync(() => Promise.resolve(server.readState.get(sGeneral) === 6))

      // The server echoes the accepted event over WS (as it does to every
      // connection of the workspace) — the mirror appends it durably.
      const wire = server.events(sGeneral)[6]
      if (!wire) throw new Error('drained event not on the server')
      hOffline.ws.last().emitEvent(wire)
      await untilAsync(async () => cursorAt(sGeneral, 7))

      const messages = (await rpcOk(hOffline, {
        method: 'query',
        params: { q: 'messages.list', stream_id: sGeneral },
      })) as MessagesListResult
      const sent = messages.messages.find((m) => m.text === 'sent while offline')
      expect(sent?.state).toBeUndefined() // settled, no longer pending
      expect(sent?.created_seq).toBe(7)

      await stopSync(hOffline)

      // The on-disk log now carries the offline-composed event, gapless
      // (the fake server accepts batches into 2023-11 — a new month file).
      const log = new NodeEventLog(root)
      const seqs = (await log.readAll(sGeneral)).map(
        (l) => (JSON.parse(l) as { server: { server_sequence: number } }).server.server_sequence,
      )
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7])
    }, 60_000)

    it('ASSERTION 3 (cont.): the folder STILL verifies — msgctl verify exit 0', () => {
      const { status, report } = msgctlVerify(root)
      expect(report.findings.filter((f) => f.severity === 'failure')).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.summary.failures).toBe(0)
      expect(report.summary.events).toBe(13) // 12 seeded + the offline-composed send
      expect(report.summary.streams).toBe(3)
      expect(report.workspace_id).toBe(wsId)
      expect(status).toBe(0)
    }, 120_000)

    // -----------------------------------------------------------------------
    // ASSERTION 4 — rebuild-from-disk ≡ incremental (invariant-6, on-disk log)
    // -----------------------------------------------------------------------

    it('ASSERTION 4: rebuild-from-disk ≡ incremental (dumpMessages/dumpFiles byte-equal)', async () => {
      const messagesBefore = await dumpMessages(db)
      const filesBefore = await dumpFiles(db)
      expect(messagesBefore.length).toBeGreaterThan(0)
      expect(filesBefore.length).toBeGreaterThan(0)

      // A fresh core over the same stores (no live sync needed for the rebuild).
      const h = boot(true)
      const result = await h.core.rebuildFromDisk()
      expect(result.events).toBe(13)
      expect(result.streams).toBe(3)

      expect(await dumpMessages(db)).toBe(messagesBefore) // byte-equal
      expect(await dumpFiles(db)).toBe(filesBefore) // byte-equal
    }, 60_000)

    it('rebuild-from-disk fails closed on a tampered log (hash re-verified)', async () => {
      const tamperRoot = mkdtempSync(join(tmpdir(), 'msg-m6-tamper-'))
      try {
        // Copy general's 2023-08 log but flip a body byte without re-hashing.
        const src = readFileSync(join(root, 'streams', sGeneral, '2023-08.ndjson'), 'utf8')
        const tampered = src.replace('"text":"second"', '"text":"tampered"')
        expect(tampered).not.toBe(src)
        const dir = join(tamperRoot, 'streams', sGeneral)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, '2023-08.ndjson'), tampered)

        const tamperDb = await openSqliteDb(':memory:')
        const mirror = new WorkspaceMirror(
          new NodeEventLog(tamperRoot),
          new NodeManifestStore(tamperRoot),
          { workspaceId: wsId, workspaceName: 'acme', myUserId: meUserId, deviceId },
        )
        const { sink } = collectingSink()
        const core = new WorkerCore(tamperDb, sink, {
          http: new FakeHttpClient(server),
          wsFactory: makeFakeWsFactory().wsFactory,
          fullMirror: true,
          mirror,
        })
        await expect(core.rebuildFromDisk()).rejects.toThrow(/event_hash mismatch/)
        await tamperDb.close()
      } finally {
        rmSync(tamperRoot, { recursive: true, force: true })
      }
    }, 60_000)

    // -----------------------------------------------------------------------
    // Durability teeth (from the M6-3 gate) — each re-proves verify exit 0
    // -----------------------------------------------------------------------

    it('crash between NDJSON fsync and cursor persist converges on restart — no duplicates', async () => {
      // The append-then-cursor ordering means a crash leaves exactly this state:
      // the log durably holds 1..7 while the persisted cursor is behind at 5.
      await db.putCursors([{ stream_id: sGeneral, last_contiguous_seq: 5, oldest_loaded_seq: 1 }])
      await extendStream(server, sGeneral, 8, 2, '2023-12') // arrives while "down"

      // Restart: a brand-new core + a brand-new mirror over the same disk (cold
      // caches — the resume head must come from the log itself).
      const h = await bootOnline()
      await untilAsync(async () => cursorAt(sGeneral, 9))
      await stopSync(h)

      const seqs = allLogSeqs(sGeneral, ['2023-08', '2023-09', '2023-11', '2023-12'])
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]) // deduped, gapless, extended
      const { status, report } = msgctlVerify(root)
      expect(report.summary.failures).toBe(0)
      expect(report.summary.events).toBe(15)
      expect(status).toBe(0)
    }, 120_000)

    it('repairs a torn trailing line (interrupted append) and stays verify-green', async () => {
      // A crash mid-write leaves a partial, unterminated line at the log tail.
      appendFileSync(join(root, 'streams', sRandom, '2023-09.ndjson'), '{"body":{"event_id":"01')
      await extendStream(server, sRandom, 5, 1, '2023-12')

      const h = await bootOnline()
      await untilAsync(async () => cursorAt(sRandom, 5))
      await stopSync(h)

      // The torn tail was truncated before the new append — no garbage line.
      expect(allLogSeqs(sRandom, ['2023-08', '2023-09', '2023-12'])).toEqual([1, 2, 3, 4, 5])
      const { status, report } = msgctlVerify(root)
      expect(report.summary.failures).toBe(0)
      expect(report.summary.events).toBe(16)
      expect(status).toBe(0)
    }, 120_000)

    // -----------------------------------------------------------------------
    // ASSERTION 5 — no secrets in the folder (runs LAST, over every byte the
    // whole flow ever wrote: NDJSON, workspace.json, blobs, sqlite + WAL).
    // -----------------------------------------------------------------------

    it('ASSERTION 5: the session token appears NOWHERE in the workspace folder', () => {
      // Positive control first — the scan demonstrably reads real content
      // (the message text lives in the NDJSON log and the projections DB).
      expect(filesContaining(root, CONTROL_TEXT).length).toBeGreaterThan(0)
      // The token is in the SecretStore only — zero hits across every byte of
      // every file, including projections.sqlite3 and its WAL sidecars.
      expect(filesContaining(root, TOKEN)).toEqual([])
    })
  },
)
