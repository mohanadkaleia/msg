<script setup lang="ts">
// MessageItem — one rendered message (ENG-82, extended for M3 interactions ENG-102).
//
// SECURITY (critical): `text`, author names, reaction `emoji` and who-reacted
// display names are ALL other users' input — reaction `emoji` is OPAQUE BYTES that
// can carry control chars. Every one of them is rendered ONLY through Vue text
// interpolation ({{ }}), which HTML-escapes. There is NO v-html, no innerHTML, no
// dynamic template compilation, and no raw-HTML sink anywhere in this component.
//
// M3 additions (ENG-102): aggregated reaction chips (emoji + count + who-reacted
// tooltip) with an idempotent optimistic toggle; a hover toolbar with quick
// reactions + an emoji picker; inline EDIT and soft-DELETE affordances on your OWN
// messages (author-gated in-UI; the server enforces too); an "edited" marker; and
// a TOMBSTONE render for a deleted message. Delete is a SOFT delete (ENG-111) —
// the confirm is worded honestly ("removed for everyone"), never as a permanent
// cryptographic erasure.
import { computed, ref, watch } from 'vue'

import type { DisplayMessage } from '../../stores/messages'
import { formatTime } from '../../lib/time'

const props = withDefaults(
  defineProps<{
    message: DisplayMessage
    /** True while this row is the active inline-edit target (owned by the parent). */
    editing?: boolean
  }>(),
  { editing: false },
)

const emit = defineEmits<{
  retry: [messageId: string]
  discard: [messageId: string]
  /** Toggle a reaction: `remove` is the caller's read of the current membership. */
  react: [messageId: string, emoji: string, remove: boolean]
  /** Request inline edit of this (own) message. */
  'edit-start': [messageId: string]
  /** Commit the inline edit. */
  'edit-submit': [messageId: string, text: string]
  /** Abandon the inline edit. */
  'edit-cancel': []
  /** Soft-delete this (own) message (already confirmed in-UI). */
  delete: [messageId: string]
}>()

/** Quick one-click reactions in the hover toolbar. Safe literal emoji. */
const QUICK_REACTIONS = ['👍', '❤️', '😂'] as const
/** The picker set (the M3 "emoji picker" — a small curated palette, no heavy dep). */
const PICKER_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥', '✅', '👀'] as const

const isPending = computed(() => props.message.state === 'pending')
const isFailed = computed(() => props.message.state === 'failed')
const isDeleted = computed(() => props.message.deleted === true)
const isSettled = computed(() => props.message.state === undefined)
const isEdited = computed(() => props.message.edited_seq !== undefined)
/** Author-or-admin is enforced server-side; in-UI we gate on ownership + a live row. */
const canModify = computed(() => props.message.mine && isSettled.value && !isDeleted.value)
/** Reactions are only meaningful on a live (non-deleted) row. */
const canReact = computed(() => isSettled.value && !isDeleted.value)
/** Retry/Delete of a failed SEND are only actionable while we hold its outbox id. */
const canAct = computed(() => props.message.eventId !== undefined)
const time = computed(() => formatTime(props.message.ts))
const reactions = computed(() => props.message.reactions ?? [])

const pickerOpen = ref(false)
const confirmingDelete = ref(false)
const draft = ref('')

// Seed the inline-edit draft with the current text whenever this row enters edit
// mode — covers BOTH entry paths (the toolbar Edit button and the composer's
// ArrowUp→edit-last, which flips `editing` without a local click).
watch(
  () => props.editing,
  (editing) => {
    if (editing) draft.value = props.message.text
  },
  { immediate: true },
)

/** " (code)" suffix for a rejected send, or "". */
function formatCode(code: string | undefined): string {
  return code ? ` (${code})` : ''
}

/** Toggle YOUR reaction — idempotent: an active (mine) reaction is removed. */
function toggleReaction(emoji: string, mine: boolean): void {
  emit('react', props.message.message_id, emoji, mine)
}

/** Add-or-remove from the toolbar/picker: remove iff I already reacted with it. */
function pickReaction(emoji: string): void {
  const mine = reactions.value.some((r) => r.emoji === emoji && r.mine)
  toggleReaction(emoji, mine)
  pickerOpen.value = false
}

function startEdit(): void {
  emit('edit-start', props.message.message_id)
}

function submitEdit(): void {
  const text = draft.value.trim()
  if (text.length === 0) {
    emit('edit-cancel')
    return
  }
  emit('edit-submit', props.message.message_id, text)
}

/** Enter commits, Shift-Enter is a newline, Escape cancels (composer parity). */
function onEditKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submitEdit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('edit-cancel')
  }
}

function confirmDelete(): void {
  confirmingDelete.value = false
  emit('delete', props.message.message_id)
}
</script>

<template>
  <div
    class="group relative px-4 py-1.5 hover:bg-slate-50"
    :class="{ 'opacity-50': isPending }"
    data-testid="message-row"
    :data-state="props.message.state ?? 'settled'"
  >
    <!-- TOMBSTONE (ENG-102/ENG-111): a soft-deleted message. Content is redacted
         projection-side; we render only a muted marker, never the old text. -->
    <p v-if="isDeleted" class="text-sm italic text-slate-400" data-testid="message-tombstone">
      message deleted
    </p>

    <template v-else>
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-semibold text-slate-800" data-testid="message-author">{{
          props.message.author_user_id
        }}</span>
        <span class="text-xs text-slate-400" data-testid="message-time">
          <template v-if="isPending">Sending…</template>
          <template v-else>{{ time }}</template>
        </span>
        <span v-if="isEdited" class="text-xs text-slate-400" data-testid="edited-marker">
          (edited)
        </span>
      </div>

      <!-- INLINE EDIT (own message) — plain textarea, serialized as source text. -->
      <div v-if="props.editing" class="mt-1" data-testid="message-edit">
        <textarea
          v-model="draft"
          rows="2"
          class="w-full resize-y rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-800 outline-none focus:border-slate-500"
          data-testid="message-edit-input"
          @keydown="onEditKeydown"
        ></textarea>
        <div class="mt-1 flex items-center gap-2 text-xs">
          <button
            type="button"
            class="rounded bg-slate-900 px-2 py-0.5 font-medium text-white"
            data-testid="message-edit-save"
            @click="submitEdit"
          >
            Save
          </button>
          <button
            type="button"
            class="font-medium text-slate-600 hover:text-slate-900"
            data-testid="message-edit-cancel"
            @click="emit('edit-cancel')"
          >
            Cancel
          </button>
          <span class="text-slate-400">Enter to save · Esc to cancel</span>
        </div>
      </div>

      <!-- Plain text ONLY — Vue interpolation escapes; never v-html (XSS). -->
      <p
        v-else
        class="whitespace-pre-wrap break-words text-sm text-slate-800"
        data-testid="message-text"
      >
        {{ props.message.text }}
      </p>

      <!-- Reaction chips (aggregated, present-only). Clicking toggles YOUR reaction. -->
      <div v-if="reactions.length > 0" class="mt-1 flex flex-wrap gap-1">
        <button
          v-for="chip in reactions"
          :key="chip.emoji"
          type="button"
          class="group/chip relative flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs"
          :class="
            chip.mine
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
              : 'border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200'
          "
          data-testid="reaction-chip"
          :data-mine="chip.mine"
          :disabled="!canReact"
          @click="toggleReaction(chip.emoji, chip.mine)"
        >
          <!-- OPAQUE emoji bytes — text interpolation only. -->
          <span>{{ chip.emoji }}</span>
          <span class="tabular-nums">{{ chip.count }}</span>
          <!-- Who-reacted tooltip: display names via interpolation (escaped). -->
          <span
            class="pointer-events-none absolute bottom-full left-0 z-20 mb-1 hidden whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-[11px] text-white group-hover/chip:block"
            data-testid="reaction-tooltip"
            >{{ chip.display_names.join(', ') }}</span
          >
        </button>
      </div>

      <!-- Hover toolbar: quick reactions + emoji picker + (own) edit/delete. -->
      <div
        v-if="canReact && !props.editing"
        class="absolute right-3 top-0 z-10 -mt-2 hidden items-center gap-0.5 rounded-md border border-slate-200 bg-white px-1 py-0.5 shadow-sm group-hover:flex"
        data-testid="message-toolbar"
      >
        <button
          v-for="emoji in QUICK_REACTIONS"
          :key="emoji"
          type="button"
          class="rounded px-1 text-sm hover:bg-slate-100"
          data-testid="reaction-quick"
          :data-emoji="emoji"
          @click="pickReaction(emoji)"
        >
          {{ emoji }}
        </button>
        <div class="relative">
          <button
            type="button"
            class="rounded px-1 text-sm text-slate-500 hover:bg-slate-100"
            data-testid="reaction-picker"
            aria-label="Add reaction"
            @click="pickerOpen = !pickerOpen"
          >
            +
          </button>
          <div
            v-if="pickerOpen"
            class="absolute right-0 top-full z-30 mt-1 grid grid-cols-5 gap-0.5 rounded-md border border-slate-200 bg-white p-1 shadow-md"
            data-testid="reaction-picker-menu"
          >
            <button
              v-for="emoji in PICKER_EMOJI"
              :key="emoji"
              type="button"
              class="rounded px-1 py-0.5 text-sm hover:bg-slate-100"
              data-testid="reaction-option"
              :data-emoji="emoji"
              @click="pickReaction(emoji)"
            >
              {{ emoji }}
            </button>
          </div>
        </div>
        <template v-if="canModify">
          <button
            type="button"
            class="rounded px-1 text-xs text-slate-500 hover:bg-slate-100"
            data-testid="message-edit"
            aria-label="Edit message"
            @click="startEdit"
          >
            Edit
          </button>
          <button
            type="button"
            class="rounded px-1 text-xs text-slate-500 hover:bg-slate-100"
            data-testid="message-delete"
            aria-label="Delete message"
            @click="confirmingDelete = true"
          >
            Delete
          </button>
        </template>
      </div>

      <!-- Soft-delete confirm (ENG-111 honest labeling: removed for everyone, NOT
           a permanent/unrecoverable erasure — the log retains it). -->
      <div
        v-if="confirmingDelete"
        class="mt-1 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
        data-testid="message-delete-confirm"
      >
        <span class="text-slate-600">Delete message? It will be removed for everyone.</span>
        <button
          type="button"
          class="rounded bg-red-600 px-2 py-0.5 font-medium text-white"
          data-testid="message-delete-confirm-yes"
          @click="confirmDelete"
        >
          Delete
        </button>
        <button
          type="button"
          class="font-medium text-slate-600 hover:text-slate-900"
          data-testid="message-delete-cancel"
          @click="confirmingDelete = false"
        >
          Cancel
        </button>
      </div>

      <div
        v-if="isFailed"
        class="mt-1 flex items-center gap-2 text-xs"
        data-testid="message-failed"
      >
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
            data-testid="message-failed-discard"
            @click="emit('discard', props.message.message_id)"
          >
            Discard
          </button>
        </template>
      </div>
    </template>
  </div>
</template>
