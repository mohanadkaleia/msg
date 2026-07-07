// tests/unit/file-payloads.spec.ts — the ENG-114 file.uploaded payload builder
// (TS port of server/msgd/core/payloads/file.py). Format-validation only; the
// bounds/domain rules must accept/reject the SAME values as the Python model so
// the frozen cross-language contract holds. Blob existence + the 50 MB business
// cap are server concerns (ENG-116), not enforced here.

import { describe, expect, it } from 'vitest'

import {
  MAX_FILE_NAME_BYTES,
  MAX_FILE_SIZE_BYTES,
  buildFileUploadedPayload,
  newFileId,
  newMessageId,
} from '../../src/core'
import type { BuildFileUploadedPayloadOptions } from '../../src/core'

const GOOD_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const fileOptions = (
  overrides: Partial<BuildFileUploadedPayloadOptions> = {},
): BuildFileUploadedPayloadOptions => ({
  file_id: newFileId(),
  sha256: GOOD_SHA,
  name: 'diagram.png',
  mime_type: 'image/png',
  size_bytes: 15243,
  ...overrides,
})

describe('file.uploaded payload (format validation only)', () => {
  it('accepts a well-formed descriptor', () => {
    const f = buildFileUploadedPayload(fileOptions())
    expect(f.mime_type).toBe('image/png')
    expect(f.size_bytes).toBe(15243)
    expect(f.sha256).toBe(GOOD_SHA)
  })

  it('rejects a bad file_id prefix', () => {
    expect(() => buildFileUploadedPayload(fileOptions({ file_id: newMessageId() }))).toThrow()
  })

  it('rejects an empty name and accepts a 255-byte name', () => {
    expect(() => buildFileUploadedPayload(fileOptions({ name: '' }))).toThrow()
    const name = 'a'.repeat(MAX_FILE_NAME_BYTES)
    expect(buildFileUploadedPayload(fileOptions({ name })).name).toBe(name)
    expect(() =>
      buildFileUploadedPayload(fileOptions({ name: 'a'.repeat(MAX_FILE_NAME_BYTES + 1) })),
    ).toThrow()
  })

  it.each([
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // prefixed form
    'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855', // uppercase
    'deadbeef', // too short
    'a'.repeat(65), // too long
    'g'.repeat(64), // non-hex
    '', // empty
  ])('rejects malformed sha256: %s', (bad) => {
    expect(() => buildFileUploadedPayload(fileOptions({ sha256: bad }))).toThrow()
  })

  it.each(['png', 'image/', '/png', 'image/png/extra', ''])(
    'rejects malformed mime_type: %s',
    (bad) => {
      expect(() => buildFileUploadedPayload(fileOptions({ mime_type: bad }))).toThrow()
    },
  )

  it('bounds size_bytes to a non-negative in-cap integer', () => {
    expect(buildFileUploadedPayload(fileOptions({ size_bytes: 0 })).size_bytes).toBe(0)
    expect(
      buildFileUploadedPayload(fileOptions({ size_bytes: MAX_FILE_SIZE_BYTES })).size_bytes,
    ).toBe(MAX_FILE_SIZE_BYTES)
    expect(() => buildFileUploadedPayload(fileOptions({ size_bytes: -1 }))).toThrow()
    expect(() =>
      buildFileUploadedPayload(fileOptions({ size_bytes: MAX_FILE_SIZE_BYTES + 1 })),
    ).toThrow()
    expect(() => buildFileUploadedPayload(fileOptions({ size_bytes: 1.5 }))).toThrow()
  })
})
