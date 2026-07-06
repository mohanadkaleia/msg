<script setup lang="ts">
// MessageComposer — the M2 plain-text composer (ENG-82). Deliberately a plain
// <textarea>, NOT rich text: the TipTap rich composer (mentions / markdown /
// paste) is M3. The SEAM is this component's `send` contract — its internals can
// be swapped for TipTap later without the shell changing. Enter sends,
// Shift+Enter inserts a newline, the field auto-grows, and whitespace-only input
// is blocked (both here and again in the store before it hits the outbox).
import { computed, nextTick, ref } from 'vue'

const props = defineProps<{
  /** Placeholder, e.g. "Message #general". */
  placeholder?: string
  /** Disable while there is no writable stream selected. */
  disabled?: boolean
}>()

const emit = defineEmits<{ send: [text: string] }>()

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)

const canSend = computed(() => !props.disabled && text.value.trim().length > 0)

/** Grow the textarea to fit its content, up to a sane max (then it scrolls). */
async function autoGrow(): Promise<void> {
  await nextTick()
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

function onInput(): void {
  void autoGrow()
}

function onKeydown(event: KeyboardEvent): void {
  // Enter (no Shift) sends; Shift+Enter falls through to insert a newline.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

function submit(): void {
  const body = text.value.trim()
  if (!canSend.value || body.length === 0) return
  emit('send', body)
  text.value = ''
  void autoGrow()
}
</script>

<template>
  <div class="border-t border-slate-200 bg-white p-3">
    <div
      class="flex items-end gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 focus-within:border-slate-500"
    >
      <textarea
        ref="textarea"
        v-model="text"
        :placeholder="props.placeholder ?? 'Write a message…'"
        :disabled="props.disabled"
        rows="1"
        class="max-h-[200px] flex-1 resize-none bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-50"
        data-testid="composer-input"
        @input="onInput"
        @keydown="onKeydown"
      />
      <button
        type="button"
        :disabled="!canSend"
        class="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="composer-send"
        @click="submit"
      >
        Send
      </button>
    </div>
  </div>
</template>
