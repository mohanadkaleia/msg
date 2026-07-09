// tests/unit/admin/AdminInvitesPanel.spec.ts — ENG-151 PR-3. The Invites panel
// over a fake `client.admin.invites.*`: pending invites render (role, creator
// resolved via the local directory, relative expiry), Revoke is confirm-gated
// and calls `invites.revoke({id})`, a `not-found` refetches (already gone), a
// `forbidden` shows the inline error, and the empty state says invites are
// CLI-minted today (there is deliberately NO create affordance).
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AdminInvitesPanel from '../../../src/components/admin/AdminInvitesPanel.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from '../shell/fakeWorker'

import type { AdminInvite } from '../../../src/worker'

const IN_TWO_DAYS = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()

function invite(over: Partial<AdminInvite> & { id: string }): AdminInvite {
  return { role: 'member', created_by: 'u_owner', expires_at: IN_TWO_DAYS, ...over }
}

describe('AdminInvitesPanel (ENG-151 PR-3)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.setDirectory([{ user_id: 'u_owner', display_name: 'Olive Owner' }], [])
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  async function mountPanel(): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    // The panel resolves creator names from the ALREADY-LOADED directory.
    await useWorkspaceStore().load()
    const wrapper = mount(AdminInvitesPanel, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it('renders pending invites: role, resolved creator, relative expiry', async () => {
    fake.setAdminInvites([
      invite({ id: 'i_1' }),
      invite({ id: 'i_2', role: 'guest', created_by: 'u_ghost' }),
    ])
    const wrapper = await mountPanel()

    expect(fake.adminInvitesListSpy).toHaveBeenCalledTimes(1)
    const rows = wrapper.findAll('[data-testid="admin-invite-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.get('[data-testid="admin-invite-role"]').text()).toBe('member')
    expect(rows[0]!.text()).toContain('Olive Owner')
    expect(rows[0]!.get('[data-testid="admin-invite-expiry"]').text()).toContain('in 2d')
    // An unresolvable creator falls back to the raw id — never invented.
    expect(rows[1]!.text()).toContain('u_ghost')
  })

  it('Revoke is confirm-gated, calls invites.revoke({id}), and drops the row', async () => {
    fake.setAdminInvites([invite({ id: 'i_1' })])
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="admin-invite-revoke"]').trigger('click')
    expect(fake.adminRevokeSpy).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="admin-revoke-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(fake.adminRevokeSpy).toHaveBeenCalledWith({ id: 'i_1' })
    expect(wrapper.findAll('[data-testid="admin-invite-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="admin-invites-empty"]').exists()).toBe(true)
  })

  it('cancelling the Revoke confirm issues no RPC', async () => {
    fake.setAdminInvites([invite({ id: 'i_1' })])
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="admin-invite-revoke"]').trigger('click')
    await wrapper.get('[data-testid="admin-revoke-confirm-no"]').trigger('click')

    expect(fake.adminRevokeSpy).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-testid="admin-invite-row"]')).toHaveLength(1)
  })

  it('a not-found revoke refetches the list instead of erroring (already gone)', async () => {
    fake.setAdminInvites([invite({ id: 'i_1' })])
    fake.failNextAdminRevoke('not-found')
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="admin-invite-revoke"]').trigger('click')
    await wrapper.get('[data-testid="admin-revoke-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(fake.adminInvitesListSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="admin-invites-error"]').exists()).toBe(false)
  })

  it('a coded forbidden revoke surfaces the inline error and keeps the row', async () => {
    fake.setAdminInvites([invite({ id: 'i_1' })])
    fake.failNextAdminRevoke('forbidden')
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="admin-invite-revoke"]').trigger('click')
    await wrapper.get('[data-testid="admin-revoke-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="admin-invites-error"]').text()).toMatch(/permission/i)
    expect(wrapper.findAll('[data-testid="admin-invite-row"]')).toHaveLength(1)
  })

  it('shows the CLI-honest empty state when there are no pending invites', async () => {
    const wrapper = await mountPanel()
    const empty = wrapper.get('[data-testid="admin-invites-empty"]')
    expect(empty.text()).toContain('No pending invites')
    expect(empty.text()).toContain('CLI')
  })

  it('a failed load shows the retryable error state; Retry re-lists', async () => {
    fake.setAdminInvites([invite({ id: 'i_1' })])
    fake.failNextAdminList('forbidden')
    const wrapper = await mountPanel()

    expect(wrapper.find('[data-testid="admin-invites-load-error"]').exists()).toBe(true)
    await wrapper.get('[data-testid="admin-invites-retry"]').trigger('click')
    await flushPromises()

    expect(fake.adminInvitesListSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-testid="admin-invite-row"]')).toHaveLength(1)
  })
})
