// worker/badges.ts — unread + mention badges (§3.5), derived from the local
// projection at query time with NO server round trip.
//
//   unread  = max(0, streams.head_seq − read_state.last_read_seq)
//   mention = a `messages` row in the stream with created_seq > last_read_seq
//             AND myUserId ∈ mention_user_ids
//
// `myUserId` is a PARAMETER (not read inside here) so the badge functions stay
// pure/unit-testable and the `messages` projection stays user-INDEPENDENT: the
// mention index is the `mention_user_ids` column stored verbatim at apply time,
// and the red/no-red decision is this query-time, user-relative scan — never
// stored state, never a separate table (the §5.2 schema is fixed at 7 tables).

import type { MsgDb, StreamBadge } from './types'

export type { StreamBadge }

/**
 * Badge for one stream. `unread` is a plain arithmetic count off `head_seq`
 * (a number, unaffected by cache eviction); `mention` scans only the messages
 * newer than `last_read_seq` (bounded by the `[stream_id+created_seq]` index).
 */
export async function computeStreamBadge(
  db: MsgDb,
  streamId: string,
  myUserId: string,
): Promise<StreamBadge> {
  const [stream, readState] = await Promise.all([db.getStream(streamId), db.getReadState(streamId)])
  const headSeq = stream?.head_seq ?? 0
  const lastReadSeq = readState?.last_read_seq ?? 0 // default 0 when absent
  const unread = Math.max(0, headSeq - lastReadSeq)

  const candidates = await db.listStreamMessagesAfter(streamId, lastReadSeq)
  const mention = candidates.some((m) => m.mention_user_ids.includes(myUserId))

  return { stream_id: streamId, unread, mention }
}

/** Badges for every stream (the sidebar). */
export async function computeAllBadges(db: MsgDb, myUserId: string): Promise<StreamBadge[]> {
  const streams = await db.listStreams()
  return Promise.all(streams.map((s) => computeStreamBadge(db, s.stream_id, myUserId)))
}
