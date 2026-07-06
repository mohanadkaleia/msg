// worker/leader.ts — the Web Locks leader-election transport (D-1), the
// Safari-<16 fallback for SharedWorker. One tab wins a single exclusive lock
// held for its lifetime and hosts a WorkerCore in-page; other tabs are
// followers that proxy over a BroadcastChannel. On leader tab close the lock
// releases and the next waiter is promoted — exactly one WorkerCore (the only
// writer) ever exists, which is the split-brain guarantee (risk 1).
//
// Everything platform-specific is injected (`locks`, `channel`, `openDb`) so
// the whole election + routing path is unit-testable with fakes.

import { WorkerCore } from './core'
import type { FromWorker, MsgDb, ToWorker, Transport, Unsubscribe, WorkerStatus } from './types'

const DEFAULT_LOCK_NAME = 'msg-worker-leader'

/** Minimal `BroadcastChannel` shape the leader needs (real BC satisfies it). */
export interface ChannelLike {
  postMessage(data: unknown): void
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void
  close(): void
}

/** Minimal `navigator.locks` shape (real LockManager satisfies it). */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>
}

export interface LeaderNodeDeps {
  clientId: string
  locks: LockManagerLike
  channel: ChannelLike
  openDb: () => Promise<MsgDb>
  lockName?: string
}

// Wire envelopes on the shared BroadcastChannel. `to-worker` is processed only
// by the leader; `from-worker` is addressed to one client; `control` drives
// election announcements.
type ChannelEnvelope =
  | { dir: 'to-worker'; frame: ToWorker }
  | { dir: 'from-worker'; target: string; frame: FromWorker }
  | { dir: 'control'; kind: 'whois' | 'leader-online'; from: string }

export class LeaderNode {
  private core: WorkerCore | undefined
  private db: MsgDb | undefined
  private role: 'leader' | 'follower' = 'follower'
  private frameHandler: ((f: FromWorker) => void) | undefined
  private readonly statusHandlers = new Set<(s: WorkerStatus) => void>()
  private releaseLock: (() => void) | undefined
  private readonly readyPromise: Promise<void>
  private resolveReadyFn: (() => void) | undefined
  private readyResolved = false
  private started = false
  private disposed = false
  private readonly onMessage = (ev: MessageEvent): void => {
    this.onChannelMessage(ev.data)
  }

  constructor(private readonly deps: LeaderNodeDeps) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReadyFn = resolve
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.deps.channel.addEventListener('message', this.onMessage)
    // Prompt any existing leader to announce itself (fast follower ready-path).
    this.broadcast({ dir: 'control', kind: 'whois', from: this.deps.clientId })
    // Contend for leadership; the callback holds the exclusive lock for this
    // tab's whole lifetime, releasing only on dispose / tab close.
    void this.deps.locks.request(
      this.deps.lockName ?? DEFAULT_LOCK_NAME,
      { mode: 'exclusive' },
      async () => {
        await this.becomeLeader()
        if (this.disposed) return
        await new Promise<void>((resolve) => {
          this.releaseLock = resolve
        })
      },
    )
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  post(frame: ToWorker): void {
    if (this.role === 'leader' && this.core) {
      void this.core.handle(this.deps.clientId, frame)
    } else {
      this.broadcast({ dir: 'to-worker', frame })
    }
  }

  setFrameHandler(cb: (f: FromWorker) => void): void {
    this.frameHandler = cb
  }

  onStatus(handler: (s: WorkerStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler)
    return () => {
      this.statusHandlers.delete(handler)
    }
  }

  status(): WorkerStatus {
    return { transport: 'leader', db: this.dbCapability(), role: this.role }
  }

  isLeader(): boolean {
    // A disposed tab is not a live leader even though its lock callback may
    // still be unwinding — this is the split-brain invariant tests assert on.
    return this.role === 'leader' && !this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Notify the current writer this tab is leaving (no-op if we are leader).
    this.post({ t: 'bye', clientId: this.deps.clientId })
    this.deps.channel.removeEventListener('message', this.onMessage)
    if (this.releaseLock) this.releaseLock()
    if (this.role === 'leader' && this.db) void this.db.close()
    try {
      this.deps.channel.close()
    } catch {
      /* channel already closed */
    }
  }

  private async becomeLeader(): Promise<void> {
    if (this.disposed) return
    const db = await this.deps.openDb()
    if (this.disposed) {
      void db.close()
      return
    }
    this.db = db
    const core = new WorkerCore(db, (targetClientId, msg) => {
      if (targetClientId === this.deps.clientId) {
        this.frameHandler?.(msg)
      } else {
        this.broadcast({ dir: 'from-worker', target: targetClientId, frame: msg })
      }
    })
    await core.init()
    if (this.disposed) {
      void db.close()
      return
    }
    this.core = core
    this.role = 'leader'
    void core.handle(this.deps.clientId, { t: 'hello', clientId: this.deps.clientId })
    this.broadcast({ dir: 'control', kind: 'leader-online', from: this.deps.clientId })
    this.resolveReadyOnce()
    this.emitStatus()
  }

  private onChannelMessage(data: unknown): void {
    const m = data as ChannelEnvelope
    switch (m.dir) {
      case 'to-worker':
        // Only the leader owns the WorkerCore; followers ignore requests.
        if (this.role === 'leader' && this.core) {
          void this.core.handle(m.frame.clientId, m.frame)
        }
        return
      case 'from-worker':
        if (m.target === this.deps.clientId) this.frameHandler?.(m.frame)
        return
      case 'control':
        if (m.from === this.deps.clientId) return
        if (m.kind === 'whois' && this.role === 'leader') {
          this.broadcast({ dir: 'control', kind: 'leader-online', from: this.deps.clientId })
        } else if (m.kind === 'leader-online' && this.role !== 'leader') {
          this.resolveReadyOnce()
        }
        return
    }
  }

  private broadcast(env: ChannelEnvelope): void {
    this.deps.channel.postMessage(env)
  }

  private dbCapability(): 'persistent' | 'memory' {
    if (this.db) return this.db.persistence
    // Follower: the owning DB lives in the leader tab. Approximate from this
    // tab's own IndexedDB availability at the shell stage — revisit if/when the
    // UI shows a real persistence indicator (deferred review nit).
    return typeof indexedDB !== 'undefined' ? 'persistent' : 'memory'
  }

  private resolveReadyOnce(): void {
    if (this.readyResolved) return
    this.readyResolved = true
    this.resolveReadyFn?.()
  }

  private emitStatus(): void {
    const s = this.status()
    for (const h of this.statusHandlers) h(s)
  }
}

/** Build a leader/follower `Transport` and start contending for leadership. */
export function createLeaderTransport(deps: LeaderNodeDeps): Transport {
  const node = new LeaderNode(deps)
  node.start()
  return {
    post: (f) => {
      node.post(f)
    },
    onFrame: (cb) => {
      node.setFrameHandler(cb)
    },
    ready: () => node.ready(),
    status: () => node.status(),
    onStatus: (cb) => node.onStatus(cb),
    dispose: () => {
      node.dispose()
    },
  }
}
