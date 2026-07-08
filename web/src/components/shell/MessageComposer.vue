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
// inserts a newline. New for M3: markdown input shortcuts render rich and serialize
// back to source (composer/serialize.ts), `@`/`#` autocomplete from the projection,
// and ArrowUp-on-empty emits `edit-last` (ENG-102 wires the edit round-trip).
//
// ATTACHMENTS (ENG-121, Option A — upload DECOUPLED from message-send): dropped/
// pasted files and the paperclip file-picker add PENDING chips to a strip above the
// editor (`useComposerAttachments`, a PER-COMPOSER instance so this composer and the
// thread-pane composer never share state). Each chip uploads in the worker (emitting
// ONLY `file.uploaded`); on Send the composer collects the resolved `file_id`s and
// passes them to the parent, which authors the ONE `message.created` via
// `outbox.send`. Send is gated CLOSED while any upload is in-flight/failed; a
// FILE-ONLY message (attachments, empty body) is allowed. XSS: pasted HTML is
// stripped to inert text (composer/sanitize.ts); attachment names render only via
// text/`:alt`; nothing here uses v-html.
import { computed, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Mention from '@tiptap/extension-mention'

import { useComposerAttachments } from '../../composables/useComposerAttachments'
import { formatBytes } from '../../lib/bytes'
import EmojiPicker from '../ui/EmojiPicker.vue'
import ComposerToolbar from './ComposerToolbar.vue'
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
    /** The stream attachments upload into (the parent knows it). */
    streamId?: string | undefined
  }>(),
  { placeholder: 'Write a message…', disabled: false, mentionItems: () => [], streamId: undefined },
)

const emit = defineEmits<{
  /**
   * A composed message: markdown source text, resolved `u_` mention ids, and the
   * resolved attachment `file_ids` (ENG-121; empty when none). The parent authors
   * the single `message.created` via `outbox.send`.
   */
  send: [text: string, mentions: string[], fileIds: string[]]
  /**
   * SEAM (ENG-102): ArrowUp on an empty composer requests loading the user's last
   * own message for editing. ENG-101 only wires the keybinding; the edit
   * round-trip (`message.edited`) lands in ENG-102 — connect this emit there.
   */
  'edit-last': []
}>()

// Per-composer attachment strip (ENG-121). `streamId` is read lazily (the selected
// stream can change under a live composer).
const {
  attachments: pendingAttachments,
  add: addAttachments,
  remove: removeAttachment,
  retry: retryAttachment,
  clear: clearAttachments,
  allDone: attachmentsAllDone,
  resolvedFileIds,
} = useComposerAttachments(() => props.streamId)

/** The hidden native file input the paperclip button proxies to. */
const fileInput = ref<HTMLInputElement | null>(null)

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
        'max-h-[200px] min-h-[1.5rem] w-full overflow-y-auto text-sm text-primary outline-none',
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
    // Attachments (ENG-121): a dropped/pasted file becomes a pending chip, inserted
    // nowhere in the doc. Returning true tells ProseMirror we handled it.
    handleDrop: (_view, event) => onFiles(event.dataTransfer?.files),
    handlePaste: (_view, event) => onFiles(event.clipboardData?.files),
  },
  onCreate: ({ editor }) => {
    empty.value = editor.isEmpty
  },
  onUpdate: ({ editor }) => {
    empty.value = editor.isEmpty
  },
})

// Send gate (ENG-121): text OR at least one attachment must be present, AND — when
// there are attachments — every one must have finished uploading (blocks Send while
// any upload is in-flight or failed). A FILE-ONLY message (no text) is allowed.
const canSend = computed(() => {
  const count = pendingAttachments.value.length
  return !props.disabled && (!empty.value || count > 0) && (count === 0 || attachmentsAllDone.value)
})

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

/** Add any dropped/pasted files as pending chips; insert nothing into the doc. */
function onFiles(files: FileList | null | undefined): boolean {
  if (!files || files.length === 0) return false
  addAttachments(Array.from(files))
  return true // handled — do not drop/paste the file as content
}

/** The paperclip button proxies to the hidden native file input. */
function openFilePicker(): void {
  fileInput.value?.click()
}

/** Toolbar emoji popover open state (the shared `ui/EmojiPicker`). */
const emojiOpen = ref(false)

/** Emoji toolbar button → toggle the shared curated-emoji popover. */
function onToolbarEmoji(): void {
  if (props.disabled) return
  emojiOpen.value = !emojiOpen.value
}

/** Insert the chosen glyph at the cursor (source text) and close the popover. */
function onEmojiSelect(emoji: string): void {
  editor.value?.chain().focus().insertContent(emoji).run()
  emojiOpen.value = false
}

/** `Aa` toolbar button → toggle a bold mark (serializes to `**…**` markdown). */
function onToolbarBold(): void {
  editor.value?.chain().focus().toggleBold().run()
}

/** `@` toolbar button → insert '@' so the tiptap mention suggestion plugin fires. */
function onToolbarMention(): void {
  editor.value?.chain().focus().insertContent('@').run()
}

/** File-picker change: add the chosen files, then reset so re-picking the same fires. */
function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files) addAttachments(Array.from(input.files))
  input.value = ''
}

/** Serialize the editor to markdown source + mentions + attachment ids, emit, clear. */
function submit(): void {
  const instance = editor.value
  if (!instance || props.disabled) return
  // Block while any upload is in-flight/failed (the button is also disabled).
  if (pendingAttachments.value.length > 0 && !attachmentsAllDone.value) return
  const { text, mentions } = serializeDoc(instance.getJSON())
  const fileIds = resolvedFileIds.value
  // Whitespace-only text AND no attachments → no-op. A file-only message is allowed.
  if (text.trim().length === 0 && fileIds.length === 0) return
  emit('send', text, mentions, fileIds)
  instance.commands.clearContent(true)
  empty.value = true
  clearAttachments()
}

// Reflect the disabled prop into the editor (read-only while no writable stream).
watch(
  () => props.disabled,
  (disabled) => editor.value?.setEditable(!disabled),
)

// Exposed for the shell (focus) and for unit tests to drive the editor / attachments.
defineExpose({ editor, submit, handleKeyDown, addFiles: addAttachments })

// Re-export the type for parents that map projection rows to candidates.
export type { MentionItem }
</script>

<template>
  <div class="border-t border-subtle bg-surface px-4 py-3">
    <!-- Pending attachment chips (ENG-121), above the editor. Names/sizes are
         attacker-controlled and rendered ONLY via text; previews are LOCAL blob: URLs. -->
    <div
      v-if="pendingAttachments.length > 0"
      class="mb-2 flex flex-wrap gap-2"
      data-testid="composer-attachments"
    >
      <div
        v-for="a in pendingAttachments"
        :key="a.localId"
        class="flex max-w-xs items-center gap-2 rounded-md border border-subtle bg-surface-elevated px-2 py-1"
        data-testid="composer-attachment"
        :data-phase="a.phase"
      >
        <img
          v-if="a.previewUrl"
          :src="a.previewUrl"
          :alt="a.name"
          class="h-8 w-8 rounded object-cover"
        />
        <span v-else class="text-base" aria-hidden="true">📄</span>
        <span class="min-w-0 truncate text-xs font-medium text-primary">{{ a.name }}</span>
        <span class="whitespace-nowrap text-[11px] text-muted">{{ formatBytes(a.size) }}</span>
        <!-- Phase cue: spinner while uploading, check on done, error on failed. -->
        <span
          v-if="a.phase === 'failed'"
          class="text-[11px] font-medium text-danger"
          data-testid="composer-attachment-error"
          >failed</span
        >
        <span v-else-if="a.phase === 'done'" class="text-[11px] text-success" aria-label="uploaded"
          >✓</span
        >
        <span v-else class="text-[11px] text-muted" aria-label="uploading">…</span>
        <button
          v-if="a.phase === 'failed'"
          type="button"
          class="text-[11px] font-medium text-secondary underline hover:text-primary"
          data-testid="composer-attachment-retry"
          @click="retryAttachment(a.localId)"
        >
          Retry
        </button>
        <button
          type="button"
          class="text-xs text-muted hover:text-primary"
          data-testid="composer-attachment-remove"
          aria-label="Remove attachment"
          @click="removeAttachment(a.localId)"
        >
          ✕
        </button>
      </div>
    </div>

    <!-- The bordered composer CARD: editor area on top, icon toolbar + accent send
         button below (ENG-136 "Ranin" high-fidelity redesign). -->
    <div
      class="relative rounded-md border border-subtle bg-surface-elevated transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30"
      :class="{ 'pointer-events-none opacity-60': props.disabled }"
    >
      <!-- Editor area. `composer-input` still lands on the ProseMirror node itself
           (set via editorProps.attributes), unchanged from M3. -->
      <div class="relative min-w-0 px-3 pb-1 pt-2.5">
        <!-- Placeholder overlay (StarterKit has no placeholder node; avoid a dep). -->
        <div
          v-if="empty"
          class="pointer-events-none absolute left-3 top-2.5 select-none text-sm text-muted"
          data-testid="composer-placeholder"
        >
          {{ props.placeholder }}
        </div>
        <EditorContent v-if="editor" :editor="editor" />
      </div>

      <!-- Hidden native multi-file input the toolbar's attach buttons proxy to. -->
      <input
        ref="fileInput"
        type="file"
        multiple
        class="hidden"
        data-testid="attach-file-input"
        @change="onFilePicked"
      />

      <ComposerToolbar
        :can-send="canSend"
        :disabled="props.disabled"
        @attach="openFilePicker"
        @bold="onToolbarBold"
        @emoji="onToolbarEmoji"
        @mention="onToolbarMention"
        @send="submit"
      />

      <!-- Shared curated-emoji popover (ui/EmojiPicker), anchored above the toolbar.
           A transparent backdrop dismisses it on an outside click. -->
      <template v-if="emojiOpen">
        <button
          type="button"
          class="fixed inset-0 z-20 cursor-default"
          aria-label="Close emoji picker"
          @click="emojiOpen = false"
        ></button>
        <div class="absolute bottom-12 left-2 z-30">
          <EmojiPicker
            menu-testid="composer-emoji-menu"
            option-testid="composer-emoji-option"
            @select="onEmojiSelect"
          />
        </div>
      </template>
    </div>

    <p class="mt-1.5 px-1 text-[11px] text-muted">Shift + Enter to add a new line</p>
  </div>
</template>

<style>
.composer-mention {
  border-radius: 0.25rem;
  background-color: rgb(var(--c-accent-subtle));
  padding: 0 0.25rem;
  color: rgb(var(--c-accent));
  font-weight: 500;
  /* Inert chip: never editable, never a script/handler surface. */
  white-space: nowrap;
}
</style>
