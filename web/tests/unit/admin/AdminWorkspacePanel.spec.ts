// tests/unit/admin/AdminWorkspacePanel.spec.ts — ENG-152. The Workspace
// settings panel over a fake `client.admin.workspace.*`: the form pre-fills
// from `workspace.get`, Save PATCHes ONLY the changed fields (presence-
// significant; a cleared description is sent as ''), a successful save shows
// "Saved" and renames the workspace store's identity (the switcher/header),
// an empty name blocks Save with inline copy, a coded failure surfaces
// inline, and a failed load renders the retryable error state.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AdminWorkspacePanel from '../../../src/components/admin/AdminWorkspacePanel.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from '../shell/fakeWorker'

describe('AdminWorkspacePanel (ENG-152)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.setAdminWorkspace({ workspace_id: 'w_1', name: 'Acme', description: 'Widgets' })
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  async function mountPanel(): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    const wrapper = mount(AdminWorkspacePanel, { attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  function nameInput(wrapper: VueWrapper): HTMLInputElement {
    return wrapper.get('[data-testid="workspace-name"]').element as HTMLInputElement
  }

  function descInput(wrapper: VueWrapper): HTMLTextAreaElement {
    return wrapper.get('[data-testid="workspace-description"]').element as HTMLTextAreaElement
  }

  it('pre-fills the form from admin.workspace.get', async () => {
    const wrapper = await mountPanel()

    expect(fake.adminWorkspaceGetSpy).toHaveBeenCalledTimes(1)
    expect(nameInput(wrapper).value).toBe('Acme')
    expect(descInput(wrapper).value).toBe('Widgets')
    // Nothing changed yet — Save is disabled.
    expect(wrapper.get('[data-testid="workspace-save"]').attributes('disabled')).toBeDefined()
    // The icon is a separate follow-up — the panel says so.
    expect(wrapper.find('[data-testid="workspace-icon-note"]').exists()).toBe(true)
  })

  it('Save PATCHes only the changed fields and shows "Saved"', async () => {
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="workspace-name"]').setValue('Acme Corp')
    await wrapper.get('[data-testid="workspace-save"]').trigger('submit')
    await flushPromises()

    // Presence-significant: the untouched description is NOT in the body.
    expect(fake.adminWorkspaceUpdateSpy).toHaveBeenCalledTimes(1)
    expect(fake.adminWorkspaceUpdateSpy).toHaveBeenCalledWith({ name: 'Acme Corp' })
    expect(wrapper.find('[data-testid="workspace-saved"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="admin-workspace-error"]').exists()).toBe(false)
  })

  it('a cleared description is sent as the explicit empty string', async () => {
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="workspace-description"]').setValue('')
    await wrapper.get('[data-testid="workspace-save"]').trigger('submit')
    await flushPromises()

    expect(fake.adminWorkspaceUpdateSpy).toHaveBeenCalledWith({ description: '' })
  })

  it('a successful save renames the workspace store identity (switcher source)', async () => {
    const workspace = useWorkspaceStore()
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="workspace-name"]').setValue('Acme Corp')
    await wrapper.get('[data-testid="workspace-save"]').trigger('submit')
    await flushPromises()

    expect(workspace.workspaceInfo.name).toBe('Acme Corp')
    expect(workspace.workspaceInfo.description).toBe('Widgets')
  })

  it('an empty name blocks Save with inline copy (no RPC fires)', async () => {
    const wrapper = await mountPanel()

    await wrapper.get('[data-testid="workspace-name"]').setValue('   ')
    expect(wrapper.find('[data-testid="workspace-name-error"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="workspace-save"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="workspace-save"]').trigger('submit')
    await flushPromises()
    expect(fake.adminWorkspaceUpdateSpy).not.toHaveBeenCalled()
  })

  it('a coded save failure surfaces inline without losing the edits', async () => {
    const wrapper = await mountPanel()
    fake.failNextAdminWorkspaceUpdate('forbidden')

    await wrapper.get('[data-testid="workspace-name"]').setValue('Acme Corp')
    await wrapper.get('[data-testid="workspace-save"]').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[data-testid="admin-workspace-error"]').text()).toContain('permission')
    expect(nameInput(wrapper).value).toBe('Acme Corp') // edits survive
    expect(wrapper.find('[data-testid="workspace-saved"]').exists()).toBe(false)
  })

  it('a failed load renders the retryable error state, and Retry reloads', async () => {
    fake.failNextAdminWorkspaceGet('forbidden')
    const wrapper = await mountPanel()

    expect(wrapper.find('[data-testid="admin-workspace-load-error"]').exists()).toBe(true)

    await wrapper.get('[data-testid="admin-workspace-retry"]').trigger('click')
    await flushPromises()
    expect(fake.adminWorkspaceGetSpy).toHaveBeenCalledTimes(2)
    expect(nameInput(wrapper).value).toBe('Acme')
  })
})
