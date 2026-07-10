// composables/useWorkspaceIconUrl.ts — turn the workspace's worker-held icon
// bytes into a renderable object URL (ENG-152), the workspace sibling of
// useAvatarUrl. The TAB requests the opaque `Blob` once through the WorkerClient
// (`client.workspace.icon`), `URL.createObjectURL`s it, and `revokeObjectURL`s
// it when the last user unmounts.
//
// Same boundary reasoning as useAvatarUrl: a `blob:` URL is scoped to the realm
// that created it, so the tab mints it; only bytes cross the RPC boundary and the
// session token stays worker-side. The source is REACTIVE — the workspace icon
// can change (or clear) while the shell is mounted (the `workspace.info` fold
// updates `icon_sha256`) — so this takes a getter of the current sha and
// re-acquires on any change, keyed by the sha (a new sha is a new key → a fresh
// fetch; the shared refcount map dedupes across every component showing the icon).
// `sha === undefined` means "no icon": the url resolves to null and no worker
// call is made (so the glyph-only rail never touches the worker).

import { onScopeDispose, ref, watch, type Ref } from 'vue'

import { resolveWorkerClient } from './useWorkerClient'

/** A shared, refcounted object URL for one icon `sha`. */
interface UrlEntry {
  refcount: number
  /** Resolves to the created object URL, or `null` on a 404 / unfetchable icon. */
  promise: Promise<string | null>
}

const entries = new Map<string, UrlEntry>()

/** Acquire (creating on first use) the shared URL for `key`, bumping its refcount. */
function acquire(key: string, loadBlob: () => Promise<Blob | null>): Promise<string | null> {
  let entry = entries.get(key)
  if (!entry) {
    entry = {
      refcount: 0,
      // Reject-proof (useAvatarUrl precedent): a rejection folds to null so it
      // can never become an unhandled rejection nor leak a URL.
      promise: loadBlob()
        .then((blob) => (blob ? URL.createObjectURL(blob) : null))
        .catch(() => null),
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
 * Resolve the workspace icon to a `blob:` URL for `<img src>`. `source` is a
 * getter of the current icon `sha` (from the `workspace.info` fold); the
 * returned `url` ref is `null` until loaded, and returns to `null` when the icon
 * clears. Shared + refcounted across callers; revoked when the last scope using
 * a given `sha` unmounts or moves off it.
 */
export function useWorkspaceIconUrl(source: () => string | undefined): {
  url: Ref<string | null>
} {
  const url = ref<string | null>(null)
  let heldKey: string | null = null

  watch(
    source,
    (sha) => {
      const key = sha ?? null
      if (key === heldKey) return
      if (heldKey !== null) release(heldKey)
      heldKey = key
      if (key === null || sha === undefined) {
        url.value = null
        return
      }
      url.value = null
      void acquire(key, async () => {
        const client = await resolveWorkerClient()
        const result = await client.workspace.icon(sha)
        return result.blob
      }).then((resolved) => {
        // Ignore a stale resolution if the source moved on meanwhile.
        if (heldKey === key) url.value = resolved
      })
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    if (heldKey !== null) release(heldKey)
    heldKey = null
  })

  return { url }
}
