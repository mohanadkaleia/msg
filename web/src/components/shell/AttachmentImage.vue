<script setup lang="ts">
// AttachmentImage — an inline image attachment (ENG-121): the server thumbnail as a
// clickable `<img>` that opens a full-size in-app lightbox.
//
// SECURITY (mirrors the MessageItem XSS doc): `file.name` is ATTACKER-CONTROLLED and
// is bound ONLY to the inert, escaped `:alt` attribute (never a markup/script sink).
// The ONLY URL bound to `:src` is `useFileUrl`'s worker `blob:` URL — never a server
// HTTP API path, never the token. Whether to render as an image (vs a file card) is
// decided by the PARENT from `mime_type` (a boolean use); nothing here renders the
// mime type or the name into a sink.
//
// TOKEN BOUNDARY: bytes arrive via `useFileUrl` (→ `client.files.thumbnail`/`.blob`,
// all worker-side); this component never fetches or sees a token. The full-size blob
// is fetched lazily by the lightbox child, mounted only while open (clean refcount).
import { ref } from 'vue'

import { useFileUrl } from '../../composables/useFileUrl'
import AttachmentLightbox from './AttachmentLightbox.vue'
import type { FileRow } from '../../worker'

const props = defineProps<{ file: FileRow }>()

const { url } = useFileUrl(props.file.file_id, 'thumbnail')
const lightboxOpen = ref(false)
</script>

<template>
  <div>
    <button
      v-if="url"
      type="button"
      class="block overflow-hidden rounded-md border border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      aria-label="Open image"
      @click="lightboxOpen = true"
    >
      <!-- Worker blob: URL only; attacker name rides the inert escaped :alt. -->
      <img
        :src="url"
        :alt="file.name"
        class="max-h-64 max-w-xs object-cover"
        data-testid="attachment-image"
      />
    </button>
    <div
      v-else
      class="flex h-24 w-40 items-center justify-center rounded-md border border-subtle bg-surface text-xs text-muted"
      data-testid="attachment-image-loading"
    >
      loading…
    </div>

    <AttachmentLightbox
      v-if="lightboxOpen"
      :file-id="file.file_id"
      :alt="file.name"
      @close="lightboxOpen = false"
    />
  </div>
</template>
