// tests/unit/shell/fakeWorker.ts — a browser-free fake WorkerClient for the shell
// tests. It backs `query`/`mutate`/`subscribe`/`sync` with an in-memory projection
// and exposes a `fetch` spy that is NEVER called by any read path — so a test can
// assert channel switching (and every other projection read) is ZERO-network. It
// mirrors how the worker layer is tested: everything injected, no SharedWorker.
import { vi } from 'vitest'

import { newEventId, newMessageId, newStreamId } from '../../../src/core'
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
  ReactionAggregate,
  StreamBadge,
  StreamRow,
  SyncStatus,
  ThreadParticipant,
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
  /** Captures every ENG-104 meta mutation (create/rename/archive/member/dm). */
  readonly metaSpy = vi.fn<(params: MutateParams) => void>()
  /** ENG-102 M3 optimistic-op spies. */
  readonly reactSpy = vi.fn<(params: Extract<MutateParams, { m: 'outbox.react' }>) => void>()
  readonly editSpy = vi.fn<(params: Extract<MutateParams, { m: 'outbox.edit' }>) => void>()
  readonly removeSpy = vi.fn<(params: Extract<MutateParams, { m: 'outbox.remove' }>) => void>()

  private streams = new Map<string, SidebarStream>()
  /** The @mention / #channel autocomplete source a `directory.list` returns. */
  private directory: { users: DirectoryUser[]; channels: DirectoryChannel[] } = {
    users: [],
    channels: [],
  }
  /** Ascending-by-created_seq message rows per stream. */
  private messages = new Map<string, MessageRow[]>()
  /** Present reactions: `message_id → emoji → set of reactor user_ids`. */
  private reactions = new Map<string, Map<string, Set<string>>>()
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
      ...(opts.thread_root_id ? { thread_root_id: opts.thread_root_id } : {}),
      ...(opts.reply_count !== undefined ? { reply_count: opts.reply_count } : {}),
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.error_code ? { error_code: opts.error_code } : {}),
    }
    const list = this.messages.get(streamId) ?? []
    list.push(row)
    list.sort((a, b) => a.created_seq - b.created_seq)
    this.messages.set(streamId, list)
    return row
  }

  /** Seed / inject a SETTLED reply (e.g. a live reply over WS) + recompute + publish. */
  addReply(
    streamId: string,
    rootMessageId: string,
    opts: Partial<MessageRow> & { created_seq: number },
  ): MessageRow {
    const row = this.addMessage(streamId, { ...opts, thread_root_id: rootMessageId })
    this.recomputeThread(rootMessageId)
    this.publishStream(streamId)
    return row
  }

  /** Find a message by id across all streams. */
  private findMessage(messageId: string): MessageRow | undefined {
    return [...this.messages.values()].flat().find((m) => m.message_id === messageId)
  }

  /** A root's replies (any stream), by `thread_root_id`. */
  private repliesOf(rootMessageId: string): MessageRow[] {
    return [...this.messages.values()].flat().filter((m) => m.thread_root_id === rootMessageId)
  }

  /**
   * Recompute a root's `reply_count` / `last_reply_seq` from its NON-DELETED,
   * SETTLED replies (mirrors the projection's delete-aware, settled-only counter —
   * a pending reply does not bump the counter).
   */
  private recomputeThread(rootMessageId: string): void {
    const root = this.findMessage(rootMessageId)
    if (!root) return
    const replies = this.repliesOf(rootMessageId).filter((r) => !r.deleted && !r.state)
    root.reply_count = replies.length
    if (replies.length > 0) root.last_reply_seq = Math.max(...replies.map((r) => r.created_seq))
    else delete root.last_reply_seq
  }

  /** A root's participants (distinct authors of its non-deleted settled replies). */
  private threadParticipants(rootMessageId: string): ThreadParticipant[] {
    const names = new Map(this.directory.users.map((u) => [u.user_id, u.display_name]))
    const replies = this.repliesOf(rootMessageId).filter((r) => !r.deleted && !r.state)
    const ids = [...new Set(replies.map((r) => r.author_user_id))]
    return ids
      .map((user_id) => ({ user_id, display_name: names.get(user_id) ?? user_id }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
  }

  /** Seed the @mention / #channel autocomplete source a `directory.list` returns. */
  setDirectory(users: DirectoryUser[], channels: DirectoryChannel[]): this {
    this.directory = { users, channels }
    return this
  }

  /** Seed a present reaction membership (message_id, reactor, emoji). */
  addReaction(messageId: string, userId: string, emoji: string): this {
    const byEmoji = this.reactions.get(messageId) ?? new Map<string, Set<string>>()
    const reactors = byEmoji.get(emoji) ?? new Set<string>()
    reactors.add(userId)
    byEmoji.set(emoji, reactors)
    this.reactions.set(messageId, byEmoji)
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
        // A settled reply now counts toward its root (settled-only counter).
        if (row.thread_root_id) this.recomputeThread(row.thread_root_id)
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
    if (params.q === 'messages.reactions') {
      const names = new Map(this.directory.users.map((u) => [u.user_id, u.display_name]))
      const messages = params.message_ids.map((message_id) => {
        const byEmoji = this.reactions.get(message_id) ?? new Map<string, Set<string>>()
        const reactions: ReactionAggregate[] = [...byEmoji.entries()]
          .filter(([, reactors]) => reactors.size > 0)
          .map(([emoji, reactors]): ReactionAggregate => {
            const user_ids = [...reactors].sort()
            return {
              emoji,
              count: user_ids.length,
              user_ids,
              display_names: user_ids.map((id) => names.get(id) ?? id),
              mine: user_ids.includes(this.myUserId),
            }
          })
          .sort((a, b) => (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0))
        return { message_id, reactions }
      })
      return Promise.resolve({ messages } as QueryResult<Q>)
    }
    if (params.q === 'messages.thread') {
      const root = this.findMessage(params.root_message_id) ?? null
      const all = this.repliesOf(params.root_message_id)
      const limit = params.limit ?? 50
      const desc = [...all].sort((a, b) => b.created_seq - a.created_seq)
      const filtered =
        params.before_seq !== undefined
          ? desc.filter((m) => m.created_seq < params.before_seq!)
          : desc
      const page = filtered.slice(0, limit + 1)
      const has_more = page.length > limit
      const replies = (has_more ? page.slice(0, limit) : page).reverse()
      return Promise.resolve({
        root,
        replies,
        has_more,
        participants: this.threadParticipants(params.root_message_id),
      } as QueryResult<Q>)
    }
    if (params.q === 'messages.threads') {
      const threads = params.root_message_ids.map((root_message_id) => ({
        root_message_id,
        reply_count: this.findMessage(root_message_id)?.reply_count ?? 0,
        participants: this.threadParticipants(root_message_id),
      }))
      return Promise.resolve({ threads } as QueryResult<Q>)
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
        ...(params.thread_root_id ? { thread_root_id: params.thread_root_id } : {}),
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
    if (params.m === 'outbox.delete') {
      this.deleteSpy(params.event_id)
      return Promise.resolve({ ok: true } as MutateResult<M>)
    }
    // ENG-104 channel/DM management. The fake records the params (tests assert the
    // right event is authored — never direct HTTP) and mints/echoes a stream id for
    // create ops so the shell can switch to the new stream. It also mirrors the
    // optimistic streams-projection effect (create adds a member:true row) so the
    // sidebar round-trips as it would against the real worker.
    if (params.m === 'channel.create') {
      this.metaSpy(params)
      const streamId = newStreamId()
      this.addStream({ stream_id: streamId, name: params.name, visibility: params.visibility })
      this.publishStream(streamId)
      return Promise.resolve({ stream_id: streamId } as MutateResult<M>)
    }
    if (params.m === 'dm.create') {
      this.metaSpy(params)
      const streamId = newStreamId()
      this.addStream({ stream_id: streamId, kind: 'dm', name: 'dm' })
      this.publishStream(streamId)
      return Promise.resolve({ stream_id: streamId } as MutateResult<M>)
    }
    if (
      params.m === 'channel.rename' ||
      params.m === 'channel.archive' ||
      params.m === 'channel.addMember' ||
      params.m === 'channel.removeMember'
    ) {
      this.metaSpy(params)
      return Promise.resolve({ ok: true } as MutateResult<M>)
    }
    // ENG-100/102 M3 optimistic ops — the fake applies the projection effect the
    // real worker overlay would (react toggle / edit text+marker / tombstone+redact)
    // and publishes, so the shell's optimistic render + settle is exercised end-to-end.
    if (params.m === 'outbox.react') {
      this.reactSpy(params)
      this.applyReaction(params.message_id, params.emoji, params.remove === true)
      this.publishStream(params.stream_id)
    } else if (params.m === 'outbox.edit') {
      this.editSpy(params)
      this.applyEdit(params.message_id, params.text)
      this.publishStream(params.stream_id)
    } else if (params.m === 'outbox.remove') {
      this.removeSpy(params)
      this.applyDelete(params.message_id)
      this.publishStream(params.stream_id)
    }
    return Promise.resolve({
      message_id: params.message_id,
      event_id: newEventId(),
      created_seq: Date.now(),
    } as MutateResult<M>)
  }

  /** Add/remove the signed-in user's reaction membership (idempotent toggle). */
  private applyReaction(messageId: string, emoji: string, remove: boolean): void {
    const byEmoji = this.reactions.get(messageId) ?? new Map<string, Set<string>>()
    const reactors = byEmoji.get(emoji) ?? new Set<string>()
    if (remove) reactors.delete(this.myUserId)
    else reactors.add(this.myUserId)
    byEmoji.set(emoji, reactors)
    this.reactions.set(messageId, byEmoji)
  }

  /** Replace a message's text + stamp the "edited" marker (fake settles instantly). */
  private applyEdit(messageId: string, text: string): void {
    for (const list of this.messages.values()) {
      const row = list.find((m) => m.message_id === messageId)
      if (row) {
        row.text = text
        row.edited_seq = (row.created_seq ?? 0) + 1
        return
      }
    }
  }

  /** Tombstone + redact a message (mirrors the projection's delete). */
  private applyDelete(messageId: string): void {
    for (const list of this.messages.values()) {
      const row = list.find((m) => m.message_id === messageId)
      if (row) {
        row.deleted = true
        row.text = ''
        // A deleted reply no longer counts toward its root.
        if (row.thread_root_id) this.recomputeThread(row.thread_root_id)
        return
      }
    }
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
      // ENG-119: the shell tests don't drive file uploads yet (ENG-121); a minimal
      // token-free stub keeps the WorkerClient surface satisfied.
      files: {
        upload: (params) => Promise.resolve({ upload_id: params.upload_id }),
        retry: (uploadId: string) => Promise.resolve({ upload_id: uploadId }),
        cancel: (uploadId: string) => Promise.resolve({ upload_id: uploadId }),
        download: () => Promise.resolve({ blob: null }),
        thumbnail: () => Promise.resolve({ blob: null }),
        onProgress: () => () => {},
      },
      dispose: () => {},
    }
  }
}
