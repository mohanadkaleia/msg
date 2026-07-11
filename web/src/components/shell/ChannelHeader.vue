<script setup lang="ts">
// ChannelHeader — the conversation panel's top bar (ENG-136 "Ranin" PR-2).
//
// Extracted from AppShell's inline `<header data-testid="channel-header">` so the
// timeline chrome matches the reference mockup: a bold `# channel` (or DM) title,
// a muted member subline, and a right-aligned Details icon action. The
// `channel-header` test-id is preserved on the root `<header>` — the golden-path +
// m3-messaging-core E2E suites assert the title text through it, and its `.text()`
// MUST stay the title alone (the icon button carries no text; the member subline
// is a SIBLING `<p>`, not inside the header element).
//
// REAL vs SCAFFOLD: `title` is the live selected stream label (a DM's title is the
// OTHER participant's display name — ENG-149 — with a REAL presence dot when
// `presence` is provided; the dot is a text-free sibling of the h1, so the
// header's `.text()` is still the title alone). "N members" is a stand-in count
// (the workspace directory user count) until a real roster query lands.
// `toggle-details` is emitted for the parent to wire. There is NO add-member
// button here (ENG-152 cleanup) — adding members lives in the channel-settings
// dialog via the Details drawer. The non-functional star (favorite), pin, and
// "Add a topic" scaffolds were REMOVED (UI-feedback cleanup): there is no
// favorites/pin/channel-topic backend (`pin.*` is explicitly out of scope
// server-side), and dead controls must not ship.
//
// ENG-172: the member subline is CHANNEL-ONLY. For a DM (`kind: 'dm'`) the
// subline instead shows the counterpart's status/presence line (`subtitle`,
// computed by the shell) — never "N members", which is a channel concept. With
// no resolvable subtitle the DM renders no subline at all.
import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'
import PresenceDot from '../ui/PresenceDot.vue'

import type { PresenceStatus } from '../../worker'

const props = withDefaults(
  defineProps<{
    /** The conversation title — e.g. "# engineering" or a DM participant's name. */
    title: string
    /**
     * SCAFFOLD member count (a stand-in — the workspace directory user count). The
     * per-channel membership roster is not yet exposed to the tab; this is honestly
     * labeled as an approximation until a real roster query lands.
     */
    memberCount?: number
    /**
     * The DM counterpart's live presence (ENG-149) — set only for a DM with a
     * resolvable single counterpart; absent (no dot) for channels and group DMs.
     * `| undefined` so an exactOptionalPropertyTypes caller can bind a computed
     * that yields undefined for the no-dot case.
     */
    presence?: PresenceStatus | undefined
    /**
     * Whether this conversation is a DM (ENG-172): flips the subline from the
     * channel member/topic scaffold to the DM `subtitle`. Defaults to 'channel'
     * so every existing channel/section caller is unchanged.
     */
    kind?: 'channel' | 'dm'
    /**
     * DM-only subline (ENG-172): the counterpart's status + presence line,
     * computed by the shell (e.g. "🌴 On vacation · Active now"). Ignored for
     * channels; a DM with no resolvable counterpart renders no subline.
     */
    subtitle?: string | undefined
  }>(),
  { memberCount: 0, presence: undefined, kind: 'channel', subtitle: undefined },
)

defineEmits<{
  /** Toggle the channel Details drawer (wired in AppShell — ENG-136/ENG-129). */
  'toggle-details': []
}>()
</script>

<template>
  <header
    data-testid="channel-header"
    class="flex items-center justify-between gap-3 border-b border-subtle px-4 py-2.5"
  >
    <div class="flex min-w-0 items-center gap-2">
      <!-- REAL DM presence (ENG-149) — a text-free dot, so header .text() stays the title. -->
      <PresenceDot v-if="props.presence !== undefined" :status="props.presence" class="shrink-0" />
      <h1 class="truncate text-[15px] font-semibold text-primary">{{ props.title }}</h1>
    </div>
    <div class="flex items-center gap-1">
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
  <!-- ENG-172: channel subline (member count) vs the DM's status/presence
       subline — a DM never shows channel concepts here. -->
  <p
    v-if="props.kind !== 'dm'"
    class="px-4 pb-2 pt-1 text-xs text-muted"
    data-testid="channel-header-meta"
  >
    {{ props.memberCount }} {{ props.memberCount === 1 ? 'member' : 'members' }}
  </p>
  <p
    v-else-if="props.subtitle"
    class="px-4 pb-2 pt-1 text-xs text-muted"
    data-testid="channel-header-meta"
  >
    {{ props.subtitle }}
  </p>
</template>
