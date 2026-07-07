// worker/meta.ts — channel & member management + DM creation authoring (ENG-104).
//
// The write half of M3 workspace administration. It turns a tab
// `mutate channel.create | channel.rename | channel.archive | channel.addMember |
// channel.removeMember | dm.create` into a hashed workspace-meta event, authored
// WORKER-SIDE from the worker-owned identity (workspace/user/device — never from a
// tab), POSTed to `/v1/events/batch`, then reconciled by refreshing `/v1/sync` so
// the new/changed stream lands in the sidebar.
//
// Unlike a `message.created` (which flows through the optimistic Outbox drain),
// these are infrequent, user-initiated, ONLINE administrative actions with a
// stream-identity outcome the UI needs before it can switch. So they take a
// direct-POST path: build → hash → POST → assert accepted → refresh streams. A
// rejection surfaces as a coded error the UI shows. (Offline durability for meta
// ops via the outbox is a deferred nicety — the token/security boundary is
// identical either way: the bearer rides the worker-side http client.)
//
// §2.2 homing is decided here from the target's visibility (read from the local
// `streams` projection): a PUBLIC channel event homes in workspace-meta; a PRIVATE
// channel event is self-homed in the channel's own stream; a `dm.created` is
// self-homed in the DM's own stream. The server re-validates all of this.

import {
  buildChannelArchivedBody,
  buildChannelCreatedBody,
  buildChannelMemberAddedBody,
  buildChannelMemberRemovedBody,
  buildChannelRenamedBody,
  buildDmCreatedBody,
  finalizeEnvelope,
  newStreamId,
  type Body,
} from '../core'

import type { HttpClient } from './http'
import { resolveWorkerIdentity, type WorkerIdentity } from './outbox'
import {
  RpcCodedError,
  type AuthStatus,
  type MsgDb,
  type MutateParams,
  type OutboxActionResult,
  type StreamCreatedResult,
} from './types'

/** One accepted/rejected entry in a `POST /v1/events/batch` 200 (ENG-66). */
interface BatchResponse {
  accepted: { event_id: string; stream_id: string; server_sequence: number }[]
  rejected: { event_id: string; code: string; detail?: string }[]
}

/** Everything the meta author needs, injected → fully unit-testable (no browser). */
export interface MetaAuthorDeps {
  db: MsgDb
  http: HttpClient
  /** Worker-owned identity snapshot (never from a tab). */
  authStatus: () => AuthStatus
  /** Re-fetch `/v1/sync` so the new/changed stream lands in the sidebar. */
  refreshStreams: () => Promise<void>
  /** After a meta op reconciles, fan a signal so the sidebar re-queries. */
  onStreamsChanged: () => void
  /** `client_created_at` clock; default `Date.now`. */
  now?: () => number
}

export class MetaAuthor {
  private readonly db: MsgDb
  private readonly http: HttpClient
  private readonly authStatus: () => AuthStatus
  private readonly refreshStreams: () => Promise<void>
  private readonly onStreamsChanged: () => void
  private readonly now: () => number

  constructor(deps: MetaAuthorDeps) {
    this.db = deps.db
    this.http = deps.http
    this.authStatus = deps.authStatus
    this.refreshStreams = deps.refreshStreams
    this.onStreamsChanged = deps.onStreamsChanged
    this.now = deps.now ?? Date.now
  }

  // -- RPC arms (dispatched from WorkerCore.mutate) ------------------------

  /** Create a channel (`channel.created`); return its new stream id for instant switch. */
  async createChannel(
    params: Extract<MutateParams, { m: 'channel.create' }>,
  ): Promise<StreamCreatedResult> {
    const id = await this.identity()
    const channelStreamId = newStreamId()
    // §2.2 homing is the CALLER's choice: public → workspace-meta, private → self.
    const home = params.visibility === 'public' ? await this.metaStreamId() : channelStreamId
    const body = buildChannelCreatedBody({
      ...this.envelope(id, home),
      channel_stream_id: channelStreamId,
      name: params.name,
      visibility: params.visibility,
    })
    await this.author(body)
    return { stream_id: channelStreamId }
  }

  /** Rename a channel (`channel.renamed`). */
  async renameChannel(
    params: Extract<MutateParams, { m: 'channel.rename' }>,
  ): Promise<OutboxActionResult> {
    const id = await this.identity()
    const home = await this.homeForChannel(params.stream_id)
    const body = buildChannelRenamedBody({
      ...this.envelope(id, home),
      channel_stream_id: params.stream_id,
      name: params.name,
    })
    await this.author(body)
    return { ok: true }
  }

  /** Archive a channel (`channel.archived`). */
  async archiveChannel(
    params: Extract<MutateParams, { m: 'channel.archive' }>,
  ): Promise<OutboxActionResult> {
    const id = await this.identity()
    const home = await this.homeForChannel(params.stream_id)
    const body = buildChannelArchivedBody({
      ...this.envelope(id, home),
      channel_stream_id: params.stream_id,
    })
    await this.author(body)
    return { ok: true }
  }

  /** Add a member to a channel (`channel.member_added`). */
  async addMember(
    params: Extract<MutateParams, { m: 'channel.addMember' }>,
  ): Promise<OutboxActionResult> {
    const id = await this.identity()
    const home = await this.homeForChannel(params.stream_id)
    const body = buildChannelMemberAddedBody({
      ...this.envelope(id, home),
      channel_stream_id: params.stream_id,
      user_id: params.user_id,
    })
    await this.author(body)
    return { ok: true }
  }

  /** Remove a member from a channel (`channel.member_removed`). */
  async removeMember(
    params: Extract<MutateParams, { m: 'channel.removeMember' }>,
  ): Promise<OutboxActionResult> {
    const id = await this.identity()
    const home = await this.homeForChannel(params.stream_id)
    const body = buildChannelMemberRemovedBody({
      ...this.envelope(id, home),
      channel_stream_id: params.stream_id,
      user_id: params.user_id,
    })
    await this.author(body)
    return { ok: true }
  }

  /**
   * Open a DM (`dm.created`) with `user_ids`; return the new DM stream id. The
   * author (worker `my_user_id`) is ALWAYS included as a participant — the server
   * requires it and rejects a DM you are not part of. Deduplicated so a 1:1 DM with
   * yourself accidentally in the list still yields a clean participant set.
   */
  async createDm(params: Extract<MutateParams, { m: 'dm.create' }>): Promise<StreamCreatedResult> {
    const id = await this.identity()
    const dmStreamId = newStreamId()
    const participants = [...new Set([id.my_user_id, ...params.user_ids])]
    const body = buildDmCreatedBody({
      // A DM genesis is self-homed in the DM's own stream (never workspace-meta,
      // which every non-guest member can read — that would leak the DM's roster).
      ...this.envelope(id, dmStreamId),
      dm_stream_id: dmStreamId,
      member_user_ids: participants,
    })
    await this.author(body)
    return { stream_id: dmStreamId }
  }

  // -- internals -----------------------------------------------------------

  private identity(): Promise<WorkerIdentity> {
    return resolveWorkerIdentity(this.db, this.authStatus)
  }

  /** The common envelope fields for a meta body, homed at `home`. */
  private envelope(
    id: WorkerIdentity,
    home: string,
  ): {
    workspace_id: string
    stream_id: string
    author_user_id: string
    author_device_id: string
    client_created_at: string
  } {
    return {
      workspace_id: id.workspace_id,
      stream_id: home,
      author_user_id: id.my_user_id,
      author_device_id: id.deviceId,
      client_created_at: new Date(this.now()).toISOString(),
    }
  }

  /** The workspace-meta stream id (public-channel homing target). */
  private async metaStreamId(): Promise<string> {
    const streams = await this.db.listStreams()
    const meta = streams.find((s) => s.kind === 'workspace-meta')
    if (!meta) {
      throw new RpcCodedError('no_workspace_meta', 'workspace-meta stream is not known yet')
    }
    return meta.stream_id
  }

  /**
   * The §2.2 home for a channel lifecycle event: workspace-meta for a PUBLIC
   * channel, the channel's own stream (self-homed) for a PRIVATE one. Reads the
   * target's visibility from the local `streams` projection. An unknown target
   * defaults to self-homed (the server re-validates and rejects a bad home).
   */
  private async homeForChannel(streamId: string): Promise<string> {
    const stream = await this.db.getStream(streamId)
    return stream?.visibility === 'public' ? this.metaStreamId() : streamId
  }

  /**
   * Finalize (hash) the body, POST it, and assert exactly one accepted event — then
   * reconcile the local `streams` projection via `/v1/sync` and signal the sidebar.
   * A whole-request failure or an item rejection throws a coded error the UI shows;
   * the local projection is NOT optimistically mutated, so a rejection leaves no
   * phantom stream to clean up.
   */
  private async author(body: Body): Promise<void> {
    const { body: finalBody, event_hash } = await finalizeEnvelope(body)
    const res = await this.http.post<BatchResponse>('/v1/events/batch', {
      events: [{ body: finalBody, event_hash }],
    })
    if (!res.ok) {
      throw new RpcCodedError('network_error', `meta event upload failed: ${res.error.status}`)
    }
    const rejected = res.value.rejected[0]
    if (rejected) {
      throw new RpcCodedError(rejected.code, rejected.detail ?? `meta event rejected: ${body.type}`)
    }
    if (res.value.accepted.length !== 1) {
      throw new RpcCodedError('not_accepted', `meta event was not accepted: ${body.type}`)
    }
    // Reconcile the authoritative stream state (new stream row, membership,
    // archived flag, head_seq) and fan a signal so the sidebar re-queries.
    await this.refreshStreams()
    this.onStreamsChanged()
  }
}
