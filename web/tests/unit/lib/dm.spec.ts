// tests/unit/lib/dm.spec.ts — ENG-149 DM participant resolution. Pure-function
// coverage of the tab-side helpers the sidebar / conversation header / Inbox all
// share: pick the OTHER participant of a DM (presence target) and build the DM's
// display label (directory name, short-id fallback, self-DM, group-DM join).
import { describe, expect, it } from 'vitest'

import { dmDisplayName, dmOtherUserId, shortUserId } from '../../../src/lib/dm'

const NAMES = new Map([
  ['u_me', 'Me Myself'],
  ['u_dana', 'Dana'],
  ['u_sam', 'Sam'],
])

describe('dmOtherUserId (ENG-149)', () => {
  it('picks the one participant that is not me (1:1 DM)', () => {
    expect(dmOtherUserId(['u_me', 'u_dana'], 'u_me')).toBe('u_dana')
    expect(dmOtherUserId(['u_dana', 'u_me'], 'u_me')).toBe('u_dana')
  })

  it('resolves a self-DM to myself', () => {
    expect(dmOtherUserId(['u_me'], 'u_me')).toBe('u_me')
    // Duplicated self entries dedupe to the same self-DM.
    expect(dmOtherUserId(['u_me', 'u_me'], 'u_me')).toBe('u_me')
  })

  it('is undefined for unknown participants (no cached genesis) or an empty list', () => {
    expect(dmOtherUserId(undefined, 'u_me')).toBeUndefined()
    expect(dmOtherUserId([], 'u_me')).toBeUndefined()
  })

  it('is undefined for a group DM (>1 other — no single counterpart)', () => {
    expect(dmOtherUserId(['u_me', 'u_dana', 'u_sam'], 'u_me')).toBeUndefined()
  })

  it('dedupes duplicate ids before deciding 1:1 vs group', () => {
    expect(dmOtherUserId(['u_me', 'u_dana', 'u_dana'], 'u_me')).toBe('u_dana')
  })
})

describe('dmDisplayName (ENG-149)', () => {
  it('labels a 1:1 DM with the other participant’s directory name', () => {
    expect(dmDisplayName(['u_me', 'u_dana'], 'u_me', NAMES)).toBe('Dana')
  })

  it('falls back to a short id for a participant missing from the directory', () => {
    expect(dmDisplayName(['u_me', 'u_01KWABCDEFGHJKMNPQRSTVWXYZ'], 'u_me', NAMES)).toBe('u_01KWAB…')
  })

  it('labels a self-DM with my own name', () => {
    expect(dmDisplayName(['u_me'], 'u_me', NAMES)).toBe('Me Myself')
  })

  it('labels a group DM with the joined other-participant names', () => {
    expect(dmDisplayName(['u_me', 'u_dana', 'u_sam'], 'u_me', NAMES)).toBe('Dana, Sam')
  })

  it('is undefined when the participants are unknown (caller keeps its fallback)', () => {
    expect(dmDisplayName(undefined, 'u_me', NAMES)).toBeUndefined()
    expect(dmDisplayName([], 'u_me', NAMES)).toBeUndefined()
  })

  it('still resolves when myUserId is unknown (labels every participant)', () => {
    expect(dmDisplayName(['u_me', 'u_dana'], undefined, NAMES)).toBe('Me Myself, Dana')
  })
})

describe('shortUserId', () => {
  it('truncates long ids with an ellipsis and keeps short ids verbatim', () => {
    expect(shortUserId('u_01KWABCDEFGHJKMNPQRSTVWXYZ')).toBe('u_01KWAB…')
    expect(shortUserId('u_short')).toBe('u_short')
  })
})
