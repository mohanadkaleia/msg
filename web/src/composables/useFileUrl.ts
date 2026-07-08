// composables/useFileUrl.ts — turn a worker-held file into a renderable object URL
// (ENG-119, minimal tab seam; the visual UI is ENG-121). The TAB requests the
// opaque `Blob` once through the WorkerClient, `URL.createObjectURL`s it, and
// `revokeObjectURL`s it when the last user unmounts.
//
// WHY the tab (not the worker) mints the URL: a `blob:` object URL is scoped to the
// realm that created it — a worker-minted URL is unusable in the tab's DOM. So only
// the opaque bytes cross the RPC boundary; the tab owns the URL lifecycle. The
// session token stays worker-side and is never reachable here.
//
// A per-tab refcounted map shares ONE URL (and one fetch) across every component
// rendering the same file+variant, and revokes it only when the last one unmounts —
// so a message re-rendered in a list and a thread pane don't double-fetch or leak.

import { onScopeDispose, ref, type Ref } from 'vue'

import { resolveWorkerClient } from './useWorkerClient'

type Variant = 'blob' | 'thumbnail'

/** A shared, refcounted object URL for one `file_id:variant`. */
interface UrlEntry {
  refcount: number
  /** Resolves to the created object URL, or `null` on a 404 / unfetchable file. */
  promise: Promise<string | null>
}

const entries = new Map<string, UrlEntry>()

/** Acquire (creating on first use) the shared URL for `key`, bumping its refcount. */
function acquire(key: string, loadBlob: () => Promise<Blob | null>): Promise<string | null> {
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      refcount: 0,
      promise: loadBlob().then((blob) => (blob ? URL.createObjectURL(blob) : null)),
    }
    entries.set(key, entry)
  }
  entry.refcount++
  return entry.promise
}

/** Release one hold on `key`; when the last releases, revoke + drop the URL. */
function release(key: string): void {
  const entry = entries.get(key)
  if (!entry) return
  entry.refcount--
  if (entry.refcount > 0) return
  entries.delete(key)
  void entry.promise.then((url) => {
    if (url) URL.revokeObjectURL(url)
  })
}

/**
 * Resolve `fileId`'s bytes to a `blob:` URL for `<img src>` / a download link. Pass
 * `variant: 'thumbnail'` for the server-generated preview. Returns a reactive `url`
 * ref (`null` until loaded, or permanently `null` on a 404 / empty id). The URL is
 * shared across callers and revoked when the last unmounts (`onScopeDispose`).
 */
export function useFileUrl(fileId: string, variant: Variant = 'blob'): { url: Ref<string | null> } {
  const url = ref<string | null>(null)
  if (!fileId) return { url }

  const key = `${variant}:${fileId}`
  void acquire(key, async () => {
    const client = await resolveWorkerClient()
    const result =
      variant === 'thumbnail'
        ? await client.files.thumbnail(fileId)
        : await client.files.download(fileId)
    return result.blob
  }).then((resolved) => {
    url.value = resolved
  })

  onScopeDispose(() => {
    release(key)
  })

  return { url }
}
