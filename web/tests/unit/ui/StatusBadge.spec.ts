import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import StatusBadge from '../../../src/components/ui/StatusBadge.vue'

describe('ui/StatusBadge', () => {
  it('renders a dot and an optional label', () => {
    const wrapper = mount(StatusBadge, { props: { tone: 'online', label: 'Online' } })
    expect(wrapper.text()).toContain('Online')
    expect(wrapper.find('span[aria-hidden="true"]').exists()).toBe(true)
  })

  it.each([
    ['online', 'bg-success'],
    ['success', 'bg-success'],
    ['syncing', 'bg-accent'],
    ['sync-pending', 'bg-sync-pending'],
    // PR-B review #3: offline reads as urgent (danger), not a muted grey.
    ['offline', 'bg-danger'],
    ['danger', 'bg-danger'],
    ['muted', 'bg-muted'],
  ] as const)('maps tone %s to %s', (tone, expected) => {
    const wrapper = mount(StatusBadge, { props: { tone } })
    const dot = wrapper.get('span[aria-hidden="true"]')
    expect(dot.classes()).toContain(expected)
  })

  it('pulses only when syncing', () => {
    const syncing = mount(StatusBadge, { props: { tone: 'syncing' } })
    expect(syncing.get('span[aria-hidden="true"]').classes()).toContain('animate-pulse')
    const idle = mount(StatusBadge, { props: { tone: 'online' } })
    expect(idle.get('span[aria-hidden="true"]').classes()).not.toContain('animate-pulse')
  })
})
