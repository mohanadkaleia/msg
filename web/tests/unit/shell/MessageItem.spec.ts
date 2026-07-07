import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import MessageItem from '../../../src/components/shell/MessageItem.vue'
import type { DisplayMessage } from '../../../src/stores/messages'

function makeMessage(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    message_id: 'm_00000000000000000000000000',
    stream_id: 's1',
    created_seq: 1,
    author_user_id: 'u_other',
    text: 'hello',
    format: 'plain',
    mention_user_ids: [],
    ts: Date.now(),
    mine: false,
    ...over,
  }
}

describe('MessageItem', () => {
  it('renders other users’ text as escaped plain text, never as DOM (XSS)', () => {
    const payload = '<img src=x onerror="window.__pwned=1"> </script><b>bold</b>'
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ text: payload }) } })

    // The dangerous markup is inert: no injected elements exist.
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    // ...it survives verbatim as text (Vue interpolation escaped it).
    expect(wrapper.find('[data-testid="message-text"]').text()).toBe(payload)
    expect(wrapper.html()).not.toContain('<img')
  })

  it('renders a pending row greyed with a "Sending…" clock', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ state: 'pending' }) } })
    expect(wrapper.get('[data-testid="message-row"]').classes()).toContain('opacity-50')
    expect(wrapper.get('[data-testid="message-time"]').text()).toContain('Sending')
  })

  it('shows retry/delete on a failed row and emits with the message id', async () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ state: 'failed', error_code: 'too_long', eventId: 'e1' }) },
    })

    expect(wrapper.find('[data-testid="message-failed"]').text()).toContain('too_long')
    await wrapper.get('[data-testid="message-retry"]').trigger('click')
    await wrapper.get('[data-testid="message-failed-discard"]').trigger('click')

    expect(wrapper.emitted('retry')?.[0]).toEqual(['m_00000000000000000000000000'])
    expect(wrapper.emitted('discard')?.[0]).toEqual(['m_00000000000000000000000000'])
  })

  it('hides retry/delete when there is no outbox id to act on', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ state: 'failed' }) } })
    expect(wrapper.find('[data-testid="message-retry"]').exists()).toBe(false)
  })

  // -- ENG-102 reactions ----------------------------------------------------

  it('renders aggregated reaction chips (emoji + count + who-reacted names)', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({
          reactions: [
            {
              emoji: '👍',
              count: 2,
              user_ids: ['u_a', 'u_b'],
              display_names: ['Ann', 'Bo'],
              mine: false,
            },
          ],
        }),
      },
    })
    const chip = wrapper.get('[data-testid="reaction-chip"]')
    expect(chip.text()).toContain('👍')
    expect(chip.text()).toContain('2')
    expect(wrapper.get('[data-testid="reaction-tooltip"]').text()).toBe('Ann, Bo')
  })

  it('toggling an ACTIVE (mine) reaction emits a remove; an inactive one emits an add', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({
          reactions: [
            { emoji: '👍', count: 1, user_ids: ['u_me'], display_names: ['Me'], mine: true },
            { emoji: '🎉', count: 1, user_ids: ['u_x'], display_names: ['X'], mine: false },
          ],
        }),
      },
    })
    const chips = wrapper.findAll('[data-testid="reaction-chip"]')
    await chips[0]!.trigger('click') // mine → remove
    await chips[1]!.trigger('click') // not mine → add
    expect(wrapper.emitted('react')?.[0]).toEqual(['m_00000000000000000000000000', '👍', true])
    expect(wrapper.emitted('react')?.[1]).toEqual(['m_00000000000000000000000000', '🎉', false])
  })

  it('renders a reaction emoji / display-name XSS payload inert (opaque bytes)', () => {
    const payload = '<img src=x onerror="window.__pwned=1">'
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({
          reactions: [
            { emoji: payload, count: 1, user_ids: ['u_x'], display_names: [payload], mine: false },
          ],
        }),
      },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('<img')
    // ...and both survive verbatim as escaped text.
    expect(wrapper.get('[data-testid="reaction-chip"]').text()).toContain(payload)
    expect(wrapper.get('[data-testid="reaction-tooltip"]').text()).toBe(payload)
  })

  // -- ENG-102 edit / delete affordance gating ------------------------------

  it('shows edit + delete affordances only on your OWN settled message', () => {
    const own = mount(MessageItem, { props: { message: makeMessage({ mine: true }) } })
    expect(own.find('[data-testid="message-edit"]').exists()).toBe(true)
    expect(own.find('[data-testid="message-delete"]').exists()).toBe(true)

    const other = mount(MessageItem, { props: { message: makeMessage({ mine: false }) } })
    expect(other.find('[data-testid="message-edit"]').exists()).toBe(false)
    expect(other.find('[data-testid="message-delete"]').exists()).toBe(false)
  })

  it('renders an "edited" marker when edited_seq is set', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ edited_seq: 9 }) } })
    expect(wrapper.find('[data-testid="edited-marker"]').exists()).toBe(true)
  })

  it('inline edit seeds the draft with the current text and emits edit-submit', async () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ mine: true, text: 'original' }), editing: true },
    })
    const input = wrapper.get('[data-testid="message-edit-input"]')
    expect((input.element as HTMLTextAreaElement).value).toBe('original')
    await input.setValue('edited text')
    await wrapper.get('[data-testid="message-edit-save"]').trigger('click')
    expect(wrapper.emitted('edit-submit')?.[0]).toEqual([
      'm_00000000000000000000000000',
      'edited text',
    ])
  })

  it('delete asks for confirmation with HONEST (soft-delete) wording, then emits', async () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ mine: true }) } })
    await wrapper.get('[data-testid="message-delete"]').trigger('click')
    const confirm = wrapper.get('[data-testid="message-delete-confirm"]')
    // Honest labeling (ENG-111): removed for everyone, NOT a permanent erasure.
    expect(confirm.text()).toContain('It will be removed for everyone.')
    expect(confirm.text().toLowerCase()).not.toContain('permanent')
    expect(confirm.text().toLowerCase()).not.toContain('forever')
    await wrapper.get('[data-testid="message-delete-confirm-yes"]').trigger('click')
    expect(wrapper.emitted('delete')?.[0]).toEqual(['m_00000000000000000000000000'])
  })

  it('renders a deleted message as a muted tombstone with no content', () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ deleted: true, text: '' }) },
    })
    expect(wrapper.get('[data-testid="message-tombstone"]').text()).toBe('message deleted')
    expect(wrapper.find('[data-testid="message-text"]').exists()).toBe(false)
    // No affordances on a tombstone.
    expect(wrapper.find('[data-testid="message-edit"]').exists()).toBe(false)
  })
})
