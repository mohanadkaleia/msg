<script setup lang="ts">
// InboxItem — one Inbox triage row (ENG-136 "Ranin"). A DUMB view over a single
// `InboxEntry`: a 36px leading avatar (a `hash` glyph for a channel, an initial
// for a DM), a bold title + a muted one-line preview + a small meta row (a
// `# channel`/`DM` chip and an accent "N new" count), and a right-aligned
// relative timestamp with an accent unread dot while unread.
//
// SECURITY: title/preview are other users' input (stream names + message text) —
// rendered via text interpolation only, never a raw-HTML sink.
import { computed } from 'vue'

import Icon from '../ui/Icon.vue'
import { formatActivityTime } from '../../lib/time'
import type { InboxEntry } from '../../composables/useInbox'

const props = defineProps<{ entry: InboxEntry }>()

const emit = defineEmits<{ open: [] }>()

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
    class="flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    @click="emit('open')"
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
