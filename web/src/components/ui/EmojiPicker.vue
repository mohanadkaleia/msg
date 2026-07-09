<script lang="ts">
// ui/EmojiPicker.vue — ENG-136 shared curated emoji palette (PR-E).
//
// A small, keyboard-accessible grid popover that emits `select(emoji)`. Extracted
// from MessageItem's reaction picker so BOTH the message-reaction toolbar and the
// composer's emoji button consume ONE curated set + one grid — no dependency on a
// heavyweight emoji-mart. Purely presentational: it emits the chosen glyph and owns
// no open/close state (each consumer positions + toggles it).
//
// SECURITY: emoji here are safe LITERAL glyphs from our own curated list; they are
// still rendered ONLY via text interpolation (never a raw-HTML sink).

/** The curated palette shared by the reaction picker and the composer. */
export const PICKER_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥', '✅', '👀'] as const
</script>

<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    /** Glyphs to offer; defaults to the shared curated palette. */
    emojis?: readonly string[]
    /** Optional test id for the grid container (consumer-specific). */
    menuTestid?: string | undefined
    /** Optional test id stamped on every option button (consumer-specific). */
    optionTestid?: string | undefined
  }>(),
  { emojis: () => PICKER_EMOJI, menuTestid: undefined, optionTestid: undefined },
)

const emit = defineEmits<{ select: [emoji: string] }>()
</script>

<template>
  <div
    role="menu"
    aria-label="Pick an emoji"
    class="grid grid-cols-5 gap-0.5 rounded-md border border-subtle bg-surface-elevated p-1 shadow-md"
    :data-testid="props.menuTestid"
  >
    <button
      v-for="emoji in props.emojis"
      :key="emoji"
      type="button"
      role="menuitem"
      class="rounded px-1 py-0.5 text-sm hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      :data-testid="props.optionTestid"
      :data-emoji="emoji"
      @click="emit('select', emoji)"
    >
      {{ emoji }}
    </button>
  </div>
</template>
