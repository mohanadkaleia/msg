import { flushPromises, mount } from '@vue/test-utils'
import type { JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MessageComposer from '../../../src/components/shell/MessageComposer.vue'
import type { MentionItem } from '../../../src/components/shell/composer/mentions'

/** A minimal KeyboardEvent stub the editor's `handleKeyDown` accepts. */
function keyEvent(key: string, shiftKey = false): KeyboardEvent {
  return { key, shiftKey, isComposing: false, preventDefault: vi.fn() } as unknown as KeyboardEvent
}

/** Mount the composer and wait for the async TipTap editor to be created. */
async function mountComposer(props: Record<string, unknown> = {}) {
  const wrapper = mount(MessageComposer, { props, attachTo: document.body })
  await flushPromises()
  return wrapper
}

/** The exposed test surface (editor instance + imperative hooks). */
interface ComposerVm {
  editor: {
    commands: { setContent: (c: JSONContent, emit?: boolean) => void; clearContent: () => void }
    isEmpty: boolean
  }
  submit: () => void
  handleKeyDown: (e: KeyboardEvent) => boolean
}

const vmOf = (wrapper: ReturnType<typeof mount>): ComposerVm => wrapper.vm as unknown as ComposerVm

const doc = (content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const paragraph = (content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })

describe('MessageComposer (TipTap, ENG-101)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('sends markdown source text + empty mentions on Enter, then clears', async () => {
    const wrapper = await mountComposer()
    const vm = vmOf(wrapper)

    // Type "hi **bold**" as rendered rich text (a bold mark, not literal asterisks).
    vm.editor.commands.setContent(
      doc([
        paragraph([
          { type: 'text', text: 'hi ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        ]),
      ]),
    )
    await flushPromises()

    expect(vm.handleKeyDown(keyEvent('Enter'))).toBe(true)

    // Serialized BACK to markdown source — the same shape the M2 textarea produced.
    expect(wrapper.emitted('send')?.[0]).toEqual(['hi **bold**', []])
    // Field cleared after send (M2 parity).
    expect(vm.editor.isEmpty).toBe(true)
  })

  it('resolves @mention chips to user ids in the sent mentions[]', async () => {
    const items: MentionItem[] = [{ id: 'u_dana', label: 'Dana', kind: 'user' }]
    const wrapper = await mountComposer({ mentionItems: items })
    const vm = vmOf(wrapper)

    vm.editor.commands.setContent(
      doc([
        paragraph([
          { type: 'text', text: 'hey ' },
          { type: 'mention', attrs: { id: 'u_dana', label: 'Dana' } },
          { type: 'text', text: ' ping' },
        ]),
      ]),
    )
    await flushPromises()
    vm.submit()

    const [text, mentions] = wrapper.emitted('send')?.[0] as [string, string[]]
    expect(text).toBe('hey @Dana ping')
    expect(mentions).toEqual(['u_dana'])
  })

  it('inserts a newline (does not send) on Shift+Enter', async () => {
    const wrapper = await mountComposer()
    const vm = vmOf(wrapper)
    vm.editor.commands.setContent(doc([paragraph([{ type: 'text', text: 'line one' }])]))
    await flushPromises()

    // Shift+Enter is NOT handled here — it falls through to TipTap's hard break.
    expect(vm.handleKeyDown(keyEvent('Enter', true))).toBe(false)
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('blocks whitespace-only / empty sends and disables the button', async () => {
    const wrapper = await mountComposer()
    const vm = vmOf(wrapper)

    // Empty composer: Enter emits nothing, the send button is disabled.
    vm.handleKeyDown(keyEvent('Enter'))
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.get('[data-testid="composer-send"]').attributes('disabled')).toBeDefined()

    // Whitespace-only content is likewise blocked by submit().
    vm.editor.commands.setContent(doc([paragraph([{ type: 'text', text: '   ' }])]))
    await flushPromises()
    vm.submit()
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('emits edit-last on ArrowUp only when empty (ENG-102 seam)', async () => {
    const wrapper = await mountComposer()
    const vm = vmOf(wrapper)

    // Empty → ArrowUp requests editing the last message.
    expect(vm.handleKeyDown(keyEvent('ArrowUp'))).toBe(true)
    expect(wrapper.emitted('edit-last')).toHaveLength(1)

    // Non-empty → ArrowUp is a normal cursor move (not consumed, no emit).
    vm.editor.commands.setContent(doc([paragraph([{ type: 'text', text: 'draft' }])]))
    await flushPromises()
    expect(vm.handleKeyDown(keyEvent('ArrowUp'))).toBe(false)
    expect(wrapper.emitted('edit-last')).toHaveLength(1)
  })

  it('is disabled when no writable stream is selected', async () => {
    const wrapper = await mountComposer({ disabled: true })
    expect(wrapper.get('[data-testid="composer-send"]').attributes('disabled')).toBeDefined()
  })
})
