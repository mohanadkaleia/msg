import { describe, expect, it, vi } from 'vitest'

import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb } from '../../../src/worker/db'
import {
  EphemeralState,
  TYPING_SEND_THROTTLE_MS,
  TYPING_TTL_MS,
} from '../../../src/worker/presence'
import {
  META_DEVICE_ID,
  META_MY_USER_ID,
  META_PROJECTION_VERSION,
  META_ROLE,
  META_SESSION_EXPIRES_AT,
  META_SESSION_TOKEN,
  META_WORKSPACE_ID,
  PROJECTION_VERSION,
  type MsgDb,
  type PresencePush,
  type TypingPush,
} from '../../../src/worker/types'

import { collectingSink, FakeHttpClient, FakeSyncServer, flush, makeFakeWsFactory } from './helpers'

/** A deterministic interval clock (setInterval-only) for the sweeper/TTL/throttle. */
class FakeIntervalClock {
  t = 0
  private nextId = 1
  private readonly intervals = new Map<number, { cb: () => void; ms: number; next: number }>()
  now = (): number => this.t
  setInterval = (cb: () => void, ms: number): number => {
    const id = this.nextId++
    this.intervals.set(id, { cb, ms, next: this.t + ms })
    return id
  }
  clearInterval = (id: number): void => {
    this.intervals.delete(id)
  }
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      let due: { id: number; iv: { cb: () => void; ms: number; next: number } } | undefined
      for (const [id, iv] of this.intervals) {
        if (iv.next <= target && (!due || iv.next < due.iv.next)) due = { id, iv }
      }
      if (!due) break
      this.t = due.iv.next
      due.iv.next += due.iv.ms
      due.iv.cb()
    }
    this.t = target
  }
}

interface EphHarness {
  eph: EphemeralState
  clock: FakeIntervalClock
  presence: PresencePush[]
  typing: TypingPush[]
  sent: string[]
}

function makeEph(): EphHarness {
  const clock = new FakeIntervalClock()
  const presence: PresencePush[] = []
  const typing: TypingPush[] = []
  const sent: string[] = []
  const eph = new EphemeralState({
    publishPresence: (p) => presence.push(p),
    publishTyping: (_s, p) => typing.push(p),
    sendTyping: (s) => sent.push(s),
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  })
  return { eph, clock, presence, typing, sent }
}

describe('EphemeralState presence (ENG-126, memory-only)', () => {
  it('applies a presence frame + pushes the full snapshot', () => {
    const h = makeEph()
    h.eph.applyPresence({ user_id: 'u1', status: 'online' })
    h.eph.applyPresence({ user_id: 'u2', status: 'offline' })

    expect(h.eph.snapshotPresence()).toEqual([
      { user_id: 'u1', status: 'online' },
      { user_id: 'u2', status: 'offline' },
    ])
    // Each frame published the current full snapshot (late subscribers seed from it).
    expect(h.presence.at(-1)?.presence).toHaveLength(2)
  })
})

describe('EphemeralState typing (ENG-126, TTL + sweep)', () => {
  it('applies a typing frame + pushes the stream set', () => {
    const h = makeEph()
    h.eph.applyTyping({ stream_id: 's1', user_id: 'u1' })
    expect(h.eph.snapshotTyping('s1')).toEqual(['u1'])
    expect(h.typing.at(-1)).toEqual({ stream_id: 's1', user_ids: ['u1'] })
  })

  it('auto-expires a typing entry ~5s later and republishes the (now empty) set', () => {
    const h = makeEph()
    h.eph.applyTyping({ stream_id: 's1', user_id: 'u1' })
    expect(h.eph.snapshotTyping('s1')).toEqual(['u1'])

    h.clock.advance(TYPING_TTL_MS + 500) // fire the sweeper past the TTL
    // The sweeper dropped the expired entry and republished an empty set.
    expect(h.eph.snapshotTyping('s1')).toEqual([])
    expect(h.typing.at(-1)).toEqual({ stream_id: 's1', user_ids: [] })
  })

  it('re-arms the TTL on a fresh frame (a typer that keeps typing stays live)', () => {
    const h = makeEph()
    h.eph.applyTyping({ stream_id: 's1', user_id: 'u1' })
    h.clock.advance(TYPING_TTL_MS - 1000)
    h.eph.applyTyping({ stream_id: 's1', user_id: 'u1' }) // refresh
    h.clock.advance(2000) // past the ORIGINAL expiry, before the refreshed one
    expect(h.eph.snapshotTyping('s1')).toEqual(['u1'])
  })
})

describe('EphemeralState outbound typing throttle (ENG-126, ~333ms leading edge)', () => {
  it('collapses two calls inside the window into ONE signal, fires again after', () => {
    const h = makeEph()
    h.eph.sendTyping('s1')
    h.eph.sendTyping('s1') // same instant → throttled
    expect(h.sent).toEqual(['s1'])

    h.clock.advance(TYPING_SEND_THROTTLE_MS - 1)
    h.eph.sendTyping('s1') // still inside the window → throttled
    expect(h.sent).toEqual(['s1'])

    h.clock.advance(2) // now past the window
    h.eph.sendTyping('s1')
    expect(h.sent).toEqual(['s1', 's1'])
  })

  it('throttles per stream independently', () => {
    const h = makeEph()
    h.eph.sendTyping('s1')
    h.eph.sendTyping('s2') // a different stream is not throttled by s1
    expect(h.sent).toEqual(['s1', 's2'])
  })
})

describe('EphemeralState.clearAll (ENG-126, wiped on leaving live)', () => {
  it('wipes both maps and notifies subscribers', () => {
    const h = makeEph()
    h.eph.applyPresence({ user_id: 'u1', status: 'online' })
    h.eph.applyTyping({ stream_id: 's1', user_id: 'u1' })

    h.eph.clearAll()

    expect(h.eph.snapshotPresence()).toEqual([])
    expect(h.eph.snapshotTyping('s1')).toEqual([])
    // The clear pushed an empty presence snapshot + an empty typing set for s1.
    expect(h.presence.at(-1)?.presence).toEqual([])
    expect(h.typing.at(-1)).toEqual({ stream_id: 's1', user_ids: [] })
  })
})

// ---------------------------------------------------------------------------
// NEGATIVE GUARD: presence/typing frames NEVER touch Dexie (structural — the
// module has no db handle). Exercised end-to-end through WorkerCore's signal
// router so the whole path (SyncEngine → onSignalFrame → EphemeralState) is real.
// ---------------------------------------------------------------------------

async function seedSession(db: MsgDb): Promise<void> {
  await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION)
  await db.metaPut(META_SESSION_TOKEN, 'tok_secret')
  await db.metaPut(META_MY_USER_ID, 'u_me')
  await db.metaPut(META_WORKSPACE_ID, 'w_me')
  await db.metaPut(META_ROLE, 'member')
  await db.metaPut(META_SESSION_EXPIRES_AT, '2099-01-01T00:00:00Z')
  await db.metaPut(META_DEVICE_ID, 'd_me')
}

describe('signal frames never persist (negative guard, ENG-126)', () => {
  it('leaves events/messages/read_state/prefs row counts unchanged after presence+typing frames', async () => {
    const db = new MemoryDb()
    await seedSession(db)
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const { wsFactory, last } = makeFakeWsFactory()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink, { http, wsFactory })
    await core.init()
    last().open()
    await flush()

    // Subscribe a client to presence + typing so we can assert the push landed.
    await core.handle('c1', { t: 'sub', id: 'sp', clientId: 'c1', topic: { kind: 'presence' } })
    await core.handle('c1', {
      t: 'sub',
      id: 'st',
      clientId: 'c1',
      topic: { kind: 'typing', stream_id: 's1' },
    })

    const before = {
      events: await db.count('events'),
      messages: await db.count('messages'),
      read_state: await db.count('read_state'),
      prefs: await db.count('prefs'),
    }

    // A burst of ephemeral signal frames on the live socket.
    last().emit({ t: 'presence', user_id: 'u_x', status: 'online' })
    last().emit({ t: 'typing', stream_id: 's1', user_id: 'u_x' })
    await flush()

    const after = {
      events: await db.count('events'),
      messages: await db.count('messages'),
      read_state: await db.count('read_state'),
      prefs: await db.count('prefs'),
    }
    expect(after).toEqual(before)

    // …but the pushes DID reach the subscriber (memory-only reactivity works).
    const presencePush = frames.find(
      (f) => f.msg.t === 'push' && f.msg.topic.kind === 'presence',
    )?.msg
    const typingPush = frames.find((f) => f.msg.t === 'push' && f.msg.topic.kind === 'typing')?.msg
    expect(presencePush && presencePush.t === 'push').toBe(true)
    if (presencePush && presencePush.t === 'push') {
      expect((presencePush.payload as PresencePush).presence).toContainEqual({
        user_id: 'u_x',
        status: 'online',
      })
    }
    expect(typingPush && typingPush.t === 'push').toBe(true)
    if (typingPush && typingPush.t === 'push') {
      expect((typingPush.payload as TypingPush).user_ids).toEqual(['u_x'])
    }
    await db.close()
  })

  it('ignores a malformed presence/typing frame (D9) without throwing or persisting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const db = new MemoryDb()
    await seedSession(db)
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const { wsFactory, last } = makeFakeWsFactory()
    const { sink } = collectingSink()
    const core = new WorkerCore(db, sink, { http, wsFactory })
    await core.init()
    last().open()
    await flush()

    // Missing/typo'd fields — must be ignored, never crash.
    last().emit({ t: 'presence', status: 'online' } as unknown as { t: string })
    last().emit({ t: 'typing', user_id: 'u' } as unknown as { t: string })
    await flush()

    expect(await db.count('read_state')).toBe(0)
    expect(await db.count('prefs')).toBe(0)
    warn.mockRestore()
    await db.close()
  })
})
