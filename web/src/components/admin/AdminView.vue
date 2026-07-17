<script setup lang="ts">
// AdminView — ENG-151 PR-3: the Admin surface (members + pending invites +
// workspace settings, ENG-152), reached from the sidebar's split Admin items
// ("Members & invites" / "Workspace" — the shell's `activeView` flips to
// 'admin'; sections are shell panels here, not router routes, matching
// Inbox/Apps/Files). All data flows through the `client.admin.*` worker RPCs;
// this view never touches HTTP or the token.
//
// Deep-targeting (sidebar Admin split): `initialTab` seeds the active tab and
// is WATCHED — clicking the other sidebar Admin item while this view is
// already open re-targets the tab. The tabs themselves keep working locally;
// every user tab click is reported up via `tabChange` so the shell (and the
// sidebar highlight) stays in sync.
//
// Role gating, two layers deep: the sidebar already hides the Admin items for
// members/guests (`canAdmin`), and this view INDEPENDENTLY checks the auth
// store's role — a non-privileged user who lands here anyway sees a no-access
// empty state and NO admin RPC is ever issued (the server would 403 it too).
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import AdminInvitesPanel from './AdminInvitesPanel.vue'
import AdminMembersPanel from './AdminMembersPanel.vue'
import AdminWorkspacePanel from './AdminWorkspacePanel.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useAuthStore } from '../../stores/auth'

import type { AdminTab } from '../../composables/useShellController'

const props = withDefaults(defineProps<{ initialTab?: AdminTab }>(), { initialTab: 'members' })

const emit = defineEmits<{
  /** A user tab click — the shell tracks it for the sidebar's active state. */
  tabChange: [tab: AdminTab]
}>()

const { role, myUserId } = storeToRefs(useAuthStore())

/** Mirror of the shell's `canAdmin` — checked HERE too (defense in depth). */
const canAdmin = computed(() => role.value === 'owner' || role.value === 'admin')

const activeTab = ref<AdminTab>(props.initialTab)

// Re-target when the sidebar's split Admin items change the requested tab
// while the view is already mounted.
watch(
  () => props.initialTab,
  (tab) => {
    activeTab.value = tab
  },
)

/** Tab click: local switch + report up (keeps the sidebar highlight honest). */
function selectTab(tab: AdminTab): void {
  activeTab.value = tab
  emit('tabChange', tab)
}

const TABS: ReadonlyArray<{ key: AdminTab; label: string }> = [
  { key: 'members', label: 'Members' },
  { key: 'invites', label: 'Invites' },
  { key: 'workspace', label: 'Workspace' },
]
</script>

<template>
  <section data-testid="admin-view" class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- No-access state: never issue an admin RPC for a member/guest. -->
    <div v-if="!canAdmin" class="flex flex-1 items-center justify-center">
      <EmptyState
        data-testid="admin-no-access"
        title="You don't have access"
        description="Only a workspace owner or admin can manage members and invites."
      />
    </div>

    <template v-else>
      <!-- Tabs: Members / Invites (InboxView's tab styling). -->
      <div
        role="tablist"
        aria-label="Admin sections"
        class="flex items-end gap-1 border-b border-subtle px-4"
      >
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :data-testid="`admin-tab-${tab.key}`"
          class="-mb-px border-b-2 px-2.5 py-2 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          :class="
            activeTab === tab.key
              ? 'border-accent font-medium text-primary'
              : 'border-transparent text-secondary hover:text-primary'
          "
          @click="selectTab(tab.key)"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Panels: a calm, constrained-width column (compact roster rows). -->
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div class="mx-auto w-full max-w-2xl">
          <AdminMembersPanel
            v-if="activeTab === 'members'"
            :actor-role="role ?? ''"
            :actor-user-id="myUserId ?? ''"
          />
          <AdminInvitesPanel v-else-if="activeTab === 'invites'" />
          <AdminWorkspacePanel v-else />
        </div>
      </div>
    </template>
  </section>
</template>
