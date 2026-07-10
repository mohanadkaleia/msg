// tests/unit/ui/UserHovercard.spec.ts — ENG-152 user hovercard content. A DUMB
// view over a directory record + a live presence status: it renders name/title,
// the ACTIVE custom status (hidden when unset or lazily expired via lib/status),
// and an online/offline presence line. No store access, no positioning here.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import UserHovercard from '../../../src/components/ui/UserHovercard.vue'
import type { DirectoryUser } from '../../../src/worker'

function makeUser(over: Partial<DirectoryUser> = {}): DirectoryUser {
  return { user_id: 'u_ana', display_name: 'Ana', ...over }
}

describe('UserHovercard (ENG-152)', () => {
  it('renders name + title from the directory record', () => {
    const wrapper = mount(UserHovercard, {
      props: { user: makeUser({ title: 'Staff Engineer' }), presence: 'offline' },
    })
    const card = wrapper.get('[data-testid="user-hovercard"]')
    expect(card.text()).toContain('Ana')
    expect(card.text()).toContain('Staff Engineer')
  })

  it('shows the active custom status (emoji + text)', () => {
    const wrapper = mount(UserHovercard, {
      props: {
        user: makeUser({ status_emoji: '🌴', status_text: 'On vacation' }),
        presence: 'offline',
      },
    })
    const status = wrapper.get('[data-testid="user-hovercard-status"]')
    expect(status.text()).toContain('🌴')
    expect(status.text()).toContain('On vacation')
  })

  it('hides the status row when there is none', () => {
    const wrapper = mount(UserHovercard, { props: { user: makeUser(), presence: 'online' } })
    expect(wrapper.find('[data-testid="user-hovercard-status"]').exists()).toBe(false)
  })

  it('hides a lazily-expired status (render-time expiry)', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const wrapper = mount(UserHovercard, {
      props: {
        user: makeUser({ status_emoji: '🎧', status_text: 'Heads down', status_expires_at: past }),
        presence: 'online',
      },
    })
    expect(wrapper.find('[data-testid="user-hovercard-status"]').exists()).toBe(false)
  })

  it('labels presence online vs offline', () => {
    const online = mount(UserHovercard, { props: { user: makeUser(), presence: 'online' } })
    const dot = online.get('[data-testid="user-hovercard-presence"]')
    expect(dot.text()).toContain('Active now')
    expect(dot.attributes('data-status')).toBe('online')

    const offline = mount(UserHovercard, { props: { user: makeUser(), presence: 'offline' } })
    expect(offline.get('[data-testid="user-hovercard-presence"]').text()).toContain('Offline')
  })

  it('escapes a hostile display name (never as DOM)', () => {
    const payload = '<img src=x onerror="window.__pwned=1">'
    const wrapper = mount(UserHovercard, {
      props: { user: makeUser({ display_name: payload }), presence: 'offline' },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('<img src=x')
  })
})
