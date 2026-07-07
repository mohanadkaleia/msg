<script setup lang="ts">
// MessageComposer — the M3 rich composer (ENG-101), a drop-in replacement for the
// M2 plain-textarea (ENG-82) at the SAME component seam. The parent still mounts
// `<MessageComposer :placeholder :disabled @send>`; the only additions are the
// `mentionItems` prop (a zero-network projection read the parent hands down) and
// the `mentions` payload on `send` — the wire/format contract is unchanged:
// messages still go out as markdown SOURCE text (§5.4), never HTML.
//
// Internals are TipTap (StarterKit + two Mention instances) instead of a
// `<textarea>`, but the behavior contract is preserved: Enter sends, Shift-Enter
// inserts a newline, whitespace-only is blocked. New for M3: markdown input
// shortcuts render rich and serialize back to source (composer/serialize.ts),
// `@`/`#` autocomplete from the projection, and two clearly-marked SEAMS —
// ArrowUp-on-empty emits `edit-last` (ENG-102 wires the edit round-trip) and
// dropped/pasted files emit `files` (M3.5 wires uploads). XSS: pasted HTML is
// stripped to inert text (composer/sanitize.ts); nothing here uses v-html.
import { computed, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Mention from '@tiptap/extension-mention'

import { buildSuggestion, type MentionItem } from './composer/mentions'
import { sanitizePastedHtml } from './composer/sanitize'
import { serializeDoc } from './composer/serialize'

const props = withDefaults(
  defineProps<{
    /** Placeholder, e.g. "Message #general". */
    placeholder?: string
    /** Disable while there is no writable stream selected. */
    disabled?: boolean
    /** Autocomplete candidates (users + channels) from the workspace projection. */
    mentionItems?: MentionItem[]
  }>(),
  { placeholder: 'Write a message…', disabled: false, mentionItems: () => [] },
)

const emit = defineEmits<{
  /** A composed message: markdown source text + resolved `u_` mention ids. */
  send: [text: string, mentions: string[]]
  /**
   * SEAM (ENG-102): ArrowUp on an empty composer requests loading the user's last
   * own message for editing. ENG-101 only wires the keybinding; the edit
   * round-trip (`message.edited`) lands in ENG-102 — connect this emit there.
   */
  'edit-last': []
  /**
   * SEAM (M3.5): files dropped or pasted into the composer. ENG-101 surfaces them
   * but wires NO upload — M3.5 connects this to the attachment flow (§6).
   */
  files: [files: File[]]
}>()

/** True while a mention popup is open, so Enter/ArrowUp defer to it (not send). */
const suggestionActive = ref(false)
/** Tracked editor-emptiness (drives the send gate + the placeholder overlay). */
const empty = ref(true)

const editor = useEditor({
  extensions: [
    StarterKit,
    // `@user` chips — resolve to `u_` ids for the payload's mentions[].
    Mention.configure({
      HTMLAttributes: { class: 'composer-mention', 'data-mention-kind': 'user' },
      renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
      suggestion: buildSuggestion('@', 'user', () => props.mentionItems, {
        onOpen: () => (suggestionActive.value = true),
        onClose: () => (suggestionActive.value = false),
      }),
    }),
    // `#channel` chips — text-only references (channels are not user mentions).
    Mention.extend({ name: 'channelMention' }).configure({
      HTMLAttributes: { class: 'composer-mention', 'data-mention-kind': 'channel' },
      renderText: ({ node }) => `#${node.attrs.label ?? node.attrs.id}`,
      suggestion: buildSuggestion('#', 'channel', () => props.mentionItems, {
        onOpen: () => (suggestionActive.value = true),
        onClose: () => (suggestionActive.value = false),
      }),
    }),
  ],
  editable: !props.disabled,
  editorProps: {
    attributes: {
      class:
        'max-h-[200px] min-h-[1.5rem] w-full overflow-y-auto text-sm text-slate-900 outline-none',
      'data-testid': 'composer-input',
    },
    // Enter-to-send / ArrowUp-edit — but ONLY when no mention popup is open (its
    // plugin owns those keys while active). Direct editorProps run before plugin
    // props in ProseMirror, so this explicit deferral is what keeps arrow/Enter
    // navigating the popup instead of sending.
    handleKeyDown: (_view, event) => handleKeyDown(event),
    // XSS boundary: pasted HTML is reduced to inert text before ProseMirror ever
    // parses it (no `<img onerror>` / `<script>` can survive as live markup).
    transformPastedHTML: (html) => sanitizePastedHtml(html),
    // File SEAM (M3.5): surface dropped/pasted files, insert nothing.
    handleDrop: (_view, event) => emitFiles(event.dataTransfer?.files),
    handlePaste: (_view, event) => emitFiles(event.clipboardData?.files),
  },
  onCreate: ({ editor }) => {
    empty.value = editor.isEmpty
  },
  onUpdate: ({ editor }) => {
    empty.value = editor.isEmpty
  },
})

const canSend = computed(() => !props.disabled && !empty.value)

/** Keyboard contract. Returns true when handled (ProseMirror then stops). */
function handleKeyDown(event: KeyboardEvent): boolean {
  if (suggestionActive.value) return false // popup owns arrows/Enter/Esc
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
    return true
  }
  // SEAM (ENG-102): ArrowUp on an empty composer → edit last own message.
  if (event.key === 'ArrowUp' && (editor.value?.isEmpty ?? true)) {
    emit('edit-last')
    return true
  }
  return false
}

/** File SEAM helper: emit any files, swallow the event, insert nothing. */
function emitFiles(files: FileList | null | undefined): boolean {
  if (!files || files.length === 0) return false
  emit('files', Array.from(files))
  return true // handled — do not drop/paste the file as content
}

/** Serialize the editor to markdown source + mentions, emit, and clear. */
function submit(): void {
  const instance = editor.value
  if (!instance || props.disabled) return
  const { text, mentions } = serializeDoc(instance.getJSON())
  if (text.trim().length === 0) return // whitespace-only blocked (M2 parity)
  emit('send', text, mentions)
  instance.commands.clearContent(true)
  empty.value = true
}

// Reflect the disabled prop into the editor (read-only while no writable stream).
watch(
  () => props.disabled,
  (disabled) => editor.value?.setEditable(!disabled),
)

// Exposed for the shell (focus) and for unit tests to drive the editor directly.
defineExpose({ editor, submit, handleKeyDown })

// Re-export the type for parents that map projection rows to candidates.
export type { MentionItem }
</script>

<template>
  <div class="border-t border-slate-200 bg-white p-3">
    <div
      class="flex items-end gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 focus-within:border-slate-500"
      :class="{ 'opacity-50': props.disabled }"
    >
      <div class="relative min-w-0 flex-1">
        <!-- Placeholder overlay (StarterKit has no placeholder node; avoid a dep). -->
        <div
          v-if="empty"
          class="pointer-events-none absolute left-0 top-0 text-sm text-slate-400"
          data-testid="composer-placeholder"
        >
          {{ props.placeholder }}
        </div>
        <EditorContent v-if="editor" :editor="editor" />
      </div>
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

<style>
.composer-mention {
  border-radius: 0.25rem;
  background-color: rgb(224 231 255);
  padding: 0 0.25rem;
  color: rgb(55 48 163);
  font-weight: 500;
  /* Inert chip: never editable, never a script/handler surface. */
  white-space: nowrap;
}
</style>
