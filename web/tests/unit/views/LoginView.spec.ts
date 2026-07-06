import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../../src/stores/auth'
import LoginView from '../../../src/views/LoginView.vue'

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { template: '<div />' } },
      { path: '/login', name: 'login', component: LoginView },
    ],
  })
}

async function mountLogin(): Promise<{
  wrapper: ReturnType<typeof mount>
  login: ReturnType<typeof vi.fn>
}> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useAuthStore()
  const login = vi.spyOn(store, 'login') as unknown as ReturnType<typeof vi.fn>

  const router = makeRouter()
  await router.push('/login')
  await router.isReady()

  const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } })
  return { wrapper, login }
}

async function fillValid(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.find('[data-test="email"]').setValue('user@example.com')
  await wrapper.find('[data-test="password"]').setValue('password1234')
}

describe('LoginView', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('submits the typed email + password to the store login action', async () => {
    const { wrapper, login } = await mountLogin()
    login.mockResolvedValue({ ok: true })

    await fillValid(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(login).toHaveBeenCalledWith({ email: 'user@example.com', password: 'password1234' })
  })

  it('renders the mapped error message when login fails', async () => {
    const { wrapper, login } = await mountLogin()
    login.mockResolvedValue({ ok: false, message: 'Incorrect email or password.' })

    await fillValid(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[data-test="error"]').text()).toContain('Incorrect email or password.')
  })

  it('disables the submit button while the request is in flight', async () => {
    const { wrapper, login } = await mountLogin()
    let resolveLogin!: (v: { ok: boolean; message?: string }) => void
    login.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve
      }),
    )

    await fillValid(wrapper)
    await wrapper.find('form').trigger('submit')
    await nextTick()

    const button = wrapper.find('[data-test="submit"]')
    expect(button.attributes('disabled')).toBeDefined()

    resolveLogin({ ok: true })
    await flushPromises()
  })

  it('keeps submit disabled until the form is valid', async () => {
    const { wrapper } = await mountLogin()

    // Empty form → disabled.
    expect(wrapper.find('[data-test="submit"]').attributes('disabled')).toBeDefined()

    // A too-short password keeps it disabled...
    await wrapper.find('[data-test="email"]').setValue('user@example.com')
    await wrapper.find('[data-test="password"]').setValue('short')
    expect(wrapper.find('[data-test="submit"]').attributes('disabled')).toBeDefined()

    // ...a valid password enables it.
    await wrapper.find('[data-test="password"]').setValue('password1234')
    expect(wrapper.find('[data-test="submit"]').attributes('disabled')).toBeUndefined()
  })
})
