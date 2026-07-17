// tests/unit/apps/AppsBotsPanel.spec.ts — ENG-176. The Bots panel over a fake
// `client.plugins.bots.*`: bots render (name, active-token scope summary,
// channel grant chips), Create bot POSTs the chosen scopes + channels, Mint
// shows the RAW token ONCE in a copyable field (clipboard mocked) and discards
// it on Done, Revoke is confirm-gated, a channel Grant calls grantStream, and a
// coded failure (validation/forbidden) surfaces inline without leaving the form.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AppsBotsPanel from '../../../src/components/apps/AppsBotsPanel.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from '../shell/fakeWorker'

import type { PluginBot } from '../../../src/worker'

function bot(over: Partial<PluginBot> & { bot_user_id: string; name: string }): PluginBot {
  return {
    device_id: `d_${over.bot_user_id}`,
    role: 'guest',
    deactivated: false,
    stream_ids: [],
    tokens: [],
    ...over,
  }
}

describe('AppsBotsPanel (ENG-176)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    fake.addStream({ stream_id: 's_ops', name: 'ops', kind: 'channel' })
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  async function mountPanel(): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    // The channel pickers read the ALREADY-LOADED sidebar projection.
    await useWorkspaceStore().load()
    const wrapper = mount(AppsBotsPanel, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  it('lists bots with the active-token scope summary and grant chips', async () => {
    fake.setPluginBots([
      bot({
        bot_user_id: 'b_1',
        name: 'Deploy notifier',
        stream_ids: ['s_general'],
        tokens: [
          {
            id: 'sha1',
            scopes: ['events:write'],
            created_at: '2026-07-01T00:00:00Z',
            last_used_at: null,
            revoked: false,
          },
        ],
      }),
    ])
    const wrapper = await mountPanel()

    expect(fake.pluginsBotsListSpy).toHaveBeenCalledTimes(1)
    const rows = wrapper.findAll('[data-testid="bot-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.get('[data-testid="bot-name"]').text()).toBe('Deploy notifier')
    expect(rows[0]!.get('[data-testid="bot-scopes"]').text()).toContain('events:write')
    // The granted channel renders by its resolved name (from the projection).
    expect(rows[0]!.get('[data-testid="bot-channel"]').text()).toContain('general')
  })

  it('shows the empty state when there are no bots', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="apps-bots-empty"]').exists()).toBe(true)
  })

  it('Create bot POSTs the chosen scopes (sorted) + channels, then refetches', async () => {
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="create-bot"]').trigger('click')
    ;(wrapper.get('[data-testid="create-bot-name"]').element as HTMLInputElement).value = 'CI bot'
    await wrapper.get('[data-testid="create-bot-name"]').trigger('input')

    // Default scope is events:write; add events:read and pick the ops channel.
    const readScope = wrapper
      .findAll('[data-testid="create-bot-scope"]')
      .find((n) => n.attributes('data-scope') === 'events:read')!
    await readScope.trigger('change')
    const opsChannel = wrapper
      .findAll('[data-testid="create-bot-channel"]')
      .find((n) => n.attributes('data-stream-id') === 's_ops')!
    await opsChannel.trigger('change')

    await wrapper.get('[data-testid="create-bot-submit"]').trigger('click')
    await flushPromises()

    expect(fake.pluginsBotCreateSpy).toHaveBeenCalledTimes(1)
    expect(fake.pluginsBotCreateSpy.mock.calls[0]![0]).toEqual({
      name: 'CI bot',
      scopes: ['events:read', 'events:write'], // sorted
      stream_ids: ['s_ops'],
    })
    // The list refetched (load again after create).
    expect(fake.pluginsBotsListSpy).toHaveBeenCalledTimes(2)
    // The form closed on success.
    expect(wrapper.find('[data-testid="create-bot-card"]').exists()).toBe(false)
  })

  it('Create surfaces a coded validation error inline without leaving the form', async () => {
    const wrapper = await mountPanel()
    fake.failNextPluginsBotCreate('validation-error')

    await wrapper.get('[data-testid="create-bot"]').trigger('click')
    ;(wrapper.get('[data-testid="create-bot-name"]').element as HTMLInputElement).value = 'x'
    await wrapper.get('[data-testid="create-bot-name"]').trigger('input')
    await wrapper.get('[data-testid="create-bot-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="create-bot-error"]').exists()).toBe(true)
    // The form stays open so the operator can correct + retry.
    expect(wrapper.find('[data-testid="create-bot-card"]').exists()).toBe(true)
  })

  it('Mint shows the RAW token ONCE in a copyable field, then discards it on Done', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fake.setPluginBots([bot({ bot_user_id: 'b_1', name: 'Deploy notifier' })])
    fake.mintedBotToken = 'xoxb-raw-fake-token-1'
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="mint-token"]').trigger('click')
    await flushPromises()

    expect(fake.pluginsMintTokenSpy).toHaveBeenCalledWith({ bot_user_id: 'b_1' })
    const field = wrapper.get('[data-testid="bot-token"]').element as HTMLInputElement
    expect(field.value).toBe('xoxb-raw-fake-token-1')
    expect(field.readOnly).toBe(true)
    expect(wrapper.get('[data-testid="bot-token-note"]').text()).toContain("won't be shown again")

    // Copy writes exactly the raw token to the clipboard.
    await wrapper.get('[data-testid="bot-token-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('xoxb-raw-fake-token-1')

    // Done discards the token forever — the card is gone.
    await wrapper.get('[data-testid="bot-token-done"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="bot-token-card"]').exists()).toBe(false)
  })

  it('Revoke a token is confirm-gated and calls revokeToken', async () => {
    fake.setPluginBots([
      bot({
        bot_user_id: 'b_1',
        name: 'Deploy notifier',
        tokens: [
          {
            id: 'sha1',
            scopes: ['events:write'],
            created_at: '2026-07-01T00:00:00Z',
            last_used_at: null,
            revoked: false,
          },
        ],
      }),
    ])
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="bot-token-revoke"]').trigger('click')
    // Nothing fires until the confirm is accepted.
    expect(fake.pluginsRevokeTokenSpy).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="bot-token-revoke-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(fake.pluginsRevokeTokenSpy).toHaveBeenCalledWith({
      bot_user_id: 'b_1',
      token_id: 'sha1',
    })
  })

  it('grants a channel to a bot via the picker', async () => {
    fake.setPluginBots([bot({ bot_user_id: 'b_1', name: 'Deploy notifier', stream_ids: [] })])
    const wrapper = await mountPanel()

    const select = wrapper.get('[data-testid="bot-grant-select"]')
    await select.setValue('s_general')
    await wrapper.get('[data-testid="bot-grant-add"]').trigger('click')
    await flushPromises()

    expect(fake.pluginsGrantStreamSpy).toHaveBeenCalledWith({
      bot_user_id: 'b_1',
      stream_id: 's_general',
    })
  })
})
