<script setup lang="ts">
// NewButton — ENG-152 PR-c, restyled COMPACT in the sidebar restructure: the
// old full-width accent button read as a hero control, so it is now a small,
// restrained ghost "+ New" button (secondary, bordered, auto width) at the top
// of the sidebar (under the workspace pill) opening a small popover menu of
// the REAL, already-wired create flows: "New message" (the existing
// NewDmDialog) and "New channel" (the existing CreateChannelDialog). The menu
// only EMITS — the parent owns the dialog flags, exactly like the palette's
// command seams. No invented actions: "Invite people" is deliberately absent
// (no web invite-creation seam exists — see lib/commands.ts's same note for
// the palette).
//
// Popover mechanics mirror the repo's bespoke pattern (EmojiPicker consumers):
// the button toggles, Escape and an outside click close, and each item closes
// after emitting.
import { onBeforeUnmount, onMounted, ref } from 'vue'

import Button from '../ui/Button.vue'
import Icon from '../ui/Icon.vue'

const emit = defineEmits<{
  /** Open the existing New DM dialog (the `open-new-dm` flow). */
  newDm: []
  /** Open the existing create-channel dialog (the `open-create-channel` flow). */
  newChannel: []
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function pick(action: 'newDm' | 'newChannel'): void {
  open.value = false
  if (action === 'newDm') emit('newDm')
  else emit('newChannel')
}

/** Close on a click anywhere outside the button + menu. */
function onDocumentClick(event: MouseEvent): void {
  if (!open.value) return
  const el = root.value
  if (el && event.target instanceof Node && !el.contains(event.target)) open.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <div ref="root" class="relative">
    <!-- Compact secondary control (not w-full, not accent-filled). -->
    <Button
      variant="ghost"
      size="sm"
      class="border border-subtle"
      data-testid="new-button"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Icon name="plus" :size="14" />
      New
    </Button>

    <div
      v-if="open"
      role="menu"
      aria-label="Create"
      data-testid="new-menu"
      class="absolute left-0 top-full z-30 mt-1 w-48 rounded-md border border-subtle bg-surface-elevated p-1 shadow-md"
    >
      <button
        type="button"
        role="menuitem"
        data-testid="new-menu-dm"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-primary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        @click="pick('newDm')"
      >
        <Icon name="message-square" :size="16" class="shrink-0 text-muted" />
        New message
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="new-menu-channel"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-primary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        @click="pick('newChannel')"
      >
        <Icon name="hash" :size="16" class="shrink-0 text-muted" />
        New channel
      </button>
    </div>
  </div>
</template>
