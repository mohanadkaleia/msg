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

  it('shows a SCAFFOLD member count + "Add a topic" outside the header element', () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# eng', memberCount: 34 } })
    const meta = wrapper.get('[data-testid="channel-header-meta"]')
    expect(meta.text()).toContain('34 members')
    expect(meta.text()).toContain('Add a topic')
    // Not part of the header element (would break the E2E title assertion).
    expect(wrapper.get('[data-testid="channel-header"]').text()).not.toContain('members')
  })

  it('singularizes a single member', () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# eng', memberCount: 1 } })
    expect(wrapper.get('[data-testid="channel-header-meta"]').text()).toContain('1 member ·')
  })

  it('renders NO add-member button (ENG-152 cleanup); pin + details remain', async () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# eng' } })
    // The add-user icon button next to the pin was removed — adding members
    // lives in the channel-settings dialog via the Details drawer.
    expect(wrapper.find('[data-testid="channel-header-add-member"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Add member"]').exists()).toBe(false)

    // The pin button is still there…
    expect(wrapper.find('button[aria-label="Pinned messages"]').exists()).toBe(true)

    // …and the details (more-horizontal) button still emits toggle-details.
    const details = wrapper.get('button[aria-label="Details"]')
    await details.trigger('click')
    expect(wrapper.emitted('toggle-details')).toHaveLength(1)
  })

  it('toggles the local SCAFFOLD favorite state on the star button', async () => {
    const wrapper = mount(ChannelHeader, { props: { title: '# eng' } })
    const star = wrapper.get('button[aria-label="Favorite"]')
    await star.trigger('click')
    // After toggling, the button relabels to "Unfavorite" (local-only, no backend).
    expect(wrapper.find('button[aria-label="Unfavorite"]').exists()).toBe(true)
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

  it('channel (ENG-172): kind="channel" keeps the member/topic subline unchanged', () => {
    const wrapper = mount(ChannelHeader, {
      props: { title: '# eng', kind: 'channel' as const, memberCount: 4 },
    })
    const meta = wrapper.get('[data-testid="channel-header-meta"]')
    expect(meta.text()).toContain('4 members')
    expect(meta.text()).toContain('Add a topic')
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
