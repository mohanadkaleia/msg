// tests/unit/shell/WorkspaceSwitcher.spec.ts — ENG-136 PR-3 + ENG-152 PR-b. The
// workspace selector pill shows the REAL workspace name + initials glyph over a
// muted "Local workspace" sub-label (hierarchy: the pill is the workspace identity;
// the header "Ranin" mark is the app brand), and preserves the `open-switcher`
// affordance (clicking it opens the quick-switcher palette).
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkspaceSwitcher from '../../../src/components/shell/WorkspaceSwitcher.vue'

describe('WorkspaceSwitcher (ENG-136 PR-3)', () => {
  it('renders the workspace name + initials glyph', () => {
    const wrapper = mount(WorkspaceSwitcher, {
      props: { workspaceName: 'Acme', workspaceInitials: 'AC' },
    })
    expect(wrapper.text()).toContain('Acme')
    expect(wrapper.text()).toContain('AC')
  })

  it('emits openSwitcher from the pill (preserving the open-switcher test-id)', async () => {
    const wrapper = mount(WorkspaceSwitcher, {
      props: { workspaceName: 'Acme', workspaceInitials: 'AC' },
    })
    const pill = wrapper.get('[data-testid="open-switcher"]')
    await pill.trigger('click')
    expect(wrapper.emitted('openSwitcher')).toHaveLength(1)
  })

  it('shows the muted "Local workspace" sub-label under the name (ENG-152)', () => {
    const wrapper = mount(WorkspaceSwitcher, {
      props: { workspaceName: 'msg', workspaceInitials: 'MS' },
    })
    const pill = wrapper.get('[data-testid="open-switcher"]')
    expect(pill.text()).toContain('msg')
    expect(pill.text()).toContain('Local workspace')
  })

  it('renders ONLY the chevron glyph — no decorative play/forward button (user feedback)', () => {
    const wrapper = mount(WorkspaceSwitcher, {
      props: { workspaceName: 'Acme', workspaceInitials: 'AC' },
    })
    // Exactly one svg in the pill: the chevron-down. The removed no-op "play"
    // circle (an accent-filled span with an inline svg) must not come back.
    const svgs = wrapper.findAll('svg')
    expect(svgs).toHaveLength(1)
    expect(svgs[0]!.classes().join(' ')).toContain('lucide-chevron-down')
    expect(wrapper.find('.bg-accent').exists()).toBe(false)
  })
})
