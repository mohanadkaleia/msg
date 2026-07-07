"""Message edits + deletes server side (ENG-98).

Two surfaces, mirroring ``test_reactions.py``:

* **Validation (§3.2 / ENG-98).** An edit/delete is writable iff the author can
  write (== read) the target message's stream, the target message EXISTS in that
  same stream, AND the author is the message's ORIGINAL author or a workspace
  admin/owner. Absence and a cross-stream reference collapse to an identical
  non-disclosing ``unknown_message``; a readable-but-not-owned message gives
  ``permission_denied``. Multiple edits / edit-after-delete / delete-after-delete
  are VALID events (convergence is a projection concern, not a reject).
* **``messages_proj`` apply.** ``message.edited`` is last-writer-wins by
  ``server_sequence`` (out-of-order replay converges to the highest-seq edit);
  ``message.deleted`` tombstones + redacts content (``deleted=True``, ``text=""``)
  and is terminal (a later edit does not un-delete), with ``rebuild ≡ incremental``.
"""

from __future__ import annotations

from typing import Any

from authutil import do_setup
from eventsutil import (
    bootstrap_channel,
    message_body,
    message_deleted_body,
    message_edited_body,
    post_batch,
    wire_item,
)
from httpx import AsyncClient
from msgd.core import ids
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import MessageProj, Stream, Workspace
from msgd.events.insert import insert_event
from msgd.events.validate import Accepted, validate_event
from msgd.projections.apply import apply_projection
from msgd.projections.dump import dump_messages_proj
from msgd.projections.rebuild import rebuild_projections
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# Reuse the seeded validation world (workspace + streams + role contexts).
from test_events_validate import _ctx, _expect_rejected, _seed, _World


async def _insert_message(
    db: AsyncSession, w: _World, stream_id: str, *, author: Any | None = None
) -> str:
    """Insert a real ``message.created`` (populating ``messages_proj``); return its id.

    ``author`` defaults to ``w.member`` (a private-channel member). Pass another
    ctx to home a message under a different author (author-or-admin coverage).
    """
    ctx = author if author is not None else w.member
    body = message_body(auth=w.auth(ctx), stream_id=stream_id)
    await insert_event(db, stream_id=stream_id, body=body)
    message_id: str = body["payload"]["message_id"]
    return message_id


# --- validation: referential + author-or-admin --------------------------------


async def test_author_edits_and_deletes_own_message_accepted(db_session: AsyncSession) -> None:
    """The original author editing/deleting its own message is Accepted."""
    w = await _seed(db_session)
    mid = await _insert_message(db_session, w, w.priv)  # authored by member
    edit = message_edited_body(auth=w.auth(w.member), stream_id=w.priv, message_id=mid, text="new")
    delete = message_deleted_body(auth=w.auth(w.member), stream_id=w.priv, message_id=mid)
    assert isinstance(
        await validate_event(db_session, ctx=w.member, item=wire_item(edit)), Accepted
    )
    assert isinstance(
        await validate_event(db_session, ctx=w.member, item=wire_item(delete)), Accepted
    )


async def test_admin_may_edit_and_delete_others_message(db_session: AsyncSession) -> None:
    """A workspace owner/admin may edit/delete a message it did NOT author (§2.4).

    The message is authored by ``member`` in the public stream; ``owner`` (a
    non-author admin) can both read the public stream and, by the author-or-admin
    rule, edit/delete it.
    """
    w = await _seed(db_session)
    mid = await _insert_message(db_session, w, w.pub, author=w.member)
    edit = message_edited_body(auth=w.auth(w.owner), stream_id=w.pub, message_id=mid, text="mod")
    delete = message_deleted_body(auth=w.auth(w.owner), stream_id=w.pub, message_id=mid)
    assert isinstance(await validate_event(db_session, ctx=w.owner, item=wire_item(edit)), Accepted)
    assert isinstance(
        await validate_event(db_session, ctx=w.owner, item=wire_item(delete)), Accepted
    )


async def test_non_author_non_admin_denied(db_session: AsyncSession) -> None:
    """A plain member who is NOT the author cannot edit/delete another's message.

    Both the author (``member``) and the stranger (a second ``member``-role ctx)
    can read/write the public stream, so the stranger clears step iii — the refusal
    is the author-or-admin gate at step vi, ``permission_denied`` (NOT
    ``unknown_message``: the message is legitimately visible to the stranger)."""
    w = await _seed(db_session)
    stranger = _ctx(
        user_id=ids.new_user_id(),
        workspace_id=w.ws,
        role="member",
        device_id=ids.new_device_id(),
    )
    mid = await _insert_message(db_session, w, w.pub, author=w.member)
    edit = message_edited_body(auth=w.auth(stranger), stream_id=w.pub, message_id=mid, text="x")
    delete = message_deleted_body(auth=w.auth(stranger), stream_id=w.pub, message_id=mid)
    _expect_rejected(
        await validate_event(db_session, ctx=stranger, item=wire_item(edit)), "permission_denied"
    )
    _expect_rejected(
        await validate_event(db_session, ctx=stranger, item=wire_item(delete)), "permission_denied"
    )


async def test_edit_delete_unknown_message_rejected(db_session: AsyncSession) -> None:
    """An edit/delete of a message that never existed → unknown_message."""
    w = await _seed(db_session)
    absent = ids.new_message_id()
    edit = message_edited_body(auth=w.auth(w.member), stream_id=w.priv, message_id=absent)
    delete = message_deleted_body(auth=w.auth(w.member), stream_id=w.priv, message_id=absent)
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(edit)), "unknown_message"
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(delete)), "unknown_message"
    )


async def test_edit_cross_stream_is_non_disclosing(db_session: AsyncSession) -> None:
    """A message in another (readable) stream and an absent message collapse to the
    IDENTICAL unknown_message — no cross-stream existence oracle (D13), and the
    author-or-admin check is never reached (existence not disclosed)."""
    w = await _seed(db_session)
    mid = await _insert_message(db_session, w, w.priv, author=w.member)  # lives in priv
    # Both homed in pub (member can read/write pub) but reference a message NOT in
    # pub: one in priv, one that never existed.
    cross = message_edited_body(auth=w.auth(w.member), stream_id=w.pub, message_id=mid)
    absent = message_edited_body(
        auth=w.auth(w.member), stream_id=w.pub, message_id=ids.new_message_id()
    )
    out_cross = _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(cross)), "unknown_message"
    )
    out_absent = _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(absent)), "unknown_message"
    )
    assert out_cross.detail == out_absent.detail  # existence not disclosed


async def test_edit_in_unwritable_stream_denied(db_session: AsyncSession) -> None:
    """Editing in a stream the author cannot even read → permission_denied at step
    iii — the message existing in priv is never disclosed (non-author adversary on a
    private stream is indistinguishable from an unreadable stream)."""
    w = await _seed(db_session)
    mid = await _insert_message(db_session, w, w.priv, author=w.member)
    # owner is NOT a member of priv → cannot read/write it.
    edit = message_edited_body(auth=w.auth(w.owner), stream_id=w.priv, message_id=mid)
    _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(edit)), "permission_denied"
    )


async def test_multiple_edits_and_edit_after_delete_are_valid(db_session: AsyncSession) -> None:
    """Multiple edits, edit-after-delete, and delete-after-delete are VALID events —
    idempotency/terminality is a projection concern, never a reject (§2.4)."""
    w = await _seed(db_session)
    mid = await _insert_message(db_session, w, w.priv, author=w.member)
    auth = w.auth(w.member)
    events = [
        message_edited_body(auth=auth, stream_id=w.priv, message_id=mid, text="e1"),
        message_edited_body(auth=auth, stream_id=w.priv, message_id=mid, text="e2"),
        message_deleted_body(auth=auth, stream_id=w.priv, message_id=mid),
        message_edited_body(auth=auth, stream_id=w.priv, message_id=mid, text="after-delete"),
        message_deleted_body(auth=auth, stream_id=w.priv, message_id=mid),
    ]
    for item in events:
        out = await validate_event(db_session, ctx=w.member, item=wire_item(item))
        assert isinstance(out, Accepted), out


async def test_unknown_version_edit_still_referential_and_authorized(
    db_session: AsyncSession,
) -> None:
    """A D9 unknown-version edit skips the payload model but still gets the
    referential + author-or-admin checks (version-agnostic): a garbage target →
    unknown_message; a non-author → permission_denied; the author → Accepted."""
    w = await _seed(db_session)
    mid = await _insert_message(db_session, w, w.pub, author=w.member)
    good = message_edited_body(
        auth=w.auth(w.member), stream_id=w.pub, message_id=mid, type_version=2
    )
    assert isinstance(
        await validate_event(db_session, ctx=w.member, item=wire_item(good)), Accepted
    )
    bad = message_edited_body(
        auth=w.auth(w.member), stream_id=w.pub, message_id=ids.new_message_id(), type_version=2
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(bad)), "unknown_message"
    )


# --- projection apply: LWW, tombstone, terminality, rebuild ≡ incremental ------


async def _seed_stream(db: AsyncSession, *, workspace_id: str, stream_id: str) -> None:
    db.add(Workspace(workspace_id=workspace_id, name="Acme"))
    await db.flush()
    db.add(
        Stream(
            stream_id=stream_id,
            workspace_id=workspace_id,
            kind="channel",
            name="c",
            visibility="public",
        )
    )
    await db.flush()


async def _seed_created_message(
    db: AsyncSession, *, ws: str, stream: str, user: str, mid: str, text: str
) -> None:
    body = build_message_created_body(
        workspace_id=ws,
        stream_id=stream,
        author_user_id=user,
        author_device_id=ids.new_device_id(),
        client_created_at=now_rfc3339(),
        text=text,
        message_id=mid,
    ).model_dump(mode="json")
    await insert_event(db, stream_id=stream, body=body)


def _edit(*, ws: str, stream: str, user: str, mid: str, text: str) -> dict[str, Any]:
    return message_edited_body(
        auth={"workspace_id": ws, "user_id": user, "device_id": ids.new_device_id()},
        stream_id=stream,
        message_id=mid,
        text=text,
    )


def _delete(*, ws: str, stream: str, user: str, mid: str) -> dict[str, Any]:
    return message_deleted_body(
        auth={"workspace_id": ws, "user_id": user, "device_id": ids.new_device_id()},
        stream_id=stream,
        message_id=mid,
    )


async def _row(db: AsyncSession, mid: str) -> MessageProj:
    row = await db.scalar(select(MessageProj).where(MessageProj.message_id == mid))
    assert row is not None
    return row


async def test_edit_applies_lww_by_server_sequence(db_session: AsyncSession) -> None:
    """An edit sets text + edited_seq; a HIGHER-seq edit wins, a LOWER-seq (stale)
    edit is ignored — LWW by server_sequence (D14), order-independent."""
    ws, stream, user = ids.new_workspace_id(), ids.new_stream_id(), ids.new_user_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    mid = ids.new_message_id()
    await _seed_created_message(db_session, ws=ws, stream=stream, user=user, mid=mid, text="orig")
    created_seq = (await _row(db_session, mid)).created_seq

    edit = _edit(ws=ws, stream=stream, user=user, mid=mid, text="v10")
    await apply_projection(db_session, body=edit, server_sequence=created_seq + 10)
    row = await _row(db_session, mid)
    assert row.text == "v10" and row.edited_seq == created_seq + 10 and not row.deleted

    # A stale, LOWER-seq edit must NOT overwrite the newer text (out-of-order guard).
    stale = _edit(ws=ws, stream=stream, user=user, mid=mid, text="STALE")
    await apply_projection(db_session, body=stale, server_sequence=created_seq + 5)
    row = await _row(db_session, mid)
    assert row.text == "v10" and row.edited_seq == created_seq + 10

    # A HIGHER-seq edit wins.
    newer = _edit(ws=ws, stream=stream, user=user, mid=mid, text="v20")
    await apply_projection(db_session, body=newer, server_sequence=created_seq + 20)
    row = await _row(db_session, mid)
    assert row.text == "v20" and row.edited_seq == created_seq + 20


async def test_delete_tombstones_and_redacts_content(db_session: AsyncSession) -> None:
    """A delete sets deleted=True AND clears text to '' — deleted content is not
    served through the projection (the read/dump surface cannot leak it)."""
    ws, stream, user = ids.new_workspace_id(), ids.new_stream_id(), ids.new_user_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    mid = ids.new_message_id()
    await _seed_created_message(db_session, ws=ws, stream=stream, user=user, mid=mid, text="secret")
    created_seq = (await _row(db_session, mid)).created_seq

    await apply_projection(
        db_session,
        body=_delete(ws=ws, stream=stream, user=user, mid=mid),
        server_sequence=created_seq + 1,
    )
    row = await _row(db_session, mid)
    assert row.deleted is True
    assert row.text == ""  # content redacted, not merely flagged

    # The dump (the read equivalence surface) carries no deleted content.
    dump = await dump_messages_proj(db_session)
    assert "secret" not in dump


async def test_delete_is_terminal_edit_does_not_undelete(db_session: AsyncSession) -> None:
    """Deleted is terminal: a later (higher-seq) edit does NOT un-delete or restore
    content, and delete-after-delete is an idempotent no-op."""
    ws, stream, user = ids.new_workspace_id(), ids.new_stream_id(), ids.new_user_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    mid = ids.new_message_id()
    await _seed_created_message(db_session, ws=ws, stream=stream, user=user, mid=mid, text="hi")
    base = (await _row(db_session, mid)).created_seq

    await apply_projection(
        db_session, body=_delete(ws=ws, stream=stream, user=user, mid=mid), server_sequence=base + 1
    )
    # An edit at a HIGHER seq than the delete must still not resurrect it.
    await apply_projection(
        db_session,
        body=_edit(ws=ws, stream=stream, user=user, mid=mid, text="resurrected"),
        server_sequence=base + 5,
    )
    row = await _row(db_session, mid)
    assert row.deleted is True and row.text == ""

    # delete-after-delete: idempotent no-op.
    await apply_projection(
        db_session, body=_delete(ws=ws, stream=stream, user=user, mid=mid), server_sequence=base + 9
    )
    row = await _row(db_session, mid)
    assert row.deleted is True and row.text == ""


async def test_out_of_order_edits_and_delete_rebuild_equivalent(db_session: AsyncSession) -> None:
    """A log with interleaved edits + a delete rebuilds byte-identically to the
    incremental projection — LWW + tombstone converge regardless of replay path."""
    ws, stream, user = ids.new_workspace_id(), ids.new_stream_id(), ids.new_user_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    m1, m2 = ids.new_message_id(), ids.new_message_id()
    await _seed_created_message(db_session, ws=ws, stream=stream, user=user, mid=m1, text="a")
    await _seed_created_message(db_session, ws=ws, stream=stream, user=user, mid=m2, text="b")
    # m1: two edits (LWW → latest wins). m2: edit then delete (tombstone terminal).
    for body in (
        _edit(ws=ws, stream=stream, user=user, mid=m1, text="a-edit1"),
        _edit(ws=ws, stream=stream, user=user, mid=m1, text="a-edit2"),
        _edit(ws=ws, stream=stream, user=user, mid=m2, text="b-edit"),
        _delete(ws=ws, stream=stream, user=user, mid=m2),
    ):
        await insert_event(db_session, stream_id=stream, body=body)

    dump_incremental = await dump_messages_proj(db_session)
    assert "b-edit" not in dump_incremental  # m2 deleted → its edited body redacted

    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == dump_incremental


# --- end-to-end through POST /v1/events/batch --------------------------------


async def test_edit_delete_end_to_end(client: AsyncClient, db_session: AsyncSession) -> None:
    """A real batch: create → edit → delete projects text/edited_seq/deleted, and a
    rebuild of the same log reproduces the projection byte for byte."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    created = message_body(auth=owner, stream_id=channel, text="hello")
    mid = created["payload"]["message_id"]
    edit = message_edited_body(auth=owner, stream_id=channel, message_id=mid, text="hello-edited")
    delete = message_deleted_body(auth=owner, stream_id=channel, message_id=mid)

    # Sequential batches so the accept order matches the intended LWW order.
    for body in (created, edit):
        resp = await post_batch(client, owner["token"], [wire_item(body)])
        assert resp.status_code == 200, resp.text
        assert resp.json()["rejected"] == []

    row = await db_session.scalar(select(MessageProj).where(MessageProj.message_id == mid))
    assert row is not None and row.text == "hello-edited" and row.edited_seq is not None

    resp = await post_batch(client, owner["token"], [wire_item(delete)])
    assert resp.status_code == 200 and resp.json()["rejected"] == []
    row = await db_session.scalar(select(MessageProj).where(MessageProj.message_id == mid))
    assert row is not None and row.deleted is True and row.text == ""

    dump_incremental = await dump_messages_proj(db_session)
    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == dump_incremental
