// composables/useTheme.ts — ENG-136 "Ranin" theme state.
//
// LIVE: ThemeToggle (mounted in SpaceRail) drives this composable, and the
// inline bootstrap script in index.html mirrors the same resolution pre-paint
// (same storage key, same 'system' fallback) so the first frame renders in the
// right theme with no FOUC.
//
// Model: a persisted preference of 'light' | 'dark' | 'system' (localStorage key
// `msg:theme`, default 'system'). The RESOLVED theme ('light' | 'dark') applies
// by setting `data-theme` on <html>; 'system' resolves through
// matchMedia('(prefers-color-scheme: dark)') and re-resolves live when the OS
// preference changes. Guarded for SSR / no-window / no-matchMedia (jsdom) envs.
//
// Module-level singleton state: every caller shares one preference ref + one
// media listener (a per-call listener would leak). No HTTP, no token — safe under
// the no-http-in-ui guard.

import { computed, ref, type ComputedRef, type Ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'msg:theme'
const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system']

const hasWindow = typeof window !== 'undefined'

/** The dark-scheme media query, or null when matchMedia is unavailable (jsdom). */
function darkMediaQuery(): MediaQueryList | null {
  if (!hasWindow || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-color-scheme: dark)')
}

/** Read the persisted preference, tolerating no-storage envs and junk values. */
function readStoredPreference(): ThemePreference {
  if (!hasWindow) return 'system'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // localStorage can throw (private mode / disabled) — fall through to default.
  }
  return 'system'
}

/** Resolve a preference to a concrete theme, consulting the OS for 'system'. */
function resolvePreference(pref: ThemePreference): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  return darkMediaQuery()?.matches ? 'dark' : 'light'
}

/** Apply the resolved theme to the document root (the token switch). */
function applyResolved(resolved: ResolvedTheme): void {
  if (!hasWindow || typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolved)
}

// --- module-level singleton state ---------------------------------------------

const preference: Ref<ThemePreference> = ref(readStoredPreference())
const resolved: Ref<ResolvedTheme> = ref(resolvePreference(preference.value))

let listenerBound = false

/** Recompute the resolved theme from the current preference + OS, and apply it. */
function refreshResolved(): void {
  resolved.value = resolvePreference(preference.value)
  applyResolved(resolved.value)
}

/** Bind the OS-preference listener once, so 'system' tracks live changes. */
function ensureMediaListener(): void {
  if (listenerBound) return
  const mql = darkMediaQuery()
  if (!mql) return
  const onChange = (): void => {
    // Only 'system' follows the OS; explicit light/dark ignore it.
    if (preference.value === 'system') refreshResolved()
  }
  mql.addEventListener('change', onChange)
  listenerBound = true
}

ensureMediaListener()

/**
 * Apply the persisted/resolved theme to <html> once at app startup, so the reactive
 * store — not just the pre-paint index.html script — drives `data-theme` after
 * hydration. Idempotent; call once from `main.ts`. (PR-A built this composable inert;
 * PR-D makes it live.)
 */
export function initTheme(): void {
  ensureMediaListener()
  refreshResolved()
}

export interface UseTheme {
  /** The persisted preference ('light' | 'dark' | 'system'). */
  theme: Ref<ThemePreference>
  /** The concrete applied theme ('light' | 'dark'). */
  resolvedTheme: ComputedRef<ResolvedTheme>
  /** Set the preference, persist it, and apply the resolved theme. */
  setTheme: (next: ThemePreference) => void
  /** Cycle light -> dark -> system -> light. */
  cycleTheme: () => void
}

export function useTheme(): UseTheme {
  ensureMediaListener()

  function setTheme(next: ThemePreference): void {
    preference.value = next
    if (hasWindow) {
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Persisting is best-effort; still apply the in-memory theme below.
      }
    }
    refreshResolved()
  }

  function cycleTheme(): void {
    const idx = PREFERENCES.indexOf(preference.value)
    const next = PREFERENCES[(idx + 1) % PREFERENCES.length] ?? 'light'
    setTheme(next)
  }

  return {
    theme: preference,
    resolvedTheme: computed(() => resolved.value),
    setTheme,
    cycleTheme,
  }
}
