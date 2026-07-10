// worker/files.ts — the FileManager: client file upload/download, worker-side
// (ENG-119). The load-bearing security boundary: EVERY `fetch`, the token, and
// every `/v1/files/...` call lives here (behind the injected HttpClient), never in
// a tab module. A tab hands over an opaque `File` (structured clone) and reads back
// only bytes + phase pushes; the session token never crosses the RPC surface (R1).
//
// Upload is a small resumable state machine held IN MEMORY per job:
//   queued → hashing → initiating → uploading → emitting → done
// `uploading` is SKIPPED when initiate reports `upload_needed:false` (the server
// already holds this content — global content-addressed dedup, ENG-115/116). A
// transient blip (network/timeout/5xx) backs off and retries the SAME step; a hard
// failure (413/quota/401/…) parks the job in `failed{code}` for an explicit retry.
//
// Idempotent retry (why a blip at any step is safe): the job holds the `File` for
// its whole life, so it can re-hash/re-PUT; `initiate` is content-addressed (same
// sha → same file_id, never a duplicate file); `putBlob` is idempotent server-side;
// and `file.uploaded` carries a persisted client-minted event_id the server dedups.
// So a network/timeout/5xx blip retries cleanly — no orphaned files, no dup events.
//
// DECOUPLED from message-send (ENG-121, Option A): an upload homes+PUTs the blob and
// enqueues ONLY the durable `file.uploaded` log record (ENG-120 projects it), then
// drives the chip to `done` carrying the resolved `file_id`. It does NOT author a
// `message.created` — the composer collects the `file_id`s of its finished uploads
// and sends ONE `message.created` (referencing all of them) through `outbox.send` on
// Send. This is safe under ENG-117: its `unknown_file` check validates the server
// `files` ROW (present via PUT + homed via initiate), NOT event order — so a message
// sent after each chip reaches `done` always references a present, homed file.
//
// OUT OF SCOPE (deliberate): durable resume across a full page reload. The in-memory
// job + `File` handle die on reload; re-selecting the same file hits the
// `upload_needed:false` dedup path and re-emits cheaply. We do NOT persist the (up to
// 50 MB) Blob to IndexedDB.

import { sha256Hex } from '../core'

import { backoffDelay, OUTBOX_BASE_MS, OUTBOX_CAP_MS } from './backoff'
import type { ApiError, HttpClient } from './http'
import type { Outbox } from './outbox'
import type { TimerId } from './sync'
import type {
  AuthStatus,
  AvatarFetchResult,
  FileFetchResult,
  FileUploadParams,
  UploadAck,
  UploadPhase,
  UploadProgress,
} from './types'

/** The `POST /v1/files/initiate` 200 body (server: schemas/files.py). */
interface FileInitiateResponse {
  file_id: string
  upload_needed: boolean
}

/** In-memory upload job — holds the `File`, the phase, and a per-job abort handle. */
interface UploadJob {
  readonly upload_id: string
  readonly file: File
  readonly stream_id: string
  /** Aborts the in-flight `putBlob` on `file.cancel`. */
  readonly controller: AbortController
  phase: UploadPhase
  sha256?: string
  file_id?: string
  /** Consecutive transient-failure count for the current step → backoff exponent. */
  attempt: number
  retryTimer: TimerId | undefined
  cancelled: boolean
}

/** Everything the FileManager needs, injected → fully unit-testable (no browser). */
export interface FileManagerDeps {
  http: HttpClient
  /** The SAME outbox WorkerCore owns — the emit step enqueues through it. */
  outbox: Outbox
  /** Worker-owned identity snapshot (never from a tab); fail-fast when unauthed. */
  authStatus: () => AuthStatus
  /** Push an upload-progress frame to the tab (`{kind:'upload', upload_id}`). */
  publishUpload: (uploadId: string, progress: UploadProgress) => void
  /** Injectable clock (tests advance backoff timers). */
  setTimeout?: (cb: () => void, ms: number) => TimerId
  /** [0,1) jitter source; inject a stub for deterministic backoff assertions. */
  random?: () => number
  /** Override the download LRU count cap (tests exercise eviction at a small cap). */
  cacheMax?: number
  /** Override the download LRU byte budget (tests exercise the byte-budget path). */
  cacheMaxBytes?: number
}

/**
 * Bounded worker-side blob LRU so repeated renders don't re-GET the same bytes. The
 * cache is bounded on BOTH axes: a COUNT cap and a BYTE budget. Count alone is unsafe
 * — 32 × up-to-50 MB blobs ≈ 1.6 GB — so a byte cap evicts oldest until the total
 * fits a sensible preview/download working set.
 */
const BLOB_CACHE_MAX = 32

/** Byte budget for the download LRU (64 MiB — a reasonable preview working set). */
const BLOB_CACHE_MAX_BYTES = 64 * 1024 * 1024

export class FileManager {
  private readonly http: HttpClient
  private readonly outbox: Outbox
  private readonly authStatus: () => AuthStatus
  private readonly publishUpload: (uploadId: string, progress: UploadProgress) => void
  private readonly setTimer: (cb: () => void, ms: number) => TimerId
  private readonly random: () => number
  private readonly cacheMax: number
  private readonly cacheMaxBytes: number

  /** Live jobs by tab-minted `upload_id`. Terminal `done` jobs are dropped; a
   *  `failed` job is KEPT so `file.retry` can restart it. */
  private readonly jobs = new Map<string, UploadJob>()

  /** Worker-side download LRU keyed `file_id:variant` (insertion-order = LRU). */
  private readonly blobCache = new Map<string, { blob: Blob; mimeType: string }>()
  /** Running sum of `blob.size` across `blobCache` — drives the byte-budget eviction. */
  private cachedBytes = 0

  constructor(deps: FileManagerDeps) {
    this.http = deps.http
    this.outbox = deps.outbox
    this.authStatus = deps.authStatus
    this.publishUpload = deps.publishUpload
    this.setTimer =
      deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown as TimerId)
    this.random = deps.random ?? Math.random
    this.cacheMax = deps.cacheMax ?? BLOB_CACHE_MAX
    this.cacheMaxBytes = deps.cacheMaxBytes ?? BLOB_CACHE_MAX_BYTES
  }

  /** Count of live upload jobs (diagnostic/test read — not part of the RPC surface). */
  get activeUploads(): number {
    return this.jobs.size
  }

  // -- RPC arms (dispatched from WorkerCore) -------------------------------

  /**
   * Start an upload (`file.upload`). Registers the in-memory job and kicks the
   * state machine fire-and-forget (progress arrives on the `{kind:'upload'}` push),
   * returning the ack immediately so the tab's `upload` promise resolves without
   * awaiting the whole transfer. A re-`upload` of a still-live `upload_id` is a
   * no-op ack (the tab minted a fresh id per selection, so this is defensive).
   */
  startUpload(params: FileUploadParams): Promise<UploadAck> {
    if (!this.jobs.has(params.upload_id)) {
      const job: UploadJob = {
        upload_id: params.upload_id,
        file: params.file,
        stream_id: params.stream_id,
        controller: new AbortController(),
        phase: 'queued',
        attempt: 0,
        retryTimer: undefined,
        cancelled: false,
      }
      this.jobs.set(job.upload_id, job)
      void this.pump(job)
    }
    return Promise.resolve({ upload_id: params.upload_id })
  }

  /** Restart a `failed` job from `hashing` (`file.retry`). A no-op ack otherwise. */
  retry(uploadId: string): Promise<UploadAck> {
    const job = this.jobs.get(uploadId)
    if (job && job.phase === 'failed' && !job.cancelled) {
      this.clearRetryTimer(job)
      job.attempt = 0
      job.phase = 'hashing'
      void this.pump(job)
    }
    return Promise.resolve({ upload_id: uploadId })
  }

  /** Abort the in-flight transfer + drop the job (`file.cancel`). Idempotent. */
  cancel(uploadId: string): Promise<UploadAck> {
    const job = this.jobs.get(uploadId)
    if (job) {
      job.cancelled = true
      this.clearRetryTimer(job)
      job.controller.abort()
      this.jobs.delete(uploadId)
    }
    return Promise.resolve({ upload_id: uploadId })
  }

  /**
   * Fetch a file's bytes (`file.fetch`) — the full blob or the server-generated
   * thumbnail. Served from a bounded worker-side LRU so repeated renders don't
   * re-GET; a 404 (absent / unreadable / no thumbnail — the server's uniform
   * not-found) returns a `null` blob and is NOT cached (a later upload can populate
   * it). The token rides the worker-side bearer; only bytes cross back to the tab.
   */
  async fetch(params: {
    file_id: string
    variant: 'blob' | 'thumbnail'
  }): Promise<FileFetchResult> {
    const key = `${params.file_id}:${params.variant}`
    const cached = this.cacheGet(key)
    if (cached) return { blob: cached.blob, mime_type: cached.mimeType }

    const path =
      params.variant === 'thumbnail'
        ? `/v1/files/${params.file_id}/thumbnail`
        : `/v1/files/${params.file_id}`
    const res = await this.http.getBlob(path)
    if (!res.ok) return { blob: null }
    this.cachePut(key, res.value)
    return { blob: res.value.blob, mime_type: res.value.mimeType }
  }

  /**
   * Fetch a member's avatar bytes (`user.avatar`, ENG-152) from the
   * workspace-readable serve endpoint. Shares the bounded download LRU; the
   * cache key includes the DIRECTORY-CARRIED `avatar_sha256`, so a changed
   * avatar (new sha) is a fresh key and re-fetches while the old entry ages
   * out — no stale-face window. A 404 (no avatar / unknown user — the server's
   * uniform not-found) returns a `null` blob and is NOT cached.
   */
  async fetchAvatar(params: {
    user_id: string
    avatar_sha256: string
  }): Promise<AvatarFetchResult> {
    const key = `avatar:${params.user_id}:${params.avatar_sha256}`
    const cached = this.cacheGet(key)
    if (cached) return { blob: cached.blob, mime_type: cached.mimeType }

    const res = await this.http.getBlob(`/v1/users/${params.user_id}/avatar`)
    if (!res.ok) return { blob: null }
    this.cachePut(key, res.value)
    return { blob: res.value.blob, mime_type: res.value.mimeType }
  }

  /**
   * Fetch the caller's OWN workspace icon bytes (`workspace.icon`, ENG-152) from
   * the workspace-readable serve endpoint. Shares the bounded download LRU; the
   * cache key includes the FOLDED `icon_sha256`, so a changed icon (new sha) is a
   * fresh key and re-fetches while the old entry ages out — no stale window. The
   * serve endpoint takes NO parameter (it resolves the caller's own workspace),
   * so `icon_sha256` is only a cache key, never sent. A 404 (no icon — the
   * server's uniform not-found) returns a `null` blob and is NOT cached.
   */
  async fetchWorkspaceIcon(params: { icon_sha256: string }): Promise<AvatarFetchResult> {
    const key = `workspace-icon:${params.icon_sha256}`
    const cached = this.cacheGet(key)
    if (cached) return { blob: cached.blob, mime_type: cached.mimeType }

    const res = await this.http.getBlob('/v1/workspace/icon')
    if (!res.ok) return { blob: null }
    this.cachePut(key, res.value)
    return { blob: res.value.blob, mime_type: res.value.mimeType }
  }

  // -- upload state machine ------------------------------------------------

  /**
   * Run/resume the job from its current `phase` forward. Each completed step
   * advances `phase` and re-enters; each entered step publishes a progress frame. A
   * transient HTTP failure backs off and retries the SAME step (no phase advance); a
   * hard failure parks `failed{code}`. Recursion depth is bounded by the fixed
   * number of phases (≤ 5 tail calls per attempt), so it cannot blow the stack.
   */
  private async pump(job: UploadJob): Promise<void> {
    if (job.cancelled) return
    if (!this.authStatus().authenticated) {
      this.fail(job, 'not_authenticated')
      return
    }
    try {
      switch (job.phase) {
        case 'queued':
        case 'hashing': {
          this.enter(job, 'hashing')
          const buffer = await job.file.arrayBuffer()
          if (job.cancelled) return
          job.sha256 = await sha256Hex(buffer)
          job.phase = 'initiating'
          return await this.pump(job)
        }
        case 'initiating': {
          this.enter(job, 'initiating')
          const res = await this.http.post<FileInitiateResponse>('/v1/files/initiate', {
            sha256: job.sha256,
            name: job.file.name,
            mime_type: job.file.type || 'application/octet-stream',
            size_bytes: job.file.size,
            stream_id: job.stream_id,
          })
          if (job.cancelled) return
          if (!res.ok) return this.onHttpError(job, res.error)
          job.file_id = res.value.file_id
          // Server-side content dedup: the blob is already present, skip the PUT.
          job.phase = res.value.upload_needed ? 'uploading' : 'emitting'
          return await this.pump(job)
        }
        case 'uploading': {
          this.enter(job, 'uploading')
          const res = await this.http.putBlob(`/v1/files/${job.file_id}/blob`, job.file, {
            contentType: job.file.type,
            // No timeout (putBlob default) — a 50 MB upload is bounded only by this
            // per-job signal, aborted by file.cancel.
            signal: job.controller.signal,
          })
          if (job.cancelled) return
          if (!res.ok) return this.onHttpError(job, res.error)
          job.phase = 'emitting'
          return await this.pump(job)
        }
        case 'emitting': {
          this.enter(job, 'emitting')
          // Enqueue ONLY the durable file.uploaded log record (ENG-120 projects it).
          // The upload is DECOUPLED from message-send (ENG-121): the referencing
          // `message.created` is authored later, once, by the composer's `outbox.send`
          // on Send — NOT here. We reach `emitting` only AFTER initiate homed the file
          // row and the PUT flipped it `present` (the prior phases), so by the time the
          // chip is `done` and Send fires, ENG-117's referential check — which
          // validates the `files` ROW (present + homed to this stream), NOT event
          // order — always sees a present, homed file for every referenced `file_id`.
          await this.outbox.enqueueFileUploaded({
            stream_id: job.stream_id,
            file_id: job.file_id!,
            sha256: job.sha256!,
            name: job.file.name,
            mime_type: job.file.type || 'application/octet-stream',
            size_bytes: job.file.size,
          })
          if (job.cancelled) return
          // `done` carries the resolved `file_id` (via the frame builder) — the composer
          // collects these to pass as `file_ids` on Send. No new phase is needed.
          job.phase = 'done'
          this.enter(job, 'done')
          this.jobs.delete(job.upload_id) // terminal — the tab holds file_id via the push
          return
        }
        default:
          return
      }
    } catch (err) {
      // enqueueFileUploaded can throw a coded error (e.g. not_authenticated) or a
      // JCS/build error — all hard failures. Never let the job promise reject.
      this.fail(job, err instanceof Error ? codeOf(err) : 'upload_failed')
    }
  }

  /** Enter `phase`: stamp it on the job and publish the progress frame. */
  private enter(job: UploadJob, phase: UploadPhase): void {
    job.phase = phase
    this.publish(job)
  }

  /** Route an HTTP failure: transient → backoff-retry the same step; hard → fail. */
  private onHttpError(job: UploadJob, error: ApiError): void {
    if (isTransient(error)) {
      this.scheduleRetry(job)
      return
    }
    this.fail(job, error.code)
  }

  /** Park the job in `failed{code}` and publish it (kept for an explicit retry). */
  private fail(job: UploadJob, code: string): void {
    job.phase = 'failed'
    job.attempt = 0
    this.publishUpload(job.upload_id, this.frame(job, code))
  }

  /** Schedule a backoff re-pump of the CURRENT step (shared outbox/sync formula). */
  private scheduleRetry(job: UploadJob): void {
    if (job.retryTimer !== undefined) return
    const delay = backoffDelay(job.attempt, {
      baseMs: OUTBOX_BASE_MS,
      capMs: OUTBOX_CAP_MS,
      random: this.random,
    })
    job.attempt++
    job.retryTimer = this.setTimer(() => {
      job.retryTimer = undefined
      void this.pump(job)
    }, delay)
  }

  private clearRetryTimer(job: UploadJob): void {
    // We only drop the handle — no `clearTimeout` (no clock is injected for that).
    // That is deliberate, not a leak: a timer that fires later re-enters `pump`,
    // whose `if (job.cancelled) return` (and the phase re-check) makes the stale
    // firing a no-op. The cancelled-guard is the real stop, not this.
    job.retryTimer = undefined
  }

  private publish(job: UploadJob): void {
    this.publishUpload(job.upload_id, this.frame(job))
  }

  /** Build a clone-safe progress frame from the job's current known state. */
  private frame(job: UploadJob, code?: string): UploadProgress {
    return {
      upload_id: job.upload_id,
      phase: job.phase,
      ...(job.file_id !== undefined ? { file_id: job.file_id } : {}),
      ...(code !== undefined ? { code } : {}),
    }
  }

  // -- download LRU --------------------------------------------------------

  private cacheGet(key: string): { blob: Blob; mimeType: string } | undefined {
    const hit = this.blobCache.get(key)
    if (!hit) return undefined
    // Touch: re-insert so it becomes most-recently-used.
    this.blobCache.delete(key)
    this.blobCache.set(key, hit)
    return hit
  }

  private cachePut(key: string, value: { blob: Blob; mimeType: string }): void {
    const existing = this.blobCache.get(key)
    if (existing) {
      this.cachedBytes -= existing.blob.size
      this.blobCache.delete(key)
    }
    this.blobCache.set(key, value)
    this.cachedBytes += value.blob.size
    this.evict()
  }

  /**
   * Evict oldest-first until the cache is under BOTH the count cap AND the byte
   * budget. A lone blob larger than the byte budget is kept TRANSIENTLY (the loop
   * stops once only it remains, size === 1) rather than being un-cacheable — the
   * next put displaces it — so an over-budget download still serves from cache once.
   */
  private evict(): void {
    while (
      this.blobCache.size > this.cacheMax ||
      (this.cachedBytes > this.cacheMaxBytes && this.blobCache.size > 1)
    ) {
      const oldest = this.blobCache.keys().next().value
      if (oldest === undefined) break
      const entry = this.blobCache.get(oldest)
      this.blobCache.delete(oldest)
      if (entry) this.cachedBytes -= entry.blob.size
    }
  }
}

/** A transient failure worth a backoff retry: a fetch reject, our timeout, or a 5xx. */
function isTransient(error: ApiError): boolean {
  if (error.code === 'network' || error.code === 'timeout') return true
  return error.status >= 500 && error.status <= 599
}

/** The coded slug of an error thrown by the outbox emit (RpcCodedError carries `.code`). */
function codeOf(err: Error): string {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : 'upload_failed'
}
