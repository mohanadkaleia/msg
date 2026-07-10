// tests/unit/admin/AdminView.spec.ts — ENG-151 PR-3. The Admin surface shell:
// role gating (a member/guest sees the no-access state and NO admin RPC is
// issued), the Members tab is the default, and the Invites tab swaps panels.
// Panel behavior itself is covered by the panel specs.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AdminView from '../../../src/components/admin/AdminView.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useAuthStore } from '../../../src/stores/auth'
import { FakeWorker } from '../shell/fakeWorker'

describe('AdminView (ENG-151 PR-3)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.setAdminMembers([
      {
        user_id: 'u_owner',
        display_name: 'Olive Owner',
        email: 'olive@example.com',
        role: 'owner',
        is_bot: false,
        deactivated: false,
      },
    ])
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  async function mountView(role: string | undefined, userId = 'u_me'): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    const auth = useAuthStore()
    auth.role = role
    auth.myUserId = userId
    const wrapper = mount(AdminView, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it.each(['member', 'guest', undefined])(
    'role %s sees the no-access state and no admin RPC fires',
    async (role) => {
      const wrapper = await mountView(role)

      expect(wrapper.find('[data-testid="admin-no-access"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="admin-members"]').exists()).toBe(false)
      expect(fake.adminMembersListSpy).not.toHaveBeenCalled()
      expect(fake.adminInvitesListSpy).not.toHaveBeenCalled()
    },
  )

  it('an owner lands on the Members tab with the roster loaded', async () => {
    const wrapper = await mountView('owner', 'u_owner')

    expect(wrapper.find('[data-testid="admin-no-access"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="admin-tab-members"]').attributes('aria-selected')).toBe(
      'true',
    )
    expect(wrapper.find('[data-testid="admin-members"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="admin-member-row"]')).toHaveLength(1)
    expect(fake.adminMembersListSpy).toHaveBeenCalledTimes(1)
  })

  it('an admin also gets the surface (owner OR admin)', async () => {
    const wrapper = await mountView('admin', 'u_admin')
    expect(wrapper.find('[data-testid="admin-members"]').exists()).toBe(true)
  })

  it('the Invites tab swaps to the invites panel (and back)', async () => {
    const wrapper = await mountView('owner', 'u_owner')

    await wrapper.get('[data-testid="admin-tab-invites"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="admin-invites"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="admin-members"]').exists()).toBe(false)
    expect(fake.adminInvitesListSpy).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="admin-tab-members"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="admin-members"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="admin-invites"]').exists()).toBe(false)
  })

  it('the Workspace tab swaps to the settings panel (ENG-152)', async () => {
    const wrapper = await mountView('owner', 'u_owner')

    await wrapper.get('[data-testid="admin-tab-workspace"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="admin-workspace"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="admin-members"]').exists()).toBe(false)
    expect(fake.adminWorkspaceGetSpy).toHaveBeenCalledTimes(1)
    // The form is pre-filled from `admin.workspace.get`.
    expect((wrapper.get('[data-testid="workspace-name"]').element as HTMLInputElement).value).toBe(
      'Acme',
    )
  })
})
