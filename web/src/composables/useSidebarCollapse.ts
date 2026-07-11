// composables/useSidebarCollapse.ts — ENG-174 sidebar collapse state.
//
// Owns the LEFT sidebar's (the channel/DM column — NOT the SpaceRail) collapsed
// state, replacing the "(coming soon)" stub on the sidebar's collapse control:
//
//  - MANUAL toggle: the sidebar-header control, the TopBar's expand affordance
//    (visible while collapsed), and the global ⌘\ / Ctrl+\ shortcut (wired in
//    useShellController's keydown — ⌘K stays the palette, ⌘/ stays search) all
//    flip `collapsed`. The choice persists in localStorage (`msg:sidebar` =
//    'collapsed' | 'expanded' — the same guarded read/write pattern as
//    ui/NavGroup and useTheme).
//
//  - RESPONSIVE auto-collapse: below the breakpoint (≤900px window width) the
//    fixed left columns (3.5rem rail + 16rem sidebar) would starve the message
//    column, so crossing INTO narrow always collapses; crossing back to wide
//    restores the persisted manual preference. A manual toggle while narrow
//    still works (matchMedia only fires on crossing the threshold) and is
//    persisted like any other choice.
//
// Guarded for no-window / no-matchMedia / no-localStorage envs (jsdom, private
// mode): no matchMedia → never narrow; no storage → in-memory state only.
// No HTTP, no token — safe under the no-http-in-ui guard.
import { onBeforeUnmount, ref, type Ref } from 'vue'

const STORAGE_KEY = 'msg:sidebar'

/** The auto-collapse breakpoint: at or below this window width the fixed left
 * columns eat too much of the message column (the old layout's effective
 * min-width floor), so the sidebar yields. Exported for tests. */
export const SIDEBAR_NARROW_QUERY = '(max-width: 900px)'

const hasWindow = typeof window !== 'undefined'

/** The narrow-window media query, or null when matchMedia is unavailable (jsdom). */
function narrowMediaQuery(): MediaQueryList | null {
  if (!hasWindow || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(SIDEBAR_NARROW_QUERY)
}

/** Read the persisted manual preference, tolerating no-storage envs and junk. */
function readStored(): 'collapsed' | 'expanded' | null {
  if (!hasWindow) return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'collapsed' || raw === 'expanded') return raw
  } catch {
    // localStorage can throw (private mode / disabled) — treat as unset.
  }
  return null
}

/** Persist a manual choice (best-effort — in-memory state still drives the UI). */
function persist(collapsed: boolean): void {
  if (!hasWindow) return
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? 'collapsed' : 'expanded')
  } catch {
    // Best-effort only.
  }
}

export interface UseSidebarCollapse {
  /** Whether the left sidebar is collapsed (hidden; the rail stays). */
  collapsed: Ref<boolean>
  /** Flip the state and persist the choice as the manual preference. */
  toggle: () => void
}

/**
 * Per-shell sidebar-collapse state (call from component setup — it binds a
 * media listener released on unmount). Initial state: a narrow window always
 * starts collapsed; a wide one follows the persisted preference (default
 * expanded — the E2E flows click sidebar rows without toggling).
 */
export function useSidebarCollapse(): UseSidebarCollapse {
  const media = narrowMediaQuery()
  const collapsed = ref(media?.matches === true ? true : readStored() === 'collapsed')

  // Crossing INTO narrow auto-collapses; crossing back OUT restores the
  // persisted manual preference (auto never overwrites the stored choice).
  const onMediaChange = (event: MediaQueryListEvent): void => {
    collapsed.value = event.matches ? true : readStored() === 'collapsed'
  }
  media?.addEventListener('change', onMediaChange)
  onBeforeUnmount(() => media?.removeEventListener('change', onMediaChange))

  function toggle(): void {
    collapsed.value = !collapsed.value
    persist(collapsed.value)
  }

  return { collapsed, toggle }
}
