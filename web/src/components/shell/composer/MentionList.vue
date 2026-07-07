<script setup lang="ts">
// MentionList — the @mention / #channel autocomplete dropdown. A CONTROLLED,
// keyboard-navigable list: arrow keys move the selection, Enter/Tab commits it,
// and clicking commits directly. It renders labels as plain text bindings (never
// v-html), so a hostile display_name is inert. It talks to no store and no
// network — it only receives an already-filtered `items` array and calls the
// TipTap-provided `command` to insert the chip.
import { nextTick, ref, watch } from 'vue'

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
    class="max-h-56 min-w-[12rem] overflow-y-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
    data-testid="mention-list"
  >
    <button
      v-for="(item, index) in props.items"
      :key="item.id"
      type="button"
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      :class="index === selected ? 'bg-slate-100 text-slate-900' : 'text-slate-700'"
      data-testid="mention-option"
      @mousedown.prevent="commit(index)"
    >
      <span class="text-slate-400">{{ item.kind === 'channel' ? '#' : '@' }}</span>
      <span class="truncate">{{ item.label }}</span>
    </button>
    <div v-if="props.items.length === 0" class="px-3 py-1.5 text-slate-400">No matches</div>
  </div>
</template>
