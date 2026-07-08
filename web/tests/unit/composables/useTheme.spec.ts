import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// useTheme keeps module-level singleton state (one preference + one media
// listener shared across callers). To test initialization from localStorage and
// matchMedia, we reset the module registry and re-import per scenario.

// This env's window.localStorage is a bare object with no methods, so install a
// working in-memory Storage before each scenario.
function installLocalStorage(): void {
  const store = new Map<string, string>()
  const mock: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  }
  Object.defineProperty(window, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
}

/** Install a matchMedia stub that reports `matches` for the dark query. */
function stubMatchMedia(matches: boolean): void {
  const impl = (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList
  Object.defineProperty(window, 'matchMedia', { value: impl, configurable: true, writable: true })
}

function removeMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    value: undefined,
    configurable: true,
    writable: true,
  })
}

async function freshUseTheme() {
  vi.resetModules()
  return (await import('../../../src/composables/useTheme')).useTheme
}

async function freshModule() {
  vi.resetModules()
  return await import('../../../src/composables/useTheme')
}

describe('useTheme', () => {
  beforeEach(() => {
    installLocalStorage()
    document.documentElement.removeAttribute('data-theme')
    removeMatchMedia()
  })

  afterEach(() => {
    removeMatchMedia()
  })

  it('defaults to the system preference when nothing is stored', async () => {
    const useTheme = await freshUseTheme()
    const { theme } = useTheme()
    expect(theme.value).toBe('system')
  })

  it('setTheme persists to localStorage and sets data-theme', async () => {
    const useTheme = await freshUseTheme()
    const { setTheme, resolvedTheme } = useTheme()
    setTheme('dark')
    expect(window.localStorage.getItem('msg:theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(resolvedTheme.value).toBe('dark')

    setTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(resolvedTheme.value).toBe('light')
  })

  it('cycleTheme cycles light -> dark -> system -> light', async () => {
    const useTheme = await freshUseTheme()
    const { setTheme, cycleTheme, theme } = useTheme()
    setTheme('light')
    cycleTheme()
    expect(theme.value).toBe('dark')
    cycleTheme()
    expect(theme.value).toBe('system')
    cycleTheme()
    expect(theme.value).toBe('light')
  })

  it("resolves 'system' to dark via matchMedia when the OS prefers dark", async () => {
    stubMatchMedia(true)
    const useTheme = await freshUseTheme()
    const { setTheme, resolvedTheme } = useTheme()
    setTheme('system')
    expect(resolvedTheme.value).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it("resolves 'system' to light when the OS prefers light", async () => {
    stubMatchMedia(false)
    const useTheme = await freshUseTheme()
    const { setTheme, resolvedTheme } = useTheme()
    setTheme('system')
    expect(resolvedTheme.value).toBe('light')
  })

  it('is graceful when matchMedia is absent (resolves system -> light, no throw)', async () => {
    removeMatchMedia()
    const useTheme = await freshUseTheme()
    const { setTheme, resolvedTheme } = useTheme()
    expect(() => setTheme('system')).not.toThrow()
    expect(resolvedTheme.value).toBe('light')
  })

  it('initTheme applies the persisted preference to data-theme on startup', async () => {
    // Persist a dark preference, then a fresh module + initTheme() must apply it to
    // <html> (mirrors main.ts wiring the pre-paint script's value into the store).
    installLocalStorage()
    window.localStorage.setItem('msg:theme', 'dark')
    const { initTheme } = await freshModule()
    expect(document.documentElement.getAttribute('data-theme')).not.toBe('dark')
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('stores are shared across callers (singleton)', async () => {
    const useTheme = await freshUseTheme()
    const a = useTheme()
    const b = useTheme()
    a.setTheme('dark')
    expect(b.theme.value).toBe('dark')
  })
})
