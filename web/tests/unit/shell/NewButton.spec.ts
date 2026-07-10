// tests/unit/shell/NewButton.spec.ts — ENG-152 "+ New" create action, restyled
// COMPACT in the sidebar restructure (a small ghost control, not a full-width
// accent hero). It toggles a small menu of the REAL create flows (New message /
// New channel — the parent wires them to the EXISTING dialogs); each item
// emits + closes; Escape and outside clicks close. "Invite people" is
// deliberately absent — no web invite-creation seam exists.
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import NewButton from '../../../src/components/shell/NewButton.vue'

function mountButton(): ReturnType<typeof mount> {
  return mount(NewButton, { attachTo: document.body })
}

describe('NewButton (ENG-152)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders a compact secondary button and no menu until opened', () => {
    const wrapper = mountButton()
    const button = wrapper.get('[data-testid="new-button"]')
    expect(button.text()).toContain('New')
    // Compact + restrained (restructure): the ghost variant with a subtle
    // border — NOT the old full-width accent hero.
    expect(button.classes()).not.toContain('bg-accent')
    expect(button.classes()).not.toContain('w-full')
    expect(button.classes()).toContain('bg-transparent')
    expect(button.classes()).toContain('border-subtle')
    expect(button.attributes('aria-haspopup')).toBe('menu')
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })

  it('opens the menu listing the REAL create actions (no invite stub)', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="new-button"]').trigger('click')

    const menu = wrapper.get('[data-testid="new-menu"]')
    expect(wrapper.get('[data-testid="new-button"]').attributes('aria-expanded')).toBe('true')
    expect(menu.get('[data-testid="new-menu-dm"]').text()).toContain('New message')
    expect(menu.get('[data-testid="new-menu-channel"]').text()).toContain('New channel')
    // No invite item — there is no web invite-creation flow to wire.
    expect(menu.text()).not.toContain('Invite')
  })

  it('"New channel" emits newChannel (the create-channel path) and closes', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="new-button"]').trigger('click')
    await wrapper.get('[data-testid="new-menu-channel"]').trigger('click')

    expect(wrapper.emitted('newChannel')).toHaveLength(1)
    expect(wrapper.emitted('newDm')).toBeUndefined()
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })

  it('"New message" emits newDm (the new-DM path) and closes', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="new-button"]').trigger('click')
    await wrapper.get('[data-testid="new-menu-dm"]').trigger('click')

    expect(wrapper.emitted('newDm')).toHaveLength(1)
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })

  it('closes on Escape and on an outside click', async () => {
    const wrapper = mountButton()
    await wrapper.get('[data-testid="new-button"]').trigger('click')
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)

    await wrapper.get('[data-testid="new-button"]').trigger('click')
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(true)
    document.body.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(false)
  })
})
