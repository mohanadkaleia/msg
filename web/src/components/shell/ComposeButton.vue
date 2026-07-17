<script setup lang="ts">
// ComposeButton — the sidebar's create control, relocated (user feedback) from
// the standalone "+ New" ghost button (the former NewButton, ENG-152 PR-c) to a
// SMALL compose icon sitting next to the Inbox nav row. Same menu, same REAL
// create flows: "New message" (the existing NewDmDialog) and "New channel" (the
// existing CreateChannelDialog). The menu only EMITS — the parent owns the
// dialog flags, exactly like the palette's command seams. The `new-menu` /
// `new-menu-dm` / `new-menu-channel` test-ids are PRESERVED; the trigger is now
// `inbox-compose`. No invented actions: "Invite people" is deliberately absent
// (no web invite-creation seam exists — see lib/commands.ts's same note for
// the palette).
//
// Popover mechanics mirror the repo's bespoke pattern (EmojiPicker consumers):
// the button toggles, Escape and an outside click close, and each item closes
// after emitting. The menu is right-aligned (the trigger sits at the sidebar
// row's right edge, so a left-aligned 12rem menu would overflow the column).
import { onBeforeUnmount, onMounted, ref } from 'vue'

import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'

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
    <!-- Small compose glyph (square-pen) — the Inbox row's trailing control. -->
    <IconButton
      size="sm"
      label="New message or channel"
      title="New message or channel"
      data-testid="inbox-compose"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Icon name="square-pen" :size="14" />
    </IconButton>

    <div
      v-if="open"
      role="menu"
      aria-label="Create"
      data-testid="new-menu"
      class="absolute right-0 top-full z-30 mt-1 w-48 rounded-md border border-subtle bg-surface-elevated p-1 shadow-md"
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
