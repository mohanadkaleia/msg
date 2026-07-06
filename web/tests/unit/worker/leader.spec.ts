import { describe, expect, it } from 'vitest'

import { MemoryDb } from '../../../src/worker/db'
import { LeaderNode } from '../../../src/worker/leader'
import type { FromWorker, MsgDb } from '../../../src/worker/types'

import { FakeChannelBus, FakeLockManager, until } from './helpers'

const openMemory = (): Promise<MsgDb> => Promise.resolve(new MemoryDb())

function makeNode(clientId: string, bus: FakeChannelBus, locks: FakeLockManager): LeaderNode {
  return new LeaderNode({ clientId, locks, channel: bus.create(), openDb: openMemory })
}

describe('LeaderNode election (D-1, split-brain guarantee)', () => {
  it('elects exactly one leader; the other tab is a follower', async () => {
    const bus = new FakeChannelBus()
    const locks = new FakeLockManager()
    const a = makeNode('A', bus, locks)
    const b = makeNode('B', bus, locks)
    a.start()
    b.start()

    await until(() => a.isLeader())

    expect(a.isLeader()).toBe(true)
    expect(b.isLeader()).toBe(false)
    expect([a, b].filter((n) => n.isLeader())).toHaveLength(1)

    a.dispose()
    b.dispose()
  })

  it('routes a follower request through the channel to the leader and back', async () => {
    const bus = new FakeChannelBus()
    const locks = new FakeLockManager()
    const leader = makeNode('A', bus, locks)
    const follower = makeNode('B', bus, locks)
    leader.start()
    follower.start()
    await until(() => leader.isLeader())

    const received: FromWorker[] = []
    follower.setFrameHandler((f) => received.push(f))

    follower.post({ t: 'req', id: 'r1', clientId: 'B', req: { method: 'ping', params: {} } })

    await until(() => received.some((f) => f.t === 'res'))
    expect(received.find((f) => f.t === 'res')).toMatchObject({
      t: 'res',
      id: 'r1',
      ok: true,
      result: { pong: true },
    })

    leader.dispose()
    follower.dispose()
  })

  it('promotes the next waiter on leader release — never two writers', async () => {
    const bus = new FakeChannelBus()
    const locks = new FakeLockManager()
    const a = makeNode('A', bus, locks)
    const b = makeNode('B', bus, locks)
    a.start()
    b.start()
    await until(() => a.isLeader())
    expect(b.isLeader()).toBe(false)

    // Leader tab closes: its lock releases, promoting the waiter.
    a.dispose()
    await until(() => b.isLeader())

    expect(b.isLeader()).toBe(true)
    expect(a.isLeader()).toBe(false)
    // The invariant: at most one live WorkerCore/writer at any time.
    expect([a, b].filter((n) => n.isLeader())).toHaveLength(1)

    b.dispose()
  })

  it('the promoted leader answers requests from a remaining follower', async () => {
    const bus = new FakeChannelBus()
    const locks = new FakeLockManager()
    const a = makeNode('A', bus, locks)
    const b = makeNode('B', bus, locks)
    const c = makeNode('C', bus, locks)
    a.start()
    b.start()
    c.start()
    await until(() => a.isLeader())

    a.dispose()
    await until(() => b.isLeader())

    const received: FromWorker[] = []
    c.setFrameHandler((f) => received.push(f))
    c.post({ t: 'req', id: 'r9', clientId: 'C', req: { method: 'ping', params: {} } })

    await until(() => received.some((f) => f.t === 'res'))
    expect(received.find((f) => f.t === 'res')).toMatchObject({ id: 'r9', ok: true })

    b.dispose()
    c.dispose()
  })
})
