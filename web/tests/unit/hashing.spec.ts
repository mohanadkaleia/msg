// @vitest-environment node
//
// hashEvent shape, determinism, and the §2.1 anchor. Node env for crypto.subtle
// (jsdom does not expose SubtleCrypto).

import { describe, expect, it } from 'vitest'

import { HASH_ALGORITHM, hashEvent } from '../../src/core/hashing'
import { JCSError, parseJcsJson } from '../../src/core/jcs'

const ANCHOR_INPUT =
  '{"event_id":"01JZ7N6A4M6Y8W5K2H7DGKX4PA","workspace_id":"w_01JZ7N6A4M6Y8W5K2H7DGKX4PB","stream_id":"s_01JZ7N6A4M6Y8W5K2H7DGKX4PC","type":"message.created","type_version":1,"author_user_id":"u_01JZ7N6A4M6Y8W5K2H7DGKX4PD","author_device_id":"d_01JZ7N6A4M6Y8W5K2H7DGKX4PE","client_created_at":"2026-07-04T18:22:10.123Z","payload":{"message_id":"m_01JZ7N6A4M6Y8W5K2H7DGKX4PF","text":"Hello everyone","format":"markdown","thread_root_id":null,"file_ids":[],"mentions":["u_01JZ7N6A4M6Y8W5K2H7DGKX4PG"]}}'

const ANCHOR_HASH = 'sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51'

describe('hashEvent', () => {
  it('exposes the sha256 algorithm constant', () => {
    expect(HASH_ALGORITHM).toBe('sha256')
  })

  it('produces the sha256:<64-hex> shape', async () => {
    const hash = await hashEvent({ a: 1 })
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('is deterministic and key-order independent', async () => {
    const a = await hashEvent({ b: 1, a: 2 })
    const b = await hashEvent({ a: 2, b: 1 })
    expect(a).toBe(b)
  })

  it('matches the frozen §2.1 anchor hash', async () => {
    expect(await hashEvent(parseJcsJson(ANCHOR_INPUT))).toBe(ANCHOR_HASH)
  })

  it('propagates JCSError for out-of-domain input (does not swallow)', async () => {
    await expect(hashEvent(Infinity)).rejects.toThrow(JCSError)
  })
})
