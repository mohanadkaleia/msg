// tests/unit/ui/NavGroup.spec.ts — ENG-152 sidebar-group restyle. The top-level
// collapsible nav group: header button (uppercase, chevron, aria-expanded)
// toggling an INDENTED item block with the thin `border-subtle` connector rule,
// with per-group collapsed/expanded persistence in localStorage.
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import NavGroup from '../../../src/components/ui/NavGroup.vue'

const KEY = 'msg:nav-group:messages'

// This env's window.localStorage is a bare object with no methods, so install a
// working in-memory Storage before each scenario (same pattern as useTheme.spec).
function installLocalStorage(): void {
  const store = new Map<string, string>()
  const mock: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  }
  Object.defineProperty(window, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
}

describe('ui/NavGroup', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  it('renders an uppercase header button and its items, default EXPANDED', () => {
    const wrapper = mount(NavGroup, {
      props: { title: 'Messages', storageKey: 'messages' },
      slots: { default: '<div data-testid="item">inbox</div>' },
    })
    const header = wrapper.get('button')
    expect(header.text()).toBe('Messages')
    expect(header.classes()).toContain('uppercase')
    expect(header.classes()).toContain('text-secondary')
    expect(header.attributes('aria-expanded')).toBe('true')
    // Expanded chevron points DOWN.
    expect(header.find('svg.lucide-chevron-down-icon, svg.lucide-chevron-down').exists()).toBe(true)
    const block = wrapper.get('[data-testid="nav-group-items"]').element as HTMLElement
    expect(block.style.display).not.toBe('none')
    expect(wrapper.find('[data-testid="item"]').exists()).toBe(true)
  })

  it('indents the item block under a thin token-styled connector rule', () => {
    const wrapper = mount(NavGroup, {
      props: { title: 'Messages', storageKey: 'messages' },
      slots: { default: '<div>x</div>' },
    })
    const block = wrapper.get('[data-testid="nav-group-items"]')
    // The single vertical connector line: a left border in the subtle token.
    expect(block.classes()).toContain('border-l')
    expect(block.classes()).toContain('border-subtle')
    // And the block is inset (indentation + inner padding past the rule).
    expect(block.classes()).toContain('ml-3.5')
    expect(block.classes()).toContain('pl-2')
  })

  it('collapses/expands on click, tracking aria-expanded + the chevron direction', async () => {
    const wrapper = mount(NavGroup, {
      props: { title: 'Messages', storageKey: 'messages' },
      slots: { default: '<div data-testid="item">x</div>' },
    })
    const header = wrapper.get('button')
    const block = wrapper.get('[data-testid="nav-group-items"]').element as HTMLElement

    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('false')
    // v-show keeps the node; assert the display style toggles off on collapse
    // (same pattern as NavSection.spec).
    expect(block.style.display).toBe('none')
    // Collapsed chevron points RIGHT.
    expect(header.find('svg.lucide-chevron-right-icon, svg.lucide-chevron-right').exists()).toBe(
      true,
    )

    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(block.style.display).not.toBe('none')
  })

  it('persists the collapsed state per group and restores it on mount', async () => {
    const first = mount(NavGroup, {
      props: { title: 'Messages', storageKey: 'messages' },
      slots: { default: '<div>x</div>' },
    })
    await first.get('button').trigger('click')
    expect(window.localStorage.getItem(KEY)).toBe('collapsed')

    // A fresh mount (new session) restores the collapsed state…
    const second = mount(NavGroup, {
      props: { title: 'Messages', storageKey: 'messages' },
      slots: { default: '<div>x</div>' },
    })
    expect(second.get('button').attributes('aria-expanded')).toBe('false')

    // …scoped PER GROUP: a different storageKey stays expanded.
    const other = mount(NavGroup, {
      props: { title: 'Workspace', storageKey: 'workspace' },
      slots: { default: '<div>x</div>' },
    })
    expect(other.get('button').attributes('aria-expanded')).toBe('true')

    // Re-expanding writes back.
    await second.get('button').trigger('click')
    expect(window.localStorage.getItem(KEY)).toBe('expanded')
  })

  it('treats junk stored values as expanded (the safe default)', () => {
    window.localStorage.setItem(KEY, 'junk')
    const wrapper = mount(NavGroup, {
      props: { title: 'Messages', storageKey: 'messages' },
      slots: { default: '<div>x</div>' },
    })
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('true')
  })

  it('renders the trailing action slot OUTSIDE the toggle button (no collapse on action click)', async () => {
    const wrapper = mount(NavGroup, {
      props: { title: 'DMs', storageKey: 'dms' },
      slots: {
        default: '<div>x</div>',
        action: '<button type="button" data-testid="group-action">+</button>',
      },
    })
    const header = wrapper.get('button[aria-expanded]')
    const action = wrapper.get('[data-testid="group-action"]')
    // The action is a sibling of the toggle button, never nested inside it.
    expect(action.element.closest('button[aria-expanded]')).toBeNull()
    // Clicking the action must NOT toggle the group.
    await action.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(window.localStorage.getItem('msg:nav-group:dms')).toBeNull()
  })

  it('renders the optional icon slot and passes data-testid through to the header', () => {
    const wrapper = mount(NavGroup, {
      props: { title: 'Messages', storageKey: 'messages' },
      attrs: { 'data-testid': 'nav-group-messages' },
      slots: { default: '<div>x</div>', icon: '<svg data-testid="group-icon" />' },
    })
    const header = wrapper.get('button')
    expect(header.attributes('data-testid')).toBe('nav-group-messages')
    const icon = wrapper.get('[data-testid="group-icon"]')
    // Decorative icon wrapper precedes the title.
    expect(icon.element.parentElement?.getAttribute('aria-hidden')).toBe('true')
    expect(wrapper.html().indexOf('group-icon')).toBeLessThan(wrapper.html().indexOf('Messages'))
  })
})
