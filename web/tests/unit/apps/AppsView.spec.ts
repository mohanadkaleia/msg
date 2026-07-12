// tests/unit/apps/AppsView.spec.ts — ENG-176. The Apps/Integrations surface
// shell: role gating (a member/guest/anon sees the no-access state and NO plugin
// RPC is issued — this surface mints credentials, so it fails closed at the view
// too), the Bots tab is the default, and the Incoming-webhooks tab swaps panels.
// Panel behavior itself is covered by the panel specs.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AppsView from '../../../src/components/apps/AppsView.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useAuthStore } from '../../../src/stores/auth'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from '../shell/fakeWorker'

describe('AppsView (ENG-176)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  async function mountView(role: string | undefined, userId = 'u_me'): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    await useWorkspaceStore().load()
    const auth = useAuthStore()
    auth.role = role
    auth.myUserId = userId
    const wrapper = mount(AppsView, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it.each(['member', 'guest', undefined])(
    'role %s sees the no-access state and NO plugin RPC fires',
    async (role) => {
      const wrapper = await mountView(role)

      expect(wrapper.find('[data-testid="apps-no-access"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="apps-bots"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="apps-hooks"]').exists()).toBe(false)
      // The whole surface mints credentials: not a single plugin call is made.
      expect(fake.pluginsBotsListSpy).not.toHaveBeenCalled()
      expect(fake.pluginsHooksListSpy).not.toHaveBeenCalled()
    },
  )

  it('an owner lands on the Bots tab with the how-it-works note and bots loaded', async () => {
    const wrapper = await mountView('owner', 'u_owner')

    expect(wrapper.find('[data-testid="apps-no-access"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="apps-tab-bots"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-testid="apps-bots"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="apps-how-it-works"]').exists()).toBe(true)
    expect(fake.pluginsBotsListSpy).toHaveBeenCalledTimes(1)
    expect(fake.pluginsHooksListSpy).not.toHaveBeenCalled()
  })

  it('an admin also gets the surface (owner OR admin)', async () => {
    const wrapper = await mountView('admin', 'u_admin')
    expect(wrapper.find('[data-testid="apps-bots"]').exists()).toBe(true)
  })

  it('the Incoming-webhooks tab swaps to the hooks panel (and back)', async () => {
    const wrapper = await mountView('owner', 'u_owner')

    await wrapper.get('[data-testid="apps-tab-hooks"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="apps-hooks"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="apps-bots"]').exists()).toBe(false)
    expect(fake.pluginsHooksListSpy).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="apps-tab-bots"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="apps-bots"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="apps-hooks"]').exists()).toBe(false)
  })
})
