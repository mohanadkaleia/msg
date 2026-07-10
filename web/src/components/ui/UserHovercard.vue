<script setup lang="ts">
// UserHovercard — the small on-hover profile popover (ENG-152). DUMB + token-
// styled: it renders a directory record + a live presence status and NOTHING
// else — no store access, no fetch, no positioning (the anchor/UserPopover owns
// where it floats). Shows the avatar, display name, title, the ACTIVE custom
// status (emoji/text, hidden when none or lazily expired via lib/status.ts), and
// an online/offline presence line ("Active now" / "Offline").
//
// Presence here is the ONLY place a member's live status surfaces on message/DM
// rows — the always-on row dots were intentionally removed (ENG-152 conversation-
// pane cleanup); presence shows on demand in this card instead.
//
// SECURITY: display_name / title / status text are all other users' input —
// rendered via Vue text interpolation only (never v-html).
import { computed } from 'vue'

import { activeStatus } from '../../lib/status'
import type { DirectoryUser, PresenceStatus } from '../../worker'
import UserAvatar from './UserAvatar.vue'

const props = defineProps<{
  /** The folded directory record (display_name/title/status/avatar_sha256). */
  user: DirectoryUser
  /** The member's live presence (ephemeral; `offline` when unknown). */
  presence: PresenceStatus
}>()

/** The custom status to SHOW — null when unset or lazily expired (render-time). */
const status = computed(() => activeStatus(props.user))
const online = computed(() => props.presence === 'online')
const presenceLabel = computed(() => (online.value ? 'Active now' : 'Offline'))
</script>

<template>
  <div
    data-testid="user-hovercard"
    role="tooltip"
    class="w-64 rounded-lg border border-subtle bg-surface-elevated p-3 text-left shadow-lg"
  >
    <div class="flex items-center gap-3">
      <UserAvatar
        aria-hidden="true"
        class="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent-subtle text-base font-semibold text-accent"
        :user-id="user.user_id"
        :name="user.display_name"
        :sha="user.avatar_sha256"
      />
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold text-primary">{{ user.display_name }}</p>
        <p v-if="user.title" class="truncate text-xs text-secondary">{{ user.title }}</p>
      </div>
    </div>

    <!-- Custom status (ENG-164) — hidden entirely when there is none to show. -->
    <p
      v-if="status"
      data-testid="user-hovercard-status"
      class="mt-2 truncate text-xs text-secondary"
    >
      <template v-if="status.emoji">{{ status.emoji }} </template>{{ status.text }}
    </p>

    <!-- Live presence — the on-demand replacement for the removed row dots. -->
    <div
      data-testid="user-hovercard-presence"
      :data-status="presence"
      class="mt-2 flex items-center gap-1.5 text-xs text-secondary"
    >
      <span
        aria-hidden="true"
        class="h-2 w-2 shrink-0 rounded-full"
        :class="online ? 'bg-success' : 'bg-muted'"
      />
      {{ presenceLabel }}
    </div>
  </div>
</template>
