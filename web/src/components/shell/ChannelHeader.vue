<script setup lang="ts">
// ChannelHeader — the conversation panel's top bar (ENG-136 "Ranin" PR-2).
//
// Extracted from AppShell's inline `<header data-testid="channel-header">` so the
// timeline chrome matches the reference mockup: a bold `# channel` (or DM) title
// with a favorite STAR, a muted member/topic subline, and a cluster of right-
// aligned icon actions (add-member, pin, details). The `channel-header` test-id is
// preserved on the root `<header>` — the golden-path + m3-messaging-core E2E suites
// assert the title text through it, and its `.text()` MUST stay the title alone
// (the icon buttons carry no text; the member/topic subline is a SIBLING `<p>`, not
// inside the header element).
//
// REAL vs SCAFFOLD: `title` is the live selected stream label. Everything else is a
// LOCAL, honest scaffold with no backend — the star/pin toggles are local ref
// state, "N members" is a stand-in count (the workspace directory user count), and
// "Add a topic" is a non-wired affordance. `add-member` / `toggle-details` are
// emitted for the parent to wire (details drawer lands in a later PR).
import { ref } from 'vue'

import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'

const props = withDefaults(
  defineProps<{
    /** The conversation title — e.g. "# engineering" or a DM name. */
    title: string
    /**
     * SCAFFOLD member count (a stand-in — the workspace directory user count). The
     * per-channel membership roster is not yet exposed to the tab; this is honestly
     * labeled as an approximation until a real roster query lands.
     */
    memberCount?: number
  }>(),
  { memberCount: 0 },
)

defineEmits<{
  /** Open the add-member affordance (wired by the parent to channel settings). */
  'add-member': []
  /** Toggle the channel Details drawer (wired in AppShell — ENG-136/ENG-129). */
  'toggle-details': []
}>()

/** SCAFFOLD local favorite toggle — no backend. */
const favorite = ref(false)
</script>

<template>
  <header
    data-testid="channel-header"
    class="flex items-center justify-between gap-3 border-b border-subtle px-4 py-2.5"
  >
    <div class="flex min-w-0 items-center gap-2">
      <h1 class="truncate text-[15px] font-semibold text-primary">{{ props.title }}</h1>
      <IconButton
        size="sm"
        :label="favorite ? 'Unfavorite' : 'Favorite'"
        :class="favorite ? 'text-accent' : ''"
        @click="favorite = !favorite"
      >
        <Icon name="star" :size="16" />
      </IconButton>
    </div>
    <div class="flex items-center gap-1">
      <IconButton
        size="sm"
        label="Add member"
        data-testid="channel-header-add-member"
        @click="$emit('add-member')"
      >
        <Icon name="user-plus" :size="18" />
      </IconButton>
      <IconButton size="sm" label="Pinned messages">
        <Icon name="pin" :size="18" />
      </IconButton>
      <IconButton
        size="sm"
        label="Details"
        data-testid="channel-header-details"
        @click="$emit('toggle-details')"
      >
        <Icon name="more-horizontal" :size="18" />
      </IconButton>
    </div>
  </header>
  <p class="px-4 pb-2 pt-1 text-xs text-muted" data-testid="channel-header-meta">
    {{ props.memberCount }} {{ props.memberCount === 1 ? 'member' : 'members' }} ·
    <button type="button" class="underline-offset-2 hover:text-secondary hover:underline">
      Add a topic
    </button>
  </p>
</template>
