// tests/unit/admin/AdminMembersPanel.spec.ts — ENG-151 PR-3. The Members panel
// over a fake `client.admin.members.*`: the roster renders (names/emails/
// badges), the role dropdown and active toggle issue `members.update` with the
// EXACT params, the policy mirror gates controls per row (owner read-only, bot
// role locked, self locked), and a coded `forbidden` rejection surfaces as an
// inline error — never a crash. All through the WorkerClient facade; no HTTP.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AdminMembersPanel from '../../../src/components/admin/AdminMembersPanel.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { FakeWorker } from '../shell/fakeWorker'

import type { AdminMember } from '../../../src/worker'

function member(over: Partial<AdminMember> & { user_id: string }): AdminMember {
  return {
    display_name: over.user_id,
    email: `${over.user_id}@example.com`,
    role: 'member',
    is_bot: false,
    deactivated: false,
    ...over,
  }
}

/** The default seeded roster: owner, two admins, a member, a guest, a bot, a
 * deactivated member — one row per policy-relevant kind. */
function seedRoster(fake: FakeWorker): void {
  fake.setAdminMembers([
    member({ user_id: 'u_owner', display_name: 'Olive Owner', role: 'owner' }),
    member({ user_id: 'u_admin', display_name: 'Ada Admin', role: 'admin' }),
    member({ user_id: 'u_admin2', display_name: 'Abe Admin', role: 'admin' }),
    member({ user_id: 'u_bob', display_name: 'Bob Builder' }),
    member({ user_id: 'u_gia', display_name: 'Gia Guest', role: 'guest' }),
    member({ user_id: 'u_bot', display_name: 'Deploy Bot', is_bot: true }),
    member({ user_id: 'u_dora', display_name: 'Dora Dormant', deactivated: true }),
  ])
}

describe('AdminMembersPanel (ENG-151 PR-3)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  async function mountPanel(actorRole: string, actorUserId: string): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    const wrapper = mount(AdminMembersPanel, {
      props: { actorRole, actorUserId },
      attachTo: document.body,
    })
    await flushPromises()
    return wrapper
  }

  function row(wrapper: VueWrapper, userId: string) {
    return wrapper.get(`[data-testid="admin-member-row"][data-user-id="${userId}"]`)
  }

  it('renders the roster with names, emails, and badges', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('owner', 'u_owner')

    expect(fake.adminMembersListSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-testid="admin-member-row"]')).toHaveLength(7)
    expect(row(wrapper, 'u_bob').text()).toContain('Bob Builder')
    expect(row(wrapper, 'u_bob').text()).toContain('u_bob@example.com')
    expect(row(wrapper, 'u_owner').find('[data-testid="admin-owner-badge"]').exists()).toBe(true)
    expect(row(wrapper, 'u_bot').find('[data-testid="admin-bot-badge"]').exists()).toBe(true)
    expect(row(wrapper, 'u_dora').find('[data-testid="admin-deactivated-badge"]').exists()).toBe(
      true,
    )
  })

  it('offers only Admin/Member/Guest in the role dropdown (never Owner)', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('owner', 'u_owner')

    const options = row(wrapper, 'u_bob')
      .get('[data-testid="admin-role-select"]')
      .findAll('option')
      .map((o) => o.attributes('value'))
    expect(options).toEqual(['admin', 'member', 'guest'])
  })

  it('changing a role calls members.update with the exact params and applies the result', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('owner', 'u_owner')

    await row(wrapper, 'u_bob').get('[data-testid="admin-role-select"]').setValue('admin')
    await flushPromises()

    expect(fake.adminUpdateSpy).toHaveBeenCalledWith({ user_id: 'u_bob', role: 'admin' })
    const select = row(wrapper, 'u_bob').get('[data-testid="admin-role-select"]')
      .element as HTMLSelectElement
    expect(select.value).toBe('admin')
    expect(wrapper.find('[data-testid="admin-members-error"]').exists()).toBe(false)
  })

  it('Deactivate is confirm-gated, then calls members.update({active:false})', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('owner', 'u_owner')

    await row(wrapper, 'u_bob').get('[data-testid="admin-deactivate"]').trigger('click')
    // No RPC yet — the inline confirm is showing.
    expect(fake.adminUpdateSpy).not.toHaveBeenCalled()
    await row(wrapper, 'u_bob').get('[data-testid="admin-deactivate-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(fake.adminUpdateSpy).toHaveBeenCalledWith({ user_id: 'u_bob', active: false })
    expect(row(wrapper, 'u_bob').find('[data-testid="admin-deactivated-badge"]').exists()).toBe(
      true,
    )
    expect(row(wrapper, 'u_bob').find('[data-testid="admin-reactivate"]').exists()).toBe(true)
  })

  it('cancelling the Deactivate confirm issues no RPC', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('owner', 'u_owner')

    await row(wrapper, 'u_bob').get('[data-testid="admin-deactivate"]').trigger('click')
    await row(wrapper, 'u_bob').get('[data-testid="admin-deactivate-confirm-no"]').trigger('click')

    expect(fake.adminUpdateSpy).not.toHaveBeenCalled()
    expect(row(wrapper, 'u_bob').find('[data-testid="admin-deactivate"]').exists()).toBe(true)
  })

  it('Reactivate calls members.update({active:true}) directly', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('owner', 'u_owner')

    await row(wrapper, 'u_dora').get('[data-testid="admin-reactivate"]').trigger('click')
    await flushPromises()

    expect(fake.adminUpdateSpy).toHaveBeenCalledWith({ user_id: 'u_dora', active: true })
    expect(row(wrapper, 'u_dora').find('[data-testid="admin-deactivated-badge"]').exists()).toBe(
      false,
    )
  })

  it('the owner row is read-only: badge, no role control, no active toggle', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('admin', 'u_admin')

    const owner = row(wrapper, 'u_owner')
    expect(owner.find('[data-testid="admin-owner-badge"]').exists()).toBe(true)
    expect(owner.find('[data-testid="admin-role-select"]').exists()).toBe(false)
    expect(owner.find('[data-testid="admin-deactivate"]').exists()).toBe(false)
    expect(owner.find('[data-testid="admin-reactivate"]').exists()).toBe(false)
  })

  it('a bot row locks the role but allows deactivation', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('owner', 'u_owner')

    const bot = row(wrapper, 'u_bot')
    expect(bot.find('[data-testid="admin-role-select"]').exists()).toBe(false)
    expect(bot.find('[data-testid="admin-role-static"]').text()).toBe('member')
    expect(bot.find('[data-testid="admin-deactivate"]').exists()).toBe(true)
  })

  it('the actor sees no controls on their own row, and an admin none on a peer admin', async () => {
    seedRoster(fake)
    const wrapper = await mountPanel('admin', 'u_admin')

    for (const id of ['u_admin', 'u_admin2']) {
      const r = row(wrapper, id)
      expect(r.find('[data-testid="admin-role-select"]').exists()).toBe(false)
      expect(r.find('[data-testid="admin-deactivate"]').exists()).toBe(false)
      expect(r.find('[data-testid="admin-reactivate"]').exists()).toBe(false)
    }
    // …while the same admin actor CAN manage a plain member.
    expect(row(wrapper, 'u_bob').find('[data-testid="admin-role-select"]').exists()).toBe(true)
  })

  it('a coded forbidden rejection surfaces the inline error, not a crash', async () => {
    seedRoster(fake)
    fake.failNextAdminUpdate('forbidden')
    const wrapper = await mountPanel('owner', 'u_owner')

    await row(wrapper, 'u_bob').get('[data-testid="admin-role-select"]').setValue('guest')
    await flushPromises()

    expect(wrapper.get('[data-testid="admin-members-error"]').text()).toMatch(/permission/i)
    // The store truth is unchanged — the row still reports 'member'.
    const select = row(wrapper, 'u_bob').get('[data-testid="admin-role-select"]')
      .element as HTMLSelectElement
    expect(select.value).toBe('member')
  })

  it('a not-found rejection refetches the roster (it drifted)', async () => {
    seedRoster(fake)
    fake.failNextAdminUpdate('not-found')
    const wrapper = await mountPanel('owner', 'u_owner')

    await row(wrapper, 'u_bob').get('[data-testid="admin-deactivate"]').trigger('click')
    await row(wrapper, 'u_bob').get('[data-testid="admin-deactivate-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="admin-members-error"]').text()).toMatch(/no longer exists/i)
    expect(fake.adminMembersListSpy).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state for an empty roster', async () => {
    const wrapper = await mountPanel('owner', 'u_owner')
    expect(wrapper.find('[data-testid="admin-members-empty"]').exists()).toBe(true)
  })

  it('a failed load shows the retryable error state; Retry re-lists', async () => {
    seedRoster(fake)
    fake.failNextAdminList('forbidden')
    const wrapper = await mountPanel('owner', 'u_owner')

    expect(wrapper.find('[data-testid="admin-members-load-error"]').exists()).toBe(true)
    await wrapper.get('[data-testid="admin-members-retry"]').trigger('click')
    await flushPromises()

    expect(fake.adminMembersListSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-testid="admin-member-row"]')).toHaveLength(7)
  })
})
