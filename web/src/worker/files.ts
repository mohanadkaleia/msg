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
// and `file.uploaded`/`message.created` carry persisted client-minted event_ids the
// server dedups. So a network/timeout/5xx blip retries cleanly — no orphaned files,
// no duplicate events.
//
// OUT OF SCOPE (deliberate): durable resume across a full page reload. The in-memory
// job + `File` handle die on reload; re-selecting the same file hits the
// `upload_needed:false` dedup path and re-emits cheaply. We do NOT persist the (up to
// 50 MB) Blob to IndexedDB. The client PROJECTION of `file.uploaded` is ENG-120; the
// composer chips / thumbnails / progress-bar UI is ENG-121 — this ships the plumbing.

import { sha256Hex } from '../core'

import { backoffDelay, OUTBOX_BASE_MS, OUTBOX_CAP_MS } from './backoff'
import type { ApiError, HttpClient } from './http'
import type { Outbox } from './outbox'
import type { TimerId } from './sync'
import type {
  AuthStatus,
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
  readonly text: string
  readonly format?: 'markdown' | 'plain'
  readonly thread_root_id?: string
  readonly mentions?: string[]
  /** Aborts the in-flight `putBlob` on `file.cancel`. */
  readonly controller: AbortController
  phase: UploadPhase
  sha256?: string
  file_id?: string
  message_id?: string
  event_id?: string
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
}

/** Bounded worker-side blob LRU so repeated renders don't re-GET the same bytes. */
const BLOB_CACHE_MAX = 32

export class FileManager {
  private readonly http: HttpClient
  private readonly outbox: Outbox
  private readonly authStatus: () => AuthStatus
  private readonly publishUpload: (uploadId: string, progress: UploadProgress) => void
  private readonly setTimer: (cb: () => void, ms: number) => TimerId
  private readonly random: () => number

  /** Live jobs by tab-minted `upload_id`. Terminal `done` jobs are dropped; a
   *  `failed` job is KEPT so `file.retry` can restart it. */
  private readonly jobs = new Map<string, UploadJob>()

  /** Worker-side download LRU keyed `file_id:variant` (insertion-order = LRU). */
  private readonly blobCache = new Map<string, { blob: Blob; mimeType: string }>()

  constructor(deps: FileManagerDeps) {
    this.http = deps.http
    this.outbox = deps.outbox
    this.authStatus = deps.authStatus
    this.publishUpload = deps.publishUpload
    this.setTimer =
      deps.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown as TimerId)
    this.random = deps.random ?? Math.random
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
        text: params.text ?? '',
        ...(params.format !== undefined ? { format: params.format } : {}),
        ...(params.thread_root_id !== undefined ? { thread_root_id: params.thread_root_id } : {}),
        ...(params.mentions !== undefined ? { mentions: params.mentions } : {}),
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
          // FIRST the durable file.uploaded log record, THEN the message that
          // references it — both drain in ONE ordered batch (blob already present,
          // so the server's referential check sees a present file, never unknown_file).
          await this.outbox.enqueueFileUploaded({
            stream_id: job.stream_id,
            file_id: job.file_id!,
            sha256: job.sha256!,
            name: job.file.name,
            mime_type: job.file.type || 'application/octet-stream',
            size_bytes: job.file.size,
          })
          const sent = await this.outbox.send({
            m: 'outbox.send',
            stream_id: job.stream_id,
            text: job.text,
            file_ids: [job.file_id!],
            ...(job.format !== undefined ? { format: job.format } : {}),
            ...(job.thread_root_id !== undefined ? { thread_root_id: job.thread_root_id } : {}),
            ...(job.mentions !== undefined ? { mentions: job.mentions } : {}),
          })
          if (job.cancelled) return
          job.message_id = sent.message_id
          job.event_id = sent.event_id
          job.phase = 'done'
          this.enter(job, 'done')
          this.jobs.delete(job.upload_id) // terminal — the tab holds its ids via the push
          return
        }
        default:
          return
      }
    } catch (err) {
      // enqueueFileUploaded / send can throw a coded error (e.g. not_authenticated)
      // or a JCS/build error — all hard failures. Never let the job promise reject.
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
      ...(job.message_id !== undefined ? { message_id: job.message_id } : {}),
      ...(job.event_id !== undefined ? { event_id: job.event_id } : {}),
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
    this.blobCache.delete(key)
    this.blobCache.set(key, value)
    if (this.blobCache.size > BLOB_CACHE_MAX) {
      const oldest = this.blobCache.keys().next().value
      if (oldest !== undefined) this.blobCache.delete(oldest)
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
