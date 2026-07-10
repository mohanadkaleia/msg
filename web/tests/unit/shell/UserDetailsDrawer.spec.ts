// tests/unit/shell/UserDetailsDrawer.spec.ts — ENG-152 right-drawer user-details
// panel. A DUMB view over a directory record + presence + optional role: it shows
// the name/title/status, an online/offline presence line, the read-only role
// (only when the shell knows it), and the description; the ✕ emits close.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import UserDetailsDrawer from '../../../src/components/shell/UserDetailsDrawer.vue'
import type { DirectoryUser } from '../../../src/worker'

function makeUser(over: Partial<DirectoryUser> = {}): DirectoryUser {
  return { user_id: 'u_ana', display_name: 'Ana', ...over }
}

describe('UserDetailsDrawer (ENG-152)', () => {
  it('renders the fuller profile: name, title, description, status, presence', () => {
    const wrapper = mount(UserDetailsDrawer, {
      props: {
        user: makeUser({
          title: 'Staff Engineer',
          description: 'Working on the sync engine.',
          status_emoji: '🎧',
          status_text: 'Heads down',
        }),
        presence: 'online',
        role: 'admin',
      },
    })
    const panel = wrapper.get('[data-testid="user-details-drawer"]')
    expect(panel.text()).toContain('Ana')
    expect(panel.text()).toContain('Staff Engineer')
    expect(wrapper.get('[data-testid="user-details-description"]').text()).toContain(
      'Working on the sync engine.',
    )
    expect(wrapper.get('[data-testid="user-details-status"]').text()).toContain('🎧')
    const presence = wrapper.get('[data-testid="user-details-presence"]')
    expect(presence.text()).toContain('Active now')
    expect(presence.attributes('data-status')).toBe('online')
  })

  it('shows the role only when the shell provides it', () => {
    const withRole = mount(UserDetailsDrawer, {
      props: { user: makeUser(), presence: 'offline', role: 'owner' },
    })
    expect(withRole.get('[data-testid="user-details-role"]').text()).toContain('owner')

    const noRole = mount(UserDetailsDrawer, {
      props: { user: makeUser(), presence: 'offline' },
    })
    expect(noRole.find('[data-testid="user-details-role"]').exists()).toBe(false)
  })

  it('hides the description row when there is none', () => {
    const wrapper = mount(UserDetailsDrawer, {
      props: { user: makeUser(), presence: 'offline' },
    })
    expect(wrapper.find('[data-testid="user-details-description"]').exists()).toBe(false)
  })

  it('emits close from the ✕', async () => {
    const wrapper = mount(UserDetailsDrawer, {
      props: { user: makeUser(), presence: 'offline' },
    })
    await wrapper.get('[data-testid="user-details-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('escapes a hostile description (never as DOM)', () => {
    const payload = '<img src=x onerror="window.__pwned=1">'
    const wrapper = mount(UserDetailsDrawer, {
      props: { user: makeUser({ description: payload }), presence: 'offline' },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="user-details-description"]').text()).toBe(payload)
  })
})
