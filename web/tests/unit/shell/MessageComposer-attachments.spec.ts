// tests/unit/shell/MessageComposer-attachments.spec.ts — the ENG-121 composer
// attachment strip (Option A: upload decoupled from send). Drives a controllable
// FakeWorker upload (queued→uploading on upload(); completeUpload/failUpload flip the
// terminal) so the Send GATE (disabled while in-flight/failed, enabled at done), the
// file-only message, the file_ids on the `send` emit, and remove (revoke preview +
// cancel) / retry all have teeth. `URL.createObjectURL/revokeObjectURL` are spied.

import { flushPromises, mount } from '@vue/test-utils'
import type { JSONContent } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MessageComposer from '../../../src/components/shell/MessageComposer.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { FakeWorker } from './fakeWorker'

let counter = 0
let createSpy: ReturnType<typeof vi.fn>
let revokeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  counter = 0
  createSpy = vi.fn(() => `blob:mock-${++counter}`)
  revokeSpy = vi.fn()
  URL.createObjectURL = createSpy
  URL.revokeObjectURL = revokeSpy
})

afterEach(() => {
  setWorkerClient(undefined)
  document.body.innerHTML = ''
  delete (URL as { createObjectURL?: unknown }).createObjectURL
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
})

interface ComposerVm {
  editor: { commands: { setContent: (c: JSONContent) => void } }
  submit: () => void
  addFiles: (files: File[]) => void
}
const vmOf = (wrapper: ReturnType<typeof mount>): ComposerVm => wrapper.vm as unknown as ComposerVm

async function mountComposer(fake: FakeWorker) {
  setWorkerClient(fake.client)
  const wrapper = mount(MessageComposer, {
    props: { streamId: 's1' },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

const imageFile = (name = 'photo.png') => new File(['bytes'], name, { type: 'image/png' })
const textFile = (name = 'notes.txt') => new File(['bytes'], name, { type: 'text/plain' })

const sendBtn = (w: ReturnType<typeof mount>) => w.get('[data-testid="composer-send"]')
const uploadIdOf = (fake: FakeWorker) => fake.uploadSpy.mock.calls[0]![0].upload_id
const typeText = async (vm: ComposerVm, text: string) => {
  vm.editor.commands.setContent({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })
  await flushPromises()
}

describe('MessageComposer attachments (ENG-121)', () => {
  it('a picked file becomes a pending chip (image → instant local preview)', async () => {
    const fake = new FakeWorker()
    const wrapper = await mountComposer(fake)

    const input = wrapper.get('[data-testid="attach-file-input"]')
    Object.defineProperty(input.element, 'files', { value: [imageFile()], configurable: true })
    await input.trigger('change')
    await flushPromises()

    expect(wrapper.findAll('[data-testid="composer-attachment"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="composer-attachment"]').text()).toContain('photo.png')
    // An image mints a LOCAL object URL for the instant preview.
    expect(createSpy).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="composer-attachment"] img').attributes('src')).toBe(
      'blob:mock-1',
    )
  })

  it('gates Send CLOSED while uploading and OPEN once every chip is done', async () => {
    const fake = new FakeWorker()
    const wrapper = await mountComposer(fake)
    const vm = vmOf(wrapper)

    vm.addFiles([textFile()])
    await flushPromises()
    // In-flight (phase 'uploading') → Send disabled even with no text.
    expect(sendBtn(wrapper).attributes('disabled')).toBeDefined()

    fake.completeUpload(uploadIdOf(fake), 'f_1')
    await flushPromises()
    // Done → a file-only message is now sendable.
    expect(sendBtn(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('on Send emits the resolved file_ids and clears the strip (file-only message)', async () => {
    const fake = new FakeWorker()
    const wrapper = await mountComposer(fake)
    const vm = vmOf(wrapper)

    vm.addFiles([textFile()])
    await flushPromises()
    fake.completeUpload(uploadIdOf(fake), 'f_1')
    await flushPromises()

    await sendBtn(wrapper).trigger('click')
    await flushPromises()

    const sent = wrapper.emitted('send')?.at(-1) as [string, string[], string[]]
    expect(sent[2]).toEqual(['f_1']) // file_ids ride the send
    // The strip cleared, and its (non-image) chip had no preview URL to revoke.
    expect(wrapper.findAll('[data-testid="composer-attachment"]')).toHaveLength(0)
  })

  it('carries file_ids alongside text + mentions when both are present', async () => {
    const fake = new FakeWorker()
    const wrapper = await mountComposer(fake)
    const vm = vmOf(wrapper)
    await typeText(vm, 'look at this')

    vm.addFiles([textFile()])
    await flushPromises()
    fake.completeUpload(uploadIdOf(fake), 'f_9')
    await flushPromises()
    vm.submit()

    const sent = wrapper.emitted('send')?.at(-1) as [string, string[], string[]]
    expect(sent[0]).toBe('look at this')
    expect(sent[2]).toEqual(['f_9'])
  })

  it('blocks a whitespace-only send with no attachments', async () => {
    const fake = new FakeWorker()
    const wrapper = await mountComposer(fake)
    const vm = vmOf(wrapper)
    // Empty editor + no attachments → Send is gated closed.
    expect(sendBtn(wrapper).attributes('disabled')).toBeDefined()
    // Whitespace-only content carries nothing (no attachment to send) → no-op.
    await typeText(vm, '   ')
    vm.submit()
    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('a failed upload shows Retry + Remove, keeps Send disabled, and re-enables on retry→done', async () => {
    const fake = new FakeWorker()
    const wrapper = await mountComposer(fake)
    const vm = vmOf(wrapper)

    vm.addFiles([textFile()])
    await flushPromises()
    fake.failUpload(uploadIdOf(fake), 'file-too-large')
    await flushPromises()

    expect(wrapper.find('[data-testid="composer-attachment-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-attachment-retry"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="composer-attachment-remove"]').exists()).toBe(true)
    // A failed chip is NOT done → Send stays gated closed.
    expect(sendBtn(wrapper).attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="composer-attachment-retry"]').trigger('click')
    await flushPromises()
    // The fake's retry re-emits done → Send re-enables.
    expect(sendBtn(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('Remove revokes the local preview URL and cancels the worker upload', async () => {
    const fake = new FakeWorker()
    const wrapper = await mountComposer(fake)
    const vm = vmOf(wrapper)

    vm.addFiles([imageFile()])
    await flushPromises()
    const uploadId = uploadIdOf(fake)
    expect(createSpy).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="composer-attachment-remove"]').trigger('click')
    await flushPromises()

    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-1')
    expect(fake.cancelSpy).toHaveBeenCalledWith(uploadId)
    expect(wrapper.findAll('[data-testid="composer-attachment"]')).toHaveLength(0)
  })
})
