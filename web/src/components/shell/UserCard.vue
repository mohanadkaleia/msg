<script setup lang="ts">
// UserCard — ENG-136 "Ranin" sidebar footer (PR-3). The signed-in user's card:
// an avatar (initial) with a presence dot, the REAL display name, a presence
// label, and a `chevron-down`. Clicking the card opens the user's own profile
// (view + edit) — it emits `open-profile`, which the sidebar wires to the
// ProfileDialog.
//
// The presence dot color is REAL: it reflects the current user's status from the
// ENG-126 presence snapshot (via the presence store), `bg-success` when online and
// a muted dot when offline. `name` is resolved from the directory upstream.
//
// ENG-164: when the user has an ACTIVE custom status (emoji/text — expiry is
// already applied upstream via `lib/status.ts` `activeStatus`, so an expired
// status never reaches these props), the sub-line shows it instead of the
// presence label (the dot still carries presence). Custom status is DISTINCT
// from presence: it is durable profile state, not the ephemeral online dot.
//
// SECURITY: `name` / `statusText` are user-controlled — rendered via text
// interpolation only.
import { computed } from 'vue'

import type { PresenceStatus } from '../../worker'
import Icon from '../ui/Icon.vue'
import PresenceDot from '../ui/PresenceDot.vue'
import UserAvatar from '../ui/UserAvatar.vue'

const props = withDefaults(
  defineProps<{
    name: string
    status?: PresenceStatus
    /** ACTIVE custom status halves (ENG-164) — pass only a non-expired status.
     * `| undefined` spelled out for exactOptionalPropertyTypes callers. */
    // eslint-disable-next-line vue/require-default-prop -- optional; absent = no custom status
    statusEmoji?: string | undefined
    // eslint-disable-next-line vue/require-default-prop -- optional; absent = no custom status
    statusText?: string | undefined
    /** ENG-152: the signed-in user's id + avatar ref (from the directory) — the
     * chip renders their avatar IMAGE when set, else the initial as before. */
    // eslint-disable-next-line vue/require-default-prop -- optional; absent = initials
    userId?: string | undefined
    // eslint-disable-next-line vue/require-default-prop -- optional; absent = initials
    avatarSha?: string | undefined
  }>(),
  {
    status: 'online',
  },
)

const emit = defineEmits<{ openProfile: [] }>()
const online = computed(() => props.status === 'online')
const statusLabel = computed(() => (online.value ? 'Online' : 'Offline'))
/** Narrowed for the dot (exactOptionalPropertyTypes: the default is 'online'). */
const dotStatus = computed<PresenceStatus>(() => props.status ?? 'online')
/** True when there is an active custom status to show on the sub-line. */
const hasCustomStatus = computed(
  () => props.statusEmoji !== undefined || props.statusText !== undefined,
)
</script>

<template>
  <button
    type="button"
    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    data-testid="user-card"
    aria-label="Open your profile"
    @click="emit('openProfile')"
  >
    <span class="relative shrink-0">
      <UserAvatar
        aria-hidden="true"
        class="grid h-7 w-7 place-items-center rounded-full bg-accent-subtle text-[12px] font-semibold text-accent"
        :user-id="props.userId"
        :name="props.name"
        :sha="props.avatarSha"
      />
      <PresenceDot
        :status="dotStatus"
        class="absolute -bottom-0.5 -right-0.5 border-2 border-surface"
      />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[13px] font-medium text-primary">{{ name }}</span>
      <span
        v-if="hasCustomStatus"
        class="block truncate text-xs text-muted"
        data-testid="user-card-status"
        ><span v-if="statusEmoji" class="mr-1">{{ statusEmoji }}</span>{{ statusText }}</span
      >
      <span v-else class="block text-xs text-muted">{{ statusLabel }}</span>
    </span>
    <span data-testid="open-profile" class="shrink-0">
      <Icon name="chevron-down" :size="16" class="text-muted" />
    </span>
  </button>
</template>
