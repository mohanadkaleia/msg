<script setup lang="ts">
// AttachmentFile — a non-image attachment card (ENG-121): a file glyph, the file
// NAME + SIZE, and a Download button.
//
// SECURITY (mirrors the MessageItem XSS doc): `file.name` and `file.mime_type` are
// ATTACKER-CONTROLLED. The name is rendered ONLY through Vue text interpolation
// ({{ }}), which HTML-escapes; the size is a number formatted to text. There is NO
// v-html / innerHTML / dynamic `:is` / template compilation anywhere here. The
// `download` attribute receives the attacker name, but it is an inert suggested
// filename the browser sanitizes — never a script or markup sink.
//
// TOKEN BOUNDARY: the download fetches bytes through `client.files.download` (all
// fetch/token/server HTTP calls stay worker-side) and creates a ONE-SHOT local `blob:`
// object URL for the `<a download>` click, revoked immediately after. It never
// touches `useFileUrl` (that shared cache is for rendered previews, not downloads).
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { formatBytes } from '../../lib/bytes'
import type { FileRow } from '../../worker'

const props = defineProps<{ file: FileRow }>()

/** Download the blob and trigger a browser save via a transient `<a download>`. */
async function onDownload(): Promise<void> {
  const client = await resolveWorkerClient()
  const { blob } = await client.files.download(props.file.file_id)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // Attacker-controlled name → an INERT suggested filename (browser-sanitized).
  a.download = props.file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick so the click has consumed the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
</script>

<template>
  <div
    class="flex max-w-sm items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2"
    data-testid="attachment-file"
  >
    <span class="text-lg" aria-hidden="true">📄</span>
    <div class="min-w-0 flex-1">
      <!-- ATTACKER-CONTROLLED name — text interpolation only (escaped). -->
      <p class="truncate text-sm font-medium text-slate-800" data-testid="attachment-file-name">
        {{ file.name }}
      </p>
      <p class="text-xs text-slate-400">{{ formatBytes(file.size_bytes) }}</p>
    </div>
    <button
      type="button"
      class="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
      data-testid="attachment-download"
      @click="onDownload"
    >
      Download
    </button>
  </div>
</template>
