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
    file_ids: [],
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

  // -- ENG-103 thread affordance --------------------------------------------

  it('shows the reply-count + participant avatars on a thread root, and opens on click', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({
          reply_count: 3,
          threadParticipants: [
            { user_id: 'u_a', display_name: 'Ann' },
            { user_id: 'u_b', display_name: 'Bo' },
          ],
        }),
      },
    })

    const affordance = wrapper.get('[data-testid="thread-affordance"]')
    expect(affordance.get('[data-testid="thread-reply-count"]').text()).toBe('3 replies')
    // A participant avatar per participant (capped at 3), initial from the name.
    const avatars = wrapper.findAll('[data-testid="thread-participant"]')
    expect(avatars).toHaveLength(2)
    expect(avatars[0]!.text()).toBe('A')

    await affordance.trigger('click')
    expect(wrapper.emitted('open-thread')?.[0]).toEqual(['m_00000000000000000000000000'])
  })

  it('singularizes a single reply and hides the affordance on a non-root', () => {
    const one = mount(MessageItem, { props: { message: makeMessage({ reply_count: 1 }) } })
    expect(one.get('[data-testid="thread-reply-count"]').text()).toBe('1 reply')

    const none = mount(MessageItem, { props: { message: makeMessage({ reply_count: 0 }) } })
    expect(none.find('[data-testid="thread-affordance"]').exists()).toBe(false)
  })

  it('"Reply in thread" targets the message itself (a non-reply becomes the root)', async () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage() } })
    await wrapper.get('[data-testid="reply-in-thread"]').trigger('click')
    expect(wrapper.emitted('open-thread')?.[0]).toEqual(['m_00000000000000000000000000'])
  })

  it('"Reply in thread" on a reply targets its root (no reply-of-reply)', async () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ thread_root_id: 'm_root' }) },
    })
    await wrapper.get('[data-testid="reply-in-thread"]').trigger('click')
    expect(wrapper.emitted('open-thread')?.[0]).toEqual(['m_root'])
  })

  it('renders a participant display name with an XSS payload as inert text', () => {
    const payload = '<img src=x onerror="window.__pwned=1">Eve'
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({
          reply_count: 1,
          threadParticipants: [{ user_id: 'u_e', display_name: payload }],
        }),
      },
    })
    // The avatar/title carry the name as inert text — never an injected element.
    // (The payload rides an escaped `title` attribute value, which is inert.)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('[data-testid="thread-participant"]').attributes('title')).toBe(payload)
  })

  // -- ENG-136 grouping + display-name resolution ---------------------------

  it('resolves the author name + avatar initial from the names map', () => {
    const names = new Map([['u_other', 'Octavia']])
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ author_user_id: 'u_other' }), names },
    })
    expect(wrapper.get('[data-testid="message-author"]').text()).toBe('Octavia')
    expect(wrapper.get('[data-testid="message-avatar"]').text()).toBe('O')
  })

  it('falls back to the raw author id when the name is absent', () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ author_user_id: 'u_other' }) },
    })
    expect(wrapper.get('[data-testid="message-author"]').text()).toBe('u_other')
    expect(wrapper.get('[data-testid="message-avatar"]').text()).toBe('U')
  })

  it('shows the avatar + header line by default (leading row)', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage() } })
    expect(wrapper.find('[data-testid="message-avatar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="message-author"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="message-time"]').exists()).toBe(true)
  })

  it('hides the avatar + name + time on a GROUPED follow-up but keeps the text', () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ text: 'grouped' }), showHeader: false },
    })
    expect(wrapper.find('[data-testid="message-avatar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-author"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-time"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="message-text"]').text()).toBe('grouped')
  })

  it('indents content behind a 40px avatar gutter on a LEADING row (flex + gap-3)', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage() } })
    const row = wrapper.get('[data-testid="message-row"]')
    // Two-column row: a w-10 gutter + gap-3 → content sits ~52px from the left.
    expect(row.classes()).toContain('flex')
    expect(row.classes()).toContain('gap-3')
    const gutter = row.get('[data-testid="message-gutter"]')
    expect(gutter.classes()).toContain('w-10')
    expect(gutter.classes()).toContain('shrink-0')
    // The round avatar chip (accent-subtle circle) renders inside the gutter.
    const avatar = gutter.get('[data-testid="message-avatar"]')
    expect(avatar.classes()).toContain('rounded-full')
    expect(avatar.classes()).toContain('bg-accent-subtle')
    expect(avatar.classes()).toContain('text-accent')
  })

  it('keeps the (empty) gutter on a GROUPED follow-up so its text aligns under the first', () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ text: 'grouped' }), showHeader: false },
    })
    // Same left indent whether or not the avatar shows: the w-10 gutter stays,
    // it is just empty — so the text is NOT flush-left.
    const gutter = wrapper.get('[data-testid="message-gutter"]')
    expect(gutter.classes()).toContain('w-10')
    expect(gutter.classes()).toContain('shrink-0')
    expect(gutter.find('[data-testid="message-avatar"]').exists()).toBe(false)
  })

  // -- ENG-136 add-reaction ghost pill --------------------------------------

  it('opens the shared EmojiPicker from the add-reaction ghost pill and adds a reaction', async () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({
          reactions: [
            { emoji: '👍', count: 1, user_ids: ['u_x'], display_names: ['X'], mine: false },
          ],
        }),
      },
    })
    // No picker until the ghost pill is clicked.
    expect(wrapper.find('[data-testid="reaction-picker-menu"]').exists()).toBe(false)
    await wrapper.get('[data-testid="add-reaction"]').trigger('click')
    expect(wrapper.find('[data-testid="reaction-picker-menu"]').exists()).toBe(true)
    // Picking an option emits a react (add — the picked emoji is not yet mine).
    const options = wrapper.findAll('[data-testid="reaction-option"]')
    await options[3]!.trigger('click')
    expect(wrapper.emitted('react')?.[0]?.[2]).toBe(false)
  })

  // -- ENG-128 presence dot on the author avatar -----------------------------

  it('renders the author presence dot from a provided presence map', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({ author_user_id: 'u_other' }),
        presence: new Map([['u_other', 'online' as const]]),
      },
    })
    const dot = wrapper.get('[data-testid="presence-dot"]')
    expect(dot.attributes('data-status')).toBe('online')
    expect(dot.classes()).toContain('bg-success')
  })

  it('defaults an author unknown to the presence map to offline', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({ author_user_id: 'u_other' }),
        presence: new Map([['u_someone_else', 'online' as const]]),
      },
    })
    const dot = wrapper.get('[data-testid="presence-dot"]')
    expect(dot.attributes('data-status')).toBe('offline')
    expect(dot.classes()).toContain('bg-muted')
  })

  it('renders NO dot without a presence map (e.g. the thread pane)', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage() } })
    expect(wrapper.find('[data-testid="presence-dot"]').exists()).toBe(false)
  })

  it('renders NO dot on a grouped follow-up row (no avatar to anchor to)', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({ author_user_id: 'u_other' }),
        showHeader: false,
        presence: new Map([['u_other', 'online' as const]]),
      },
    })
    expect(wrapper.find('[data-testid="presence-dot"]').exists()).toBe(false)
  })
})

// -- ENG-152 PR-c: read-only rendering (the Inbox preview pane) ---------------
//
// In the preview, MessageItem's action emits are UNWIRED — rendering the hover
// toolbar / add-reaction / thread affordances would present dead buttons. The
// `readonly` prop suppresses every interactive affordance while the content
// (text, reaction chips as information) still renders.
describe('MessageItem — readonly (preview context)', () => {
  const reacted = () =>
    makeMessage({
      reactions: [
        { emoji: '👍', count: 1, user_ids: ['u_a'], display_names: ['Ann'], mine: false },
      ],
      reply_count: 2,
      threadParticipants: [{ user_id: 'u_a', display_name: 'Ann' }],
    })

  it('renders NO hover toolbar, add-reaction pill, or thread affordance', () => {
    const wrapper = mount(MessageItem, { props: { message: reacted(), readonly: true } })

    expect(wrapper.find('[data-testid="message-toolbar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="add-reaction"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="reply-in-thread"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="thread-affordance"]').exists()).toBe(false)
    // Content still renders: the text and the informational reaction chip.
    expect(wrapper.get('[data-testid="message-text"]').text()).toBe('hello')
    expect(wrapper.get('[data-testid="reaction-chip"]').text()).toContain('👍')
  })

  it('disables reaction-chip toggling in the readonly context', () => {
    const wrapper = mount(MessageItem, { props: { message: reacted(), readonly: true } })
    expect(wrapper.get('[data-testid="reaction-chip"]').attributes('disabled')).toBeDefined()
  })

  it('hides retry/discard on a failed row in the readonly context', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({ state: 'failed', error_code: 'too_long', eventId: 'e1' }),
        readonly: true,
      },
    })
    // The honest failure label stays; the unwired action buttons do not.
    expect(wrapper.get('[data-testid="message-failed"]').text()).toContain('too_long')
    expect(wrapper.find('[data-testid="message-retry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-failed-discard"]').exists()).toBe(false)
  })

  it('keeps every affordance in the default (wired) context', () => {
    const wrapper = mount(MessageItem, { props: { message: reacted() } })
    expect(wrapper.find('[data-testid="message-toolbar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="add-reaction"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="thread-affordance"]').exists()).toBe(true)
  })
})
