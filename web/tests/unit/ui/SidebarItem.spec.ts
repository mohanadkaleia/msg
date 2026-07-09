import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SidebarItem from '../../../src/components/ui/SidebarItem.vue'

describe('ui/SidebarItem', () => {
  it('renders a button with default (secondary) styling and slot label', () => {
    const wrapper = mount(SidebarItem, { slots: { default: '# general' } })
    const root = wrapper.get('button')
    expect(root.text()).toContain('# general')
    expect(root.classes()).toContain('text-secondary')
    expect(root.classes()).toContain('h-7')
  })

  it('shows the strengthened active state (accent-subtle bg + accent text + left bar)', () => {
    const wrapper = mount(SidebarItem, { props: { active: true }, slots: { default: 'x' } })
    const cls = wrapper.get('button').attributes('class') ?? ''
    // ENG-152 PR-c: "you are here" is accent-tinted bg + ACCENT text, not just grey.
    expect(cls).toContain('bg-accent-subtle')
    expect(cls).toContain('text-accent')
    expect(cls).toContain('font-medium')
    // The left accent bar only renders when active.
    expect(wrapper.find('span.bg-accent').exists()).toBe(true)
  })

  it('colors the leading icon with the accent while active', () => {
    const active = mount(SidebarItem, {
      props: { active: true },
      slots: { default: 'x', leading: '<svg data-testid="lead" />' },
    })
    expect(active.get('[data-testid="lead"]').element.parentElement?.className).toContain(
      'text-accent',
    )

    const idle = mount(SidebarItem, {
      slots: { default: 'x', leading: '<svg data-testid="lead" />' },
    })
    expect(idle.get('[data-testid="lead"]').element.parentElement?.className).toContain(
      'text-muted',
    )
  })

  it('applies unread styling (primary text + SEMIBOLD weight) vs muted read rows', () => {
    const cls =
      mount(SidebarItem, { props: { unread: true }, slots: { default: 'x' } })
        .get('button')
        .attributes('class') ?? ''
    expect(cls).toContain('text-primary')
    expect(cls).toContain('font-semibold')

    // A read row stays calm: secondary text, normal weight.
    const read =
      mount(SidebarItem, { slots: { default: 'x' } })
        .get('button')
        .attributes('class') ?? ''
    expect(read).toContain('text-secondary')
    expect(read).toContain('font-normal')
  })

  it('renders as an anchor when href is provided', () => {
    const wrapper = mount(SidebarItem, { props: { href: '/c/general' }, slots: { default: 'x' } })
    const a = wrapper.get('a')
    expect(a.attributes('href')).toBe('/c/general')
  })

  it('renders the trailing slot and passes through data-testid', () => {
    const wrapper = mount(SidebarItem, {
      attrs: { 'data-testid': 'nav-general' },
      slots: { default: 'general', trailing: '<span>3</span>' },
    })
    expect(wrapper.get('button').attributes('data-testid')).toBe('nav-general')
    expect(wrapper.text()).toContain('3')
  })

  it('renders the optional leading slot before the label (aria-hidden wrapper)', () => {
    const wrapper = mount(SidebarItem, {
      slots: { default: 'general', leading: '<svg data-testid="lead-icon" />' },
    })
    const lead = wrapper.get('[data-testid="lead-icon"]')
    // The leading glyph is wrapped in an aria-hidden decorative container.
    expect(lead.element.parentElement?.getAttribute('aria-hidden')).toBe('true')
    // And it precedes the label in document order.
    const html = wrapper.html()
    expect(html.indexOf('lead-icon')).toBeLessThan(html.indexOf('general'))
  })

  it('omits the leading wrapper when no leading slot is provided', () => {
    const wrapper = mount(SidebarItem, { slots: { default: 'general' } })
    expect(wrapper.find('[aria-hidden="true"]').exists()).toBe(false)
  })
})
