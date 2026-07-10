// @vitest-environment node
//
// M6-3 (ENG-167) — THE HEADLESS GATE: drive the REAL WorkerCore + SyncEngine in
// full-mirror mode (SqliteDb + the Node-fs mirror seams — the desktop stack
// minus Tauri) against a FakeSyncServer seeded with multiple streams, multiple
// months, and edits/reactions/deletes, into a temp directory — then spawn the
// REAL `msgctl verify --json <dir>` and assert exit code 0 with zero failures.
//
// Also gated here:
//   • events-table ≡ NDJSON: the parsed log lines are exactly the stored
//     envelopes, in order, and each line byte-equals `eventNdjsonLine`.
//   • rebuild-from-disk ≡ incremental (invariant 6 EXTENDED to the on-disk
//     log): dumpMessages/dumpFiles byte-equal across `core.rebuildFromDisk()`.
//   • crash-resume: a crash between the NDJSON fsync and the cursor persist
//     (simulated by regressing the cursor) converges on restart with no
//     duplicate lines — and verify stays exit 0.
//   • torn-tail repair: a partial trailing line (interrupted append) is
//     truncated on the next open, appends continue cleanly, verify exit 0.
//
// TOOLCHAIN GATING: spawning msgctl needs `uv` (the repo's Python runner, the
// same entrypoint the CLI e2e suite uses). Where uv is absent the suite
// self-skips — EXCEPT under CI, where it hard-fails instead: the gate must
// never silently vanish from the pipeline (the web CI job installs uv for it).
// Run locally from web/:  pnpm test tests/integration/m6-workspace-mirror.spec.ts

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  type Body,
} from '../../src/core'
import { WorkerCore } from '../../src/worker/core'
import { NodeEventLog, NodeManifestStore } from '../../src/worker/mirror/node-fs'
import { eventNdjsonLine } from '../../src/worker/mirror/serialize'
import { WorkspaceMirror } from '../../src/worker/mirror/workspace-mirror'
import { dumpFiles, dumpMessages } from '../../src/worker/projection'
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
  // The M6-3 gate MUST run in CI. If uv is missing there, fail loudly rather
  // than skip — a silently-skipped verify gate is a hole in the invariant wall.
  throw new Error(
    'm6-workspace-mirror gate: `uv` is not on PATH under CI. The web CI job must ' +
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
// Workspace seed — real typed ULIDs (msgctl verify validates envelope shape)
// ---------------------------------------------------------------------------

const wsId = newWorkspaceId()
const meUserId = newUserId()
const otherUserId = newUserId()
const deviceId = newDeviceId()
const sMeta = newStreamId()
const sGeneral = newStreamId()
const sRandom = newStreamId()
const FILE_SHA = 'a'.repeat(64)

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

/** Seed: 3 streams (meta + 2 channels), 2 months, edits/reactions/deletes/files. */
async function seedServer(server: FakeSyncServer): Promise<{ total: number }> {
  server.addStream({ stream_id: sMeta, kind: 'workspace-meta', name: null })
  server.addStream({ stream_id: sGeneral, name: 'general' })
  server.addStream({ stream_id: sRandom, name: 'random' })

  // workspace-meta: the two channel.created records.
  server.append(sMeta, [
    await serve(
      buildChannelCreatedBody({
        ...common,
        stream_id: sMeta,
        client_created_at: at('2026-01', 0),
        channel_stream_id: sGeneral,
        name: 'general',
        visibility: 'public',
      }),
      1,
      at('2026-01', 0),
    ),
    await serve(
      buildChannelCreatedBody({
        ...common,
        stream_id: sMeta,
        client_created_at: at('2026-01', 1),
        channel_stream_id: sRandom,
        name: 'random',
        visibility: 'public',
      }),
      2,
      at('2026-01', 1),
    ),
  ])

  // general: creates in 2026-01, then a reaction, an edit, a delete and a
  // reaction-remove rolling into 2026-02 (multi-month within one stream).
  const msgA = buildMessageCreatedBody({
    ...common,
    stream_id: sGeneral,
    client_created_at: at('2026-01', 2),
    text: 'first — héllo 😀',
  })
  const msgB = buildMessageCreatedBody({
    ...common,
    stream_id: sGeneral,
    author_user_id: otherUserId,
    client_created_at: at('2026-01', 3),
    text: 'second',
  })
  const idA = (msgA.payload as { message_id: string }).message_id
  const idB = (msgB.payload as { message_id: string }).message_id
  server.append(sGeneral, [
    await serve(msgA, 1, at('2026-01', 2)),
    await serve(msgB, 2, at('2026-01', 3)),
    await serve(
      buildReactionAddedBody({
        ...common,
        stream_id: sGeneral,
        client_created_at: at('2026-01', 4),
        message_id: idA,
        emoji: '👍',
      }),
      3,
      at('2026-01', 4),
    ),
    await serve(
      buildMessageEditedBody({
        ...common,
        stream_id: sGeneral,
        author_user_id: otherUserId,
        client_created_at: at('2026-02', 0),
        message_id: idB,
        text: 'second (edited)',
      }),
      4,
      at('2026-02', 0),
    ),
    await serve(
      buildMessageDeletedBody({
        ...common,
        stream_id: sGeneral,
        client_created_at: at('2026-02', 1),
        message_id: idA,
      }),
      5,
      at('2026-02', 1),
    ),
    await serve(
      buildReactionRemovedBody({
        ...common,
        stream_id: sGeneral,
        client_created_at: at('2026-02', 2),
        message_id: idA,
        emoji: '👍',
      }),
      6,
      at('2026-02', 2),
    ),
  ])

  // random: a message, a file upload (dumpFiles coverage), a referencing message.
  const fileId = newFileId()
  const msgC = buildMessageCreatedBody({
    ...common,
    stream_id: sRandom,
    client_created_at: at('2026-01', 5),
    text: 'in random',
  })
  server.append(sRandom, [
    await serve(msgC, 1, at('2026-01', 5)),
    await serve(
      buildFileUploadedBody({
        ...common,
        stream_id: sRandom,
        client_created_at: at('2026-02', 3),
        file_id: fileId,
        sha256: FILE_SHA,
        name: 'notes.txt',
        mime_type: 'text/plain',
        size_bytes: 5,
      }),
      2,
      at('2026-02', 3),
    ),
    await serve(
      buildMessageCreatedBody({
        ...common,
        stream_id: sRandom,
        client_created_at: at('2026-02', 4),
        text: 'with attachment',
        file_ids: [fileId],
      }),
      3,
      at('2026-02', 4),
    ),
  ])
  return { total: 11 }
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
// Harness — REAL WorkerCore over SqliteDb + the Node-fs mirror seams
// ---------------------------------------------------------------------------

interface DesktopHarness {
  core: WorkerCore
  db: SqliteDb
  ws: ReturnType<typeof makeFakeWsFactory>
}

async function bootDesktop(
  server: FakeSyncServer,
  db: SqliteDb,
  root: string,
): Promise<DesktopHarness> {
  const mirror = new WorkspaceMirror(new NodeEventLog(root), new NodeManifestStore(root), {
    workspaceId: wsId,
    workspaceName: 'acme',
    myUserId: meUserId,
    deviceId,
  })
  const http = new FakeHttpClient(server)
  const ws = makeFakeWsFactory()
  const { sink } = collectingSink()
  const core = new WorkerCore(db, sink, {
    http,
    wsFactory: ws.wsFactory,
    fullMirror: true,
    mirror,
  })
  await core.init() // restores the seeded session → sync.start()
  ws.last().open()
  return { core, db, ws }
}

async function seedSession(db: SqliteDb): Promise<void> {
  await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION)
  await db.metaPut(META_SESSION_TOKEN, 'tok_secret')
  await db.metaPut(META_MY_USER_ID, meUserId)
  await db.metaPut(META_WORKSPACE_ID, wsId)
  await db.metaPut(META_ROLE, 'member')
  await db.metaPut(META_SESSION_EXPIRES_AT, '2099-01-01T00:00:00Z')
  await db.metaPut(META_DEVICE_ID, deviceId)
}

async function stopSync(core: WorkerCore): Promise<void> {
  await core.handle('gate', {
    t: 'req',
    id: 'stop',
    clientId: 'gate',
    req: { method: 'sync.stop', params: {} },
  })
}

async function cursorAt(db: SqliteDb, streamId: string, seq: number): Promise<boolean> {
  return (await db.getCursor(streamId))?.last_contiguous_seq === seq
}

function logSeqs(root: string, streamId: string, month: string): number[] {
  const text = readFileSync(join(root, 'streams', streamId, `${month}.ndjson`), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { server: { server_sequence: number } }).server.server_sequence)
}

function allLogSeqs(root: string, streamId: string, months: string[]): number[] {
  return months.flatMap((m) => logSeqs(root, streamId, m))
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe.skipIf(!uvAvailable)(
  'M6-3 headless gate — full-mirror sync ⇒ msgctl verify exit 0',
  () => {
    let root: string
    let db: SqliteDb
    let server: FakeSyncServer
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeAll(async () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      // Node env has no `location`; WorkerCore's SyncEngine derives the WS URL
      // from it (the fake ws factory never dials, so any origin works).
      vi.stubGlobal('location', { protocol: 'http:', host: 'gate.test' })
      root = mkdtempSync(join(tmpdir(), 'msg-m6-mirror-'))
      // The projections DB lives AT the workspace root, exactly like the desktop
      // will place it — msgctl verify explicitly ignores root projections.sqlite3.
      db = await openSqliteDb(join(root, 'projections.sqlite3'))
      await seedSession(db)
      server = new FakeSyncServer()
      await seedServer(server)
    })

    afterAll(async () => {
      warnSpy.mockRestore()
      vi.unstubAllGlobals()
      await db.close()
      rmSync(root, { recursive: true, force: true })
    })

    it('live full-mirror sync writes a verify-green msgctl workspace', async () => {
      const h = await bootDesktop(server, db, root)
      await untilAsync(
        async () =>
          (await cursorAt(db, sMeta, 2)) &&
          (await cursorAt(db, sGeneral, 6)) &&
          (await cursorAt(db, sRandom, 3)),
      )
      await stopSync(h.core)

      // On-disk layout: registered manifest + month-split logs.
      expect(existsSync(join(root, 'workspace.json'))).toBe(true)
      expect(allLogSeqs(root, sGeneral, ['2026-01', '2026-02'])).toEqual([1, 2, 3, 4, 5, 6])
      expect(logSeqs(root, sGeneral, '2026-01')).toEqual([1, 2, 3])
      expect(logSeqs(root, sRandom, '2026-01')).toEqual([1])

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

      // THE GATE: the real msgctl verify walks the dir — exit 0, zero failures.
      const { status, report } = msgctlVerify(root)
      expect(report.findings.filter((f) => f.severity === 'failure')).toEqual([])
      expect(report.ok).toBe(true)
      expect(report.summary.failures).toBe(0)
      expect(report.summary.events).toBe(11)
      expect(report.summary.streams).toBe(3)
      expect(report.workspace_id).toBe(wsId)
      expect(status).toBe(0)
    }, 120_000)

    it('rebuild-from-disk ≡ incremental (invariant 6 extended to the NDJSON log)', async () => {
      const messagesBefore = await dumpMessages(db)
      const filesBefore = await dumpFiles(db)
      expect(messagesBefore.length).toBeGreaterThan(0)
      expect(filesBefore.length).toBeGreaterThan(0)

      // A fresh core over the same stores (no live sync needed for the rebuild).
      const mirror = new WorkspaceMirror(new NodeEventLog(root), new NodeManifestStore(root), {
        workspaceId: wsId,
        workspaceName: 'acme',
        myUserId: meUserId,
        deviceId,
      })
      const { sink } = collectingSink()
      const core = new WorkerCore(db, sink, {
        http: new FakeHttpClient(server),
        wsFactory: makeFakeWsFactory().wsFactory,
        fullMirror: true,
        mirror,
      })
      const result = await core.rebuildFromDisk()
      expect(result.events).toBe(11)
      expect(result.streams).toBe(3)

      expect(await dumpMessages(db)).toBe(messagesBefore) // byte-equal
      expect(await dumpFiles(db)).toBe(filesBefore) // byte-equal
    }, 60_000)

    it('rebuild-from-disk fails closed on a tampered log (hash re-verified)', async () => {
      const tamperRoot = mkdtempSync(join(tmpdir(), 'msg-m6-tamper-'))
      try {
        // Copy general's 2026-01 log but flip a body byte without re-hashing.
        const src = readFileSync(join(root, 'streams', sGeneral, '2026-01.ndjson'), 'utf8')
        const tampered = src.replace('"text":"second"', '"text":"tampered"')
        expect(tampered).not.toBe(src)
        const dir = join(tamperRoot, 'streams', sGeneral)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, '2026-01.ndjson'), tampered)

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

    it('crash between NDJSON fsync and cursor persist converges on restart — no duplicates', async () => {
      // The append-then-cursor ordering means a crash leaves exactly this state:
      // the log durably holds 1..6 while the persisted cursor is behind at 4.
      await db.putCursors([{ stream_id: sGeneral, last_contiguous_seq: 4, oldest_loaded_seq: 1 }])
      await extendStream(server, sGeneral, 7, 2, '2026-03') // arrives while "down"

      // Restart: a brand-new core + a brand-new mirror over the same disk (cold
      // caches — the resume head must come from the log itself).
      const h = await bootDesktop(server, db, root)
      await untilAsync(async () => cursorAt(db, sGeneral, 8))
      await stopSync(h.core)

      const seqs = allLogSeqs(root, sGeneral, ['2026-01', '2026-02', '2026-03'])
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]) // deduped, gapless, extended
      const { status, report } = msgctlVerify(root)
      expect(report.summary.failures).toBe(0)
      expect(report.summary.events).toBe(13)
      expect(status).toBe(0)
    }, 120_000)

    it('repairs a torn trailing line (interrupted append) and stays verify-green', async () => {
      // A crash mid-write leaves a partial, unterminated line at the log tail.
      appendFileSync(join(root, 'streams', sRandom, '2026-02.ndjson'), '{"body":{"event_id":"01')
      await extendStream(server, sRandom, 4, 1, '2026-03')

      const h = await bootDesktop(server, db, root)
      await untilAsync(async () => cursorAt(db, sRandom, 4))
      await stopSync(h.core)

      // The torn tail was truncated before the new append — no garbage line.
      expect(allLogSeqs(root, sRandom, ['2026-01', '2026-02', '2026-03'])).toEqual([1, 2, 3, 4])
      const { status, report } = msgctlVerify(root)
      expect(report.summary.failures).toBe(0)
      expect(report.summary.events).toBe(14)
      expect(status).toBe(0)
    }, 120_000)
  },
)
