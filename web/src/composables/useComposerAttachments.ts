// composables/useComposerAttachments.ts — the composer's pending-attachment strip
// (ENG-121, Option A: upload DECOUPLED from message-send).
//
// A PER-COMPOSER instance (NOT a module-level singleton): the shell mounts two live
// composers — the main channel composer and the thread-pane reply composer — and
// their attachment strips must NOT share state. Each `useComposerAttachments()` call
// owns its own reactive list, tied to the calling component's effect scope.
//
// Flow: `add(files)` mints a local id per File, shows an INSTANT local preview for
// images (`URL.createObjectURL` of the local `File` — no network), and kicks a
// worker upload (`useFileUpload().start`, which enqueues ONLY `file.uploaded`). Each
// chip advances through the upload phases via the progress push; on `done` it holds
// the resolved `file_id`. On Send the composer reads `resolvedFileIds` (populated
// only when every chip is `done`) and passes them to `outbox.send` — the ONE
// `message.created` that references all the attachments.
//
// TOKEN BOUNDARY: this file touches only `useFileUpload` / `client.files.*` (RPC)
// and `URL.createObjectURL/revokeObjectURL` (local blob URLs). No `fetch`, no token,
// no server HTTP API path — the no-http-in-ui guard stays green.

import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'

import { resolveWorkerClient } from './useWorkerClient'
import { useFileUpload } from './useFileUpload'
import type { UploadPhase, UploadProgress } from '../worker'

/** One pending attachment in a composer strip — its local preview + upload state. */
export interface PendingAttachment {
  /** Stable client id (`crypto.randomUUID`) — the render key + the `remove`/`retry` handle. */
  localId: string
  /** The worker-minted upload id (set once `start` resolves) — cancel/retry target. */
  uploadId: string
  /** The opaque local `File` (never re-read here — the worker hashes/PUTs it). */
  file: File
  /** `File.name` — ATTACKER-CONTROLLED; rendered ONLY via `{{ }}` text interpolation. */
  name: string
  size: number
  /** `File.type` — used ONLY as a boolean (`startsWith('image/')`), never a sink. */
  mime: string
  /** A local `blob:` object URL for an instant image preview, or `null` (non-image). */
  previewUrl: string | null
  phase: UploadPhase
  /** The resolved server `file_id`, once the upload reaches `done`. */
  fileId?: string
  /** The failure code, when `phase === 'failed'`. */
  code?: string
}

export interface ComposerAttachments {
  /** The reactive strip (render order = add order). */
  attachments: Ref<PendingAttachment[]>
  /** Enqueue an upload per File (local preview + worker upload). */
  add: (files: File[]) => void
  /** Drop a chip: revoke its preview URL + cancel its worker upload. */
  remove: (localId: string) => void
  /** Restart a failed chip's worker upload. */
  retry: (localId: string) => void
  /** Empty the strip (after Send): revoke every preview URL. */
  clear: () => void
  /** Every chip finished uploading (and there is at least one) — the Send gate. */
  allDone: ComputedRef<boolean>
  /** At least one chip is still uploading (in-flight, not failed) — the spinner cue. */
  anyPending: ComputedRef<boolean>
  /** The resolved `file_id`s for Send — populated ONLY when `allDone`. */
  resolvedFileIds: ComputedRef<string[]>
}

/**
 * Own a composer's pending-attachment strip. `streamId` is a getter (the selected
 * stream can change under a live composer) — an `add` with no stream is a no-op.
 */
export function useComposerAttachments(streamId: () => string | undefined): ComposerAttachments {
  const attachments = ref<PendingAttachment[]>([])
  const uploader = useFileUpload()

  function find(localId: string): PendingAttachment | undefined {
    return attachments.value.find((a) => a.localId === localId)
  }

  function onProgress(localId: string, p: UploadProgress): void {
    const a = find(localId)
    if (!a) return
    a.phase = p.phase
    if (p.file_id !== undefined) a.fileId = p.file_id
    if (p.code !== undefined) a.code = p.code
    else delete a.code
  }

  // Per-chip progress-sub teardown (set once `start` resolves the upload id).
  const unsubscribers = new Map<string, () => void>()
  // A `remove`/`retry` taken BEFORE a chip's upload id resolved parks its intent
  // here; the `start().then()` resolution honors it the instant the id is known.
  // Without this, a remove-before-resolve would leave `uploadId === ''`, so the
  // worker job would run to completion — enqueuing a `file.uploaded` for a file no
  // message references — and its progress subscription would linger.
  const pendingIntent = new Map<string, 'cancel' | 'retry'>()

  function add(files: File[]): void {
    const stream = streamId()
    if (!stream) return
    for (const file of files) {
      const localId = crypto.randomUUID()
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      attachments.value.push({
        localId,
        uploadId: '',
        file,
        name: file.name,
        size: file.size,
        mime: file.type,
        previewUrl,
        phase: 'queued',
      })
      void uploader
        .start({ stream_id: stream, file }, (p) => onProgress(localId, p))
        .then(({ uploadId, unsubscribe }) => {
          unsubscribers.set(localId, unsubscribe)
          const intent = pendingIntent.get(localId)
          pendingIntent.delete(localId)
          const a = find(localId)
          // Removed (chip gone) or an explicit cancel was requested while the id was
          // pending: tear the sub down and cancel the now-known worker job.
          if (intent === 'cancel' || !a) {
            unsubscribe()
            unsubscribers.delete(localId)
            void cancelUpload(uploadId)
            return
          }
          a.uploadId = uploadId
          // A retry requested before the id resolved fires now that it is known.
          if (intent === 'retry') void retryUpload(uploadId)
        })
    }
  }

  function remove(localId: string): void {
    const idx = attachments.value.findIndex((a) => a.localId === localId)
    if (idx === -1) return
    const [gone] = attachments.value.splice(idx, 1)
    if (!gone) return
    if (gone.previewUrl) URL.revokeObjectURL(gone.previewUrl)
    const unsub = unsubscribers.get(localId)
    if (unsub) {
      unsub()
      unsubscribers.delete(localId)
    }
    if (gone.uploadId) void cancelUpload(gone.uploadId)
    // Id not resolved yet — defer the cancel to the `start().then()` resolution.
    else pendingIntent.set(localId, 'cancel')
  }

  function retry(localId: string): void {
    const a = find(localId)
    if (!a) return
    if (a.uploadId) void retryUpload(a.uploadId)
    // Id not resolved yet — defer the retry to the `start().then()` resolution.
    else pendingIntent.set(localId, 'retry')
  }

  function clear(): void {
    for (const a of attachments.value) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    for (const unsub of unsubscribers.values()) unsub()
    unsubscribers.clear()
    pendingIntent.clear()
    attachments.value = []
  }

  async function cancelUpload(uploadId: string): Promise<void> {
    const client = await resolveWorkerClient()
    await client.files.cancel(uploadId)
  }

  async function retryUpload(uploadId: string): Promise<void> {
    const client = await resolveWorkerClient()
    await client.files.retry(uploadId)
  }

  // Leaving the composer (unmount) must not leak the local preview object URLs.
  onScopeDispose(clear)

  const allDone = computed(
    () => attachments.value.length > 0 && attachments.value.every((a) => a.phase === 'done'),
  )
  const anyPending = computed(() =>
    attachments.value.some((a) => a.phase !== 'done' && a.phase !== 'failed'),
  )
  const resolvedFileIds = computed<string[]>(() =>
    allDone.value
      ? attachments.value.map((a) => a.fileId).filter((id): id is string => typeof id === 'string')
      : [],
  )

  return { attachments, add, remove, retry, clear, allDone, anyPending, resolvedFileIds }
}
