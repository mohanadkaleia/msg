<script setup lang="ts">
// Toast — one in-app notification card (ENG-129). A DUMB view over a ToastItem:
// where (channel/DM), who, and a short text-only preview. Clicking the body
// emits `select` (the shell jumps to the stream); the ✕ or the ~5s auto-dismiss
// timer emits `dismiss`.
//
// SECURITY: title / author / preview are OTHER USERS' INPUT — rendered ONLY via
// Vue text interpolation (`{{ }}`), never v-html. A message containing markup
// (e.g. `<img onerror=…>`) renders as inert text.
import { onBeforeUnmount, onMounted } from 'vue'

import Icon from './Icon.vue'
import IconButton from './IconButton.vue'
import type { ToastItem } from '../../stores/notifications'

const props = withDefaults(
  defineProps<{
    toast: ToastItem
    /** Auto-dismiss delay in ms (overridable in tests). */
    duration?: number
  }>(),
  { duration: 5000 },
)

const emit = defineEmits<{
  /** Body click — jump to the toast's stream. */
  select: []
  /** The ✕ or the auto-dismiss timer. */
  dismiss: []
}>()

let timer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  timer = setTimeout(() => emit('dismiss'), props.duration)
})

onBeforeUnmount(() => {
  if (timer !== undefined) clearTimeout(timer)
})
</script>

<template>
  <div
    class="relative overflow-hidden rounded-lg border border-subtle bg-surface-elevated shadow-lg"
    data-testid="notification-toast"
    :data-stream-id="toast.stream_id"
  >
    <button
      type="button"
      class="block w-full px-3 py-2.5 pr-9 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-testid="toast-body"
      @click="emit('select')"
    >
      <span class="flex items-center gap-1.5">
        <Icon name="bell" :size="13" class="shrink-0 text-accent" />
        <span class="truncate text-xs font-semibold text-primary" data-testid="toast-title">
          {{ toast.title }}
        </span>
      </span>
      <span class="mt-0.5 block truncate text-sm text-secondary">
        <span class="font-medium text-primary" data-testid="toast-author">{{ toast.author }}</span>
        <span v-if="toast.preview" data-testid="toast-preview">: {{ toast.preview }}</span>
      </span>
    </button>
    <IconButton
      size="sm"
      label="Dismiss notification"
      class="absolute right-1 top-1"
      data-testid="toast-dismiss"
      @click="emit('dismiss')"
    >
      <Icon name="x" :size="14" />
    </IconButton>
  </div>
</template>
