<script setup lang="ts">
// AppsView — ENG-176: the Apps/Integrations surface (bots + incoming webhooks
// over the M5 plugin backend), reached from the sidebar's `nav-apps` item (the
// shell's `activeView` flips to 'apps'; sections are shell panels, matching
// Admin/Inbox/Files). All data flows through the `client.plugins.*` worker
// RPCs — this view never touches HTTP or the token.
//
// Role gating, two layers deep (the AdminView pattern): the sidebar already
// hides the Apps item for members/guests (`canAdmin`), and this view
// INDEPENDENTLY checks the auth store's role — a non-privileged user who lands
// here anyway sees a no-access empty state and NO plugin RPC is ever issued
// (the server would 403 it too; this surface mints credentials, so it fails
// closed at every layer).
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'

import AppsBotsPanel from './AppsBotsPanel.vue'
import AppsHooksPanel from './AppsHooksPanel.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useAuthStore } from '../../stores/auth'

type AppsTab = 'bots' | 'hooks'

const { role } = storeToRefs(useAuthStore())

/** Mirror of the shell's `canAdmin` — checked HERE too (defense in depth). */
const canAdmin = computed(() => role.value === 'owner' || role.value === 'admin')

const activeTab = ref<AppsTab>('bots')

const TABS: ReadonlyArray<{ key: AppsTab; label: string }> = [
  { key: 'bots', label: 'Bots' },
  { key: 'hooks', label: 'Incoming webhooks' },
]
</script>

<template>
  <section data-testid="apps-view" class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- No-access state: never issue a plugin RPC for a member/guest. -->
    <div v-if="!canAdmin" class="flex flex-1 items-center justify-center">
      <EmptyState
        data-testid="apps-no-access"
        title="You don't have access"
        description="Only a workspace owner or admin can manage bots and webhooks."
      />
    </div>

    <template v-else>
      <!-- Tabs: Bots / Incoming webhooks (AdminView's tab styling). -->
      <div
        role="tablist"
        aria-label="Apps sections"
        class="flex items-end gap-1 border-b border-subtle px-4"
      >
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :data-testid="`apps-tab-${tab.key}`"
          class="-mb-px border-b-2 px-2.5 py-2 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          :class="
            activeTab === tab.key
              ? 'border-accent font-medium text-primary'
              : 'border-transparent text-secondary hover:text-primary'
          "
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Panels: a calm, constrained-width column (the Admin layout). -->
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div class="mx-auto w-full max-w-2xl">
          <!-- How integrations work — a short conceptual note (docs/plugins.md
               has the full contract + the GitHub notifier reference). -->
          <p class="px-1 pb-3 text-[12px] text-muted" data-testid="apps-how-it-works">
            Bots post as their own identity using a scoped token you mint here — treat it like a
            password. Incoming webhooks give an external service a secret URL that posts into one
            channel. Each secret is shown exactly once at creation; see the plugins doc and the
            GitHub notifier example for the full contract.
          </p>

          <AppsBotsPanel v-if="activeTab === 'bots'" />
          <AppsHooksPanel v-else />
        </div>
      </div>
    </template>
  </section>
</template>
