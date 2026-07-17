// tests/unit/shell/useShellController.spec.ts — ENG-136 "Ranin" (PR-B). The shell
// controller is the behavior-preserving extraction of ShellView's cross-store
// wiring; both ShellView (PR-B) and AppShell (PR-C) consume it. This proves the
// contract: stream selection loads messages + shows the conversation view, the
// `activeView` flips the main panel between sections, Cmd+K opens the palette, the palette
// selects + closes, threads open/close, and Admin is role-gated — all via stores,
// never HTTP (the FakeWorker's fetch spy stays untouched).
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useShellController } from '../../../src/composables/useShellController'
import { useTheme } from '../../../src/composables/useTheme'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useAuthStore } from '../../../src/stores/auth'
import { useThreadStore } from '../../../src/stores/thread'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

type Controller = ReturnType<typeof useShellController>

const Blank = { template: '<div />' }

// This env's window.localStorage is a bare object with no methods; the sidebar
// collapse (ENG-174) persists through it, so install a working in-memory
// Storage where a test asserts persistence (same pattern as useTheme.spec).
function installLocalStorage(): void {
  const store = new Map<string, string>()
  const mock: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  }
  Object.defineProperty(window, 'localStorage', { value: mock, configurable: true, writable: true })
}

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

  it('workspaceName reads the workspace.info fold; falls back until it syncs (ENG-152)', async () => {
    // No workspace.info seeded → the genesis event has not synced: fallback.
    setWorkerClient(fake.client)
    const first = await mountController(router)
    expect(first.ctrl.workspaceName.value).toBe('Workspace')
    expect(first.ctrl.workspaceInitials.value).toBe('WO')

    // The REAL name (workspace.created + any workspace.updated renames) wins.
    setActivePinia(createPinia())
    fake.setWorkspaceInfo({ name: 'Acme Corp', description: null })
    const second = await mountController(router)
    expect(second.ctrl.workspaceName.value).toBe('Acme Corp')
    expect(second.ctrl.workspaceInitials.value).toBe('AC')

    // A store update (e.g. the admin's save echo) renames reactively.
    useWorkspaceStore().applyWorkspaceUpdate({ name: 'Zenith', description: null })
    await flushPromises()
    expect(second.ctrl.workspaceName.value).toBe('Zenith')
    expect(second.ctrl.workspaceInitials.value).toBe('ZE')
  })

  it('flips the main panel to the Apps section and back (REAL view — ENG-176)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.setActiveView('apps')
    expect(ctrl.activeView.value).toBe('apps')
    expect(ctrl.mainTitle.value).toBe('Apps')

    // Selecting a real stream returns to the conversation timeline.
    ctrl.onPaletteSelect('s_a')
    await flushPromises()
    expect(ctrl.activeView.value).toBe('conversation')
    expect(ctrl.paletteOpen.value).toBe(false)
  })

  it('toggles the palette on Cmd+K (ENG-152 nav cleanup)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    expect(ctrl.paletteOpen.value).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    expect(ctrl.paletteOpen.value).toBe(true)
    // A second Cmd+K closes it again (toggle).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    expect(ctrl.paletteOpen.value).toBe(false)
  })

  it('opens the unified search on Cmd+/ — and the two overlays displace each other', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    // Cmd+/ → the ONE search modal.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }))
    expect(ctrl.searchOpen.value).toBe(true)
    expect(ctrl.paletteOpen.value).toBe(false)

    // Cmd+K while search is open: the palette opens and search closes (both are
    // full-screen overlays — never stacked).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    expect(ctrl.paletteOpen.value).toBe(true)
    expect(ctrl.searchOpen.value).toBe(false)

    // And Cmd+/ while the palette is open flips back to search.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true }))
    expect(ctrl.searchOpen.value).toBe(true)
    expect(ctrl.paletteOpen.value).toBe(false)
  })

  // -- ENG-174 sidebar collapse -----------------------------------------------

  it('toggles the sidebar on Cmd+\\ / Ctrl+\\ and persists the choice (ENG-174)', async () => {
    installLocalStorage()
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    // Default expanded — the E2E flows click sidebar rows without toggling.
    expect(ctrl.sidebarCollapsed.value).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true }))
    expect(ctrl.sidebarCollapsed.value).toBe(true)
    expect(window.localStorage.getItem('msg:sidebar')).toBe('collapsed')

    // Ctrl variant toggles back; the palette/search overlays are untouched.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }))
    expect(ctrl.sidebarCollapsed.value).toBe(false)
    expect(window.localStorage.getItem('msg:sidebar')).toBe('expanded')
    expect(ctrl.paletteOpen.value).toBe(false)
    expect(ctrl.searchOpen.value).toBe(false)

    // A bare '\' (no modifier) is NOT the shortcut.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\' }))
    expect(ctrl.sidebarCollapsed.value).toBe(false)
  })

  it('toggleSidebar flips the state directly (the control/affordance seam)', async () => {
    installLocalStorage()
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.toggleSidebar()
    expect(ctrl.sidebarCollapsed.value).toBe(true)
    ctrl.toggleSidebar()
    expect(ctrl.sidebarCollapsed.value).toBe(false)
  })

  it('restores a persisted collapsed sidebar on mount (ENG-174)', async () => {
    installLocalStorage()
    window.localStorage.setItem('msg:sidebar', 'collapsed')
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    expect(ctrl.sidebarCollapsed.value).toBe(true)
  })

  // -- ENG-136 palette commands ----------------------------------------------

  it('exposes the command registry and runs "create-channel" against the dialog flag', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    const ids = (ctrl.paletteCommands.value as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain('create-channel')
    expect(ids).toContain('start-dm')
    expect(ids).toContain('browse-channels')
    expect(ids).toContain('search-messages')
    expect(ids).toContain('sign-out')

    ctrl.paletteOpen.value = true
    expect(ctrl.createChannelOpen.value).toBe(false)
    ctrl.onPaletteCommand('create-channel')
    // The seam fires AND the palette closes.
    expect(ctrl.createChannelOpen.value).toBe(true)
    expect(ctrl.paletteOpen.value).toBe(false)
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('"start-dm" / "browse-channels" / "search-messages" open their existing surfaces', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.onPaletteCommand('start-dm')
    expect(ctrl.newDmOpen.value).toBe(true)
    ctrl.onPaletteCommand('browse-channels')
    expect(ctrl.channelBrowserOpen.value).toBe(true)
    ctrl.onPaletteCommand('search-messages')
    expect(ctrl.searchOpen.value).toBe(true)
  })

  it('"go-inbox" flips the main panel; "toggle-theme" cycles the preference', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.onPaletteCommand('go-inbox')
    expect(ctrl.activeView.value).toBe('inbox')

    const { theme, setTheme } = useTheme()
    setTheme('light')
    ctrl.onPaletteCommand('toggle-theme')
    expect(theme.value).toBe('dark') // light → dark (useTheme's cycle order)
    setTheme('system') // restore the default for other suites
  })

  it('"channel-notifications" is context-gated and opens the Details drawer', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    const commandIds = (): string[] =>
      (ctrl.paletteCommands.value as Array<{ id: string }>).map((c) => c.id)

    // Available while a channel conversation is active…
    expect(commandIds()).toContain('channel-notifications')
    ctrl.onPaletteCommand('channel-notifications')
    expect(ctrl.drawerMode.value).toBe('details')
    ctrl.closeDetails()

    // …hidden (and inert) away from a channel conversation.
    ctrl.setActiveView('inbox')
    expect(commandIds()).not.toContain('channel-notifications')
    ctrl.onPaletteCommand('channel-notifications')
    expect(ctrl.drawerMode.value).toBe('none')
  })

  it('"sign-out" runs the existing logout flow (redirect to /login)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.onPaletteCommand('sign-out')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/login')
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
    // Inbox is a REAL view (ENG-136) — its own header titles it.
    expect(ctrl.mainTitle.value).toBe('Inbox')

    // Re-opening the ALREADY-selected stream must still leave the Inbox (the
    // selection watch only fires on a changed id).
    expect(ctrl.selectedStreamId.value).toBe('s_a')
    ctrl.onOpenStream('s_a')
    await flushPromises()
    expect(ctrl.activeView.value).toBe('conversation')
    expect(ctrl.selectedStreamId.value).toBe('s_a')
  })

  it('closes an open thread when navigating to a section view (PR-B review #4)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.onOpenThread(root.message_id)
    await flushPromises()
    expect(ctrl.threadOpen.value).toBe(true)

    // Flipping to a section view closes the drawer so it does not dock beside it.
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

  // -- ENG-152 user-details drawer (hovercard click → right drawer) ----------

  it('opens the user-details drawer for a user_id and resolves the record', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.setDirectory([{ user_id: 'u_ana', display_name: 'Ana', title: 'Eng' }], [])
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    expect(ctrl.drawerMode.value).toBe('none')
    ctrl.openUserDetails('u_ana')
    expect(ctrl.drawerMode.value).toBe('user')
    expect(ctrl.detailsUser.value?.display_name).toBe('Ana')
    expect(ctrl.detailsPresence.value).toBe('offline')

    // Close returns the drawer to the prior (none) state.
    ctrl.closeUserDetails()
    expect(ctrl.drawerMode.value).toBe('none')
    expect(ctrl.detailsUser.value).toBeNull()
  })

  it('overlays the user-details panel and RESTORES the prior channel-details state on close', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.toggleDetails()
    expect(ctrl.drawerMode.value).toBe('details')

    ctrl.openUserDetails('u_ana')
    expect(ctrl.drawerMode.value).toBe('user') // overlays details

    ctrl.closeUserDetails()
    expect(ctrl.drawerMode.value).toBe('details') // prior state restored
  })

  it('overlays the user-details panel over an open thread and restores it on close', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    ctrl.onOpenThread(root.message_id)
    await flushPromises()
    expect(ctrl.drawerMode.value).toBe('thread')

    ctrl.openUserDetails('u_ana')
    expect(ctrl.drawerMode.value).toBe('user')

    ctrl.closeUserDetails()
    expect(ctrl.drawerMode.value).toBe('thread') // the thread is revealed again
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

  // -- ENG-172 DM-aware header + Close conversation ---------------------------

  it('DM header (ENG-172): headerKind flips to dm with a status/presence subtitle', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addStream({ stream_id: 's_dm', kind: 'dm', dm_user_ids: ['u_me', 'u_ana'] })
    fake.setDirectory(
      [
        { user_id: 'u_me', display_name: 'Me' },
        {
          user_id: 'u_ana',
          display_name: 'Ana',
          status_emoji: '🌴',
          status_text: 'On vacation',
        },
      ],
      [],
    )
    setWorkerClient(fake.client)
    const auth = useAuthStore()
    auth.myUserId = 'u_me'
    const { ctrl } = await mountController(router)

    // Channel selected: channel-shaped header, no DM subtitle.
    expect(ctrl.headerKind.value).toBe('channel')
    expect(ctrl.headerSubtitle.value).toBeUndefined()

    // DM selected: the title is the counterpart's name (ENG-149) and the subline
    // is their status + presence — never "N members"/"Add a topic".
    ctrl.onOpenStream('s_dm')
    await flushPromises()
    expect(ctrl.headerKind.value).toBe('dm')
    expect(ctrl.mainTitle.value).toBe('Ana')
    expect(ctrl.headerSubtitle.value).toBe('🌴 On vacation · Offline')
  })

  it('onDmClosed (ENG-172): closes the drawer and navigates away from the DM', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addStream({ stream_id: 's_dm', kind: 'dm', dm_user_ids: ['u_me', 'u_ana'] })
    setWorkerClient(fake.client)
    const auth = useAuthStore()
    auth.myUserId = 'u_me'
    const { ctrl } = await mountController(router)

    ctrl.onOpenStream('s_dm')
    await flushPromises()
    ctrl.toggleDetails()
    expect(ctrl.drawerMode.value).toBe('details')

    ctrl.onDmClosed()
    expect(ctrl.drawerMode.value).toBe('none')
    // Fell back to the first channel — the DM view is closed.
    expect(ctrl.selectedStreamId.value).toBe('s_a')
  })

  // -- ENG-129 mark-read on channel view ------------------------------------

  it('marks the opened stream read up to max(head_seq, newest loaded seq)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel', head_seq: 3 })
    fake.addMessage('s_a', { created_seq: 1, text: 'one' })
    fake.addMessage('s_a', { created_seq: 2, text: 'two' })
    setWorkerClient(fake.client)

    await mountController(router)
    expect(fake.markSpy).toHaveBeenCalledWith('s_a', 3)
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('re-marks when a new message arrives while the stream is ACTIVE', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel', head_seq: 1 })
    fake.addMessage('s_a', { created_seq: 1, text: 'one' })
    setWorkerClient(fake.client)

    await mountController(router)
    expect(fake.markSpy).toHaveBeenCalledWith('s_a', 1)

    // A live inbound message lands while the user is looking at the stream.
    fake.deliver('s_a', { created_seq: 2, text: 'two', author_user_id: 'u_other' })
    await flushPromises()
    expect(fake.markSpy).toHaveBeenCalledWith('s_a', 2)
  })

  it('marks a stream opened from the Inbox (open-stream path)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel', head_seq: 1 })
    fake.addStream({ stream_id: 's_b', name: 'bravo', kind: 'channel', head_seq: 7 })
    setWorkerClient(fake.client)

    const { ctrl } = await mountController(router)
    ctrl.setActiveView('inbox')
    ctrl.onOpenStream('s_b')
    await flushPromises()
    expect(fake.markSpy).toHaveBeenCalledWith('s_b', 7)
  })

  it('a pending own send (sentinel seq) never advances read-state', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel', head_seq: 1 })
    fake.addMessage('s_a', { created_seq: 1, text: 'one' })
    setWorkerClient(fake.client)

    const { ctrl } = await mountController(router)
    expect(fake.markSpy).toHaveBeenCalledTimes(1)
    expect(fake.markSpy).toHaveBeenCalledWith('s_a', 1)

    // The optimistic pending row carries a ms-epoch `created_seq` sentinel — the
    // mark watch must skip it (else read-state would jump into the far future).
    ctrl.onSend('hello', [], [])
    await flushPromises()
    expect(fake.markSpy).toHaveBeenCalledTimes(1)
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

  it('openAdmin deep-targets an AdminView tab; tabChange reports keep it honest', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const { ctrl } = await mountController(router)

    // The split sidebar "Workspace" item: admin view + workspace tab, together.
    ctrl.openAdmin('workspace')
    expect(ctrl.activeView.value).toBe('admin')
    expect(ctrl.adminTab.value).toBe('workspace')

    // The "Members & invites" item while ALREADY on admin re-targets the tab.
    ctrl.openAdmin('members')
    expect(ctrl.activeView.value).toBe('admin')
    expect(ctrl.adminTab.value).toBe('members')

    // An in-view tab click reported by AdminView keeps the sidebar state honest.
    ctrl.onAdminTabChange('invites')
    expect(ctrl.adminTab.value).toBe('invites')
  })
})
