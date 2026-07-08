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

export function useFileUpload(): {
  start: (input: StartUploadInput, onProgress?: (p: UploadProgress) => void) => Promise<string>
} {
  const subs: Unsubscribe[] = []
  onScopeDispose(() => {
    for (const unsub of subs) unsub()
  })

  /**
   * Begin an upload. Returns the minted `upload_id` (the tab keys its optimistic UI
   * on it). `onProgress` is wired BEFORE the request is issued, so the machine's
   * first frame is never dropped.
   */
  async function start(
    input: StartUploadInput,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<string> {
    const client = await resolveWorkerClient()
    const uploadId = crypto.randomUUID()
    if (onProgress) subs.push(client.files.onProgress(uploadId, onProgress))
    await client.files.upload({ upload_id: uploadId, ...input })
    return uploadId
  }

  return { start }
}
