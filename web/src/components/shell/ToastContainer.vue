<script setup lang="ts">
// ToastContainer — the notification toast stack (ENG-129), mounted once in
// AppShell. A DUMB view over the notifications store's `toasts`: renders each as
// a Toast card (bottom-right, newest last), forwards dismissals to the store,
// and emits `select` so the shell jumps to the stream (its existing open-stream
// path). `aria-live="polite"` announces arrivals without stealing focus.
import { useNotificationsStore } from '../../stores/notifications'
import Toast from '../ui/Toast.vue'

const notifications = useNotificationsStore()

const emit = defineEmits<{
  /** A toast body was clicked — open its stream. */
  select: [streamId: string]
}>()

function onSelect(streamId: string, toastId: number): void {
  notifications.dismissToast(toastId)
  emit('select', streamId)
}
</script>

<template>
  <div
    v-if="notifications.toasts.length > 0"
    class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    role="status"
    aria-live="polite"
    data-testid="toast-container"
  >
    <Toast
      v-for="toast in notifications.toasts"
      :key="toast.id"
      :toast="toast"
      class="pointer-events-auto"
      @select="onSelect(toast.stream_id, toast.id)"
      @dismiss="notifications.dismissToast(toast.id)"
    />
  </div>
</template>
