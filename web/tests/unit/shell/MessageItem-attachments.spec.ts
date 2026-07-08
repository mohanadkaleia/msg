// tests/unit/shell/MessageItem-attachments.spec.ts — the ENG-121 attachment render.
// MessageItem resolves a message's `file_ids` via the local `attachments.forMessage`
// projection and renders images (thumbnail + lightbox), file cards (download), and
// pending placeholders. `useFileUrl` is MOCKED (so the thumbnail resolves to a blob:
// URL without a worker), and a minimal fake WorkerClient answers the projection query
// and the download. Covers: image vs card, the download blob path, XSS-inert names,
// dedupe by file_id, and the pending placeholder.

import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The image thumbnail/lightbox URL comes from useFileUrl — mock it to a static blob:
// URL so the component renders without touching the worker.
vi.mock('../../../src/composables/useFileUrl', () => ({
  useFileUrl: () => ({ url: ref('blob:thumb-1') }),
}))

import MessageItem from '../../../src/components/shell/MessageItem.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import type { DisplayMessage } from '../../../src/stores/messages'
import type { FileFetchResult, FileRow, WorkerClient } from '../../../src/worker'

function fileRow(over: Partial<FileRow> & { file_id: string }): FileRow {
  return {
    sha256: 'a'.repeat(64),
    name: 'file.bin',
    mime_type: 'application/octet-stream',
    size_bytes: 1234,
    stream_id: 's1',
    ...over,
  }
}

/** A minimal fake exposing only `attachments.forMessage` + `files.download`. */
function fakeClient(opts: {
  files?: FileRow[]
  pending?: string[]
  download?: (fileId: string) => Promise<FileFetchResult>
}): WorkerClient {
  return {
    query: (params: { q: string; message_id: string }) => {
      if (params.q === 'attachments.forMessage') {
        return Promise.resolve({
          message_id: params.message_id,
          files: opts.files ?? [],
          pending_file_ids: opts.pending ?? [],
        })
      }
      return Promise.resolve({})
    },
    files: {
      download: opts.download ?? (() => Promise.resolve({ blob: null })),
      thumbnail: () => Promise.resolve({ blob: null }),
      upload: () => Promise.resolve({ upload_id: 'x' }),
      retry: () => Promise.resolve({ upload_id: 'x' }),
      cancel: () => Promise.resolve({ upload_id: 'x' }),
      onProgress: () => () => {},
    },
  } as unknown as WorkerClient
}

function makeMessage(fileIds: string[]): DisplayMessage {
  return {
    message_id: 'm_00000000000000000000000000',
    stream_id: 's1',
    created_seq: 1,
    author_user_id: 'u_other',
    text: 'see attached',
    format: 'plain',
    mention_user_ids: [],
    file_ids: fileIds,
    ts: Date.now(),
    mine: false,
  }
}

let createSpy: ReturnType<typeof vi.fn>
let revokeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  createSpy = vi.fn(() => 'blob:download-1')
  revokeSpy = vi.fn()
  URL.createObjectURL = createSpy
  URL.revokeObjectURL = revokeSpy
})

afterEach(() => {
  setWorkerClient(undefined)
  delete (URL as { createObjectURL?: unknown }).createObjectURL
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
})

describe('MessageItem attachments (ENG-121)', () => {
  it('renders an image FileRow as a thumbnail <img> with a blob: src', async () => {
    setWorkerClient(fakeClient({ files: [fileRow({ file_id: 'f_img', mime_type: 'image/png' })] }))
    const wrapper = mount(MessageItem, { props: { message: makeMessage(['f_img']) } })
    await flushPromises()

    const img = wrapper.get('[data-testid="attachment-image"]')
    expect(img.attributes('src')).toBe('blob:thumb-1')
    expect(wrapper.find('[data-testid="attachment-file"]').exists()).toBe(false)
  })

  it('renders a non-image FileRow as a file card with name, size, and a download button', async () => {
    setWorkerClient(
      fakeClient({
        files: [
          fileRow({
            file_id: 'f_doc',
            name: 'report.pdf',
            mime_type: 'application/pdf',
            size_bytes: 2048,
          }),
        ],
      }),
    )
    const wrapper = mount(MessageItem, { props: { message: makeMessage(['f_doc']) } })
    await flushPromises()

    const card = wrapper.get('[data-testid="attachment-file"]')
    expect(card.text()).toContain('report.pdf')
    expect(card.text()).toContain('2.0 KB')
    expect(wrapper.find('[data-testid="attachment-download"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="attachment-image"]').exists()).toBe(false)
  })

  it('download fetches the blob worker-side and triggers a transient <a download> then revokes', async () => {
    const download = vi.fn(() => Promise.resolve({ blob: new Blob(['x']) }))
    setWorkerClient(
      fakeClient({ files: [fileRow({ file_id: 'f_doc', name: 'report.pdf' })], download }),
    )
    const clickSpy = vi.fn()
    const realCreate = document.createElement.bind(document)
    const createElSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag)
      if (tag === 'a') el.click = clickSpy
      return el
    })
    vi.useFakeTimers()

    const wrapper = mount(MessageItem, { props: { message: makeMessage(['f_doc']) } })
    await vi.runAllTimersAsync()
    await wrapper.get('[data-testid="attachment-download"]').trigger('click')
    await vi.runAllTimersAsync()

    expect(download).toHaveBeenCalledWith('f_doc')
    expect(createSpy).toHaveBeenCalledTimes(1) // one-shot local object URL
    expect(clickSpy).toHaveBeenCalledTimes(1) // the <a download> was clicked
    expect(revokeSpy).toHaveBeenCalledWith('blob:download-1') // revoked after

    createElSpy.mockRestore()
    vi.useRealTimers()
  })

  it('renders an attacker-controlled file name as INERT escaped text (XSS)', async () => {
    const payload = '<img src=x onerror="window.__pwned=1">.png'
    setWorkerClient(
      fakeClient({ files: [fileRow({ file_id: 'f_img', name: payload, mime_type: 'image/png' })] }),
    )
    const wrapper = mount(MessageItem, { props: { message: makeMessage(['f_img']) } })
    await flushPromises()

    // No injected handler element exists; the payload rides the inert escaped :alt.
    expect(wrapper.find('img[onerror]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="attachment-image"]').attributes('alt')).toBe(payload)
  })

  it('dedupes a repeated file_id to a single rendered attachment', async () => {
    // The query does NOT dedupe (ENG-120 nit): it returns the same row twice.
    const dup = fileRow({ file_id: 'f_img', mime_type: 'image/png' })
    setWorkerClient(fakeClient({ files: [dup, dup] }))
    const wrapper = mount(MessageItem, { props: { message: makeMessage(['f_img', 'f_img']) } })
    await flushPromises()

    expect(wrapper.findAll('[data-testid="attachment-image"]')).toHaveLength(1)
  })

  it('renders a not-yet-projected id as a pending placeholder', async () => {
    setWorkerClient(fakeClient({ pending: ['f_soon'] }))
    const wrapper = mount(MessageItem, { props: { message: makeMessage(['f_soon']) } })
    await flushPromises()

    expect(wrapper.findAll('[data-testid="attachment-pending"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="attachment-pending"]').text()).toContain('loading')
  })
})
