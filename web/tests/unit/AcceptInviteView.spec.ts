import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '../../src/stores/auth'
import AcceptInviteView from '../../src/views/AcceptInviteView.vue'

// The view uses useRoute (for the token) and useRouter (go-to-app / submit nav);
// stub both so the component mounts without the full router + its auth guard.
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { token: 'tok_123' } }),
  useRouter: () => ({ push }),
}))

describe('AcceptInviteView (ENG-112: /join handles already-signed-in users)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    push.mockClear()
  })

  it('unauthenticated → renders the create-account form, not the signed-in state', () => {
    const auth = useAuthStore()
    auth.phase = 'anonymous'

    const wrapper = mount(AcceptInviteView)

    expect(wrapper.find('[data-test="submit"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="display-name"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="already-signed-in"]').exists()).toBe(false)
  })

  it('authenticated → hides the create-account form and shows the already-signed-in state', () => {
    const auth = useAuthStore()
    auth.phase = 'authenticated'
    auth.myUserId = 'u_abc123'

    const wrapper = mount(AcceptInviteView)

    // The create-account form is NOT shown.
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="display-name"]').exists()).toBe(false)

    // The "already signed in" state IS shown, with the identity + both actions.
    expect(wrapper.find('[data-test="already-signed-in"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="signed-in-as"]').text()).toBe('u_abc123')
    expect(wrapper.find('[data-test="go-to-app"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="logout"]').exists()).toBe(true)
  })

  it('go-to-app navigates to the app root', async () => {
    const auth = useAuthStore()
    auth.phase = 'authenticated'

    const wrapper = mount(AcceptInviteView)
    await wrapper.get('[data-test="go-to-app"]').trigger('click')

    expect(push).toHaveBeenCalledWith('/')
  })

  it('after logout the create-account form appears for the same /join/:token', async () => {
    const auth = useAuthStore()
    auth.phase = 'authenticated'
    // Stub the store action (avoids the worker); flip phase like the real logout.
    const logoutSpy = vi.spyOn(auth, 'logout').mockImplementation(() => {
      auth.phase = 'anonymous'
      return Promise.resolve()
    })

    const wrapper = mount(AcceptInviteView)
    expect(wrapper.find('[data-test="already-signed-in"]').exists()).toBe(true)

    await wrapper.get('[data-test="logout"]').trigger('click')
    await flushPromises()

    expect(logoutSpy).toHaveBeenCalledOnce()
    // The create-account form is now shown (reactive on auth.phase).
    expect(wrapper.find('[data-test="already-signed-in"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="submit"]').exists()).toBe(true)
  })
})
