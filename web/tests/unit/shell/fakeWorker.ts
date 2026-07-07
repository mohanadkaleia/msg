// tests/unit/shell/fakeWorker.ts — a browser-free fake WorkerClient for the shell
// tests. It backs `query`/`mutate`/`subscribe`/`sync` with an in-memory projection
// and exposes a `fetch` spy that is NEVER called by any read path — so a test can
// assert channel switching (and every other projection read) is ZERO-network. It
// mirrors how the worker layer is tested: everything injected, no SharedWorker.
import { vi } from 'vitest'

import { newEventId, newMessageId } from '../../../src/core'
import { topicKey } from '../../../src/worker/types'
import type {
  BackfillResult,
  DirectoryChannel,
  DirectoryUser,
  MessageRow,
  MutateParams,
  MutateResult,
  PushPayload,
  QueryParams,
  QueryResult,
  StreamBadge,
  StreamRow,
  SyncStatus,
  Topic,
  Unsubscribe,
  WorkerClient,
} from '../../../src/worker'

type SidebarStream = StreamRow & StreamBadge

export class FakeWorker {
  /** The HTTP escape hatch that must stay untouched by projection reads. */
  readonly fetch = vi.fn()
  /** Spies so tests can assert exactly which RPCs a flow drives. */
  readonly querySpy = vi.fn()
  readonly backfillSpy = vi.fn()
  readonly retrySpy = vi.fn<(eventId: string) => void>()
  readonly deleteSpy = vi.fn<(eventId: string) => void>()
  /** Captures every `outbox.send` params object (text + mentions assertions). */
  readonly sendSpy = vi.fn<(params: Extract<MutateParams, { m: 'outbox.send' }>) => void>()

  private streams = new Map<string, SidebarStream>()
  /** The @mention / #channel autocomplete source a `directory.list` returns. */
  private directory: { users: DirectoryUser[]; channels: DirectoryChannel[] } = {
    users: [],
    channels: [],
  }
  /** Ascending-by-created_seq message rows per stream. */
  private messages = new Map<string, MessageRow[]>()
  private subs = new Map<string, Set<(p: unknown) => void>>()
  private syncStatus: SyncStatus = { state: 'live', online: true }
  private myUserId = 'u_me'

  /** A configurable older-page the next `sync.backfill` reveals (oldest first). */
  private pendingBackfill: MessageRow[] = []

  // -- setup helpers -------------------------------------------------------

  setMyUserId(id: string): this {
    this.myUserId = id
    return this
  }

  addStream(stream: Partial<SidebarStream> & { stream_id: string }): this {
    this.streams.set(stream.stream_id, {
      kind: 'channel',
      name: stream.stream_id,
      head_seq: 0,
      member: true,
      unread: 0,
      mention: false,
      ...stream,
    })
    return this
  }

  /** Seed a settled message (real ULID id so its timestamp decodes). */
  addMessage(streamId: string, opts: Partial<MessageRow> & { created_seq: number }): MessageRow {
    const row: MessageRow = {
      message_id: opts.message_id ?? newMessageId(),
      stream_id: streamId,
      author_user_id: opts.author_user_id ?? 'u_other',
      text: opts.text ?? 'hello',
      format: opts.format ?? 'plain',
      mention_user_ids: opts.mention_user_ids ?? [],
      created_seq: opts.created_seq,
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.error_code ? { error_code: opts.error_code } : {}),
    }
    const list = this.messages.get(streamId) ?? []
    list.push(row)
    list.sort((a, b) => a.created_seq - b.created_seq)
    this.messages.set(streamId, list)
    return row
  }

  /** Seed the @mention / #channel autocomplete source a `directory.list` returns. */
  setDirectory(users: DirectoryUser[], channels: DirectoryChannel[]): this {
    this.directory = { users, channels }
    return this
  }

  /** Mutate a stream's badge, then publish so subscribers re-query. */
  setBadge(streamId: string, badge: Partial<StreamBadge>): void {
    const stream = this.streams.get(streamId)
    if (stream) {
      Object.assign(stream, badge)
      this.publishStream(streamId)
    }
  }

  /** Queue an older page (created_seq below the current floor) for the next backfill. */
  queueBackfill(
    streamId: string,
    rows: Array<Partial<MessageRow> & { created_seq: number }>,
  ): void {
    this.pendingBackfill = rows.map((r) => ({
      message_id: r.message_id ?? newMessageId(),
      stream_id: streamId,
      author_user_id: r.author_user_id ?? 'u_other',
      text: r.text ?? 'old',
      format: r.format ?? 'plain',
      mention_user_ids: r.mention_user_ids ?? [],
      created_seq: r.created_seq,
    }))
  }

  /** Settle a pending row in place (server ack): drop `state`, set the server seq. */
  settle(messageId: string, serverSeq: number): void {
    for (const [streamId, list] of this.messages) {
      const row = list.find((m) => m.message_id === messageId)
      if (row) {
        delete row.state
        delete row.error_code
        row.created_seq = serverSeq
        list.sort((a, b) => a.created_seq - b.created_seq)
        this.publishStream(streamId)
        return
      }
    }
  }

  /** Mark a pending row failed (server reject). */
  fail(messageId: string, code = 'rejected'): void {
    for (const [streamId, list] of this.messages) {
      const row = list.find((m) => m.message_id === messageId)
      if (row) {
        row.state = 'failed'
        row.error_code = code
        this.publishStream(streamId)
        return
      }
    }
  }

  emitSync(status: SyncStatus): void {
    this.syncStatus = status
    for (const h of this.subs.get('sync') ?? []) h(status)
  }

  publishStream(streamId: string): void {
    const payload: PushPayload<{ kind: 'stream'; stream_id: string }> = { stream_id: streamId }
    for (const h of this.subs.get(`stream:${streamId}`) ?? []) h(payload)
  }

  // -- WorkerClient surface ------------------------------------------------

  private query = <Q extends QueryParams>(params: Q): Promise<QueryResult<Q>> => {
    this.querySpy(params)
    if (params.q === 'streams.list') {
      return Promise.resolve({ streams: [...this.streams.values()] } as QueryResult<Q>)
    }
    if (params.q === 'directory.list') {
      return Promise.resolve({
        users: [...this.directory.users],
        channels: [...this.directory.channels],
      } as QueryResult<Q>)
    }
    if (params.q === 'message.get') {
      const found = [...this.messages.values()]
        .flat()
        .find((m) => m.message_id === params.message_id)
      return Promise.resolve({ message: found ?? null } as QueryResult<Q>)
    }
    // messages.list — newest-first, paginated by created_seq, `limit+1` has_more.
    const list = this.messages.get(params.stream_id) ?? []
    const limit = params.limit ?? 50
    const desc = [...list].sort((a, b) => b.created_seq - a.created_seq)
    const filtered =
      params.before_seq !== undefined
        ? desc.filter((m) => m.created_seq < params.before_seq!)
        : desc
    const page = filtered.slice(0, limit + 1)
    const has_more = page.length > limit
    return Promise.resolve({
      messages: has_more ? page.slice(0, limit) : page,
      has_more,
    } as QueryResult<Q>)
  }

  private mutate = <M extends MutateParams>(params: M): Promise<MutateResult<M>> => {
    if (params.m === 'outbox.send') {
      this.sendSpy(params)
      const messageId = newMessageId()
      const eventId = newEventId()
      const createdSeq = Date.now() + this.messages.size + Math.floor(Math.random() * 1000)
      this.addMessage(params.stream_id, {
        message_id: messageId,
        author_user_id: this.myUserId,
        text: params.text,
        created_seq: createdSeq,
        mention_user_ids: params.mentions ?? [],
        state: 'pending',
      })
      this.publishStream(params.stream_id)
      return Promise.resolve({
        message_id: messageId,
        event_id: eventId,
        created_seq: createdSeq,
      } as MutateResult<M>)
    }
    if (params.m === 'outbox.retry') {
      this.retrySpy(params.event_id)
      return Promise.resolve({ ok: true } as MutateResult<M>)
    }
    // outbox.delete
    this.deleteSpy(params.event_id)
    return Promise.resolve({ ok: true } as MutateResult<M>)
  }

  private subscribe = <T extends Topic>(
    topic: T,
    handler: (payload: PushPayload<T>) => void,
  ): Unsubscribe => {
    const key = topicKey(topic)
    const set = this.subs.get(key) ?? new Set()
    set.add(handler as (p: unknown) => void)
    this.subs.set(key, set)
    return () => set.delete(handler as (p: unknown) => void)
  }

  /** The WorkerClient the store/composable will resolve. */
  get client(): WorkerClient {
    return {
      ready: () => Promise.resolve(),
      query: this.query,
      mutate: this.mutate,
      subscribe: this.subscribe,
      status: () => ({ transport: 'solo', db: 'memory', role: 'n/a' }),
      onStatus: () => () => {},
      auth: {
        login: () => Promise.resolve({ ok: true, status: { authenticated: true } }),
        setup: () => Promise.resolve({ ok: true, status: { authenticated: true } }),
        acceptInvite: () => Promise.resolve({ ok: true, status: { authenticated: true } }),
        logout: () => Promise.resolve({ ok: true }),
        status: () => Promise.resolve({ authenticated: true, my_user_id: this.myUserId }),
      },
      sync: {
        status: () => Promise.resolve(this.syncStatus),
        backfill: (streamId: string): Promise<BackfillResult> => {
          this.backfillSpy(streamId)
          const older = this.pendingBackfill
          this.pendingBackfill = []
          for (const row of older) {
            const list = this.messages.get(streamId) ?? []
            list.push(row)
            list.sort((a, b) => a.created_seq - b.created_seq)
            this.messages.set(streamId, list)
          }
          return Promise.resolve({
            events: older.length,
            has_more: false,
            oldest_loaded_seq: older[0]?.created_seq ?? 0,
          })
        },
      },
      dispose: () => {},
    }
  }
}
