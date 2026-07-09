<script setup lang="ts">
// AdminMembersPanel — ENG-151 PR-3: the workspace roster for an owner/admin.
// Reads/writes ONLY through the `client.admin.members.*` worker RPCs (the
// worker owns the token; nothing here touches HTTP). Controls are gated by the
// PURE `adminPolicy` mirror — the server stays authoritative, so a coded 403/
// 404 from a stale client still surfaces as a calm inline error, never a crash.
//
// Update strategy: apply the RETURNED row on success (the server response is
// the updated member, so no refetch round-trip); on failure the row's role
// select is re-keyed so the DOM snaps back to the store truth, and a
// `not-found` additionally refetches the roster (it drifted).
import { computed, onMounted, ref } from 'vue'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import {
  ASSIGNABLE_ROLES,
  adminErrorCode,
  adminErrorCopy,
  permittedMemberActions,
} from '../../lib/adminPolicy'

import type { AdminAssignableRole, AdminMember, AdminMemberUpdateParams } from '../../worker'

const props = defineProps<{
  /** The signed-in user's role — one input of the policy mirror. */
  actorRole: string
  /** The signed-in user's id — the self-edit rule needs it. */
  actorUserId: string
}>()

const members = ref<AdminMember[]>([])
const loading = ref(true)
/** A failed roster LOAD (list) — renders the retryable error state. */
const loadError = ref<string | null>(null)
/** A failed row ACTION (update) — renders the inline error line. */
const actionError = ref<string | null>(null)
/** The row with an update in flight (all controls disabled meanwhile). */
const busyId = ref<string | null>(null)
/** The row whose Deactivate is awaiting inline confirmation. */
const confirmingDeactivate = ref<string | null>(null)
/** Bumped on a failed update so the role <select> re-keys back to store truth. */
const resetKey = ref(0)

/** Display labels for the assignable roles (values stay the wire slugs). */
const ROLE_LABELS: Record<AdminAssignableRole, string> = {
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}

const rows = computed(() =>
  members.value.map((member) => ({
    member,
    actions: permittedMemberActions(props.actorRole, props.actorUserId, member),
  })),
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const client = await resolveWorkerClient()
    members.value = (await client.admin.members.list()).members
  } catch (err) {
    loadError.value = adminErrorCopy(err)
  } finally {
    loading.value = false
  }
}

async function applyUpdate(params: AdminMemberUpdateParams): Promise<void> {
  if (busyId.value !== null) return
  busyId.value = params.user_id
  actionError.value = null
  try {
    const client = await resolveWorkerClient()
    const updated = await client.admin.members.update(params)
    const idx = members.value.findIndex((m) => m.user_id === updated.user_id)
    if (idx >= 0) members.value[idx] = updated
  } catch (err) {
    actionError.value = adminErrorCopy(err)
    resetKey.value++
    // The roster drifted under us (member gone) — resync the list.
    if (adminErrorCode(err) === 'not-found') await load()
  } finally {
    busyId.value = null
    confirmingDeactivate.value = null
  }
}

function onRoleChange(member: AdminMember, event: Event): void {
  const value = (event.target as HTMLSelectElement).value as AdminAssignableRole
  if (value === member.role) return
  void applyUpdate({ user_id: member.user_id, role: value })
}

onMounted(() => void load())
</script>

<template>
  <section data-testid="admin-members" aria-label="Members" class="flex min-h-0 flex-col">
    <p v-if="loading" class="px-1 py-4 text-[12px] text-muted" data-testid="admin-members-loading">
      Loading members…
    </p>

    <EmptyState
      v-else-if="loadError"
      data-testid="admin-members-load-error"
      title="Couldn't load members"
      :description="loadError"
    >
      <template #action>
        <Button variant="ghost" size="sm" data-testid="admin-members-retry" @click="load">
          Retry
        </Button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="members.length === 0"
      data-testid="admin-members-empty"
      title="No members"
      description="The roster is empty."
    />

    <template v-else>
      <ul class="divide-y divide-subtle">
        <li
          v-for="{ member, actions } in rows"
          :key="member.user_id"
          data-testid="admin-member-row"
          :data-user-id="member.user_id"
          class="flex items-center gap-3 px-1 py-2.5"
        >
          <!-- Identity: name + admin-visible email. -->
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 truncate text-[13px] font-medium text-primary">
              <span class="truncate">{{ member.display_name }}</span>
              <span
                v-if="member.role === 'owner'"
                class="shrink-0 rounded-full border border-subtle px-1.5 text-[11px] font-medium text-secondary"
                data-testid="admin-owner-badge"
                >Owner</span
              >
              <span
                v-if="member.is_bot"
                class="shrink-0 rounded-full bg-accent-subtle px-1.5 text-[11px] font-medium text-accent"
                data-testid="admin-bot-badge"
                >Bot</span
              >
              <span
                v-if="member.deactivated"
                class="shrink-0 rounded-full bg-danger/10 px-1.5 text-[11px] font-medium text-danger"
                data-testid="admin-deactivated-badge"
                >Deactivated</span
              >
            </p>
            <p class="truncate text-[12px] text-muted">{{ member.email }}</p>
          </div>

          <!-- Role: a dropdown when the policy mirror allows it, else static
               text (the Owner badge above already labels the owner row). -->
          <select
            v-if="actions.changeRole"
            :key="`${member.user_id}:${member.role}:${resetKey}`"
            :value="member.role"
            :disabled="busyId !== null"
            :aria-label="`Role for ${member.display_name}`"
            data-testid="admin-role-select"
            class="h-7 rounded border border-strong bg-transparent px-1.5 text-[12px] text-primary focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            @change="onRoleChange(member, $event)"
          >
            <option v-for="r in ASSIGNABLE_ROLES" :key="r" :value="r">{{ ROLE_LABELS[r] }}</option>
          </select>
          <span
            v-else-if="member.role !== 'owner'"
            class="text-[12px] capitalize text-secondary"
            data-testid="admin-role-static"
            >{{ member.role }}</span
          >

          <!-- Active toggle: Deactivate (destructive → inline confirm) or
               Reactivate. Hidden entirely when the policy denies it. -->
          <template v-if="actions.toggleActive">
            <Button
              v-if="member.deactivated"
              variant="ghost"
              size="sm"
              :disabled="busyId !== null"
              data-testid="admin-reactivate"
              @click="applyUpdate({ user_id: member.user_id, active: true })"
            >
              Reactivate
            </Button>
            <template v-else-if="confirmingDeactivate === member.user_id">
              <span
                class="flex items-center gap-1.5"
                data-testid="admin-deactivate-confirm"
                role="alert"
              >
                <span class="text-[11px] text-secondary">Their sessions end immediately.</span>
                <Button
                  variant="danger"
                  size="sm"
                  :disabled="busyId !== null"
                  data-testid="admin-deactivate-confirm-yes"
                  @click="applyUpdate({ user_id: member.user_id, active: false })"
                >
                  Deactivate
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="admin-deactivate-confirm-no"
                  @click="confirmingDeactivate = null"
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
              data-testid="admin-deactivate"
              @click="confirmingDeactivate = member.user_id"
            >
              Deactivate
            </Button>
          </template>
        </li>
      </ul>

      <p
        v-if="actionError"
        class="px-1 py-2 text-[12px] text-danger"
        data-testid="admin-members-error"
      >
        {{ actionError }}
      </p>
    </template>
  </section>
</template>
