<script setup lang="ts">
// AdminInvitesPanel — ENG-151 PR-3: the workspace's PENDING invites for an
// owner/admin. Reads/revokes ONLY through the `client.admin.invites.*` worker
// RPCs; each row shows the invite's role, its creator (resolved to a display
// name via the local directory projection when available, else the raw id),
// and a relative expiry. Revoke is destructive → inline confirm (repo pattern).
//
// There is deliberately NO create-invite affordance: no web seam exists —
// invites are minted via the CLI today (the empty state says so honestly).
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { adminErrorCode, adminErrorCopy } from '../../lib/adminPolicy'
import { formatExpiresIn } from '../../lib/time'
import { useWorkspaceStore } from '../../stores/workspace'

import type { AdminInvite } from '../../worker'

const invites = ref<AdminInvite[]>([])
const loading = ref(true)
/** A failed LOAD (list) — renders the retryable error state. */
const loadError = ref<string | null>(null)
/** A failed REVOKE — renders the inline error line. */
const actionError = ref<string | null>(null)
/** The invite with a revoke in flight. */
const busyId = ref<string | null>(null)
/** The invite whose Revoke is awaiting inline confirmation. */
const confirmingRevoke = ref<string | null>(null)

// Creator names come from the ALREADY-LOADED directory projection (zero
// network) — the admin seam carries only the creator's user_id.
const { directory } = storeToRefs(useWorkspaceStore())
const names = computed<ReadonlyMap<string, string>>(() => {
  const map = new Map<string, string>()
  for (const u of directory.value.users) map.set(u.user_id, u.display_name)
  return map
})

function creatorLabel(invite: AdminInvite): string {
  return names.value.get(invite.created_by) ?? invite.created_by
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const client = await resolveWorkerClient()
    invites.value = (await client.admin.invites.list()).invites
  } catch (err) {
    loadError.value = adminErrorCopy(err)
  } finally {
    loading.value = false
  }
}

async function revoke(id: string): Promise<void> {
  if (busyId.value !== null) return
  busyId.value = id
  actionError.value = null
  try {
    const client = await resolveWorkerClient()
    await client.admin.invites.revoke({ id })
    invites.value = invites.value.filter((i) => i.id !== id)
  } catch (err) {
    // Already gone (used/expired/revoked elsewhere) — refetch rather than error.
    if (adminErrorCode(err) === 'not-found') await load()
    else actionError.value = adminErrorCopy(err)
  } finally {
    busyId.value = null
    confirmingRevoke.value = null
  }
}

onMounted(() => void load())
</script>

<template>
  <section data-testid="admin-invites" aria-label="Pending invites" class="flex min-h-0 flex-col">
    <p v-if="loading" class="px-1 py-4 text-[12px] text-muted" data-testid="admin-invites-loading">
      Loading invites…
    </p>

    <EmptyState
      v-else-if="loadError"
      data-testid="admin-invites-load-error"
      title="Couldn't load invites"
      :description="loadError"
    >
      <template #action>
        <Button variant="ghost" size="sm" data-testid="admin-invites-retry" @click="load">
          Retry
        </Button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="invites.length === 0"
      data-testid="admin-invites-empty"
      title="No pending invites"
      description="New invites are created from the CLI today."
    />

    <template v-else>
      <ul class="divide-y divide-subtle">
        <li
          v-for="invite in invites"
          :key="invite.id"
          data-testid="admin-invite-row"
          :data-invite-id="invite.id"
          class="flex items-center gap-3 px-1 py-2.5"
        >
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-[13px] text-primary">
              <span
                class="shrink-0 rounded-full border border-subtle px-1.5 text-[11px] font-medium capitalize text-secondary"
                data-testid="admin-invite-role"
                >{{ invite.role }}</span
              >
              <span class="truncate text-secondary">
                invited by <span class="text-primary">{{ creatorLabel(invite) }}</span>
              </span>
            </p>
            <p class="text-[12px] text-muted" data-testid="admin-invite-expiry">
              Expires {{ formatExpiresIn(invite.expires_at) }}
            </p>
          </div>

          <template v-if="confirmingRevoke === invite.id">
            <span class="flex items-center gap-1.5" data-testid="admin-revoke-confirm" role="alert">
              <span class="text-[11px] text-secondary">The invite link stops working.</span>
              <Button
                variant="danger"
                size="sm"
                :disabled="busyId !== null"
                data-testid="admin-revoke-confirm-yes"
                @click="revoke(invite.id)"
              >
                Revoke
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="admin-revoke-confirm-no"
                @click="confirmingRevoke = null"
              >
                Cancel
              </Button>
            </span>
          </template>
          <Button
            v-else
            variant="danger"
            size="sm"
            :disabled="busyId !== null"
            data-testid="admin-invite-revoke"
            @click="confirmingRevoke = invite.id"
          >
            Revoke
          </Button>
        </li>
      </ul>

      <p
        v-if="actionError"
        class="px-1 py-2 text-[12px] text-danger"
        data-testid="admin-invites-error"
      >
        {{ actionError }}
      </p>
    </template>
  </section>
</template>
