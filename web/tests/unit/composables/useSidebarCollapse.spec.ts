// tests/unit/composables/useSidebarCollapse.spec.ts — ENG-174 sidebar collapse.
//
// The composable owns the left sidebar's collapsed state: a manual toggle
// persisted in localStorage (`msg:sidebar`) plus a responsive auto-collapse
// driven by a matchMedia narrow-window query — crossing INTO narrow collapses,
// crossing back OUT restores the persisted manual preference. State is asserted
// (never pixel layout); matchMedia + localStorage are mocked.
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useSidebarCollapse,
  SIDEBAR_NARROW_QUERY,
  type UseSidebarCollapse,
} from '../../../src/composables/useSidebarCollapse'

// This env's window.localStorage is a bare object with no methods — install a
// working in-memory Storage per test (same pattern as useTheme.spec).
function installLocalStorage(): void {
  const store = new Map<string, string>()
  const mock: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  }
  Object.defineProperty(window, 'localStorage', { value: mock, configurable: true, writable: true })
}

/** A controllable matchMedia stub: `setNarrow` flips `matches` and fires the
 * registered 'change' listeners (a resize crossing the breakpoint). */
function stubMatchMedia(initialNarrow: boolean): {
  setNarrow: (narrow: boolean) => void
  queries: string[]
} {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const queries: string[] = []
  const state = { matches: initialNarrow }
  const impl = (query: string) => {
    queries.push(query)
    return {
      get matches() {
        return state.matches
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
        void listeners.add(cb),
      removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
        void listeners.delete(cb),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList
  }
  Object.defineProperty(window, 'matchMedia', { value: impl, configurable: true, writable: true })
  return {
    setNarrow: (narrow: boolean) => {
      state.matches = narrow
      for (const cb of listeners) cb({ matches: narrow } as MediaQueryListEvent)
    },
    queries,
  }
}

function removeMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    value: undefined,
    configurable: true,
    writable: true,
  })
}

/** Mount a harness so the composable's lifecycle hooks (media cleanup) bind. */
function mountCollapse(): { api: UseSidebarCollapse; unmount: () => void } {
  const Harness = defineComponent({
    setup() {
      const api = useSidebarCollapse()
      return { api }
    },
    template: '<div />',
  })
  const wrapper = mount(Harness)
  return {
    api: (wrapper.vm as unknown as { api: UseSidebarCollapse }).api,
    unmount: () => wrapper.unmount(),
  }
}

describe('useSidebarCollapse (ENG-174)', () => {
  beforeEach(() => {
    installLocalStorage()
    removeMatchMedia()
  })

  it('defaults to expanded (wide window, nothing stored)', () => {
    stubMatchMedia(false)
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(false)
  })

  it('registers the narrow-window breakpoint query', () => {
    const media = stubMatchMedia(false)
    mountCollapse()
    expect(media.queries).toContain(SIDEBAR_NARROW_QUERY)
  })

  it('toggle collapses/expands and persists the manual choice', () => {
    stubMatchMedia(false)
    const { api } = mountCollapse()

    api.toggle()
    expect(api.collapsed.value).toBe(true)
    expect(window.localStorage.getItem('msg:sidebar')).toBe('collapsed')

    api.toggle()
    expect(api.collapsed.value).toBe(false)
    expect(window.localStorage.getItem('msg:sidebar')).toBe('expanded')
  })

  it('restores a persisted collapsed preference on mount (wide window)', () => {
    stubMatchMedia(false)
    window.localStorage.setItem('msg:sidebar', 'collapsed')
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(true)
  })

  it('ignores junk stored values (defaults expanded)', () => {
    stubMatchMedia(false)
    window.localStorage.setItem('msg:sidebar', 'banana')
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(false)
  })

  it('starts collapsed when the window is already narrow at mount', () => {
    stubMatchMedia(true)
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(true)
    // Auto-collapse never overwrites the stored manual preference.
    expect(window.localStorage.getItem('msg:sidebar')).toBeNull()
  })

  it('auto-collapses crossing INTO narrow and re-expands back OUT (no preference)', () => {
    const media = stubMatchMedia(false)
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(false)

    media.setNarrow(true)
    expect(api.collapsed.value).toBe(true)

    media.setNarrow(false)
    expect(api.collapsed.value).toBe(false)
  })

  it('returning to wide restores a persisted COLLAPSED manual preference', () => {
    const media = stubMatchMedia(false)
    window.localStorage.setItem('msg:sidebar', 'collapsed')
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(true)

    media.setNarrow(true)
    expect(api.collapsed.value).toBe(true)
    media.setNarrow(false)
    // The user's manual choice — not a blanket expand — wins on the way back.
    expect(api.collapsed.value).toBe(true)
  })

  it('a manual expand while narrow works and persists (matchMedia only fires on crossing)', () => {
    const media = stubMatchMedia(true)
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(true)

    api.toggle()
    expect(api.collapsed.value).toBe(false)
    expect(window.localStorage.getItem('msg:sidebar')).toBe('expanded')

    // Widening keeps it expanded (the stored preference).
    media.setNarrow(false)
    expect(api.collapsed.value).toBe(false)
  })

  it('unbinds the media listener on unmount', () => {
    const media = stubMatchMedia(false)
    const { api, unmount } = mountCollapse()
    unmount()
    media.setNarrow(true)
    expect(api.collapsed.value).toBe(false) // no dangling listener flips it
  })

  it('is graceful without matchMedia (jsdom): never narrow, toggle still works', () => {
    removeMatchMedia()
    const { api } = mountCollapse()
    expect(api.collapsed.value).toBe(false)
    expect(() => api.toggle()).not.toThrow()
    expect(api.collapsed.value).toBe(true)
  })
})
