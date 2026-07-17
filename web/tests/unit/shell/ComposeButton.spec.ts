// tests/unit/shell/ComposeButton.spec.ts — the sidebar create control,
// relocated (user feedback) from the standalone "+ New" ghost button to a
// SMALL compose icon next to the Inbox row. It toggles the same small menu of
// the REAL create flows (New message / New channel — the parent wires them to
// the EXISTING dialogs); each item emits + closes; Escape and outside clicks
// close. The menu test-ids (`new-menu`, `new-menu-dm`, `new-menu-channel`)
// are PRESERVED from the old NewButton. "Invite people" is deliberately
// absent — no web invite-creation seam exists.
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import ComposeButton from '../../../src/components/shell/ComposeButton.vue'

function mountButton(): ReturnType<typeof mount> {
  return mount(ComposeButton, { attachTo: document.body })
}

describe('ComposeButton (Inbox compose control)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders a small labeled icon-only trigger and no menu until opened', () => {
    const wrapper = mountButton()
    const button = wrapper.get('[data-testid="inbox-compose"]')
    // Icon-only (a compose glyph, no "New" text) with a REQUIRED accessible name.
    expect(button.text()).toBe('')
    expect(button.find('svg.lucide-square-pen-icon, svg.lucide-square-pen').exists()).toBe(true)
    expect(button.attributes('aria-label')).toBe('New message or channel')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    // The old standalone "+ New" trigger is gone.
    expect(wrapper.find('[data-testid="new-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })

  it('opens the menu listing the REAL create actions (no invite stub)', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="inbox-compose"]').trigger('click')

    const menu = wrapper.get('[data-testid="new-menu"]')
    expect(wrapper.get('[data-testid="inbox-compose"]').attributes('aria-expanded')).toBe('true')
    expect(menu.get('[data-testid="new-menu-dm"]').text()).toContain('New message')
    expect(menu.get('[data-testid="new-menu-channel"]').text()).toContain('New channel')
    // No invite item — there is no web invite-creation flow to wire.
    expect(menu.text()).not.toContain('Invite')
  })

  it('"New channel" emits newChannel (the create-channel path) and closes', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="inbox-compose"]').trigger('click')
    await wrapper.get('[data-testid="new-menu-channel"]').trigger('click')

    expect(wrapper.emitted('newChannel')).toHaveLength(1)
    expect(wrapper.emitted('newDm')).toBeUndefined()
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })

  it('"New message" emits newDm (the new-DM path) and closes', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="inbox-compose"]').trigger('click')
    await wrapper.get('[data-testid="new-menu-dm"]').trigger('click')

    expect(wrapper.emitted('newDm')).toHaveLength(1)
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })

  it('closes on Escape and on an outside click', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="inbox-compose"]').trigger('click')
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)

    await wrapper.get('[data-testid="inbox-compose"]').trigger('click')
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(true)
    document.body.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })
})
