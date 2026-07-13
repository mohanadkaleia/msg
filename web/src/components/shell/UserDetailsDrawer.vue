<script setup lang="ts">
// UserDetailsDrawer — the right-drawer "user details" panel (ENG-152). The fuller
// counterpart to the hovercard, opened by clicking a user avatar/name: a large
// avatar with a presence dot, the display name, title, custom status, an
// online/offline presence line, the read-only role (when known), and the profile
// description. It reads NOTHING itself — the shell passes the already-in-memory
// directory record + live presence + role down as props, so this stays a DUMB,
// token-styled view and the token boundary (`no-http-in-ui`) is untouched.
//
// Role is shown only when the shell KNOWS it (the signed-in user's own role, from
// the auth store) — the workspace directory does not carry other members' roles,
// so we never invent one. Email is likewise not in the directory, so it is omitted.
//
// SECURITY: every profile field is user-controlled — rendered via text
// interpolation only (never v-html).
import { computed } from 'vue'

import { activeStatus } from '../../lib/status'
import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'
import PresenceDot from '../ui/PresenceDot.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import type { DirectoryUser, PresenceStatus } from '../../worker'

const props = defineProps<{
  /** The folded directory record for the user this panel describes. */
  user: DirectoryUser
  /** The member's live presence (ephemeral; `offline` when unknown). */
  presence: PresenceStatus
  /** Read-only role, when the shell knows it (self only); omitted otherwise. */
  role?: string | undefined
}>()

defineEmits<{
  /** The ✕ — the shell clears the user-details drawer, restoring the prior state. */
  close: []
}>()

const status = computed(() => activeStatus(props.user))
const online = computed(() => props.presence === 'online')
const presenceLabel = computed(() => (online.value ? 'Active now' : 'Offline'))
</script>

<template>
  <aside
    data-testid="user-details-drawer"
    class="flex h-full min-w-0 flex-col border-l border-subtle bg-background"
  >
    <header class="flex items-center justify-between border-b border-subtle px-4 py-3">
      <h2 class="text-[15px] font-semibold text-primary">Profile</h2>
      <IconButton
        size="sm"
        label="Close profile"
        data-testid="user-details-close"
        @click="$emit('close')"
      >
        <Icon name="x" :size="16" />
      </IconButton>
    </header>

    <div class="flex-1 overflow-y-auto p-4">
      <!-- Identity block: large avatar + presence dot, name, title, custom status. -->
      <div class="flex flex-col items-center text-center">
        <span class="relative shrink-0">
          <UserAvatar
            aria-hidden="true"
            class="grid h-20 w-20 place-items-center rounded-full bg-accent-subtle text-2xl font-semibold text-accent"
            :user-id="user.user_id"
            :name="user.display_name"
            :sha="user.avatar_sha256"
          />
          <PresenceDot
            :status="presence"
            class="absolute bottom-1 right-1 border-2 border-background"
          />
        </span>
        <h3 class="mt-3 text-base font-semibold text-primary">{{ user.display_name }}</h3>
        <p v-if="user.title" class="mt-0.5 text-sm text-secondary">{{ user.title }}</p>
        <p v-if="status" data-testid="user-details-status" class="mt-1 text-sm text-secondary">
          <span v-if="status.emoji" class="mr-1">{{ status.emoji }}</span>{{ status.text }}
        </p>
      </div>

      <dl class="mt-5 space-y-4 text-sm">
        <!-- Live presence. -->
        <div>
          <dt class="text-xs font-medium uppercase tracking-wide text-muted">Presence</dt>
          <dd
            data-testid="user-details-presence"
            :data-status="presence"
            class="mt-1 flex items-center gap-1.5 text-primary"
          >
            <span
              aria-hidden="true"
              class="h-2 w-2 shrink-0 rounded-full"
              :class="online ? 'bg-success' : 'bg-muted'"
            />
            {{ presenceLabel }}
          </dd>
        </div>

        <!-- Read-only role — shown only when the shell knows it (self). -->
        <div v-if="role">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted">Role</dt>
          <dd data-testid="user-details-role" class="mt-1 capitalize text-primary">{{ role }}</dd>
        </div>

        <!-- About / description. -->
        <div v-if="user.description">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted">About</dt>
          <dd
            data-testid="user-details-description"
            class="mt-1 whitespace-pre-wrap break-words text-primary"
          >
            {{ user.description }}
          </dd>
        </div>
      </dl>
    </div>
  </aside>
</template>
