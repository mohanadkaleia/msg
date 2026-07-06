// tests/unit/worker/helpers.ts — hermetic fakes for the worker unit suites.
// fake-indexeddb is injected via an IDBFactory (not the `/auto` global) so
// tests stay isolated; the leader tests get fake locks + a fake channel bus.

import { IDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'
import type { DexieOptions } from 'dexie'

import { DexieDb, MsgDB } from '../../../src/worker/db'
import type { ChannelLike, LockManagerLike } from '../../../src/worker/leader'
import type { FromWorker, MessageSink } from '../../../src/worker/types'

/** A fresh in-memory IndexedDB layer for a single test's Dexie DB. */
export function fakeIdbOptions(): DexieOptions {
  return {
    indexedDB: new IDBFactory(),
    IDBKeyRange: FakeIDBKeyRange,
  }
}

/** A persistent DexieDb on a private fake-indexeddb instance. */
export function makeFakeMsgDB(): MsgDB {
  return new MsgDB(fakeIdbOptions())
}

export function makeFakeDexieDb(): DexieDb {
  return new DexieDb(makeFakeMsgDB())
}

/** A MessageSink that records every frame it is handed. */
export function collectingSink(): {
  sink: MessageSink
  frames: Array<{ clientId: string; msg: FromWorker }>
} {
  const frames: Array<{ clientId: string; msg: FromWorker }> = []
  const sink: MessageSink = (clientId, msg) => {
    frames.push({ clientId, msg })
  }
  return { sink, frames }
}

/** Drain the microtask queue a few times so async plumbing settles. */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Poll `fn` across microtask ticks until it is true (or throw). */
export async function until(fn: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return
    await Promise.resolve()
  }
  throw new Error('until(): condition never became true')
}

// ---------------------------------------------------------------------------
// Fake Web Locks — models a single exclusive lock per name with a FIFO queue.
// A waiter's callback runs only once it holds the lock; releasing (the callback
// promise settling) promotes the next waiter. Exactly one holder at a time.
// ---------------------------------------------------------------------------

export class FakeLockManager implements LockManagerLike {
  private readonly held = new Set<string>()
  private readonly queues = new Map<string, Array<() => void>>()

  request(
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void> {
    void options
    return new Promise<void>((resolveRequest) => {
      const release = (): void => {
        this.held.delete(name)
        resolveRequest()
        const next = this.queues.get(name)?.shift()
        if (next) next()
      }
      const attempt = (): void => {
        this.held.add(name)
        void Promise.resolve(callback(null)).finally(release)
      }
      if (this.held.has(name)) {
        const q = this.queues.get(name) ?? []
        q.push(attempt)
        this.queues.set(name, q)
      } else {
        attempt()
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Fake BroadcastChannel bus — postMessage fans out to every OTHER channel on
// the bus (never the sender), asynchronously and structured-cloned, like the
// real API.
// ---------------------------------------------------------------------------

export class FakeChannelBus {
  private readonly channels = new Set<FakeChannel>()

  create(): ChannelLike {
    const ch = new FakeChannel(this)
    this.channels.add(ch)
    return ch
  }

  deliver(from: FakeChannel, data: unknown): void {
    for (const ch of this.channels) {
      if (ch !== from) ch.receive(data)
    }
  }

  remove(ch: FakeChannel): void {
    this.channels.delete(ch)
  }
}

class FakeChannel implements ChannelLike {
  private readonly listeners = new Set<(ev: MessageEvent) => void>()

  constructor(private readonly bus: FakeChannelBus) {}

  postMessage(data: unknown): void {
    const clone = structuredClone(data)
    queueMicrotask(() => {
      this.bus.deliver(this, clone)
    })
  }

  addEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  close(): void {
    this.listeners.clear()
    this.bus.remove(this)
  }

  receive(data: unknown): void {
    const ev = { data } as MessageEvent
    for (const l of this.listeners) l(ev)
  }
}
