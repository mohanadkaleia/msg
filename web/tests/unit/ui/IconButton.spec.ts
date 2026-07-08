import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import IconButton from '../../../src/components/ui/IconButton.vue'

describe('ui/IconButton', () => {
  it('binds the required `label` prop to the native aria-label and renders an icon slot', () => {
    const wrapper = mount(IconButton, {
      props: { label: 'Close' },
      slots: { default: '<svg data-testid="icon" />' },
    })
    const btn = wrapper.get('button')
    expect(btn.attributes('aria-label')).toBe('Close')
    expect(btn.find('[data-testid="icon"]').exists()).toBe(true)
    expect(btn.attributes('class') ?? '').toContain('focus-visible:ring-accent')
  })

  it('is square with the md size by default', () => {
    const btn = mount(IconButton, { props: { label: 'Menu' } }).get('button')
    expect(btn.classes()).toContain('h-7')
    expect(btn.classes()).toContain('w-7')
  })

  it('throws in dev when `label` is missing/blank', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Vue surfaces the setup throw; assert it is our label guard.
    expect(() => mount(IconButton, { props: { label: '  ' } })).toThrow(/label/)
    spy.mockRestore()
  })
})
