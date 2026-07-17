// The desktop onboarding gate in src/router/index.ts (ENG-170, M6-5) — and
// the regression for the post-save redirect loop: once a desktop config
// exists, /onboarding must route AWAY (home → auth gate), never re-present a
// fresh onboarding form. The guard memoizes the first-run probe once per page
// load, so every case re-imports a fresh router module.
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'

const { isTauriMock, needsOnboardingMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn<() => boolean>(),
  needsOnboardingMock: vi.fn<() => Promise<boolean>>(),
}))

vi.mock('../../../src/worker/tauri/detect', () => ({ isTauri: isTauriMock }))
vi.mock('../../../src/worker/tauri/boot', () => ({ needsOnboarding: needsOnboardingMock }))

/**
 * A fresh router module (fresh onboarding memo) with the auth store phase
 * preset so the guard's auth gate never dials the worker.
 */
async function freshRouter(phase: 'anonymous' | 'authenticated'): Promise<Router> {
  vi.resetModules()
  setActivePinia(createPinia())
  const [{ router }, { useAuthStore }] = await Promise.all([
    import('../../../src/router/index'),
    import('../../../src/stores/auth'),
  ])
  useAuthStore().phase = phase
  return router
}

describe('router desktop onboarding gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('desktop first run: every route funnels to /onboarding', async () => {
    isTauriMock.mockReturnValue(true)
    needsOnboardingMock.mockResolvedValue(true)
    const router = await freshRouter('anonymous')

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('onboarding')
  })

  it('desktop with a config: /onboarding routes away to the auth gate (post-save loop regression)', async () => {
    isTauriMock.mockReturnValue(true)
    needsOnboardingMock.mockResolvedValue(false)
    const router = await freshRouter('anonymous')

    // The post-save page load landing back on /onboarding must NOT strand the
    // user on the form: config exists → home → auth gate → login.
    await router.push('/onboarding')

    expect(router.currentRoute.value.name).toBe('login')
  })

  it('desktop with a config, authenticated: /onboarding lands home', async () => {
    isTauriMock.mockReturnValue(true)
    needsOnboardingMock.mockResolvedValue(false)
    const router = await freshRouter('authenticated')

    await router.push('/onboarding')

    expect(router.currentRoute.value.name).toBe('home')
  })

  it('desktop with a config: home proceeds normally', async () => {
    isTauriMock.mockReturnValue(true)
    needsOnboardingMock.mockResolvedValue(false)
    const router = await freshRouter('authenticated')

    await router.push('/')

    expect(router.currentRoute.value.name).toBe('home')
  })

  it('browser: /onboarding is not a destination and the probe never runs', async () => {
    isTauriMock.mockReturnValue(false)
    const router = await freshRouter('authenticated')

    await router.push('/onboarding')

    expect(router.currentRoute.value.name).toBe('home')
    expect(needsOnboardingMock).not.toHaveBeenCalled()
  })
})
