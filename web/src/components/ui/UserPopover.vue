<script setup lang="ts">
// UserPopover — the interactive wrapper (ENG-152) that turns any avatar/name into
// a hover-preview + click-to-open-details affordance. It wraps its slot (a shared
// UserAvatar, or a message row's author name) and, on hover/focus, floats a
// UserHovercard after a short delay; a click (or Enter/Space) opens the right
// drawer's user-details panel via the shell-provided opener seam.
//
// It reads the member's directory record + live presence STRAIGHT FROM THE STORES
// (already in memory — no per-hover fetch, no HTTP: `no-http-in-ui` stays green).
// Store access is pinia-guarded so the wrapper degrades to a name-only card when
// mounted without an active pinia (the tiptap mention popup + isolated tests).
//
// Gated by `interactive` (default true) so avatars that must not be interactive
// (e.g. the composer, the signed-in user's own footer card) opt out and render the
// slot bare, and by `clickable` (default true) so a context can keep hover-preview
// without the click-to-drawer (the mention list, where a click selects the item).
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'

import { injectOpenUserDetails } from '../../composables/useUserDetails'
import { usePresenceStore } from '../../stores/presence'
import { useWorkspaceStore } from '../../stores/workspace'
import type { DirectoryUser, PresenceStatus } from '../../worker'
import UserHovercard from './UserHovercard.vue'

const props = withDefaults(
  defineProps<{
    /** The member this avatar/name represents (undefined ⇒ non-interactive). */
    userId?: string | undefined
    /** Display-name fallback when the directory has no record for `userId`. */
    name?: string | undefined
    /** Opt out entirely (composer / own footer card): render the slot bare. */
    interactive?: boolean
    /** Keep hover-preview but drop click-to-drawer (mention list selection). */
    clickable?: boolean
  }>(),
  { userId: undefined, name: undefined, interactive: true, clickable: true },
)

// Store access is best-effort: the real app (and the tiptap mention popup, which
// shares the app's active pinia) resolves the directory record + live presence
// from memory — no per-hover fetch, no HTTP (`no-http-in-ui` stays green). An
// isolated mount with no active pinia (some component specs) throws on the first
// `useStore()`; we swallow that and degrade to a name-only card.
let workspace: ReturnType<typeof useWorkspaceStore> | null = null
let presence: ReturnType<typeof usePresenceStore> | null = null
try {
  workspace = useWorkspaceStore()
  presence = usePresenceStore()
} catch {
  // No active pinia (isolated mount) — fall back to the name-only card below.
}

/** Whether this instance shows a hovercard / accepts a click at all. */
const active = computed(() => props.interactive && props.userId !== undefined)
const openable = computed(() => active.value && props.clickable)

/** The record to render — the folded directory profile, else a name-only stub. */
const record = computed<DirectoryUser>(() => {
  const id = props.userId ?? ''
  return workspace?.userOf(props.userId) ?? { user_id: id, display_name: props.name ?? id }
})
const presenceStatus = computed<PresenceStatus>(() =>
  props.userId && presence ? presence.statusOf(props.userId) : 'offline',
)

const openUserDetails = injectOpenUserDetails()

const anchor = ref<HTMLElement | null>(null)
const open = ref(false)
const cardStyle = ref<Record<string, string>>({})
let timer: ReturnType<typeof setTimeout> | undefined

/** Position the (fixed, teleported) card under the anchor, flipping/clamping to
 * stay on-screen. Sizes are the card's own w-64 + a conservative height estimate. */
function place(): void {
  const el = anchor.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const width = 256
  const estHeight = 150
  const margin = 8
  const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin)
  let top = rect.bottom + 6
  if (top + estHeight > window.innerHeight) top = Math.max(margin, rect.top - estHeight - 6)
  cardStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    zIndex: '60',
  }
}

/** Open after a short delay so quick pointer sweeps don't flash the card. */
function show(): void {
  if (!active.value) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    open.value = true
    void nextTick(place)
  }, 300)
}

function hide(): void {
  clearTimeout(timer)
  open.value = false
}

function activate(): void {
  if (openable.value && props.userId) openUserDetails?.(props.userId)
}

function onKeydown(event: KeyboardEvent): void {
  if (!openable.value) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    activate()
  } else if (event.key === 'Escape') {
    hide()
  }
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <span
    ref="anchor"
    class="inline-flex"
    :class="openable ? 'cursor-pointer' : ''"
    :role="openable ? 'button' : undefined"
    :tabindex="openable ? 0 : undefined"
    :aria-label="openable ? `View ${record.display_name}'s profile` : undefined"
    :data-testid="openable ? 'open-user-details' : undefined"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
    @click="activate"
    @keydown="onKeydown"
  >
    <slot />
    <Teleport to="body">
      <!-- Purely informational, so it never captures the pointer (no hover flicker
           crossing the gap from the anchor to the card). -->
      <div v-if="open && active" :style="cardStyle" class="pointer-events-none">
        <UserHovercard :user="record" :presence="presenceStatus" />
      </div>
    </Teleport>
  </span>
</template>
