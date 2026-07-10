// tests/unit/shell/UserCard.spec.ts — ENG-136 PR-3. The footer user card renders the
// REAL display name, an initial avatar, and a presence dot whose color reflects the
// REAL status (bg-success online, bg-muted offline) with an honest label.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import UserCard from '../../../src/components/shell/UserCard.vue'

describe('UserCard (ENG-136 PR-3)', () => {
  it('shows the name, initial and an online dot + label by default', () => {
    const wrapper = mount(UserCard, { props: { name: 'Dana Scully' } })
    expect(wrapper.text()).toContain('Dana Scully')
    expect(wrapper.text()).toContain('Online')
    // Avatar initial.
    expect(wrapper.text()).toContain('D')
    // The presence dot is success-toned when online.
    const dot = wrapper.get('[data-status="online"]')
    expect(dot.classes()).toContain('bg-success')
  })

  it('reflects an offline status with a muted dot + label', () => {
    const wrapper = mount(UserCard, { props: { name: 'Sam', status: 'offline' } })
    expect(wrapper.text()).toContain('Offline')
    const dot = wrapper.get('[data-status="offline"]')
    expect(dot.classes()).toContain('bg-muted')
  })

  it('exposes the user-card test-id', () => {
    const wrapper = mount(UserCard, { props: { name: 'Sam' } })
    expect(wrapper.find('[data-testid="user-card"]').exists()).toBe(true)
  })

  it('emits open-profile when the card is clicked (the profile affordance)', async () => {
    const wrapper = mount(UserCard, { props: { name: 'Sam' } })
    expect(wrapper.find('[data-testid="open-profile"]').exists()).toBe(true)
    await wrapper.get('[data-testid="user-card"]').trigger('click')
    expect(wrapper.emitted('openProfile')).toHaveLength(1)
  })

  // ENG-164: the sub-line shows the ACTIVE custom status (emoji + text) when one
  // is passed; expiry is applied UPSTREAM (lib/status.ts activeStatus), so an
  // expired status simply never reaches these props → the presence label shows.
  it('renders the custom status (emoji + text) instead of the presence label', () => {
    const wrapper = mount(UserCard, {
      props: { name: 'Sam', statusEmoji: '🌴', statusText: 'On vacation' },
    })
    const status = wrapper.get('[data-testid="user-card-status"]')
    expect(status.text()).toContain('🌴')
    expect(status.text()).toContain('On vacation')
    expect(wrapper.text()).not.toContain('Online')
  })

  it('renders an emoji-only or text-only status', () => {
    const emojiOnly = mount(UserCard, { props: { name: 'Sam', statusEmoji: '🎧' } })
    expect(emojiOnly.get('[data-testid="user-card-status"]').text()).toBe('🎧')
    const textOnly = mount(UserCard, { props: { name: 'Sam', statusText: 'Focusing' } })
    expect(textOnly.get('[data-testid="user-card-status"]').text()).toBe('Focusing')
  })

  it('falls back to the presence label when no status is set (expired upstream)', () => {
    const wrapper = mount(UserCard, { props: { name: 'Sam' } })
    expect(wrapper.find('[data-testid="user-card-status"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Online')
  })
})
