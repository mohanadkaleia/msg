<script setup lang="ts">
// WorkspaceSwitcher — ENG-136 "Ranin" workspace selector pill (PR-3). A single
// row under the sidebar header: a leading rounded workspace glyph + the REAL
// workspace name + a `chevron-down`. Clicking the pill opens the quick-switcher
// (Cmd+K palette), preserving the `open-switcher` test-id that previously lived
// in the header. (An earlier decorative "play/forward" glyph was removed on user
// feedback — it read as an interactive control but was a no-op.)
import Icon from '../ui/Icon.vue'

defineProps<{ workspaceName: string; workspaceInitials: string }>()
const emit = defineEmits<{ openSwitcher: [] }>()
</script>

<template>
  <div class="px-2">
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      data-testid="open-switcher"
      title="Switch workspace (⌘K)"
      @click="emit('openSwitcher')"
    >
      <span
        aria-hidden="true"
        class="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-subtle text-[11px] font-semibold text-accent"
      >
        {{ workspaceInitials }}
      </span>
      <span class="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">{{
        workspaceName
      }}</span>
      <Icon name="chevron-down" :size="16" class="shrink-0 text-muted" />
    </button>
  </div>
</template>
