// OnboardingView (ENG-170, M6-5) — the desktop first-run screen. On a
// successful save it must full-document-navigate to the app ROOT (never
// reload the /onboarding URL — the redirect-loop bug); on a failed save it
// must surface the error and stay put.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OnboardingView from '../../../src/views/OnboardingView.vue'

const { openMock, writeDesktopConfigMock } = vi.hoisted(() => ({
  openMock: vi.fn<() => Promise<string | null>>(),
  writeDesktopConfigMock: vi.fn<() => Promise<void>>(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }))
vi.mock('../../../src/worker/tauri/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/worker/tauri/config')>()
  return { ...actual, writeDesktopConfig: writeDesktopConfigMock }
})

// jsdom's Location is unmockable (its methods are non-configurable), but the
// vitest global proxy lets the whole `location` property be swapped out.
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')!
let assignMock: ReturnType<typeof vi.fn>

async function fillAndSubmit(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.find('[data-test="server-url"]').setValue('https://msg.example.com/')
  openMock.mockResolvedValue('/home/user/msg-workspace')
  await wrapper.find('[data-test="pick-folder"]').trigger('click')
  await vi.dynamicImportSettled()
  await flushPromises()
  await wrapper.find('form').trigger('submit')
  // onSubmit lazy-imports the config module; wait for the dynamic import
  // (a real vite-node transform, not just a microtask) to settle.
  await vi.dynamicImportSettled()
  await flushPromises()
}

describe('OnboardingView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    assignMock = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { assign: assignMock },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', originalLocation)
  })

  it('persists the normalized config and navigates to the app root', async () => {
    writeDesktopConfigMock.mockResolvedValue(undefined)
    const wrapper = mount(OnboardingView)

    await fillAndSubmit(wrapper)

    expect(writeDesktopConfigMock).toHaveBeenCalledWith({
      serverUrl: 'https://msg.example.com',
      workspaceDir: '/home/user/msg-workspace',
    })
    // The root, NOT a reload of /onboarding — the fresh page must land on
    // home so the guard flows to login (the redirect-loop regression).
    expect(assignMock).toHaveBeenCalledWith(import.meta.env.BASE_URL || '/')
  })

  it('shows the error and does NOT navigate when the write fails', async () => {
    writeDesktopConfigMock.mockRejectedValue(new Error('disk full'))
    const wrapper = mount(OnboardingView)

    await fillAndSubmit(wrapper)

    expect(wrapper.find('[data-test="error"]').text()).toContain('Saving the configuration failed')
    expect(assignMock).not.toHaveBeenCalled()
    // The form stays interactive for a retry.
    expect(wrapper.find('[data-test="submit"]').attributes('disabled')).toBeUndefined()
  })
})
