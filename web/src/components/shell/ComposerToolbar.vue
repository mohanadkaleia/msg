<script setup lang="ts">
// ComposerToolbar — ENG-136 "Ranin" composer bottom row (PR-E).
//
// PURELY PRESENTATIONAL: it holds no store/editor state and never touches the
// worker — it only renders the icon-button row + the accent circular send button
// and EMITS intent up to MessageComposer, which owns the tiptap editor and the send
// gate. The `+`/paperclip attach, `Aa` bold, emoji, and `@` mention buttons are
// REAL (wired in the parent); mic/audio are rendered but `disabled` (no backend yet).
import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'

withDefaults(
  defineProps<{
    /** Mirrors the parent send gate: text-or-attachment present AND uploads done. */
    canSend: boolean
    /** No writable stream selected → the whole row is inert (parent dims the card). */
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  attach: []
  bold: []
  emoji: [event: MouseEvent]
  mention: []
  send: []
}>()
</script>

<template>
  <div class="flex items-center justify-between px-2 py-1.5">
    <div class="flex items-center gap-0.5">
      <IconButton size="sm" label="Attach file" data-testid="attach-file" @click="emit('attach')">
        <Icon name="plus" :size="18" />
      </IconButton>
      <IconButton size="sm" label="Bold" @click="emit('bold')">
        <Icon name="type" :size="18" />
      </IconButton>
      <IconButton
        size="sm"
        label="Emoji"
        data-testid="composer-emoji"
        @click="emit('emoji', $event)"
      >
        <Icon name="smile" :size="18" />
      </IconButton>
      <IconButton
        size="sm"
        label="Mention someone"
        data-testid="composer-mention-btn"
        @click="emit('mention')"
      >
        <Icon name="at-sign" :size="18" />
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
