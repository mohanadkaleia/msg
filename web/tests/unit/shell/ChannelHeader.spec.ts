import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import ChannelHeader from '../../../src/components/shell/ChannelHeader.vue'

describe('ChannelHeader', () => {
  it('renders the title alone as the channel-header text (E2E asserts this)', () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# engineering', memberCount: 34 } })
    const header = wrapper.get('[data-testid="channel-header"]')
    // The icon buttons carry no text and the member/topic line is a SIBLING, so the
    // header element's text is exactly the title — the golden-path E2E depends on it.
    expect(header.text()).toBe('# engineering')
  })

  it('shows the member count outside the header element, with NO "Add a topic"', () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# eng', memberCount: 34 } })
    const meta = wrapper.get('[data-testid="channel-header-meta"]')
    expect(meta.text()).toContain('34 members')
    // "Add a topic" was a non-wired scaffold (no channel-topic backend) — removed.
    expect(meta.text()).not.toContain('Add a topic')
    expect(meta.find('button').exists()).toBe(false)
    // Not part of the header element (would break the E2E title assertion).
    expect(wrapper.get('[data-testid="channel-header"]').text()).not.toContain('members')
  })

  it('singularizes a single member', () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# eng', memberCount: 1 } })
    expect(wrapper.get('[data-testid="channel-header-meta"]').text()).toBe('1 member')
  })

  it('renders NO non-functional controls (star/pin/add-member); Details remains and works', async () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# eng' } })
    // ENG-152 cleanup: no add-member button — adding members lives in the
    // channel-settings dialog via the Details drawer.
    expect(wrapper.find('[data-testid="channel-header-add-member"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Add member"]').exists()).toBe(false)

    // UI-feedback cleanup: the star (favorite) and pin buttons were unbacked
    // scaffolds (no favorites/pin backend) — removed.
    expect(wrapper.find('button[aria-label="Favorite"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Unfavorite"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Pinned messages"]').exists()).toBe(false)

    // The details (more-horizontal) button is the header's ONLY icon action and
    // still emits toggle-details.
    const header = wrapper.get('[data-testid="channel-header"]')
    expect(header.findAll('button')).toHaveLength(1)
    const details = wrapper.get('button[aria-label="Details"]')
    await details.trigger('click')
    expect(wrapper.emitted('toggle-details')).toHaveLength(1)
  })

  it('shows a DM participant name + presence dot; header text stays the title alone (ENG-149)', () => {
    const wrapper = mount(ChannelHeader, { props: { title: 'Dana', presence: 'online' as const } })
    const header = wrapper.get('[data-testid="channel-header"]')
    // The dot is text-free, so the E2E title assertion surface is unchanged.
    expect(header.text()).toBe('Dana')
    expect(header.get('[data-testid="presence-dot"]').attributes('data-status')).toBe('online')
  })

  it('DM (ENG-172): the subline is the status/presence subtitle — never members/topic', () => {
    const wrapper = mount(ChannelHeader, {
      props: {
        title: 'Dana',
        kind: 'dm' as const,
        subtitle: '🌴 On vacation · Active now',
        presence: 'online' as const,
        memberCount: 34, // must be ignored for a DM
      },
    })
    const meta = wrapper.get('[data-testid="channel-header-meta"]')
    expect(meta.text()).toBe('🌴 On vacation · Active now')
    expect(wrapper.text()).not.toContain('members')
    expect(wrapper.text()).not.toContain('Add a topic')
    // The header element still carries the title alone (E2E contract).
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe('Dana')
  })

  it('DM (ENG-172): with no resolvable subtitle it renders NO subline at all', () => {
    const wrapper = mount(ChannelHeader, {
      props: { title: 'Dana', kind: 'dm' as const, memberCount: 34 },
    })
    expect(wrapper.find('[data-testid="channel-header-meta"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('members')
    expect(wrapper.text()).not.toContain('Add a topic')
  })

  it('channel (ENG-172): kind="channel" keeps the member-count subline', () => {
    const wrapper = mount(ChannelHeader, {
      props: { title: '# eng', kind: 'channel' as const, memberCount: 4 },
    })
    const meta = wrapper.get('[data-testid="channel-header-meta"]')
    expect(meta.text()).toBe('4 members')
  })

  it('renders an offline DM counterpart with a muted (offline) dot', () => {
    const wrapper = mount(ChannelHeader, { props: { title: 'Dana', presence: 'offline' as const } })
    const header = wrapper.get('[data-testid="channel-header"]')
    expect(header.get('[data-testid="presence-dot"]').attributes('data-status')).toBe('offline')
  })

  it('shows NO presence dot for a channel (presence absent) and keeps the # title', () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# engineering' } })
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe('# engineering')
    expect(wrapper.find('[data-testid="presence-dot"]').exists()).toBe(false)
  })

  it('renders a title with an XSS payload as inert escaped text', () => {
    const payload = '<img src=x onerror="window.__pwned=1">#eng'
    const wrapper = mount(ChannelHeader, { props: { title: payload } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe(payload)
  })
})
