/* eslint-disable vue/one-component-per-file -- lightweight leaf stubs, not real SFCs */
// tests/unit/shell/RightDrawer.spec.ts — ENG-136 "Ranin" right drawer host.
// The drawer renders EITHER the thread pane OR the channel Details panel OR the
// ENG-152 user-details panel, keyed on `mode` ('none' | 'thread' | 'details' |
// 'user'). The thread branch must behave EXACTLY as
// the old boolean-open wrapper (synchronous mount/unmount, "Thread" complementary
// landmark, ThreadPane VERBATIM inside); the details branch hosts
// ChannelDetailsDrawer and forwards its close/open-members/left events. Both leaves
// are stubbed — their own testids are covered by their specs; here we prove the
// host's mode switching + landmark contract.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'

import RightDrawer from '../../../src/components/shell/RightDrawer.vue'
import type { SidebarStream } from '../../../src/stores/workspace'

const ChannelDetailsDrawerStub = defineComponent({
  name: 'ChannelDetailsDrawer',
  emits: ['close', 'open-members', 'left'],
  template: '<div data-testid="details-stub" />',
})

const UserDetailsDrawerStub = defineComponent({
  name: 'UserDetailsDrawer',
  emits: ['close'],
  template: '<div data-testid="user-details-stub" />',
})

const stubs = {
  ThreadPane: { template: '<div data-testid="thread-pane-stub" />' },
  ChannelDetailsDrawer: ChannelDetailsDrawerStub,
  UserDetailsDrawer: UserDetailsDrawerStub,
}

const user = { user_id: 'u_ana', display_name: 'Ana' }

const stream: SidebarStream = {
  stream_id: 's_a',
  kind: 'channel',
  name: 'alpha',
  head_seq: 0,
  member: true,
  unread: 0,
  mention: false,
}

function mountDrawer(props: {
  mode: 'none' | 'thread' | 'details' | 'user'
  stream?: SidebarStream | null
  user?: { user_id: string; display_name: string } | null
  userPresence?: 'online' | 'offline'
  userRole?: string
}) {
  return mount(RightDrawer, { props, global: { stubs } })
}

describe('RightDrawer (ENG-136 drawer-mode host)', () => {
  it('renders nothing when the mode is none', () => {
    const wrapper = mountDrawer({ mode: 'none', stream })
    expect(wrapper.find('[role="complementary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="details-stub"]').exists()).toBe(false)
  })

  it('mounts ThreadPane as a Thread complementary landmark in thread mode', () => {
    const wrapper = mountDrawer({ mode: 'thread', stream })
    const panel = wrapper.get('[role="complementary"]')
    expect(panel.attributes('aria-label')).toBe('Thread')
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(true)
    // Mutual exclusion at the host: the details panel is NOT mounted alongside.
    expect(wrapper.find('[data-testid="details-stub"]').exists()).toBe(false)
  })

  it('mounts ChannelDetailsDrawer as a Details complementary landmark in details mode', () => {
    const wrapper = mountDrawer({ mode: 'details', stream })
    const panel = wrapper.get('[role="complementary"]')
    expect(panel.attributes('aria-label')).toBe('Details')
    expect(wrapper.find('[data-testid="details-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(false)
  })

  it('renders nothing in details mode without a selected stream', () => {
    const wrapper = mountDrawer({ mode: 'details', stream: null })
    expect(wrapper.find('[role="complementary"]').exists()).toBe(false)
  })

  it('unmounts the thread pane synchronously when the mode flips to none', async () => {
    const wrapper = mountDrawer({ mode: 'thread', stream })
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(true)
    await wrapper.setProps({ mode: 'none' })
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(false)
  })

  it('swaps thread ↔ details exclusively as the mode changes', async () => {
    const wrapper = mountDrawer({ mode: 'thread', stream })
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(true)

    await wrapper.setProps({ mode: 'details' })
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="details-stub"]').exists()).toBe(true)
    expect(wrapper.get('[role="complementary"]').attributes('aria-label')).toBe('Details')

    await wrapper.setProps({ mode: 'thread' })
    expect(wrapper.find('[data-testid="details-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(true)
  })

  it('mounts UserDetailsDrawer as a Profile complementary landmark in user mode', () => {
    const wrapper = mountDrawer({ mode: 'user', user, userPresence: 'online', userRole: 'admin' })
    const panel = wrapper.get('[role="complementary"]')
    expect(panel.attributes('aria-label')).toBe('Profile')
    expect(wrapper.find('[data-testid="user-details-stub"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="thread-pane-stub"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="details-stub"]').exists()).toBe(false)
  })

  it('renders nothing in user mode without a user record', () => {
    const wrapper = mountDrawer({ mode: 'user', user: null })
    expect(wrapper.find('[role="complementary"]').exists()).toBe(false)
  })

  it('forwards the user-details panel close as close-user', () => {
    const wrapper = mountDrawer({ mode: 'user', user, userPresence: 'offline' })
    wrapper.getComponent(UserDetailsDrawerStub).vm.$emit('close')
    expect(wrapper.emitted('close-user')).toHaveLength(1)
  })

  it('forwards the details panel close / open-members / left events', () => {
    const wrapper = mountDrawer({ mode: 'details', stream })
    const details = wrapper.getComponent(ChannelDetailsDrawerStub)
    details.vm.$emit('close')
    details.vm.$emit('open-members')
    details.vm.$emit('left')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('open-members')).toHaveLength(1)
    expect(wrapper.emitted('left')).toHaveLength(1)
  })
})
