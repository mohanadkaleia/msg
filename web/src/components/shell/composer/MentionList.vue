<script setup lang="ts">
// MentionList — the @mention / #channel autocomplete dropdown. A CONTROLLED,
// keyboard-navigable list: arrow keys move the selection, Enter/Tab commits it,
// and clicking commits directly. It renders labels as plain text bindings (never
// v-html), so a hostile display_name is inert. It talks to no store and no
// network — it only receives an already-filtered `items` array and calls the
// TipTap-provided `command` to insert the chip.
import { nextTick, ref, watch } from 'vue'

import UserAvatar from '../../ui/UserAvatar.vue'
import UserPopover from '../../ui/UserPopover.vue'

import type { MentionItem } from './mentions'

const props = defineProps<{
  items: MentionItem[]
  command: (item: { id: string; label: string }) => void
}>()

const selected = ref(0)

// Reset the highlight to the top whenever the filtered list changes.
watch(
  () => props.items,
  () => {
    selected.value = 0
  },
)

function commit(index: number): void {
  const item = props.items[index]
  if (item) props.command({ id: item.id, label: item.label })
}

/** Keyboard nav delegated from the suggestion plugin. Returns true when handled. */
function onKeyDown(event: KeyboardEvent): boolean {
  if (props.items.length === 0) return false
  if (event.key === 'ArrowUp') {
    selected.value = (selected.value + props.items.length - 1) % props.items.length
    void nextTick()
    return true
  }
  if (event.key === 'ArrowDown') {
    selected.value = (selected.value + 1) % props.items.length
    void nextTick()
    return true
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    commit(selected.value)
    return true
  }
  return false
}

defineExpose({ onKeyDown })
</script>

<template>
  <div
    class="max-h-56 min-w-[12rem] overflow-y-auto rounded-md border border-subtle bg-surface-elevated py-1 text-sm shadow-lg"
    data-testid="mention-list"
  >
    <button
      v-for="(item, index) in props.items"
      :key="item.id"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      :class="index === selected ? 'bg-accent-subtle text-primary' : 'text-secondary'"
      data-testid="mention-option"
      @mousedown.prevent="commit(index)"
    >
      <!-- User rows carry an avatar (image when set, initial otherwise, ENG-152);
           channel rows keep the # glyph. Hover previews the profile (ENG-152) but
           is NOT clickable here — a click on the row selects the mention. -->
      <UserPopover
        v-if="item.kind === 'user'"
        :user-id="item.id"
        :name="item.label"
        :clickable="false"
      >
        <UserAvatar
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-[10px] font-semibold text-accent"
          aria-hidden="true"
          :user-id="item.id"
          :name="item.label"
          :sha="item.avatar_sha"
        />
      </UserPopover>
      <span v-else class="text-muted">#</span>
      <span class="truncate">{{ item.label }}</span>
    </button>
    <div v-if="props.items.length === 0" class="px-3 py-1.5 text-muted">No matches</div>
  </div>
</template>
