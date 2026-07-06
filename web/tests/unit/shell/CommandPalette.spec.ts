import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import CommandPalette, { type QuickItem } from '../../../src/components/shell/CommandPalette.vue'

const ITEMS: QuickItem[] = [
  { id: 's_general', label: 'general', kind: 'channel', unread: 0 },
  { id: 's_random', label: 'random', kind: 'channel', unread: 2 },
  { id: 's_design', label: 'design', kind: 'channel', unread: 0 },
]

describe('CommandPalette', () => {
  it('is hidden until opened', async () => {
    const wrapper = mount(CommandPalette, { props: { open: false, items: ITEMS } })
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(false)

    await wrapper.setProps({ open: true })
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(true)
  })

  it('fuzzy-filters as the user types and Enter navigates to the match', async () => {
    const wrapper = mount(CommandPalette, { props: { open: true, items: ITEMS } })
    const input = wrapper.get('[data-testid="command-palette-input"]')

    await input.setValue('gen')
    const results = wrapper.findAll('[data-testid="command-palette-item"]')
    expect(results).toHaveLength(1)
    expect(results[0]!.text()).toContain('general')

    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')?.[0]).toEqual(['s_general'])
  })

  it('moves the highlight with arrow keys and selects the active row', async () => {
    const wrapper = mount(CommandPalette, { props: { open: true, items: ITEMS } })
    const input = wrapper.get('[data-testid="command-palette-input"]')

    await input.trigger('keydown', { key: 'ArrowDown' }) // → index 1
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')?.[0]).toEqual(['s_random'])
  })

  it('closes on Escape', async () => {
    const wrapper = mount(CommandPalette, { props: { open: true, items: ITEMS } })
    await wrapper.get('[data-testid="command-palette-input"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
