// composables/useAttachments.ts — resolve a message's attachments for rendering
// (ENG-121). Reads the LOCAL `attachments.forMessage` projection (the `file.uploaded`
// mirror, ENG-120) — ZERO network, no token — and returns the resolved `FileRow`s
// plus the ids whose `file.uploaded` has not yet projected (rendered as pending
// placeholders). Re-queries on mount and whenever the message's `file_ids` change
// (a late `file.uploaded` backfill flips a pending id into a rendered file).
//
// DEDUPE (ENG-120 nit): the query does NOT dedupe, so a `message.created` that
// happens to list the same `file_id` twice would yield duplicate rows. We de-dup
// BOTH arrays by `file_id` here so the UI renders each attachment exactly once and
// keys stay unique.

import { onMounted, ref, watch, type Ref } from 'vue'

import { resolveWorkerClient } from './useWorkerClient'
import type { FileRow } from '../worker'

/** De-duplicate `items` by `key`, preserving first-seen order. */
function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

/**
 * Resolve `messageId`'s attachments. `fileIds` is the message's projected
 * `file_ids` (reactive) — an empty list short-circuits the query entirely (the
 * overwhelming common case: a message with no attachments never touches the worker).
 */
export function useAttachments(
  messageId: string,
  fileIds: Ref<readonly string[]>,
): { files: Ref<FileRow[]>; pendingFileIds: Ref<string[]> } {
  const files = ref<FileRow[]>([])
  const pendingFileIds = ref<string[]>([])

  async function load(): Promise<void> {
    if (fileIds.value.length === 0) {
      files.value = []
      pendingFileIds.value = []
      return
    }
    const client = await resolveWorkerClient()
    const res = await client.query({ q: 'attachments.forMessage', message_id: messageId })
    files.value = dedupeBy(res.files, (f) => f.file_id)
    pendingFileIds.value = dedupeBy(res.pending_file_ids, (id) => id)
  }

  onMounted(() => {
    void load()
  })
  // A change to the message's `file_ids` (e.g. a backfill lands) re-resolves.
  watch(fileIds, () => {
    void load()
  })

  return { files, pendingFileIds }
}
