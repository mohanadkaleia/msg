// tests/unit/ui/UserPopover.spec.ts — ENG-152 interactive-avatar wrapper. Hovering
// a wrapped avatar/name opens the hovercard after a short delay; clicking (with a
// shell-provided opener injected) opens the user-details drawer; the `interactive`
// opt-out renders the slot bare with no affordance. Store access is pinia-guarded,
// so an empty directory simply falls back to a name-only card (no throw).
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import UserPopover from '../../../src/components/ui/UserPopover.vue'
import { provideOpenUserDetails } from '../../../src/composables/useUserDetails'

/** A harness that PROVIDES an opener (as the shell does) then renders UserPopover. */
function harness(props: Record<string, unknown>, open?: (id: string) => void) {
  return defineComponent({
    setup() {
      if (open) provideOpenUserDetails(open)
      return () =>
        h(UserPopover, props, { default: () => h('span', { 'data-testid': 'slot-child' }, 'Ana') })
    },
  })
}

function card(): Element | null {
  return document.body.querySelector('[data-testid="user-hovercard"]')
}

describe('UserPopover (ENG-152)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('opens the hovercard after the hover delay and closes on leave', async () => {
    const wrapper = mount(harness({ userId: 'u_ana', name: 'Ana' }), { attachTo: document.body })
    const trigger = wrapper.get('[data-testid="open-user-details"]')

    await trigger.trigger('mouseenter')
    expect(card()).toBeNull() // not until the delay elapses
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(card()).not.toBeNull()
    expect(card()?.textContent).toContain('Ana')

    await trigger.trigger('mouseleave')
    expect(card()).toBeNull()
  })

  it('opens the user-details drawer on click via the injected opener', async () => {
    const open = vi.fn()
    const wrapper = mount(harness({ userId: 'u_ana', name: 'Ana' }, open), {
      attachTo: document.body,
    })
    await wrapper.get('[data-testid="open-user-details"]').trigger('click')
    expect(open).toHaveBeenCalledWith('u_ana')
  })

  it('opens the drawer on Enter (keyboard-accessible)', async () => {
    const open = vi.fn()
    const wrapper = mount(harness({ userId: 'u_ana', name: 'Ana' }, open), {
      attachTo: document.body,
    })
    await wrapper.get('[data-testid="open-user-details"]').trigger('keydown', { key: 'Enter' })
    expect(open).toHaveBeenCalledWith('u_ana')
  })

  it('opt-out (interactive=false) renders the slot bare — no affordance, no hovercard', async () => {
    const wrapper = mount(harness({ userId: 'u_ana', name: 'Ana', interactive: false }), {
      attachTo: document.body,
    })
    expect(wrapper.find('[data-testid="open-user-details"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="slot-child"]').exists()).toBe(true)

    // mouseenter on the (bare) wrapper root is inert when opted out.
    await wrapper.trigger('mouseenter')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(card()).toBeNull()
  })

  it('clickable=false keeps hover-preview but never opens the drawer', async () => {
    const open = vi.fn()
    const wrapper = mount(harness({ userId: 'u_ana', name: 'Ana', clickable: false }, open), {
      attachTo: document.body,
    })
    // No click affordance testid (a row click stays the item-select action).
    expect(wrapper.find('[data-testid="open-user-details"]').exists()).toBe(false)

    // Hover still previews.
    await wrapper.trigger('mouseenter')
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(card()).not.toBeNull()

    await wrapper.trigger('click')
    expect(open).not.toHaveBeenCalled()
  })
})
