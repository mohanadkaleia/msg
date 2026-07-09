<script setup lang="ts">
// AdminInvitesPanel — ENG-151: the workspace's PENDING invites for an
// owner/admin, plus "Create invite link". Everything flows through the
// `client.admin.invites.*` worker RPCs (list / create / revoke) — this panel
// never touches HTTP or the token. Each row shows the invite's role, its
// creator (resolved via the local directory projection when available, else
// the raw id), and a relative expiry. Revoke is destructive → inline confirm.
//
// CREATE is the one place the RAW join link ever exists in a tab: the server
// returns it exactly once (only its sha256 is stored), so the panel shows it
// in a copyable field with a "won't be shown again" warning; closing the card
// discards it forever. Role choices mirror the server Literal — Owner is
// structurally not offered (an invite can never mint an owner). The server
// stays authoritative: a 403/422 surfaces inline as coded-error copy.
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { ASSIGNABLE_ROLES, adminErrorCode, adminErrorCopy } from '../../lib/adminPolicy'
import { formatExpiresIn } from '../../lib/time'
import { useWorkspaceStore } from '../../stores/workspace'

import type { AdminAssignableRole, AdminInvite } from '../../worker'

/** Expiry presets (sent as `ttl_seconds`; 7 days is the server default too). */
const TTL_OPTIONS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 24 * 60 * 60, label: '1 day' },
  { seconds: 7 * 24 * 60 * 60, label: '7 days' },
  { seconds: 30 * 24 * 60 * 60, label: '30 days' },
]

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

// -- Create-invite state ------------------------------------------------
/** Whether the create card is open (form or, once generated, the link). */
const creating = ref(false)
/** The role the new invite grants — server Literal; Owner is never offered. */
const createRole = ref<AdminAssignableRole>('member')
/** The invite's lifetime in seconds (sent as `ttl_seconds`; server clamps). */
const createTtl = ref(TTL_OPTIONS[1]!.seconds)
/** A create RPC in flight (disables Generate). */
const generating = ref(false)
/** A failed create — coded-error copy rendered inside the card. */
const createError = ref<string | null>(null)
/** The one-time join URL. Shown ONCE — closing the card discards it forever. */
const createdUrl = ref<string | null>(null)
/** Copy feedback (flips the button label briefly). */
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/** Display labels for the assignable roles (values stay the wire slugs). */
const ROLE_LABELS: Record<AdminAssignableRole, string> = {
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}

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

/** Open the create card fresh (defaults; any previous one-time link is gone). */
function openCreate(): void {
  creating.value = true
  createRole.value = 'member'
  createTtl.value = TTL_OPTIONS[1]!.seconds
  createError.value = null
  createdUrl.value = null
  copied.value = false
}

/** Close + reset. Once a link was shown, closing discards it FOREVER (by design). */
function closeCreate(): void {
  creating.value = false
  createError.value = null
  createdUrl.value = null
  copied.value = false
}

async function generate(): Promise<void> {
  if (generating.value) return
  generating.value = true
  createError.value = null
  try {
    const client = await resolveWorkerClient()
    const res = await client.admin.invites.create({
      role: createRole.value,
      ttl_seconds: createTtl.value,
    })
    createdUrl.value = res.url
    // The new invite is pending now — refresh the list below the card.
    await load()
  } catch (err) {
    createError.value = adminErrorCopy(err)
  } finally {
    generating.value = false
  }
}

async function copyLink(): Promise<void> {
  if (createdUrl.value === null) return
  try {
    await navigator.clipboard.writeText(createdUrl.value)
    copied.value = true
    if (copiedTimer !== undefined) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // Clipboard unavailable (permissions) — the field stays selectable by hand.
  }
}

onMounted(() => void load())
</script>

<template>
  <section data-testid="admin-invites" aria-label="Pending invites" class="flex min-h-0 flex-col">
    <!-- Create invite link — the web path that mints an invite (owner/admin;
         the server 403s anyone else). Always visible above the list states. -->
    <div v-if="!creating" class="flex items-center justify-end px-1 pb-2">
      <Button size="sm" data-testid="create-invite" @click="openCreate">Create invite link</Button>
    </div>

    <div
      v-if="creating"
      class="mx-1 mb-3 rounded-md border border-subtle p-3"
      data-testid="create-invite-card"
    >
      <!-- Phase 2 — the generated link, shown EXACTLY ONCE (never again). -->
      <template v-if="createdUrl !== null">
        <p class="pb-1.5 text-[13px] font-medium text-primary">Invite link created</p>
        <div class="flex items-center gap-1.5">
          <input
            readonly
            :value="createdUrl"
            aria-label="Invite link"
            data-testid="invite-link"
            class="h-7 min-w-0 flex-1 rounded border border-strong bg-transparent px-2 text-[12px] text-primary focus:border-accent focus:outline-none"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <Button size="sm" data-testid="invite-link-copy" @click="copyLink">
            {{ copied ? 'Copied' : 'Copy' }}
          </Button>
        </div>
        <p class="pt-1.5 text-[12px] text-warning" data-testid="invite-link-note">
          Copy it now — this link won't be shown again.
        </p>
        <div class="flex justify-end pt-2">
          <Button variant="ghost" size="sm" data-testid="invite-link-done" @click="closeCreate">
            Done
          </Button>
        </div>
      </template>

      <!-- Phase 1 — choose role + expiry, then Generate. Owner is never offered. -->
      <template v-else>
        <p class="pb-2 text-[13px] font-medium text-primary">Create invite link</p>
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1 text-[12px] text-secondary">
            Role
            <select
              v-model="createRole"
              :disabled="generating"
              data-testid="create-invite-role"
              class="h-7 rounded border border-strong bg-transparent px-1.5 text-[12px] text-primary focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option v-for="r in ASSIGNABLE_ROLES" :key="r" :value="r">
                {{ ROLE_LABELS[r] }}
              </option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[12px] text-secondary">
            Expires in
            <select
              v-model="createTtl"
              :disabled="generating"
              data-testid="create-invite-expiry"
              class="h-7 rounded border border-strong bg-transparent px-1.5 text-[12px] text-primary focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option v-for="opt in TTL_OPTIONS" :key="opt.seconds" :value="opt.seconds">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <span class="flex items-center gap-1.5">
            <Button
              size="sm"
              :disabled="generating"
              data-testid="create-invite-generate"
              @click="generate"
            >
              Generate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :disabled="generating"
              data-testid="create-invite-cancel"
              @click="closeCreate"
            >
              Cancel
            </Button>
          </span>
        </div>
        <p
          v-if="createError"
          class="pt-2 text-[12px] text-danger"
          data-testid="create-invite-error"
          role="alert"
        >
          {{ createError }}
        </p>
      </template>
    </div>

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
      description="Create an invite link to bring someone into the workspace."
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
