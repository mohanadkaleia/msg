<script setup lang="ts">
// InboxItem — one Inbox triage row (ENG-136 "Ranin"). A DUMB view over a single
// `InboxEntry`: a 36px leading avatar (a `hash` glyph for a channel, an initial
// for a DM), a bold title + a muted one-line preview + a small meta row (a
// `# channel`/`DM` chip and an accent "N new" count), and a right-aligned
// relative timestamp with an accent unread dot while unread.
//
// SECURITY: title/preview are other users' input (stream names + message text) —
// rendered via text interpolation only, never a raw-HTML sink.
//
// ENG-152 (feed + preview split): a single CLICK now SELECTS the row for the
// preview pane (`select`; the accent-subtle active state marks it); a
// DOUBLE-CLICK emits `open` — the full jump to the conversation (the preview
// header's "Open" button is the primary path for that).
import { computed } from 'vue'

import Icon from '../ui/Icon.vue'
import { formatActivityTime } from '../../lib/time'
import type { InboxEntry } from '../../composables/useInbox'

const props = withDefaults(
  defineProps<{
    entry: InboxEntry
    /** True while this row is the preview selection (accent-subtle highlight). */
    selected?: boolean
  }>(),
  { selected: false },
)

const emit = defineEmits<{
  /** Single click: select this row for the preview pane (stays in Inbox). */
  select: []
  /** Double click: the full jump to this stream's conversation. */
  open: []
}>()

/** Single-letter avatar for a DM row (mirrors the sidebar's `dmInitial`). */
const initial = computed(() => props.entry.title.trim()[0]?.toUpperCase() ?? '?')

/** Relative stamp: "10:32 AM" today, "Yesterday", else a short date. */
const time = computed(() => formatActivityTime(props.entry.lastActivityTs))

/** Meta chip: the channel's `# name` (the title verbatim) or a plain "DM". */
const chip = computed(() => (props.entry.kind === 'dm' ? 'DM' : props.entry.title))
</script>

<template>
  <button
    type="button"
    data-testid="inbox-item"
    :data-stream-id="entry.stream_id"
    :data-unread="entry.unread"
    :data-selected="selected"
    :aria-pressed="selected"
    class="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    :class="selected ? 'bg-accent-subtle' : 'hover:bg-surface'"
    @click="emit('select')"
    @dblclick="emit('open')"
  >
    <!-- Leading 36px avatar: hash glyph for a channel, initial for a DM. -->
    <span
      v-if="entry.kind === 'channel'"
      class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent"
    >
      <Icon name="hash" :size="16" />
    </span>
    <span
      v-else
      class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-subtle text-[13px] font-semibold text-accent"
      >{{ initial }}</span
    >

    <!-- Title + preview + meta. -->
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[13px] font-semibold text-primary">{{ entry.title }}</span>
      <span class="block truncate text-[12px] text-muted">{{ entry.preview }}</span>
      <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
        <span class="truncate rounded border border-subtle px-1.5 py-px">{{ chip }}</span>
        <template v-if="entry.unread > 0">
          <span aria-hidden="true">·</span>
          <span class="shrink-0 font-medium text-accent" data-testid="inbox-new-count"
            >{{ entry.unread }} new</span
          >
        </template>
      </span>
    </span>

    <!-- Right rail: relative timestamp + unread dot. -->
    <span class="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
      <span class="text-[11px] text-muted">{{ time }}</span>
      <span
        v-if="entry.unread > 0"
        class="h-2 w-2 rounded-full bg-accent"
        data-testid="inbox-unread-dot"
      />
    </span>
  </button>
</template>
