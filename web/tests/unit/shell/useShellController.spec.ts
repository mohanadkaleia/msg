// tests/unit/shell/useShellController.spec.ts — ENG-136 "Ranin" (PR-B). The shell
// controller is the behavior-preserving extraction of ShellView's cross-store
// wiring; both ShellView (PR-B) and AppShell (PR-C) consume it. This proves the
// contract: stream selection loads messages + shows the conversation view, the
// scaffold `activeView` flips the main panel, Cmd+K opens the palette, the palette
// selects + closes, threads open/close, and Admin is role-gated — all via stores,
// never HTTP (the FakeWorker's fetch spy stays untouched).
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useShellController } from '../../../src/composables/useShellController'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useAuthStore } from '../../../src/stores/auth'
import { useThreadStore } from '../../../src/stores/thread'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

type Controller = ReturnType<typeof useShellController>

const Blank = { template: '<div />' }

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/login', component: Blank },
    ],
  })
}

/** Mount a harness that exposes the live controller as `vm.ctrl`. */
async function mountController(router: Router): Promise<{
  wrapper: ReturnType<typeof mount>
  ctrl: Controller
}> {
  const Harness = defineComponent({
    setup() {
      const ctrl = useShellController()
      return { ctrl }
    },
    template: '<div />',
  })
  const wrapper = mount(Harness, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, ctrl: (wrapper.vm as unknown as { ctrl: Controller }).ctrl }
}

describe('useShellController (ENG-136 PR-B)', () => {
  let fake: FakeWorker
  let router: Router

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    router = makeRouter()
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('default-selects the first channel and shows the conversation view', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addStream({ stream_id: 's_b', name: 'bravo', kind: 'channel' })
    setWorkerClient(fake.client)

    const { ctrl } = await mountController(router)

    expect(ctrl.selectedStreamId.value).toBe('s_a')
    expect(ctrl.activeView.value).toBe('conversation')
    expect(ctrl.mainTitle.value).toBe('# alpha')
    const quickIds = (ctrl.quickItems.value as Array<{ id: string }>).map((i) => i.id)
    expect(quickIds).toEqual(['s_a', 's_b'])
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('flips the main panel to a scaffold view and back', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.setActiveView('apps')
    expect(ctrl.activeView.value).toBe('apps')
    expect(ctrl.scaffold.value?.title).toBe('Apps')
    expect(ctrl.mainTitle.value).toBe('Apps')

    // Selecting a real stream returns to the conversation timeline.
    ctrl.onPaletteSelect('s_a')
    await flushPromises()
    expect(ctrl.activeView.value).toBe('conversation')
    expect(ctrl.paletteOpen.value).toBe(false)
    expect(ctrl.scaffold.value).toBeNull()
  })

  it('opens the palette on Cmd+K', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    expect(ctrl.paletteOpen.value).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    expect(ctrl.paletteOpen.value).toBe(true)
  })

  it('opens a thread and closes it when the stream changes', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addStream({ stream_id: 's_b', name: 'bravo', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.onOpenThread(root.message_id)
    await flushPromises()
    expect(ctrl.threadOpen.value).toBe(true)

    // Switching streams closes the pane (a thread belongs to one stream).
    ctrl.onPaletteSelect('s_b')
    await flushPromises()
    expect(ctrl.threadOpen.value).toBe(false)
  })

  it('opens a stream from the Inbox: selects it + returns to the conversation', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.setActiveView('inbox')
    // Inbox is a REAL view now (ENG-136) — no scaffold copy; its own header titles it.
    expect(ctrl.scaffold.value).toBeNull()
    expect(ctrl.mainTitle.value).toBe('Inbox')

    // Re-opening the ALREADY-selected stream must still leave the Inbox (the
    // selection watch only fires on a changed id).
    expect(ctrl.selectedStreamId.value).toBe('s_a')
    ctrl.onOpenStream('s_a')
    await flushPromises()
    expect(ctrl.activeView.value).toBe('conversation')
    expect(ctrl.selectedStreamId.value).toBe('s_a')
  })

  it('closes an open thread when navigating to a scaffold view (PR-B review #4)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.onOpenThread(root.message_id)
    await flushPromises()
    expect(ctrl.threadOpen.value).toBe(true)

    // Flipping to a scaffold placeholder closes the drawer so it doesn't dock beside it.
    ctrl.setActiveView('inbox')
    await flushPromises()
    expect(ctrl.threadOpen.value).toBe(false)
    expect(ctrl.activeView.value).toBe('inbox')
  })

  it('toggles the Details drawer from the header action (open → close)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    expect(ctrl.drawerMode.value).toBe('none')
    ctrl.toggleDetails()
    expect(ctrl.drawerMode.value).toBe('details')
    // A second press closes it again.
    ctrl.toggleDetails()
    expect(ctrl.drawerMode.value).toBe('none')
  })

  it('keeps thread and details mutually exclusive (either direction)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    // details → thread: opening a thread displaces the details drawer.
    ctrl.toggleDetails()
    expect(ctrl.drawerMode.value).toBe('details')
    ctrl.onOpenThread(root.message_id)
    await flushPromises()
    expect(ctrl.drawerMode.value).toBe('thread')
    expect(ctrl.threadOpen.value).toBe(true)

    // thread → details: the header details button closes the open thread.
    ctrl.toggleDetails()
    await flushPromises()
    expect(ctrl.drawerMode.value).toBe('details')
    expect(ctrl.threadOpen.value).toBe(false)
  })

  it('closeDetails and thread.close both land the drawer on none (synchronously)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.toggleDetails()
    ctrl.closeDetails()
    expect(ctrl.drawerMode.value).toBe('none')

    ctrl.onOpenThread(root.message_id)
    await flushPromises()
    expect(ctrl.drawerMode.value).toBe('thread')
    // thread.close() must flip the mode back with NO awaited flush — the drawer's
    // synchronous unmount contract (thread testids/behavior unchanged).
    useThreadStore().close()
    expect(ctrl.drawerMode.value).toBe('none')
  })

  it('closes the details drawer when navigating away from the conversation', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.toggleDetails()
    expect(ctrl.drawerMode.value).toBe('details')
    ctrl.setActiveView('inbox')
    expect(ctrl.drawerMode.value).toBe('none')
    // And details cannot open on a non-conversation view.
    ctrl.toggleDetails()
    expect(ctrl.drawerMode.value).toBe('none')
  })

  it('after leaving the channel: closes the drawer and selects the next stream', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addStream({ stream_id: 's_b', name: 'bravo', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    expect(ctrl.selectedStreamId.value).toBe('s_a')
    ctrl.toggleDetails()

    // The drawer ran channel.removeMember(s_a, me); the fake flipped member:false.
    const workspace = useWorkspaceStore()
    await workspace.removeMember('s_a', 'u_me')
    await flushPromises()

    ctrl.onChannelLeft()
    await flushPromises()
    expect(ctrl.drawerMode.value).toBe('none')
    // Gracefully reselected the remaining channel.
    expect(ctrl.selectedStreamId.value).toBe('s_b')
  })

  it('gates the Admin scaffold on a privileged role', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    const auth = useAuthStore()
    expect(ctrl.canAdmin.value).toBe(false)
    auth.role = 'admin'
    await flushPromises()
    expect(ctrl.canAdmin.value).toBe(true)
  })
})
