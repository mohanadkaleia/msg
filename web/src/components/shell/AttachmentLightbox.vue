<script setup lang="ts">
// AttachmentLightbox — the full-size image overlay (ENG-121). Mounted ONLY while
// open (a `v-if` in AttachmentImage) so `useFileUrl(fileId, 'blob')` acquires the
// full blob on open and its `onScopeDispose` revokes it on close — a clean,
// refcounted lifecycle with no eager full-size fetch.
//
// SECURITY: the ONLY URL bound to `:src` is `useFileUrl`'s worker `blob:` URL (never
// a server HTTP API path, never the token); `:alt` carries the attacker-controlled
// file name as an inert, escaped attribute value.
import { useFileUrl } from '../../composables/useFileUrl'

const props = defineProps<{ fileId: string; alt: string }>()
const emit = defineEmits<{ close: [] }>()

const { url } = useFileUrl(props.fileId, 'blob')
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
    data-testid="attachment-lightbox"
    @click="emit('close')"
  >
    <img
      v-if="url"
      :src="url"
      :alt="alt"
      class="max-h-full max-w-full rounded shadow-lg"
      data-testid="attachment-lightbox-image"
    />
  </div>
</template>
