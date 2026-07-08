// composables/useFileUpload.ts — the minimal tab driver for a file upload
// (ENG-119). It mints the `upload_id`, subscribes to progress BEFORE issuing the
// request (so no first `queued`/`hashing` frame is lost), and calls
// `client.files.upload`. That is the WHOLE seam: the composer chips / thumbnails /
// progress bars are ENG-121, and the client `file.uploaded` projection is ENG-120.
//
// The token never comes near this file — the tab hands the worker an opaque `File`
// and reads back only phase pushes; every network call and the token stay worker-side.

import { onScopeDispose } from 'vue'

import type { Unsubscribe, UploadProgress } from '../worker'
import { resolveWorkerClient } from './useWorkerClient'

/**
 * What an upload needs: the target stream + the opaque `File`. The upload is
 * DECOUPLED from message-send (ENG-121) — no text/mentions ride here; the composer
 * references the resolved `file_id` on Send. The worker hashes/homes/PUTs the blob.
 */
export interface StartUploadInput {
  stream_id: string
  file: File
}

/** The resolved handle for one started upload: its id + a targeted sub teardown. */
export interface StartedUpload {
  uploadId: string
  /**
   * Tear down JUST this upload's progress subscription (idempotent). The caller uses
   * it to drop a lingering sub when it cancels a chip whose id resolved late (ENG-121);
   * all subs are also torn down on scope dispose, so calling this is optional cleanup.
   */
  unsubscribe: Unsubscribe
}

export function useFileUpload(): {
  start: (
    input: StartUploadInput,
    onProgress?: (p: UploadProgress) => void,
  ) => Promise<StartedUpload>
} {
  const subs = new Set<Unsubscribe>()
  onScopeDispose(() => {
    for (const unsub of subs) unsub()
    subs.clear()
  })

  /**
   * Begin an upload. Resolves to the minted `upload_id` (the tab keys its optimistic
   * UI on it) plus a targeted `unsubscribe`. `onProgress` is wired BEFORE the request
   * is issued, so the machine's first frame is never dropped.
   */
  async function start(
    input: StartUploadInput,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<StartedUpload> {
    const client = await resolveWorkerClient()
    const uploadId = crypto.randomUUID()
    let unsubscribe: Unsubscribe = () => {}
    if (onProgress) {
      const raw = client.files.onProgress(uploadId, onProgress)
      subs.add(raw)
      // Idempotent, self-removing from the set so scope dispose can't double-call.
      unsubscribe = () => {
        if (subs.delete(raw)) raw()
      }
    }
    await client.files.upload({ upload_id: uploadId, ...input })
    return { uploadId, unsubscribe }
  }

  return { start }
}
