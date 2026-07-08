<script setup lang="ts">
// ui/Icon.vue — ENG-136 "Ranin" icon foundation (PR-E).
//
// A thin wrapper over `lucide-vue-next` that maps a STABLE string `name` to a
// concrete icon component. Icons are imported PER-ICON and NAMED (never a barrel
// `import * as icons` nor a dynamic `import()`), so the bundler tree-shakes to the
// exact set this app uses — the whole point of paying the wrapper's indirection.
//
// Consumers say `<Icon name="send" :size="16" />`, decoupling call-sites from the
// lucide component identity: renames live here, in one typed map. Icons are
// decorative by default (`aria-hidden`); pass `label` to promote an icon to a
// standalone semantic image (`role="img"` + `aria-label`) — but PREFER labeling the
// surrounding control (e.g. `ui/IconButton`'s `label`) and leaving the glyph hidden.
import {
  AtSign,
  AudioLines,
  ChevronDown,
  Hash,
  Mic,
  Paperclip,
  Plus,
  Search,
  Send,
  Smile,
  Type,
  X,
  type LucideIcon,
} from 'lucide-vue-next'
import { computed } from 'vue'

// The explicit, typed name→component map. Add a row here (plus the named import
// above) when a later PR needs a new glyph — keeping the surface auditable.
const ICONS = {
  plus: Plus,
  type: Type,
  smile: Smile,
  'at-sign': AtSign,
  paperclip: Paperclip,
  mic: Mic,
  'audio-lines': AudioLines,
  send: Send,
  x: X,
  'chevron-down': ChevronDown,
  hash: Hash,
  search: Search,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

const props = withDefaults(
  defineProps<{
    /** Stable icon key (decoupled from the lucide component identity). */
    name: IconName
    /** Square edge length in px. */
    size?: number
    /**
     * When set, the glyph is a standalone semantic image (`role="img"` +
     * `aria-label`). Omit for decorative icons inside an already-labeled control —
     * then the glyph is `aria-hidden` so screen readers don't double-announce it.
     */
    label?: string | undefined
  }>(),
  { size: 18, label: undefined },
)

const component = computed(() => ICONS[props.name])

// a11y attributes as an all-present bag (v-bind spreads only defined keys, so we
// never assign an explicit `undefined` — required under exactOptionalPropertyTypes).
// Labeled → a standalone image; unlabeled → decorative and hidden.
const a11y = computed(() =>
  props.label ? { role: 'img', 'aria-label': props.label } : { 'aria-hidden': true },
)
</script>

<template>
  <component
    :is="component"
    :size="size ?? 18"
    :stroke-width="1.75"
    stroke="currentColor"
    v-bind="a11y"
  />
</template>
