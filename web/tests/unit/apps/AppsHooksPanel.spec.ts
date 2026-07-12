// tests/unit/apps/AppsHooksPanel.spec.ts — ENG-176. The Incoming-webhooks panel
// over a fake `client.plugins.hooks.*`: hooks render (name, resolved target
// channel), Create webhook POSTs {stream_id, name} and shows the capability URL
// ONCE in a copyable field (clipboard mocked), Revoke is confirm-gated, and a
// coded failure (forbidden/validation) surfaces inline without leaving the form.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AppsHooksPanel from '../../../src/components/apps/AppsHooksPanel.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from '../shell/fakeWorker'

import type { PluginHook } from '../../../src/worker'

function hook(over: Partial<PluginHook> & { id: string }): PluginHook {
  return {
    stream_id: 's_general',
    bot_user_id: 'b_1',
    name: 'GitHub notifier',
    created_by: 'u_owner',
    created_at: '2026-07-01T00:00:00Z',
    disabled: false,
    ...over,
  }
}

describe('AppsHooksPanel (ENG-176)', () => {
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

  async function mountPanel(): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    await useWorkspaceStore().load()
    const wrapper = mount(AppsHooksPanel, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it('lists webhooks with the resolved target channel', async () => {
    fake.setPluginHooks([hook({ id: 'h1', name: 'GitHub notifier', stream_id: 's_general' })])
    const wrapper = await mountPanel()

    expect(fake.pluginsHooksListSpy).toHaveBeenCalledTimes(1)
    const rows = wrapper.findAll('[data-testid="hook-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.get('[data-testid="hook-name"]').text()).toBe('GitHub notifier')
    expect(rows[0]!.get('[data-testid="hook-channel"]').text()).toContain('general')
  })

  it('shows the empty state when there are no webhooks', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="apps-hooks-empty"]').exists()).toBe(true)
  })

  it('Create POSTs {stream_id, name} and shows the capability URL ONCE', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fake.createdHookUrl = 'https://msg.example/hooks/raw-hook-token-1'
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="create-hook"]').trigger('click')
    ;(wrapper.get('[data-testid="create-hook-name"]').element as HTMLInputElement).value = 'CI hook'
    await wrapper.get('[data-testid="create-hook-name"]').trigger('input')
    // The channel select defaults to the first channel (s_general).
    await wrapper.get('[data-testid="create-hook-submit"]').trigger('click')
    await flushPromises()

    expect(fake.pluginsHookCreateSpy).toHaveBeenCalledWith({
      stream_id: 's_general',
      name: 'CI hook',
    })
    const field = wrapper.get('[data-testid="hook-url"]').element as HTMLInputElement
    expect(field.value).toBe('https://msg.example/hooks/raw-hook-token-1')
    expect(field.readOnly).toBe(true)
    expect(wrapper.get('[data-testid="hook-url-note"]').text()).toContain("won't be shown again")

    await wrapper.get('[data-testid="hook-url-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('https://msg.example/hooks/raw-hook-token-1')

    // Done discards the URL forever — the card is gone.
    await wrapper.get('[data-testid="hook-url-done"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="hook-url"]').exists()).toBe(false)
  })

  it('Create surfaces a coded forbidden error inline without leaving the form', async () => {
    const wrapper = await mountPanel()
    fake.failNextPluginsHookCreate('forbidden')

    await wrapper.get('[data-testid="create-hook"]').trigger('click')
    ;(wrapper.get('[data-testid="create-hook-name"]').element as HTMLInputElement).value = 'x'
    await wrapper.get('[data-testid="create-hook-name"]').trigger('input')
    await wrapper.get('[data-testid="create-hook-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="create-hook-error"]').exists()).toBe(true)
    // No capability URL was shown, and the form stays open.
    expect(wrapper.find('[data-testid="hook-url"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="create-hook-card"]').exists()).toBe(true)
  })

  it('Revoke is confirm-gated and calls hooks.revoke', async () => {
    fake.setPluginHooks([hook({ id: 'h1' })])
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="hook-revoke"]').trigger('click')
    expect(fake.pluginsHookRevokeSpy).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="hook-revoke-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(fake.pluginsHookRevokeSpy).toHaveBeenCalledWith({ id: 'h1' })
    expect(wrapper.findAll('[data-testid="hook-row"]')).toHaveLength(0)
  })
})
