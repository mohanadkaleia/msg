<script setup lang="ts">
// ComposerToolbar — ENG-136 "Ranin" composer bottom row (PR-E), extended with a
// text-FORMATTING cluster (bold / italic / inline code · lists · quote / code
// block) from UI feedback ("add more text formatting controls").
//
// PURELY PRESENTATIONAL: it holds no store/editor state and never touches the
// worker — it only renders the icon-button rows + the accent circular send button
// and EMITS intent up to MessageComposer, which owns the tiptap editor and the
// send gate. Formatting buttons emit ONE generic `format` event carrying the
// action id; the parent maps it to the matching tiptap toggle command and feeds
// back `active` (is the selection inside that mark/node?) for the pressed
// highlight. The `+`/paperclip attach and emoji buttons are REAL (wired in the
// parent); mic/audio are rendered but `disabled` (no backend yet). There is NO
// `@` button — @mentions are typed: `@` in the editor opens the tiptap suggestion
// popup (ENG-152 conversation-pane cleanup).
import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'

/** Formatting actions — 1:1 with StarterKit toggle commands in the parent. */
export type FormatAction =
  'bold' | 'italic' | 'code' | 'bulletList' | 'orderedList' | 'blockquote' | 'codeBlock'

const props = withDefaults(
  defineProps<{
    /** Mirrors the parent send gate: text-or-attachment present AND uploads done. */
    canSend: boolean
    /** No writable stream selected → the whole row is inert (parent dims the card). */
    disabled?: boolean
    /** Which formats the current selection is inside (drives pressed styling). */
    active?: Partial<Record<FormatAction, boolean>>
  }>(),
  { disabled: false, active: () => ({}) },
)

const emit = defineEmits<{
  attach: []
  format: [action: FormatAction]
  emoji: [event: MouseEvent]
  send: []
}>()

/** The formatting cluster, grouped: inline marks · lists · block wrappers. */
const FORMAT_BUTTONS: {
  action: FormatAction
  icon: 'bold' | 'italic' | 'code' | 'list' | 'list-ordered' | 'text-quote' | 'square-code'
  label: string
  /** tiptap StarterKit default shortcut, surfaced in the tooltip. */
  shortcut: string
  /** Opens a visual sub-group (a hairline gap before this button). */
  groupStart?: boolean
}[] = [
  { action: 'bold', icon: 'bold', label: 'Bold', shortcut: 'Mod-B' },
  { action: 'italic', icon: 'italic', label: 'Italic', shortcut: 'Mod-I' },
  { action: 'code', icon: 'code', label: 'Inline code', shortcut: 'Mod-E' },
  {
    action: 'orderedList',
    icon: 'list-ordered',
    label: 'Numbered list',
    shortcut: 'Mod-Shift-7',
    groupStart: true,
  },
  { action: 'bulletList', icon: 'list', label: 'Bulleted list', shortcut: 'Mod-Shift-8' },
  {
    action: 'blockquote',
    icon: 'text-quote',
    label: 'Blockquote',
    shortcut: 'Mod-Shift-B',
    groupStart: true,
  },
  { action: 'codeBlock', icon: 'square-code', label: 'Code block', shortcut: 'Mod-Alt-C' },
]

/** Stable per-action testid, e.g. `composer-format-bulletList`. */
const testId = (action: FormatAction): string => `composer-format-${action}`
</script>

<template>
  <div class="flex items-center justify-between px-2 py-1.5">
    <div class="flex items-center gap-0.5">
      <IconButton size="sm" label="Attach file" data-testid="attach-file" @click="emit('attach')">
        <Icon name="plus" :size="18" />
      </IconButton>

      <!-- Formatting cluster (tokens only; pressed = accent-subtle chip). -->
      <span class="mx-1 h-4 w-px bg-strong" aria-hidden="true"></span>
      <IconButton
        v-for="btn in FORMAT_BUTTONS"
        :key="btn.action"
        size="sm"
        :label="btn.label"
        :title="`${btn.label} (${btn.shortcut})`"
        :data-testid="testId(btn.action)"
        :aria-pressed="props.active[btn.action] === true"
        :class="[
          btn.groupStart ? 'ms-1.5' : '',
          props.active[btn.action] === true ? 'bg-accent-subtle !text-accent' : '',
        ]"
        @click="emit('format', btn.action)"
      >
        <Icon :name="btn.icon" :size="16" />
      </IconButton>
      <span class="mx-1 h-4 w-px bg-strong" aria-hidden="true"></span>

      <IconButton
        size="sm"
        label="Emoji"
        data-testid="composer-emoji"
        @click="emit('emoji', $event)"
      >
        <Icon name="smile" :size="18" />
      </IconButton>
      <IconButton size="sm" label="Attach link" @click="emit('attach')">
        <Icon name="paperclip" :size="18" />
      </IconButton>
      <IconButton size="sm" label="Voice message" disabled title="Coming soon">
        <Icon name="mic" :size="18" />
      </IconButton>
      <IconButton size="sm" label="Audio" disabled title="Coming soon">
        <Icon name="audio-lines" :size="18" />
      </IconButton>
    </div>
    <button
      type="button"
      :disabled="!canSend"
      data-testid="composer-send"
      aria-label="Send message"
      class="flex h-8 w-8 items-center justify-center rounded-full transition-colors bg-accent text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      @click="emit('send')"
    >
      <Icon name="send" :size="16" />
    </button>
  </div>
</template>
