import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import Button from '../../../src/components/ui/Button.vue'

describe('ui/Button', () => {
  it('renders a button with default primary + md classes and slot content', () => {
    const wrapper = mount(Button, { slots: { default: 'Save' } })
    const btn = wrapper.get('button')
    expect(btn.text()).toBe('Save')
    expect(btn.attributes('type')).toBe('button')
    expect(btn.classes()).toContain('bg-accent')
    expect(btn.classes()).toContain('text-accent-fg')
    expect(btn.classes()).toContain('h-8')
  })

  it('applies the ghost variant classes', () => {
    const wrapper = mount(Button, { props: { variant: 'ghost' } })
    const cls = wrapper.get('button').attributes('class') ?? ''
    expect(cls).toContain('bg-transparent')
    expect(cls).toContain('hover:bg-surface-hover')
    expect(cls).not.toContain('bg-accent ')
  })

  it('applies the danger variant classes', () => {
    const wrapper = mount(Button, { props: { variant: 'danger' } })
    const cls = wrapper.get('button').attributes('class') ?? ''
    expect(cls).toContain('border-danger')
    expect(cls).toContain('text-danger')
  })

  it('applies the sm size', () => {
    const wrapper = mount(Button, { props: { size: 'sm' } })
    expect(wrapper.get('button').classes()).toContain('h-7')
  })

  it('carries an accent focus-visible ring', () => {
    const cls = mount(Button).get('button').attributes('class') ?? ''
    expect(cls).toContain('focus-visible:ring-accent')
  })

  it('reflects disabled and passes through the type attr', () => {
    const wrapper = mount(Button, { props: { disabled: true, type: 'submit' } })
    const btn = wrapper.get('button')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('type')).toBe('submit')
  })

  it('passes through aria-* attributes', () => {
    const wrapper = mount(Button, { attrs: { 'aria-pressed': 'true' } })
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true')
  })
})
