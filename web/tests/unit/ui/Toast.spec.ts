// tests/unit/shell/Toast.spec.ts — ENG-129 in-app notification toast. Proves the
// card renders its fields via TEXT INTERPOLATION only (XSS teeth: markup in a
// message preview renders inert — no live element), the body click emits
// `select` (the shell's jump), the ✕ emits `dismiss`, and the ~5s auto-dismiss
// timer fires (fake timers).
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Toast from '../../../src/components/ui/Toast.vue'
import type { ToastItem } from '../../../src/stores/notifications'

function makeToast(overrides: Partial<ToastItem> = {}): ToastItem {
  return {
    id: 1,
    stream_id: 's_general',
    title: '# general',
    author: 'Rana',
    preview: 'lunch at noon?',
    ...overrides,
  }
}

describe('Toast (ENG-129)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the stream title, author, and preview', () => {
    const wrapper = mount(Toast, { props: { toast: makeToast() } })
    expect(wrapper.get('[data-testid="notification-toast"]').attributes('data-stream-id')).toBe(
      's_general',
    )
    expect(wrapper.get('[data-testid="toast-title"]').text()).toBe('# general')
    expect(wrapper.get('[data-testid="toast-author"]').text()).toBe('Rana')
    expect(wrapper.get('[data-testid="toast-preview"]').text()).toContain('lunch at noon?')
  })

  it('emits select on a body click and dismiss on the ✕', async () => {
    const wrapper = mount(Toast, { props: { toast: makeToast() } })
    await wrapper.get('[data-testid="toast-body"]').trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)

    await wrapper.get('[data-testid="toast-dismiss"]').trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('auto-dismisses after the duration (and not before)', () => {
    const wrapper = mount(Toast, { props: { toast: makeToast(), duration: 5000 } })
    vi.advanceTimersByTime(4999)
    expect(wrapper.emitted('dismiss')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
  })

  it('clears the timer on unmount (no dismissal after teardown)', () => {
    const wrapper = mount(Toast, { props: { toast: makeToast() } })
    wrapper.unmount()
    vi.advanceTimersByTime(10_000)
    expect(wrapper.emitted('dismiss')).toBeUndefined()
  })

  it('XSS teeth: markup in the preview / title / author renders INERT', () => {
    const wrapper = mount(Toast, {
      props: {
        toast: makeToast({
          title: '<b>#evil</b>',
          author: '<script>window.x=1</script>',
          preview: '<img src=x onerror="window.__pwned=true">',
        }),
      },
    })
    // No live element was created from any field — pure text nodes only.
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
    // The raw markup is still visible as literal text.
    expect(wrapper.get('[data-testid="toast-preview"]').text()).toContain(
      '<img src=x onerror="window.__pwned=true">',
    )
    expect(wrapper.get('[data-testid="toast-title"]').text()).toBe('<b>#evil</b>')
  })
})
