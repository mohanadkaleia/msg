<script setup lang="ts">
// AppsHooksPanel — ENG-176: the workspace's incoming webhooks for an
// owner/admin, plus "Create webhook". Everything flows through the
// `client.plugins.hooks.*` worker RPCs (list / create / revoke) — this panel
// never touches HTTP or the token store.
//
// CREATE is the one place the CAPABILITY URL ever exists in a tab: the server
// returns it exactly once (only the path token's sha256 is stored), so the
// panel shows it in a copyable field with a "won't be shown again" warning;
// closing the card discards it forever. Listings carry hash HANDLES only.
// Revoke is uniform-404-safe: an already-gone hook refetches instead of
// erroring (revoked ≡ never-existed server-side, by design). The server stays
// authoritative: a 403/404/422 surfaces inline as coded-error copy.
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { adminErrorCode, adminErrorCopy } from '../../lib/adminPolicy'
import { useWorkspaceStore } from '../../stores/workspace'

import type { PluginHook } from '../../worker'

const hooks = ref<PluginHook[]>([])
const loading = ref(true)
/** A failed LOAD (list) — renders the retryable error state. */
const loadError = ref<string | null>(null)
/** A failed REVOKE — renders the inline error line. */
const actionError = ref<string | null>(null)
/** The hook with a revoke in flight. */
const busyId = ref<string | null>(null)
/** The hook whose Revoke is awaiting inline confirmation. */
const confirmingRevoke = ref<string | null>(null)

// -- Create-webhook state -----------------------------------------------------
/** Whether the create card is open (form or, once created, the one-time URL). */
const creating = ref(false)
const createStreamId = ref('')
const createName = ref('')
const createBusy = ref(false)
const createError = ref<string | null>(null)
/** The one-time capability URL. Shown ONCE — closing discards it forever. */
const createdUrl = ref<string | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

// Channel names come from the ALREADY-LOADED sidebar projection (zero network)
// — the same stream source the sidebar renders from.
const { streams } = storeToRefs(useWorkspaceStore())

/** Target channels: real channels only (never DMs/meta), archived excluded —
 * mirroring the server's channel kind-gate on hook creation. */
const channels = computed(() =>
  streams.value
    .filter((s) => s.kind === 'channel' && s.archived !== true)
    .sort((a, b) => (a.name ?? a.stream_id).localeCompare(b.name ?? b.stream_id)),
)

const channelNames = computed<ReadonlyMap<string, string>>(() => {
  const map = new Map<string, string>()
  for (const s of streams.value) map.set(s.stream_id, s.name ?? s.stream_id)
  return map
})

function channelLabel(streamId: string): string {
  return channelNames.value.get(streamId) ?? streamId
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const client = await resolveWorkerClient()
    hooks.value = (await client.plugins.hooks.list()).hooks
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
    await client.plugins.hooks.revoke({ id })
    hooks.value = hooks.value.filter((h) => h.id !== id)
  } catch (err) {
    // Already gone (revoked elsewhere) — refetch rather than error (the
    // uniform 404: revoked and never-existed are indistinguishable).
    if (adminErrorCode(err) === 'not-found') await load()
    else actionError.value = adminErrorCopy(err)
  } finally {
    busyId.value = null
    confirmingRevoke.value = null
  }
}

/** Open the create card fresh (any previous one-time URL is gone). */
function openCreate(): void {
  creating.value = true
  createStreamId.value = channels.value[0]?.stream_id ?? ''
  createName.value = ''
  createError.value = null
  createdUrl.value = null
  copied.value = false
}

/** Close + reset. Once a URL was shown, closing discards it FOREVER (by design). */
function closeCreate(): void {
  creating.value = false
  createError.value = null
  createdUrl.value = null
  copied.value = false
}

const canSubmitCreate = computed(
  () => createStreamId.value !== '' && createName.value.trim().length > 0 && !createBusy.value,
)

async function submitCreate(): Promise<void> {
  if (!canSubmitCreate.value) return
  createBusy.value = true
  createError.value = null
  try {
    const client = await resolveWorkerClient()
    // No `bot_user_id` — the server auto-provisions a dedicated events:write
    // bot named for the hook (the M5-1 creation path).
    const res = await client.plugins.hooks.create({
      stream_id: createStreamId.value,
      name: createName.value.trim(),
    })
    createdUrl.value = res.url
    // The new hook is listed now — refresh the rows below the card.
    await load()
  } catch (err) {
    createError.value = adminErrorCopy(err)
  } finally {
    createBusy.value = false
  }
}

async function copyUrl(): Promise<void> {
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
  <section data-testid="apps-hooks" aria-label="Incoming webhooks" class="flex min-h-0 flex-col">
    <!-- Create webhook — mints the capability URL (owner/admin; the server
         403s anyone else). Always visible above the list states. -->
    <div v-if="!creating" class="flex items-center justify-end px-1 pb-2">
      <Button size="sm" data-testid="create-hook" @click="openCreate">Create webhook</Button>
    </div>

    <div
      v-if="creating"
      class="mx-1 mb-3 rounded-md border border-subtle p-3"
      data-testid="create-hook-card"
    >
      <!-- Phase 2 — the capability URL, shown EXACTLY ONCE (never again). -->
      <template v-if="createdUrl !== null">
        <p class="pb-1.5 text-[13px] font-medium text-primary">Webhook created</p>
        <div class="flex items-center gap-1.5">
          <input
            readonly
            :value="createdUrl"
            aria-label="Webhook URL"
            data-testid="hook-url"
            class="h-7 min-w-0 flex-1 rounded border border-strong bg-transparent px-2 font-mono text-[12px] text-primary focus:border-accent focus:outline-none"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <Button size="sm" data-testid="hook-url-copy" @click="copyUrl">
            {{ copied ? 'Copied' : 'Copy' }}
          </Button>
        </div>
        <p class="pt-1.5 text-[12px] text-warning" data-testid="hook-url-note">
          Copy it now — this URL won't be shown again. Anyone who has it can post into the channel.
        </p>
        <div class="flex justify-end pt-2">
          <Button variant="ghost" size="sm" data-testid="hook-url-done" @click="closeCreate">
            Done
          </Button>
        </div>
      </template>

      <!-- Phase 1 — pick the target channel + name, then Create. -->
      <template v-else>
        <p class="pb-2 text-[13px] font-medium text-primary">Create webhook</p>
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1 text-[12px] text-secondary">
            Posts into
            <select
              v-model="createStreamId"
              :disabled="createBusy"
              data-testid="create-hook-channel"
              class="h-7 rounded border border-strong bg-transparent px-1.5 text-[12px] text-primary focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option v-for="c in channels" :key="c.stream_id" :value="c.stream_id">
                # {{ c.name ?? c.stream_id }}
              </option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[12px] text-secondary">
            Name
            <input
              v-model="createName"
              :disabled="createBusy"
              data-testid="create-hook-name"
              placeholder="e.g. GitHub notifier"
              maxlength="200"
              class="h-7 rounded border border-strong bg-transparent px-2 text-[12px] text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <span class="flex items-center gap-1.5">
            <Button
              size="sm"
              :disabled="!canSubmitCreate"
              data-testid="create-hook-submit"
              @click="submitCreate"
            >
              Create
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :disabled="createBusy"
              data-testid="create-hook-cancel"
              @click="closeCreate"
            >
              Cancel
            </Button>
          </span>
        </div>
        <p
          v-if="createError"
          class="pt-2 text-[12px] text-danger"
          data-testid="create-hook-error"
          role="alert"
        >
          {{ createError }}
        </p>
      </template>
    </div>

    <p v-if="loading" class="px-1 py-4 text-[12px] text-muted" data-testid="apps-hooks-loading">
      Loading webhooks…
    </p>

    <EmptyState
      v-else-if="loadError"
      data-testid="apps-hooks-load-error"
      title="Couldn't load webhooks"
      :description="loadError"
    >
      <template #action>
        <Button variant="ghost" size="sm" data-testid="apps-hooks-retry" @click="load">
          Retry
        </Button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="hooks.length === 0"
      data-testid="apps-hooks-empty"
      title="No incoming webhooks"
      description="Create a webhook to let an external service post into a channel."
    />

    <template v-else>
      <ul class="divide-y divide-subtle">
        <li
          v-for="hook in hooks"
          :key="hook.id"
          data-testid="hook-row"
          :data-hook-id="hook.id"
          class="flex items-center gap-3 px-1 py-2.5"
        >
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-[13px] text-primary">
              <span class="truncate" data-testid="hook-name">{{ hook.name }}</span>
              <span
                v-if="hook.disabled"
                class="shrink-0 rounded-full border border-subtle px-1.5 text-[11px] text-muted"
                data-testid="hook-disabled"
                >disabled</span
              >
            </p>
            <p class="text-[12px] text-muted" data-testid="hook-channel">
              Posts into <span class="text-secondary"># {{ channelLabel(hook.stream_id) }}</span>
            </p>
          </div>

          <template v-if="confirmingRevoke === hook.id">
            <span class="flex items-center gap-1.5" data-testid="hook-revoke-confirm" role="alert">
              <span class="text-[11px] text-secondary">The webhook URL stops working.</span>
              <Button
                variant="danger"
                size="sm"
                :disabled="busyId !== null"
                data-testid="hook-revoke-confirm-yes"
                @click="revoke(hook.id)"
              >
                Revoke
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="hook-revoke-confirm-no"
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
            data-testid="hook-revoke"
            @click="confirmingRevoke = hook.id"
          >
            Revoke
          </Button>
        </li>
      </ul>

      <p
        v-if="actionError"
        class="px-1 py-2 text-[12px] text-danger"
        data-testid="apps-hooks-error"
      >
        {{ actionError }}
      </p>
    </template>
  </section>
</template>
