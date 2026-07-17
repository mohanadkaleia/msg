<script setup lang="ts">
// AppsBotsPanel — ENG-176: the workspace's bots for an owner/admin, plus
// "Create bot", per-bot token mint/revoke and channel grant/revoke. Everything
// flows through the `client.plugins.bots.*` worker RPCs — this panel never
// touches HTTP or the token store.
//
// MINT is the one place a RAW bot token ever exists in a tab: the server
// returns it exactly once (only its sha256 is stored), so the panel shows it
// in a copyable field with a "won't be shown again" warning; Done (or any
// re-render path that drops the card) discards it forever. It is held in a
// plain ref for display only — never written to storage, never logged.
// Listings show sha256 hash HANDLES only (revoke handles, not credentials).
// The server stays authoritative: a 403/404/422 surfaces inline as coded copy.
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { adminErrorCode, adminErrorCopy } from '../../lib/adminPolicy'
import { useWorkspaceStore } from '../../stores/workspace'

import type { PluginBot, PluginScope } from '../../worker'

/** The closed scope vocabulary (server Literal), with human labels. */
const SCOPES: ReadonlyArray<{ value: PluginScope; label: string; hint: string }> = [
  { value: 'events:write', label: 'Post messages', hint: 'events:write' },
  { value: 'events:read', label: 'Read messages', hint: 'events:read' },
  { value: 'files:write', label: 'Upload files', hint: 'files:write' },
]

const bots = ref<PluginBot[]>([])
const loading = ref(true)
/** A failed LOAD (list) — renders the retryable error state. */
const loadError = ref<string | null>(null)
/** A failed row action (mint/revoke/grant) — renders the inline error line. */
const actionError = ref<string | null>(null)
/** Any row mutation in flight (serializes the destructive ops). */
const busy = ref(false)
/** The token row (bot_user_id:token_id) whose Revoke awaits inline confirm. */
const confirmingTokenRevoke = ref<string | null>(null)

// -- Create-bot state -------------------------------------------------------
const creating = ref(false)
const createName = ref('')
const createScopes = ref<Set<PluginScope>>(new Set(['events:write']))
const createChannels = ref<Set<string>>(new Set())
const createBusy = ref(false)
const createError = ref<string | null>(null)

// -- One-time mint display ----------------------------------------------------
/** The freshly minted RAW token, shown ONCE for its bot. Closing discards it
 * forever (the server keeps only the hash — it can never be shown again). */
const minted = ref<{ bot_user_id: string; token: string } | null>(null)
const mintCopied = ref(false)
let mintCopiedTimer: ReturnType<typeof setTimeout> | undefined

// -- Channel grant pick (per bot) --------------------------------------------
const grantPick = ref<Record<string, string>>({})

// Channel names come from the ALREADY-LOADED sidebar projection (zero network)
// — the same stream source the sidebar renders from.
const workspace = useWorkspaceStore()
const { streams } = storeToRefs(workspace)

/** Grantable channels: real channels only (never DMs/meta), archived excluded. */
const grantableChannels = computed(() =>
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

/** Channels a bot can still be granted (not already in its grant set). */
function ungranted(bot: PluginBot): Array<{ stream_id: string; label: string }> {
  const granted = new Set(bot.stream_ids)
  return grantableChannels.value
    .filter((s) => !granted.has(s.stream_id))
    .map((s) => ({ stream_id: s.stream_id, label: s.name ?? s.stream_id }))
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const client = await resolveWorkerClient()
    bots.value = (await client.plugins.bots.list()).bots
  } catch (err) {
    loadError.value = adminErrorCopy(err)
  } finally {
    loading.value = false
  }
}

// -- Create bot ---------------------------------------------------------------

function openCreate(): void {
  creating.value = true
  createName.value = ''
  createScopes.value = new Set(['events:write'])
  createChannels.value = new Set()
  createError.value = null
}

function closeCreate(): void {
  creating.value = false
  createError.value = null
}

function toggleScope(scope: PluginScope): void {
  const next = new Set(createScopes.value)
  if (next.has(scope)) next.delete(scope)
  else next.add(scope)
  createScopes.value = next
}

function toggleChannel(streamId: string): void {
  const next = new Set(createChannels.value)
  if (next.has(streamId)) next.delete(streamId)
  else next.add(streamId)
  createChannels.value = next
}

const canSubmitCreate = computed(
  () => createName.value.trim().length > 0 && createScopes.value.size > 0 && !createBusy.value,
)

async function submitCreate(): Promise<void> {
  if (!canSubmitCreate.value) return
  createBusy.value = true
  createError.value = null
  try {
    const client = await resolveWorkerClient()
    await client.plugins.bots.create({
      name: createName.value.trim(),
      scopes: [...createScopes.value].sort(),
      stream_ids: [...createChannels.value],
    })
    closeCreate()
    await load()
  } catch (err) {
    createError.value = adminErrorCopy(err)
  } finally {
    createBusy.value = false
  }
}

// -- Mint / revoke tokens -------------------------------------------------------

async function mintToken(bot: PluginBot): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionError.value = null
  try {
    const client = await resolveWorkerClient()
    // No explicit scopes → the token inherits the bot's install scopes.
    const res = await client.plugins.bots.mintToken({ bot_user_id: bot.bot_user_id })
    minted.value = { bot_user_id: bot.bot_user_id, token: res.token }
    mintCopied.value = false
    // The new token HANDLE is listed now — refresh the rows below the card.
    await load()
  } catch (err) {
    actionError.value = adminErrorCopy(err)
  } finally {
    busy.value = false
  }
}

/** Close the one-time token card. The raw token is DISCARDED forever. */
function closeMinted(): void {
  minted.value = null
  mintCopied.value = false
}

async function copyMinted(): Promise<void> {
  if (minted.value === null) return
  try {
    await navigator.clipboard.writeText(minted.value.token)
    mintCopied.value = true
    if (mintCopiedTimer !== undefined) clearTimeout(mintCopiedTimer)
    mintCopiedTimer = setTimeout(() => {
      mintCopied.value = false
    }, 2000)
  } catch {
    // Clipboard unavailable (permissions) — the field stays selectable by hand.
  }
}

async function revokeToken(bot: PluginBot, tokenId: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionError.value = null
  try {
    const client = await resolveWorkerClient()
    await client.plugins.bots.revokeToken({ bot_user_id: bot.bot_user_id, token_id: tokenId })
    await load()
  } catch (err) {
    // Already gone (revoked elsewhere) — refetch rather than error.
    if (adminErrorCode(err) === 'not-found') await load()
    else actionError.value = adminErrorCopy(err)
  } finally {
    busy.value = false
    confirmingTokenRevoke.value = null
  }
}

// -- Channel grants --------------------------------------------------------------

async function grantChannel(bot: PluginBot): Promise<void> {
  const streamId = grantPick.value[bot.bot_user_id]
  if (!streamId || busy.value) return
  busy.value = true
  actionError.value = null
  try {
    const client = await resolveWorkerClient()
    await client.plugins.bots.grantStream({ bot_user_id: bot.bot_user_id, stream_id: streamId })
    grantPick.value = { ...grantPick.value, [bot.bot_user_id]: '' }
    await load()
  } catch (err) {
    actionError.value = adminErrorCopy(err)
  } finally {
    busy.value = false
  }
}

async function revokeChannel(bot: PluginBot, streamId: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionError.value = null
  try {
    const client = await resolveWorkerClient()
    await client.plugins.bots.revokeStream({ bot_user_id: bot.bot_user_id, stream_id: streamId })
    await load()
  } catch (err) {
    if (adminErrorCode(err) === 'not-found') await load()
    else actionError.value = adminErrorCopy(err)
  } finally {
    busy.value = false
  }
}

/** A short display handle for a token hash (never a credential — sha256 only). */
function shortHandle(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id
}

/**
 * A bot-level scope summary. The server's `BotInfo` deliberately carries no
 * scope column (install scopes are event-sourced in `bot.installed`), so the
 * honest client-side summary is the union of the bot's ACTIVE token scopes —
 * what the bot can actually do right now.
 */
function scopeSummary(bot: PluginBot): string {
  const scopes = new Set<string>()
  for (const t of bot.tokens) {
    if (!t.revoked) for (const s of t.scopes) scopes.add(s)
  }
  return scopes.size > 0 ? [...scopes].sort().join(', ') : 'no active tokens'
}

onMounted(() => void load())
</script>

<template>
  <section data-testid="apps-bots" aria-label="Bots" class="flex min-h-0 flex-col">
    <!-- Create bot — provisions the identity ONLY (no credential is minted
         here; a token is a separate, deliberate mint on the bot row). -->
    <div v-if="!creating" class="flex items-center justify-end px-1 pb-2">
      <Button size="sm" data-testid="create-bot" @click="openCreate">Create bot</Button>
    </div>

    <div
      v-if="creating"
      class="mx-1 mb-3 rounded-md border border-subtle p-3"
      data-testid="create-bot-card"
    >
      <p class="pb-2 text-[13px] font-medium text-primary">Create bot</p>

      <label class="flex flex-col gap-1 pb-3 text-[12px] text-secondary">
        Name
        <input
          v-model="createName"
          :disabled="createBusy"
          data-testid="create-bot-name"
          placeholder="e.g. Deploy notifier"
          maxlength="200"
          class="h-7 rounded border border-strong bg-transparent px-2 text-[12px] text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
      </label>

      <p class="pb-1 text-[12px] text-secondary">Scopes</p>
      <div class="flex flex-wrap gap-3 pb-3">
        <label
          v-for="s in SCOPES"
          :key="s.value"
          class="flex items-center gap-1.5 text-[12px] text-primary"
        >
          <input
            type="checkbox"
            :checked="createScopes.has(s.value)"
            :disabled="createBusy"
            data-testid="create-bot-scope"
            :data-scope="s.value"
            class="accent-accent"
            @change="toggleScope(s.value)"
          />
          {{ s.label }}
          <span class="text-[11px] text-muted">({{ s.hint }})</span>
        </label>
      </div>

      <p class="pb-1 text-[12px] text-secondary">Channels the bot can access</p>
      <div class="flex max-h-40 flex-col gap-1 overflow-y-auto pb-2">
        <p v-if="grantableChannels.length === 0" class="text-[12px] text-muted">
          No channels yet — you can grant access later.
        </p>
        <label
          v-for="c in grantableChannels"
          :key="c.stream_id"
          class="flex items-center gap-1.5 text-[12px] text-primary"
        >
          <input
            type="checkbox"
            :checked="createChannels.has(c.stream_id)"
            :disabled="createBusy"
            data-testid="create-bot-channel"
            :data-stream-id="c.stream_id"
            class="accent-accent"
            @change="toggleChannel(c.stream_id)"
          />
          # {{ c.name ?? c.stream_id }}
        </label>
      </div>

      <div class="flex items-center gap-1.5 pt-1">
        <Button
          size="sm"
          :disabled="!canSubmitCreate"
          data-testid="create-bot-submit"
          @click="submitCreate"
        >
          Create
        </Button>
        <Button
          variant="ghost"
          size="sm"
          :disabled="createBusy"
          data-testid="create-bot-cancel"
          @click="closeCreate"
        >
          Cancel
        </Button>
      </div>
      <p
        v-if="createError"
        class="pt-2 text-[12px] text-danger"
        data-testid="create-bot-error"
        role="alert"
      >
        {{ createError }}
      </p>
    </div>

    <p v-if="loading" class="px-1 py-4 text-[12px] text-muted" data-testid="apps-bots-loading">
      Loading bots…
    </p>

    <EmptyState
      v-else-if="loadError"
      data-testid="apps-bots-load-error"
      title="Couldn't load bots"
      :description="loadError"
    >
      <template #action>
        <Button variant="ghost" size="sm" data-testid="apps-bots-retry" @click="load">
          Retry
        </Button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="bots.length === 0"
      data-testid="apps-bots-empty"
      title="No bots yet"
      description="Create a bot to let an integration post into your workspace."
    />

    <template v-else>
      <ul class="divide-y divide-subtle">
        <li
          v-for="bot in bots"
          :key="bot.bot_user_id"
          data-testid="bot-row"
          :data-bot-id="bot.bot_user_id"
          class="px-1 py-3"
        >
          <!-- Identity line: name + scopes + deactivated badge + Mint. -->
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">
              <span data-testid="bot-name">{{ bot.name }}</span>
              <span
                v-if="bot.deactivated"
                class="ml-1.5 rounded-full border border-subtle px-1.5 text-[11px] font-normal text-muted"
                data-testid="bot-deactivated"
                >deactivated</span
              >
            </p>
            <Button
              size="sm"
              :disabled="busy || bot.deactivated"
              data-testid="mint-token"
              @click="mintToken(bot)"
            >
              Mint token
            </Button>
          </div>

          <!-- One-time raw token card — shown EXACTLY ONCE, never again. -->
          <div
            v-if="minted !== null && minted.bot_user_id === bot.bot_user_id"
            class="mt-2 rounded-md border border-subtle p-2.5"
            data-testid="bot-token-card"
          >
            <p class="pb-1.5 text-[13px] font-medium text-primary">Bot token created</p>
            <div class="flex items-center gap-1.5">
              <input
                readonly
                :value="minted.token"
                aria-label="Bot token"
                data-testid="bot-token"
                class="h-7 min-w-0 flex-1 rounded border border-strong bg-transparent px-2 font-mono text-[12px] text-primary focus:border-accent focus:outline-none"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <Button size="sm" data-testid="bot-token-copy" @click="copyMinted">
                {{ mintCopied ? 'Copied' : 'Copy' }}
              </Button>
            </div>
            <p class="pt-1.5 text-[12px] text-warning" data-testid="bot-token-note">
              Copy it now — this token won't be shown again. Treat it like a password.
            </p>
            <div class="flex justify-end pt-2">
              <Button variant="ghost" size="sm" data-testid="bot-token-done" @click="closeMinted">
                Done
              </Button>
            </div>
          </div>

          <!-- Scopes: the union of the bot's active token scopes (BotInfo
               carries no scope column — install scopes are event-sourced). -->
          <p class="pt-1 text-[12px] text-muted" data-testid="bot-scopes">
            Scopes: <span class="text-secondary">{{ scopeSummary(bot) }}</span>
          </p>

          <!-- Channel grants: chips + remove, plus an add picker. -->
          <div class="flex flex-wrap items-center gap-1.5 pt-1.5">
            <span
              v-for="sid in bot.stream_ids"
              :key="sid"
              class="flex items-center gap-1 rounded-full border border-subtle px-2 py-0.5 text-[11px] text-secondary"
              data-testid="bot-channel"
              :data-stream-id="sid"
            >
              # {{ channelLabel(sid) }}
              <button
                type="button"
                class="text-muted transition-colors hover:text-danger"
                :disabled="busy"
                :aria-label="`Remove ${channelLabel(sid)}`"
                data-testid="bot-channel-remove"
                :data-stream-id="sid"
                @click="revokeChannel(bot, sid)"
              >
                ✕
              </button>
            </span>
            <span v-if="bot.stream_ids.length === 0" class="text-[11px] text-muted">
              No channel access
            </span>
            <template v-if="ungranted(bot).length > 0">
              <select
                v-model="grantPick[bot.bot_user_id]"
                :disabled="busy"
                aria-label="Grant a channel"
                data-testid="bot-grant-select"
                class="h-6 rounded border border-strong bg-transparent px-1 text-[11px] text-primary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="" disabled>Add channel…</option>
                <option v-for="c in ungranted(bot)" :key="c.stream_id" :value="c.stream_id">
                  # {{ c.label }}
                </option>
              </select>
              <Button
                variant="ghost"
                size="sm"
                :disabled="busy || !grantPick[bot.bot_user_id]"
                data-testid="bot-grant-add"
                @click="grantChannel(bot)"
              >
                Grant
              </Button>
            </template>
          </div>

          <!-- Tokens: hash handles only (revoke handles, never credentials). -->
          <ul v-if="bot.tokens.length > 0" class="pt-2">
            <li
              v-for="token in bot.tokens"
              :key="token.id"
              class="flex items-center gap-2 py-1"
              data-testid="bot-token-row"
              :data-token-id="token.id"
            >
              <span class="font-mono text-[11px] text-muted">{{ shortHandle(token.id) }}</span>
              <span class="text-[11px] text-muted">{{ token.scopes.join(', ') }}</span>
              <span
                v-if="token.revoked"
                class="rounded-full border border-subtle px-1.5 text-[11px] text-muted"
                data-testid="bot-token-revoked"
                >revoked</span
              >
              <span class="flex-1" />
              <template v-if="!token.revoked">
                <template v-if="confirmingTokenRevoke === `${bot.bot_user_id}:${token.id}`">
                  <span
                    class="flex items-center gap-1.5"
                    data-testid="bot-token-revoke-confirm"
                    role="alert"
                  >
                    <span class="text-[11px] text-secondary">The token stops working.</span>
                    <Button
                      variant="danger"
                      size="sm"
                      :disabled="busy"
                      data-testid="bot-token-revoke-confirm-yes"
                      @click="revokeToken(bot, token.id)"
                    >
                      Revoke
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="bot-token-revoke-confirm-no"
                      @click="confirmingTokenRevoke = null"
                    >
                      Cancel
                    </Button>
                  </span>
                </template>
                <Button
                  v-else
                  variant="danger"
                  size="sm"
                  :disabled="busy"
                  data-testid="bot-token-revoke"
                  @click="confirmingTokenRevoke = `${bot.bot_user_id}:${token.id}`"
                >
                  Revoke
                </Button>
              </template>
            </li>
          </ul>
        </li>
      </ul>

      <p v-if="actionError" class="px-1 py-2 text-[12px] text-danger" data-testid="apps-bots-error">
        {{ actionError }}
      </p>
    </template>
  </section>
</template>
