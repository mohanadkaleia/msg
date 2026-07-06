import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import MessageComposer from '../../../src/components/shell/MessageComposer.vue'

describe('MessageComposer', () => {
  it('sends on Enter and clears the field', async () => {
    const wrapper = mount(MessageComposer)
    const input = wrapper.get('[data-testid="composer-input"]')
    await input.setValue('hello team')
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')?.[0]).toEqual(['hello team'])
    expect((input.element as HTMLTextAreaElement).value).toBe('')
  })

  it('inserts a newline (does not send) on Shift+Enter', async () => {
    const wrapper = mount(MessageComposer)
    const input = wrapper.get('[data-testid="composer-input"]')
    await input.setValue('line one')
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('blocks whitespace-only sends and trims the payload', async () => {
    const wrapper = mount(MessageComposer)
    const input = wrapper.get('[data-testid="composer-input"]')

    await input.setValue('   ')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.get('[data-testid="composer-send"]').attributes('disabled')).toBeDefined()

    await input.setValue('  spaced  ')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]).toEqual(['spaced'])
  })

  it('is disabled when the composer is disabled (no writable stream)', () => {
    const wrapper = mount(MessageComposer, { props: { disabled: true } })
    expect(wrapper.get('[data-testid="composer-input"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="composer-send"]').attributes('disabled')).toBeDefined()
  })
})
