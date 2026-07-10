// tests/unit/shell/WorkspaceSwitcher.spec.ts — ENG-136 PR-3 + ENG-152 PR-b +
// nav cleanup. The workspace selector pill shows the REAL workspace name +
// initials glyph over a muted "Local workspace" sub-label (hierarchy: the pill
// is the workspace identity; the header "Ranin" mark is the app brand). ENG-152
// nav cleanup: clicking the pill opens the component's OWN workspace menu (the
// one local workspace, marked current) — NOT the command palette (the old
// quick-switcher crossed wiring). The `open-switcher` test-id stays on the pill.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkspaceSwitcher from '../../../src/components/shell/WorkspaceSwitcher.vue'

function mountSwitcher(name = 'Acme', initials = 'AC') {
  return mount(WorkspaceSwitcher, {
    props: { workspaceName: name, workspaceInitials: initials },
    attachTo: document.body,
  })
}

describe('WorkspaceSwitcher (ENG-136 PR-3 / ENG-152 nav cleanup)', () => {
  it('renders the workspace name + initials glyph', () => {
    const wrapper = mountSwitcher()
    expect(wrapper.text()).toContain('Acme')
    expect(wrapper.text()).toContain('AC')
    wrapper.unmount()
  })

  it('shows the muted "Local workspace" sub-label under the name (ENG-152)', () => {
    const wrapper = mountSwitcher('msg', 'MS')
    const pill = wrapper.get('[data-testid="open-switcher"]')
    expect(pill.text()).toContain('msg')
    expect(pill.text()).toContain('Local workspace')
    wrapper.unmount()
  })

  it('opens its OWN workspace menu from the pill — no palette event (nav cleanup)', async () => {
    const wrapper = mountSwitcher('msg', 'MS')
    const pill = wrapper.get('[data-testid="open-switcher"]')
    expect(wrapper.find('[data-testid="workspace-menu"]').exists()).toBe(false)
    expect(pill.attributes('aria-expanded')).toBe('false')

    await pill.trigger('click')
    // The menu lists the one local workspace as current — honest, no invented rows.
    const menu = wrapper.get('[data-testid="workspace-menu"]')
    expect(pill.attributes('aria-expanded')).toBe('true')
    const current = menu.get('[data-testid="workspace-menu-current"]')
    expect(current.attributes('aria-checked')).toBe('true')
    expect(current.text()).toContain('msg')
    expect(current.text()).toContain('Local workspace')

    // The component is self-contained: it must NOT emit the old openSwitcher
    // event (whose shell wiring opened the command palette).
    expect(wrapper.emitted('openSwitcher')).toBeUndefined()

    // A second pill click closes the menu again (toggle).
    await pill.trigger('click')
    expect(wrapper.find('[data-testid="workspace-menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('closes the menu on Escape and on selecting the current workspace', async () => {
    const wrapper = mountSwitcher()
    await wrapper.get('[data-testid="open-switcher"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-menu"]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="workspace-menu"]').exists()).toBe(false)

    await wrapper.get('[data-testid="open-switcher"]').trigger('click')
    await wrapper.get('[data-testid="workspace-menu-current"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders ONLY the chevron glyph in the closed pill — no decorative play/forward button', () => {
    const wrapper = mountSwitcher()
    // Exactly one svg while closed: the chevron-down. The removed no-op "play"
    // circle (an accent-filled span with an inline svg) must not come back.
    const svgs = wrapper.findAll('svg')
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.classes().join(' ')).toContain('lucide-chevron-down')
    expect(wrapper.find('.bg-accent').exists()).toBe(false)
    wrapper.unmount()
  })
})
