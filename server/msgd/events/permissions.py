"""Readable-streams predicate + read/write helpers (ENG-65 D5/D6).

:func:`readable_streams_predicate` is the **one shared SQL fragment** reused
verbatim by pull (``/v1/events``, ``/v1/sync``), search (§8), and WS fanout
scoping.  :func:`can_read` / :func:`can_write` are the row-level helpers built on
the *same* predicate (no divergent second implementation).

Rulings baked in (D5):

* **``workspace-meta`` is readable by non-guest members only** (owner/admin/
  member).  Guests see *only* streams with an explicit ``stream_members`` row
  (§3.6).  **FLAGGED DEVIATION** from a naive "workspace-meta readable by every
  member" reading of §2.2: giving guests the meta stream would leak the full
  public-channel + member roster.  This is the precise §3.6 interpretation — a
  guest is a member with restricted scope — but it is a conscious call, and the
  web member-list projection must know guests won't receive meta.
* **Public channels** are readable by every non-guest member without a
  membership row (§3.6: reading a public channel does not require joining).
  Guests need an explicit row (the ``EXISTS`` branch covers them).
* **Private channels + DMs** require a ``stream_members`` row (the ``EXISTS``
  branch) — for *every* role.
* **Archived channels stay readable** (no ``archived_at`` filter — archival gates
  writes/UI, not history access, D13).

Because the private/DM/guest branch is a **live** ``EXISTS`` on
``stream_members``, deleting a member row cuts predicate access on the very next
query — the "removal cuts server-side history access immediately" property (D13).
"""

from __future__ import annotations

from sqlalchemy import ColumnElement, and_, exists, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.auth.context import AuthContext
from msgd.db.models import Stream, StreamMember

__all__ = [
    "readable_streams_predicate",
    "can_read",
    "can_write",
]

_ADMINISH = ("owner", "admin")


def readable_streams_predicate(
    *, user_id: str, role: str, workspace_id: str
) -> ColumnElement[bool]:
    """A SQLAlchemy boolean over ``streams`` selecting the caller's readable streams.

    ``role`` is the caller's *workspace* role (a compile-time Python value), so
    the meta + public branches are included only for non-guests; guests fall
    through to the ``EXISTS(stream_members)`` branch alone (explicit-only).
    """
    # Live membership test — re-evaluated per query, so a removed member row cuts
    # access on the very next call (D13, no caching).
    is_member = exists(
        select(literal(1)).where(
            StreamMember.stream_id == Stream.stream_id,
            StreamMember.user_id == user_id,
        )
    )

    branches: list[ColumnElement[bool]] = []
    if role != "guest":
        # meta: all non-guest members (FLAGGED DEVIATION — guests excluded, see
        # the module docstring).
        branches.append(Stream.kind == "workspace-meta")
        # public channels: all non-guest members, no membership row required.
        branches.append(and_(Stream.kind == "channel", Stream.visibility == "public"))
    # private / dm / guest-explicit: a live stream_members row.
    branches.append(is_member)

    return and_(Stream.workspace_id == workspace_id, or_(*branches))


async def can_read(db: AsyncSession, *, ctx: AuthContext, stream_id: str) -> bool:
    """True iff ``stream_id`` exists **and** is readable by ``ctx`` (D5).

    Built on :func:`readable_streams_predicate` — the identical fragment used by
    pull/search/fanout, so there is no second read-access implementation.
    """
    predicate = readable_streams_predicate(
        user_id=ctx.user_id, role=ctx.role, workspace_id=ctx.workspace_id
    )
    found = await db.scalar(
        select(literal(1)).select_from(Stream).where(Stream.stream_id == stream_id, predicate)
    )
    return found is not None


async def can_write(db: AsyncSession, *, ctx: AuthContext, stream_id: str, event_type: str) -> bool:
    """M1 write-permission matrix (D6) — enforced by ENG-66 at upload; unwired here.

    | Event type | Who may write |
    |---|---|
    | ``message.created`` | any member with read access to the target stream |
    | ``channel.created`` | any non-guest member (owner/admin/member) |
    | ``channel.renamed`` / ``channel.archived`` | owner/admin only (M1: no
      per-channel creator role, so "creator may archive" is deferred) |
    | ``channel.member_added`` / ``channel.member_removed`` | owner/admin only
      (member-initiated private-channel invites are a deferred product call) |
    | ``dm.created`` | deferred with the DM endpoint (M3); no M1 caller |
    | ``reaction.added`` / ``reaction.removed`` | any member who can WRITE the
      target message's stream — and a reaction is a write to the same stream the
      message lives in (§2.4), so write access == read access, identical to
      ``message.created`` (ENG-97, M3) |
    | ``message.edited`` / ``message.deleted`` | any member who can WRITE (== read)
      the target message's stream — a first, stream-level gate. The **author-or-
      admin** refinement (only the ORIGINAL author or a workspace admin/owner may
      edit/delete a given message) needs the message row, which ``can_write`` does
      not have, so it is enforced downstream in ``validate._check_referential``
      alongside the ``unknown_message`` existence check (ENG-98, M3) |

    ``pin.*`` / ``file.uploaded`` are out of scope — later tickets define their
    rules; they are not in this matrix and default to not-writable here.
    """
    if event_type in (
        "message.created",
        "reaction.added",
        "reaction.removed",
        "message.edited",
        "message.deleted",
    ):
        # Write access == read access for messages, reactions, AND edits/deletes —
        # all are writes to the same stream the target message lives in (§2.4), so
        # the stream-level gate is the identical readable-streams predicate. For
        # edits/deletes this is only the FIRST gate: the author-or-admin rule is
        # applied in validate._check_referential, which has the message row.
        return await can_read(db, ctx=ctx, stream_id=stream_id)
    if event_type == "channel.created":
        # Any non-guest member may create a channel; guests cannot.
        return ctx.role != "guest"
    if event_type in (
        "channel.renamed",
        "channel.archived",
        "channel.member_added",
        "channel.member_removed",
    ):
        return ctx.role in _ADMINISH
    if event_type == "dm.created":
        # Deferred with the DM endpoint (M3). Reducer + predicate are ready; there
        # is no M1 caller, so this is a documented deferral (not writable in M1).
        return False
    # Out of ENG-65 scope — ENG-66+ owns these rules.
    return False
