<script setup lang="ts">
// MessageItem — one rendered message (ENG-82). SECURITY: `text`, author names
// and every other field are OTHER USERS' input — they are rendered ONLY through
// Vue text interpolation ({{ }}), which HTML-escapes. There is NO v-html, no
// innerHTML, no dynamic template compilation anywhere in this component (M2 is
// plain text; markdown/HTML rendering does not exist yet). Optimistic states:
// `pending` renders greyed with a "Sending…" clock; `failed` shows the error plus
// Retry / Delete affordances wired to the ENG-81 outbox RPCs.
import { computed } from 'vue'

import type { DisplayMessage } from '../../stores/messages'
import { formatTime } from '../../lib/time'

const props = defineProps<{ message: DisplayMessage }>()

const emit = defineEmits<{ retry: [messageId: string]; discard: [messageId: string] }>()

const isPending = computed(() => props.message.state === 'pending')
const isFailed = computed(() => props.message.state === 'failed')
/** Retry/Delete are only actionable for a send we still hold the outbox id for. */
const canAct = computed(() => props.message.eventId !== undefined)
const time = computed(() => formatTime(props.message.ts))

/** " (code)" suffix for a rejected send, or "". */
function formatCode(code: string | undefined): string {
  return code ? ` (${code})` : ''
}
</script>

<template>
  <div
    class="group px-4 py-1.5 hover:bg-slate-50"
    :class="{ 'opacity-50': isPending }"
    data-testid="message-row"
    :data-state="props.message.state ?? 'settled'"
  >
    <div class="flex items-baseline gap-2">
      <span class="text-sm font-semibold text-slate-800" data-testid="message-author">{{
        props.message.author_user_id
      }}</span>
      <span
        class="text-xs"
        :class="isPending ? 'text-slate-400' : 'text-slate-400'"
        data-testid="message-time"
      >
        <template v-if="isPending">Sending…</template>
        <template v-else>{{ time }}</template>
      </span>
    </div>

    <!-- Plain text ONLY — Vue interpolation escapes; never v-html (XSS). -->
    <p class="whitespace-pre-wrap break-words text-sm text-slate-800" data-testid="message-text">
      {{ props.message.text }}
    </p>

    <div v-if="isFailed" class="mt-1 flex items-center gap-2 text-xs" data-testid="message-failed">
      <span class="text-red-600"> Failed to send{{ formatCode(props.message.error_code) }} </span>
      <template v-if="canAct">
        <button
          type="button"
          class="font-medium text-slate-600 underline hover:text-slate-900"
          data-testid="message-retry"
          @click="emit('retry', props.message.message_id)"
        >
          Retry
        </button>
        <button
          type="button"
          class="font-medium text-slate-600 underline hover:text-slate-900"
          data-testid="message-delete"
          @click="emit('discard', props.message.message_id)"
        >
          Delete
        </button>
      </template>
    </div>
  </div>
</template>
