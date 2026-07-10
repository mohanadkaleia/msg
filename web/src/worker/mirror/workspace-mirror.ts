// worker/mirror/workspace-mirror.ts — the WorkspaceMirror (M6-3, ENG-167): the
// TypeScript twin of `msgctl pull`'s on-disk mirror (cli/msgctl/sync.py).
//
// When the desktop runs in full-mirror mode, every stream is forward-synced
// gapless-from-1 and this mirror tees the cursor-covered contiguous run of
// each `applyForward` into `<root>/streams/<stream_id>/<YYYY-MM>.ndjson` —
// producing exactly the workspace `msgctl verify` proves (per-event raw-hash
// faithfulness, gapless `server_sequence`, registered-before-written streams).
//
// The three msgctl disciplines mirrored here, precisely:
//
//  1. REGISTRATION-BEFORE-WRITE (`_register_streams`): a stream dir carrying
//     events with no `workspace.json` entry is an `unregistered_stream_dir`
//     verify FAILURE, so `registerStreams` (called on every `/v1/sync`
//     response, before any pull) upserts the manifest atomically FIRST, and
//     `appendApplied` refuses (fail-closed) to write a line for an
//     unregistered stream.
//
//  2. MONTH SPLIT (`_write_page` / `_safe_month`): each event lands in
//     `<server_received_at[:7]>.ndjson`, the month validated against
//     `^\d{4}-\d{2}$` BEFORE it becomes a path component; stream ids are
//     validated as `s_` typed ULIDs (`_safe_stream_id`) at this trust boundary
//     — a hostile server cannot drive path traversal through either.
//
//  3. LOG-DERIVED RESUME (`_resume_seq`): the crash-safety hinge. The engine
//     appends + fsyncs the NDJSON bytes BEFORE persisting the cursor, so a
//     crash in that window leaves a DURABLE log head above a STALE cursor. On
//     restart the engine re-pulls from the stale cursor; this mirror derives
//     its per-stream head from the log itself (scan-on-open, torn tail
//     repaired by the EventLog) and drops every already-durable sequence — so
//     the re-pull can never double-append, and the two stores converge with
//     the log as the source of truth.
//
// The mirror is INERT unless constructed and injected (web builds pass no
// mirror → zero behavior change); its disk access goes through the injected
// seams (`EventLog`/`ManifestStore`), so it is itself pure TS.

import { IdKind, isValidTypedId } from '../../core'
import type { EventRow, SyncStreamMeta } from '../types'

import { eventNdjsonLine } from './serialize'
import type { EventLog, ManifestStore, WorkspaceManifest } from './seams'

/** The reserved manifest name for the workspace-meta stream (msgctl `META_STREAM_NAME`). */
export const META_STREAM_NAME = 'workspace-meta'

/** The month-partition shape `YYYY-MM` — server-supplied, validated before path use. */
const MONTH_RE = /^\d{4}-\d{2}$/

/** msgctl `FORMAT_VERSION` — the `workspace.json` manifest format. */
export const MANIFEST_FORMAT_VERSION = 1

/** The local identity stamped into `workspace.json` (msgctl `LocalAuthor` + workspace row). */
export interface WorkspaceMirrorIdentity {
  /** MUST equal every event body's `workspace_id` — verify cross-checks them. */
  workspaceId: string
  workspaceName: string
  myUserId: string
  deviceId: string
}

/**
 * Validate a server-supplied `stream_id` BEFORE it is used as a path component
 * (the TS `_safe_stream_id`). The raw value is never echoed — only its shape.
 */
function safeStreamId(value: unknown): string {
  if (typeof value === 'string' && isValidTypedId(value, IdKind.STREAM)) return value
  const kind = typeof value === 'string' ? `str[len=${value.length}]` : typeof value
  throw new Error(
    `WorkspaceMirror: server returned a stream_id that is not a valid 's_' typed ULID (${kind}); ` +
      'refusing to use it as a path component',
  )
}

/** Validate the `YYYY-MM` month partition BEFORE path use (the TS `_safe_month`). */
function safeMonth(receivedAt: unknown): string {
  if (typeof receivedAt === 'string') {
    const month = receivedAt.slice(0, 7)
    if (MONTH_RE.test(month)) return month
  }
  throw new Error(
    'WorkspaceMirror: server returned a server_received_at whose YYYY-MM prefix is malformed; ' +
      'refusing to use it as a path component',
  )
}

export class WorkspaceMirror {
  /** Manifest cache — re-read once, then kept in lockstep with our own writes. */
  private manifest: WorkspaceManifest | undefined
  /** Per-stream durable log head (max `server_sequence` on disk), lazily scanned. */
  private readonly heads = new Map<string, number>()
  /** Serializes manifest read-modify-write cycles (bootstrap vs. live registration). */
  private registerQueue: Promise<void> = Promise.resolve()

  constructor(
    /** The durable NDJSON log seam — also the rebuild-from-disk read surface. */
    readonly log: EventLog,
    private readonly store: ManifestStore,
    private readonly identity: WorkspaceMirrorIdentity,
    /** Injectable clock for `created_at` stamps (RFC 3339, ms precision). */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Register every synced stream in `workspace.json` if absent — the TS
   * `_register_streams`. MUST complete before the first NDJSON line of any of
   * these streams is written (verify fails an unregistered stream dir). The
   * whole batch is validated up front (abort before any path use / register),
   * the manifest is re-written atomically only when something was added, and
   * concurrent registrations are serialized.
   */
  registerStreams(streams: readonly SyncStreamMeta[]): Promise<void> {
    const run = this.registerQueue.then(async () => {
      for (const s of streams) safeStreamId(s.stream_id) // validate ALL ids up front
      const manifest = await this.loadManifest()
      let added = false
      for (const s of [...streams].sort((a, b) => (a.stream_id < b.stream_id ? -1 : 1))) {
        const sid = safeStreamId(s.stream_id)
        if (manifest.streams[sid]) continue
        // workspace-meta gets the reserved name (its server name may be null and
        // manifest names must be non-null + unique); a null-named stream (private
        // channel / DM) falls back to its stream id — msgctl's exact rules.
        const name = s.kind === 'workspace-meta' ? META_STREAM_NAME : (s.name ?? sid)
        manifest.streams[sid] = { name, kind: s.kind, created_at: this.now() }
        added = true
      }
      if (added) await this.store.write(manifest)
      this.manifest = manifest
    })
    // Keep the queue alive past a rejection so a later register still runs.
    this.registerQueue = run.catch(() => undefined)
    return run
  }

  /**
   * Append one contiguous, cursor-covered run of verified events to the
   * stream's month files — the applyForward hook. Only ever called with the
   * `applied` run (never stored-but-past-a-gap rows), BEFORE the cursor is
   * persisted (durable-log-first ordering).
   *
   * Crash-safe dedupe: sequences at or below the durable log head are dropped
   * (`_resume_seq` semantics — a stale-cursor re-pull re-delivers them; they
   * must not be re-appended). What remains MUST extend the log exactly at
   * `head+1`, gapless — anything else would corrupt the mirror and is refused
   * fail-closed (the thrown error also stops the cursor from advancing past
   * bytes that never became durable).
   */
  async appendApplied(streamId: string, rows: readonly EventRow[]): Promise<void> {
    if (rows.length === 0) return
    const sid = safeStreamId(streamId)
    const manifest = await this.loadManifest()
    if (!manifest.streams[sid]) {
      // Registration-before-write, enforced fail-closed: verify treats an
      // unregistered stream dir as a FAILURE, so never create one. The engine
      // registers on every /v1/sync; the next bootstrap/refresh re-applies.
      throw new Error(
        `WorkspaceMirror: stream is not registered in workspace.json; ` +
          `refusing to write its log (registration-before-write)`,
      )
    }
    const head = await this.headSeq(sid)
    const fresh = rows.filter((r) => r.server_sequence > head)
    if (fresh.length === 0) return // already durable — a crash-window re-pull
    let expected = head + 1
    for (const row of fresh) {
      if (row.server_sequence !== expected) {
        throw new Error(
          `WorkspaceMirror: refusing a non-contiguous append at seq ${row.server_sequence} ` +
            `(log head ${head}, expected ${expected}) — the on-disk log must stay gapless`,
        )
      }
      expected++
    }
    // Group consecutive same-month lines (received_at is monotonic with seq, so
    // consecutive grouping == per-month grouping) and append batch by batch,
    // advancing the cached head only after each batch is durably fsynced.
    let batchMonth: string | undefined
    let batch: string[] = []
    let batchLastSeq = head
    const flush = async (): Promise<void> => {
      if (batchMonth === undefined || batch.length === 0) return
      await this.log.append(sid, batchMonth, batch)
      this.heads.set(sid, batchLastSeq)
      batch = []
    }
    for (const row of fresh) {
      const env = row.envelope
      if (!env) throw new Error('WorkspaceMirror: applied row is missing its envelope')
      const month = safeMonth(env.server?.server_received_at)
      if (month !== batchMonth) {
        await flush()
        batchMonth = month
      }
      batch.push(eventNdjsonLine(env))
      batchLastSeq = row.server_sequence
    }
    await flush()
  }

  /**
   * The durable log head for a stream: the max `server_sequence` on disk
   * (0 when the stream has no log yet). Lazily derived by scanning the log
   * once (`_resume_seq`); the EventLog repairs a torn trailing line on open,
   * so the head is always a fully-written event.
   */
  async headSeq(streamId: string): Promise<number> {
    const sid = safeStreamId(streamId)
    const cached = this.heads.get(sid)
    if (cached !== undefined) return cached
    const lines = await this.log.readAll(sid)
    let head = 0
    const last = lines[lines.length - 1]
    if (last !== undefined) {
      let seq: unknown
      try {
        const obj = JSON.parse(last) as { server?: { server_sequence?: unknown } }
        seq = obj.server?.server_sequence
      } catch {
        seq = undefined
      }
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
        // Fail closed: a log whose final full line is not a well-formed event is
        // corrupt — never guess a head and append after garbage.
        throw new Error(
          `WorkspaceMirror: cannot derive the log head for a stream ` +
            `(final line is not a well-formed event)`,
        )
      }
      head = seq
    }
    this.heads.set(sid, head)
    return head
  }

  /** Load (once) or lazily create the manifest — msgctl `init_workspace` + `open`. */
  private async loadManifest(): Promise<WorkspaceManifest> {
    if (this.manifest) return this.manifest
    const existing = await this.store.read()
    if (existing) {
      if (existing.workspace_id !== this.identity.workspaceId) {
        // Never write another workspace's mirror (msgctl "refuse to clobber").
        throw new Error('WorkspaceMirror: workspace.json belongs to a different workspace_id')
      }
      this.manifest = existing
      return existing
    }
    const fresh: WorkspaceManifest = {
      format_version: MANIFEST_FORMAT_VERSION,
      workspace_id: this.identity.workspaceId,
      name: this.identity.workspaceName,
      created_at: this.now(),
      local_author: {
        user_id: this.identity.myUserId,
        device_id: this.identity.deviceId,
      },
      streams: {},
    }
    await this.store.write(fresh)
    this.manifest = fresh
    return fresh
  }
}
