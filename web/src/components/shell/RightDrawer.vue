<script setup lang="ts">
// RightDrawer — ENG-136 "Ranin" right drawer. A thin host that renders EITHER the
// thread panel OR the channel Details panel as the right-hand column, keyed on the
// shell's `drawerMode` ('none' | 'thread' | 'details' — mutually exclusive by
// construction in useShellController).
//
// The thread branch is UNCHANGED from the boolean-open wrapper it replaces: SAME
// synchronous mount/unmount (no leave transition, so closing removes the pane
// immediately), and it reuses <ThreadPane> VERBATIM — the `thread-pane` /
// `thread-close` / `thread-composer` testids (which live in ThreadPane) are
// untouched. Landmark: role="complementary", aria-label="Thread".
//
// The details branch hosts <ChannelDetailsDrawer> for the selected stream
// (landmark aria-label="Details"), forwarding its close / open-members / left
// events to the shell. A mount-only CSS entrance gives each open a subtle
// slide-in without ever delaying the close.
import ChannelDetailsDrawer from './ChannelDetailsDrawer.vue'
import ThreadPane from './ThreadPane.vue'
import type { DrawerMode } from '../../composables/useShellController'
import type { SidebarStream } from '../../stores/workspace'

defineProps<{
  mode: DrawerMode
  /** The selected stream the Details panel describes (ignored for 'thread'). */
  stream?: SidebarStream | null
}>()

defineEmits<{
  /** Details ✕ — the shell flips `drawerMode` back to 'none'. */
  close: []
  /** Details Members row — the shell opens the channel-settings dialog. */
  'open-members': []
  /** The user left the channel — the shell closes + reselects. */
  left: []
}>()
</script>

<template>
  <div
    v-if="mode === 'thread'"
    role="complementary"
    aria-label="Thread"
    class="drawer-panel h-full w-96 shrink-0 overflow-hidden"
  >
    <ThreadPane />
  </div>

  <div
    v-else-if="mode === 'details' && stream"
    role="complementary"
    aria-label="Details"
    class="drawer-panel h-full w-64 shrink-0 overflow-hidden"
  >
    <ChannelDetailsDrawer
      :stream="stream"
      @close="$emit('close')"
      @open-members="$emit('open-members')"
      @left="$emit('left')"
    />
  </div>
</template>

<style scoped>
@keyframes drawer-in {
  from {
    opacity: 0;
    transform: translateX(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.drawer-panel {
  animation: drawer-in 150ms ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .drawer-panel {
    animation: none;
  }
}
</style>
