// tests/unit/shell/SpaceRail.spec.ts — ENG-136 "Ranin" left rail (PR-B; ENG-152
// PR-b cleanup). Asserts the rail landmark, the neutral workspace glyph, the
// relocated GLOBAL sync indicator (single `sync-indicator` testid, tone-driven
// from the sync store, ALWAYS titled so the dot is never mysterious), the account
// sign-out affordance, and — ENG-152 — that NO placeholder/disabled workspace
// squares render (only the one real workspace square).
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import SpaceRail from '../../../src/components/shell/SpaceRail.vue'
import ThemeToggle from '../../../src/components/ui/ThemeToggle.vue'
import { useSyncStore } from '../../../src/stores/sync'
import { FakeWorker } from './fakeWorker'

// ThemeToggle (mounted in the rail from PR-D) uses useTheme, which reads
// localStorage; this env's window.localStorage is a bare object, so install a stub.
function installLocalStorage(): void {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  })
}

function mountRail(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(SpaceRail, {
    props: { workspaceInitials: 'MS', workspaceName: 'msg', ...props },
  })
}

describe('SpaceRail (ENG-136 PR-B)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installLocalStorage()
    URL.createObjectURL = vi.fn(() => 'blob:ws-icon-1')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    setWorkerClient(undefined)
    delete (URL as { createObjectURL?: unknown }).createObjectURL
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
  })

  it('is a Workspaces navigation landmark with the neutral workspace glyph', () => {
    const wrapper = mountRail()
    const nav = wrapper.get('nav')
    expect(nav.attributes('role')).toBe('navigation')
    expect(nav.attributes('aria-label')).toBe('Workspaces')
    // Neutral initials — NOT "Ranin".
    expect(wrapper.text()).toContain('MS')
    expect(wrapper.text()).not.toContain('Ranin')
  })

  it('hosts the single global sync indicator, tone-driven from the sync store', async () => {
    const wrapper = mountRail()
    const sync = useSyncStore()

    // Exactly one sync-indicator lives in the rail (uniqueness for the e2e selector).
    expect(wrapper.findAll('[data-testid="sync-indicator"]')).toHaveLength(1)

    sync.status = { state: 'live', online: true }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="sync-indicator"]').attributes('data-tone')).toBe('live')

    sync.status = { state: 'degraded', online: false }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="sync-indicator"]').attributes('data-tone')).toBe('offline')
  })

  it('titles the sync dot with the store label — never an unexplained dot (ENG-152)', async () => {
    const wrapper = mountRail()
    const sync = useSyncStore()

    sync.status = { state: 'live', online: true }
    await wrapper.vm.$nextTick()
    const dot = wrapper.get('[data-testid="sync-indicator"]')
    expect(dot.attributes('title')).toBe('Connected')
    expect(dot.attributes('aria-label')).toBe('Connection: Connected')

    sync.status = { state: 'degraded', online: false }
    await wrapper.vm.$nextTick()
    expect(dot.attributes('title')).toBe('Offline')
  })

  it('renders NO placeholder/disabled workspace squares — only the real one (ENG-152)', () => {
    const wrapper = mountRail()
    // Exactly one workspace square: the real, active one.
    expect(wrapper.findAll('button[aria-current="true"]')).toHaveLength(1)
    // The scaffold "A"/"B" squares and the disabled add-"+" are gone.
    expect(wrapper.text()).not.toContain('A')
    expect(wrapper.text()).not.toContain('B')
    expect(wrapper.find('button[disabled]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="Add a workspace (coming soon)"]').exists()).toBe(false)
    expect(wrapper.find('.cursor-not-allowed').exists()).toBe(false)
    expect(wrapper.find('svg.lucide-plus').exists()).toBe(false)
  })

  it('emits logout from the settings gear popover', async () => {
    const wrapper = mountRail()
    // Sign-out lives in the gear popover — closed until the gear is opened.
    expect(wrapper.find('[data-testid="logout"]').exists()).toBe(false)
    await wrapper.get('[data-testid="open-settings"]').trigger('click')
    await wrapper.get('[data-testid="logout"]').trigger('click')
    expect(wrapper.emitted('logout')).toHaveLength(1)
  })

  it('renders the brand logo and the active workspace square', () => {
    const wrapper = mountRail()
    // The "R" brand mark is a labeled image.
    const logo = wrapper.get('[role="img"][aria-label="Ranin"]')
    expect(logo.text()).toBe('R')
    // The one real workspace is the active square (aria-current) with its initials.
    const square = wrapper.get('button[aria-current="true"]')
    expect(square.text()).toBe('MS')
    expect(square.attributes('title')).toBe('msg')
  })

  it('renders the workspace icon image when a sha is set (ENG-152)', async () => {
    const fake = new FakeWorker()
    fake.setWorkspaceIconBlob('icon-sha-1', new Blob([new Uint8Array([1, 2, 3])]))
    setWorkerClient(fake.client)

    const wrapper = mountRail({ workspaceIconSha: 'icon-sha-1' })
    await flushPromises()

    const square = wrapper.get('[data-testid="workspace-icon"]')
    expect(square.attributes('data-has-icon')).toBe('true')
    const img = square.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('blob:ws-icon-1')
    expect(fake.workspaceIconSpy).toHaveBeenCalledWith('icon-sha-1')
  })

  it('falls back to the initials glyph when no icon is set (ENG-152)', () => {
    const wrapper = mountRail()
    const square = wrapper.get('[data-testid="workspace-icon"]')
    expect(square.attributes('data-has-icon')).toBe('false')
    expect(square.find('img').exists()).toBe(false)
    expect(square.text()).toBe('MS')
  })

  it('falls back to the glyph on an icon load error (ENG-152)', async () => {
    const fake = new FakeWorker()
    fake.setWorkspaceIconBlob('icon-sha-2', new Blob([new Uint8Array([9])]))
    setWorkerClient(fake.client)

    const wrapper = mountRail({ workspaceIconSha: 'icon-sha-2' })
    await flushPromises()

    await wrapper.get('[data-testid="workspace-icon"] img').trigger('error')
    const square = wrapper.get('[data-testid="workspace-icon"]')
    expect(square.attributes('data-has-icon')).toBe('false')
    expect(square.find('img').exists()).toBe(false)
    expect(square.text()).toBe('MS')
  })

  it('mounts the ThemeToggle in the rail (PR-D)', () => {
    const wrapper = mountRail()
    // The theme control lives in the rail: a keyboard-operable button with an
    // aria-label reflecting the current preference.
    expect(wrapper.findComponent(ThemeToggle).exists()).toBe(true)
    const toggle = wrapper.getComponent(ThemeToggle)
    expect(toggle.get('button').attributes('aria-label')).toBeTruthy()
  })
})
