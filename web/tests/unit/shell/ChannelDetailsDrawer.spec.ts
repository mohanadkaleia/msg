// tests/unit/shell/ChannelDetailsDrawer.spec.ts — the Ranin channel Details panel
// (ENG-136) + the per-channel notification-level selector (ENG-129). Proves:
// every reference row renders; Notifications is REAL — the row shows the level
// stored in the worker prefs mirror (default `all`), selecting an option calls
// `client.prefs.set(streamId, level)` and updates the label optimistically, and a
// cross-device `{kind:'prefs'}` echo reconciles it; Leave channel is REAL — the
// inline confirm gates `channel.removeMember(streamId, myUserId)` and emits `left`;
// Members emits `open-members` (the shell opens the existing settings dialog);
// the ✕ emits `close`. All through the FakeWorker — the fetch spy stays untouched.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import ChannelDetailsDrawer from '../../../src/components/shell/ChannelDetailsDrawer.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useAuthStore } from '../../../src/stores/auth'
import { usePresenceStore } from '../../../src/stores/presence'
import { useWorkspaceStore, type SidebarStream } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

const STREAM: SidebarStream = {
  stream_id: 's_a',
  kind: 'channel',
  name: 'engineering',
  head_seq: 0,
  member: true,
  unread: 0,
  mention: false,
}

async function mountDrawer(
  fake: FakeWorker,
  stream: SidebarStream = STREAM,
): Promise<ReturnType<typeof mount>> {
  setWorkerClient(fake.client)
  const auth = useAuthStore()
  auth.myUserId = 'u_me'
  const wrapper = mount(ChannelDetailsDrawer, { props: { stream } })
  await flushPromises()
  return wrapper
}

describe('ChannelDetailsDrawer (ENG-136 + ENG-129)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.addStream({ stream_id: 's_a', name: 'engineering', kind: 'channel' })
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('renders the header + every reference row in order, and Leave in danger', async () => {
    const wrapper = await mountDrawer(fake)

    expect(wrapper.text()).toContain('Details')
    const labels = wrapper
      .findAll('.text-sm.text-primary')
      .map((n) => n.text())
      .filter((t) =>
        [
          'About',
          'Members',
          'Files',
          'Pinned',
          'Apps',
          'Notifications',
          'Threads',
          'Shortcuts',
        ].includes(t),
      )
    expect(labels).toEqual([
      'About',
      'Members',
      'Files',
      'Pinned',
      'Apps',
      'Notifications',
      'Threads',
      'Shortcuts',
    ])

    // Sub-labels: About copy + DESCRIPTIVE empty-state copy (ENG-173 — no bare
    // em-dashes) + Threads copy.
    expect(wrapper.text()).toContain('Description, members, rules')
    expect(wrapper.text()).toContain('No files yet')
    expect(wrapper.text()).toContain('No pinned items')
    expect(wrapper.text()).toContain('No apps installed')
    expect(wrapper.text()).toContain('View all threads')
    expect(wrapper.text()).toContain('No shortcuts')
    expect(wrapper.text()).not.toContain('—')

    // Leave channel is a danger row (no chevron affordance semantics tested here).
    const leave = wrapper.get('[data-testid="channel-leave"]')
    expect(leave.text()).toContain('Leave channel')
    expect(leave.classes()).toContain('text-danger')
  })

  it('shows the directory stand-in member count on the Members row', async () => {
    fake.setDirectory(
      [
        { user_id: 'u_me', display_name: 'Me' },
        { user_id: 'u_ana', display_name: 'Ana' },
      ],
      [],
    )
    const wrapper = await mountDrawer(fake)
    const workspace = useWorkspaceStore()
    await workspace.refresh()
    await flushPromises()

    expect(wrapper.get('[data-testid="channel-members"]').text()).toContain('2 members')
  })

  it('emits open-members when the Members row is clicked (existing dialog reuse)', async () => {
    const wrapper = await mountDrawer(fake)
    await wrapper.get('[data-testid="channel-members"]').trigger('click')
    expect(wrapper.emitted('open-members')).toHaveLength(1)
  })

  it('emits close from the ✕', async () => {
    const wrapper = await mountDrawer(fake)
    await wrapper.get('[data-testid="details-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('defaults the Notifications row to All messages when no pref is stored', async () => {
    const wrapper = await mountDrawer(fake)
    expect(wrapper.get('[data-testid="channel-notifications-level"]').text()).toBe('All messages')
  })

  it('shows the stored prefs level for the channel', async () => {
    fake.setPref('s_a', 'mentions')
    // Another stream's pref must not bleed in.
    fake.setPref('s_other', 'mute')
    const wrapper = await mountDrawer(fake)
    expect(wrapper.get('[data-testid="channel-notifications-level"]').text()).toBe('Mentions only')
  })

  it('selecting a level calls client.prefs.set(streamId, level) and updates the label', async () => {
    const wrapper = await mountDrawer(fake)

    // The menu is closed until the row is clicked.
    expect(wrapper.find('[data-testid="channel-notif-mute"]').exists()).toBe(false)
    await wrapper.get('[data-testid="channel-notifications"]').trigger('click')
    expect(wrapper.find('[data-testid="channel-notif-all"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="channel-notif-mentions"]').exists()).toBe(true)

    await wrapper.get('[data-testid="channel-notif-mute"]').trigger('click')
    await flushPromises()

    expect(fake.prefsSetSpy).toHaveBeenCalledTimes(1)
    expect(fake.prefsSetSpy).toHaveBeenCalledWith('s_a', 'mute')
    // Optimistic label + closed menu.
    expect(wrapper.get('[data-testid="channel-notifications-level"]').text()).toBe('Muted')
    expect(wrapper.find('[data-testid="channel-notif-mute"]').exists()).toBe(false)
    // Zero HTTP from the tab: the prefs surface is the worker client's.
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('reconciles the label from a cross-device {kind:"prefs"} echo', async () => {
    const wrapper = await mountDrawer(fake)
    expect(wrapper.get('[data-testid="channel-notifications-level"]').text()).toBe('All messages')

    fake.echoPref('s_a', 'mentions')
    await flushPromises()
    expect(wrapper.get('[data-testid="channel-notifications-level"]').text()).toBe('Mentions only')
  })

  it('marks the current level in the selector menu', async () => {
    fake.setPref('s_a', 'mentions')
    const wrapper = await mountDrawer(fake)
    await wrapper.get('[data-testid="channel-notifications"]').trigger('click')
    expect(wrapper.get('[data-testid="channel-notif-mentions"]').attributes('aria-checked')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="channel-notif-all"]').attributes('aria-checked')).toBe(
      'false',
    )
  })

  it('Leave: confirms, then calls channel.removeMember(streamId, myUserId) and emits left', async () => {
    const wrapper = await mountDrawer(fake)

    await wrapper.get('[data-testid="channel-leave"]').trigger('click')
    // Nothing mutated yet — the confirm gates the leave.
    expect(fake.metaSpy).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="channel-leave-confirm"]').text()).toContain('engineering')

    await wrapper.get('[data-testid="channel-leave-confirm-yes"]').trigger('click')
    await flushPromises()

    expect(fake.metaSpy).toHaveBeenCalledWith({
      m: 'channel.removeMember',
      stream_id: 's_a',
      user_id: 'u_me',
    })
    expect(wrapper.emitted('left')).toHaveLength(1)
  })

  it('Leave: cancel closes the confirm without mutating', async () => {
    const wrapper = await mountDrawer(fake)
    await wrapper.get('[data-testid="channel-leave"]').trigger('click')
    await wrapper.get('[data-testid="channel-leave-cancel"]').trigger('click')
    expect(wrapper.find('[data-testid="channel-leave-confirm"]').exists()).toBe(false)
    expect(fake.metaSpy).not.toHaveBeenCalled()
    expect(wrapper.emitted('left')).toBeUndefined()
  })

  it('hides the Leave row for a DM (no leave semantics)', async () => {
    const dm: SidebarStream = { ...STREAM, stream_id: 's_dm', kind: 'dm', name: 'ana' }
    fake.addStream({ stream_id: 's_dm', name: 'ana', kind: 'dm' })
    const wrapper = await mountDrawer(fake, dm)
    expect(wrapper.find('[data-testid="channel-leave"]').exists()).toBe(false)
  })

  // -- ENG-172: DM-aware Details panel ---------------------------------------

  describe('DM panel (ENG-172)', () => {
    // DM streams are server-named null (ENG-149), so no `name` here.
    const DM: SidebarStream = {
      stream_id: 's_dm',
      kind: 'dm',
      head_seq: 0,
      member: true,
      unread: 0,
      mention: false,
      dm_user_ids: ['u_me', 'u_ana'],
    }

    async function mountDmDrawer(): Promise<ReturnType<typeof mount>> {
      fake.addStream({ stream_id: 's_dm', kind: 'dm', dm_user_ids: ['u_me', 'u_ana'] })
      fake.setDirectory(
        [
          { user_id: 'u_me', display_name: 'Me' },
          {
            user_id: 'u_ana',
            display_name: 'Ana',
            title: 'Designer',
            status_emoji: '🌴',
            status_text: 'On vacation',
          },
        ],
        [],
      )
      const wrapper = await mountDrawer(fake, DM)
      const workspace = useWorkspaceStore()
      await workspace.refresh()
      await flushPromises()
      return wrapper
    }

    it('shows the OTHER participant profile — no Members row, no channel scaffold rows', async () => {
      const wrapper = await mountDmDrawer()

      const profile = wrapper.get('[data-testid="dm-profile"]')
      expect(wrapper.get('[data-testid="dm-profile-name"]').text()).toBe('Ana')
      expect(profile.text()).toContain('Designer')
      expect(wrapper.get('[data-testid="dm-profile-status"]').text()).toContain('On vacation')
      // Offline until a presence snapshot says otherwise.
      expect(wrapper.get('[data-testid="dm-profile-presence"]').attributes('data-status')).toBe(
        'offline',
      )

      // Channel concepts never render for a DM.
      expect(wrapper.find('[data-testid="channel-members"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Members')
      expect(wrapper.text()).not.toContain('Leave channel')
      expect(wrapper.text()).not.toContain('About')
      expect(wrapper.text()).not.toContain('Apps')
      expect(wrapper.text()).not.toContain('Shortcuts')

      // DM-relevant rows stay: shared Files (descriptive empty state — ENG-173)
      // + the REAL Notifications selector (its Mute option is the DM mute).
      expect(wrapper.text()).toContain('Files')
      expect(wrapper.text()).toContain('No files yet')
      expect(wrapper.text()).not.toContain('—')
      expect(wrapper.find('[data-testid="channel-notifications"]').exists()).toBe(true)
    })

    it('reflects a live presence snapshot on the profile presence line', async () => {
      const wrapper = await mountDmDrawer()
      const presence = usePresenceStore()
      await presence.start('u_me')
      fake.publishPresence([{ user_id: 'u_ana', status: 'online' }])
      await flushPromises()

      const line = wrapper.get('[data-testid="dm-profile-presence"]')
      expect(line.attributes('data-status')).toBe('online')
      expect(line.text()).toContain('Active now')
      presence.stop()
    })

    it('Mute via the Notifications selector drives the REAL prefs surface for the DM', async () => {
      const wrapper = await mountDmDrawer()
      await wrapper.get('[data-testid="channel-notifications"]').trigger('click')
      await wrapper.get('[data-testid="channel-notif-mute"]').trigger('click')
      await flushPromises()
      expect(fake.prefsSetSpy).toHaveBeenCalledWith('s_dm', 'mute')
      expect(wrapper.get('[data-testid="channel-notifications-level"]').text()).toBe('Muted')
    })

    it('Close conversation emits close-dm (the shell deselects the DM)', async () => {
      const wrapper = await mountDmDrawer()
      await wrapper.get('[data-testid="dm-close-conversation"]').trigger('click')
      expect(wrapper.emitted('close-dm')).toHaveLength(1)
      // No mutation fired — closing is navigation, not a meta event.
      expect(fake.metaSpy).not.toHaveBeenCalled()
      expect(fake.fetch).not.toHaveBeenCalled()
    })

    it('falls back to a name-only stub when the counterpart is not in the directory yet', async () => {
      fake.addStream({ stream_id: 's_dm', kind: 'dm', dm_user_ids: ['u_me', 'u_ana'] })
      const wrapper = await mountDrawer(fake, DM)
      // Directory empty → raw-id fallback, still no crash and no channel rows.
      expect(wrapper.get('[data-testid="dm-profile-name"]').text()).toBe('u_ana')
      expect(wrapper.find('[data-testid="channel-members"]').exists()).toBe(false)
    })
  })
})
