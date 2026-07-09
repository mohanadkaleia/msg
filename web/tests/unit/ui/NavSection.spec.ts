import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import NavSection from '../../../src/components/ui/NavSection.vue'

describe('ui/NavSection', () => {
  it('renders an uppercase header (text-secondary — ENG-152 contrast bump) and its items', () => {
    const wrapper = mount(NavSection, {
      props: { title: 'Channels' },
      slots: { default: '<div data-testid="item">general</div>' },
    })
    const header = wrapper.get('button')
    expect(header.text()).toContain('Channels')
    expect(header.classes()).toContain('uppercase')
    // ENG-152 PR-c: section labels bumped from text-muted toward the token
    // hierarchy — readable, still clearly secondary to the items.
    expect(header.classes()).toContain('text-secondary')
    expect(header.classes()).not.toContain('text-muted')
    expect(wrapper.find('[data-testid="item"]').exists()).toBe(true)
  })

  it('collapses and expands the body via the header, tracking aria-expanded', async () => {
    const wrapper = mount(NavSection, {
      props: { title: 'Channels' },
      slots: { default: '<div class="body-item">x</div>' },
    })
    const header = wrapper.get('button')
    expect(header.attributes('aria-expanded')).toBe('true')
    // v-show keeps the node; assert the display style toggles off on collapse.
    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('false')
    const body = wrapper.get('.body-item').element.parentElement as HTMLElement
    expect(body.style.display).toBe('none')
  })

  it('honors defaultOpen=false', () => {
    const wrapper = mount(NavSection, {
      props: { title: 'DMs', defaultOpen: false },
      slots: { default: '<div>x</div>' },
    })
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
  })

  it('renders the action slot', () => {
    const wrapper = mount(NavSection, {
      props: { title: 'Channels' },
      slots: { action: '<button data-testid="add">+</button>' },
    })
    expect(wrapper.find('[data-testid="add"]').exists()).toBe(true)
  })
})
