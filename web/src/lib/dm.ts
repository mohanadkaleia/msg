// lib/dm.ts — resolve a DM stream's display identity from its participant ids
// (ENG-149). DM streams are server-named `null`, so the tab labels a DM with the
// OTHER participant's display name instead of the raw stream id. The participant
// ids ride the `streams.list` result (`dm_user_ids`, folded worker-side from the
// DM's own cached `dm.created` genesis event — see worker/projection.ts); names
// resolve through the workspace directory map the caller already holds.
//
// Pure functions, no stores, no network — shared by the sidebar, the conversation
// header, and the Inbox so all three agree on the label + presence target.
// Display names are OTHER USERS' INPUT: callers render them via Vue text
// interpolation only, never a raw-HTML sink.

/**
 * The single counterpart of a DM, i.e. the participant whose presence the dot
 * shows: the ONE participant who is not `myUserId`. A self-DM (you alone)
 * resolves to yourself. `undefined` when the participants are unknown (no cached
 * genesis) or when this is a group DM (>1 other — no single counterpart, so no
 * dot; deferred until group DMs exist).
 */
export function dmOtherUserId(
  memberUserIds: readonly string[] | undefined,
  myUserId: string | undefined,
): string | undefined {
  if (memberUserIds === undefined || memberUserIds.length === 0) return undefined
  const others = [...new Set(memberUserIds)].filter((id) => id !== myUserId)
  if (others.length === 0) return memberUserIds[0] // self-DM → yourself
  if (others.length === 1) return others[0]
  return undefined // group DM — no single counterpart
}

/**
 * A short, non-crashing stand-in for a user id that is not in the directory
 * (e.g. a departed member): the id's first 8 chars + an ellipsis. Honest — it
 * never fabricates a name.
 */
export function shortUserId(userId: string): string {
  return userId.length > 9 ? `${userId.slice(0, 8)}…` : userId
}

/**
 * The DM's display label: the other participant's directory name (1:1), your own
 * name (self-DM), or the joined name list (group DM — honest until group DMs are
 * a real feature). A participant missing from the directory falls back to a
 * short id. `undefined` when the participants are unknown — the caller keeps its
 * existing fallback (stream name/id) for that row.
 */
export function dmDisplayName(
  memberUserIds: readonly string[] | undefined,
  myUserId: string | undefined,
  names: ReadonlyMap<string, string>,
): string | undefined {
  if (memberUserIds === undefined || memberUserIds.length === 0) return undefined
  const resolve = (id: string): string => names.get(id) ?? shortUserId(id)
  const others = [...new Set(memberUserIds)].filter((id) => id !== myUserId)
  if (others.length === 0) return resolve(memberUserIds[0]!) // self-DM → your own name
  return others.map(resolve).join(', ')
}
