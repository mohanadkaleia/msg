"""``GET /v1/sync`` — shape, member flags, public browser, guest exclusion, heads (ENG-67).

Principals are minted through the real auth path (setup + invite/accept so each
has a bearer token); streams and memberships are seeded directly at the DB layer.
Requests run through the in-process ``client`` sharing the rolled-back session.
"""

from __future__ import annotations

from typing import Any

from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_setup,
    fetch_meta_stream_id,
    join_token,
)
from httpx import AsyncClient
from msgd.core import ids
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import Stream, StreamMember
from msgd.events.insert import insert_event
from sqlalchemy.ext.asyncio import AsyncSession


async def _invited_user(
    client: AsyncClient, owner_token: str, *, role: str, email: str
) -> dict[str, Any]:
    """Create + accept an invite; return the new principal's login body."""
    inv = await create_invite(client, owner_token, role=role)
    raw = join_token(inv.json()["url"])
    accepted = await accept_invite(client, raw, email=email)
    assert accepted.status_code == 200, accepted.text
    body: dict[str, Any] = accepted.json()
    return body


def _add_stream(
    db: AsyncSession,
    *,
    ws: str,
    kind: str,
    name: str | None = None,
    visibility: str | None = None,
) -> str:
    sid = ids.new_stream_id()
    db.add(Stream(stream_id=sid, workspace_id=ws, kind=kind, name=name, visibility=visibility))
    return sid


async def _sync(client: AsyncClient, token: str) -> dict[str, Any]:
    r = await client.get("/v1/sync", headers=auth_header(token))
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def _by_id(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s["stream_id"]: s for s in body["streams"]}


async def _meta_id(db: AsyncSession, ws: str) -> str:
    sid = await fetch_meta_stream_id(db, ws)
    assert sid is not None
    return sid


# --- shape + member flags + public browser ------------------------------------


async def test_sync_shape_member_flags_and_public_browser(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Non-guest sees meta + joined/un-joined public + private-member; not private-non-member."""
    o = await do_setup(client)
    ws, uid = o["workspace_id"], o["user_id"]
    meta = await _meta_id(db_session, ws)

    pub_joined = _add_stream(db_session, ws=ws, kind="channel", name="general", visibility="public")
    pub_open = _add_stream(db_session, ws=ws, kind="channel", name="random", visibility="public")
    priv_member = _add_stream(
        db_session, ws=ws, kind="channel", name="secret", visibility="private"
    )
    priv_other = _add_stream(db_session, ws=ws, kind="channel", name="hidden", visibility="private")
    await db_session.flush()
    db_session.add(StreamMember(stream_id=pub_joined, user_id=uid))
    db_session.add(StreamMember(stream_id=priv_member, user_id=uid))
    await db_session.flush()

    streams = _by_id(await _sync(client, o["token"]))

    # meta: present, member:false, name/visibility null.
    assert meta in streams
    assert streams[meta]["member"] is False
    assert streams[meta]["kind"] == "workspace-meta"
    assert streams[meta]["name"] is None and streams[meta]["visibility"] is None

    # public joined vs un-joined: both present, member reflects join state (browser).
    assert streams[pub_joined]["member"] is True
    assert streams[pub_open]["member"] is False  # the public-channel browser distinction
    assert streams[pub_open]["visibility"] == "public"

    # private the caller belongs to: present, member:true.
    assert streams[priv_member]["member"] is True

    # private the caller does NOT belong to: absent entirely.
    assert priv_other not in streams


# --- guest exclusion (FLAGGED DEVIATION) --------------------------------------


async def test_guest_sees_only_explicit_memberships(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A guest sees ONLY explicit-membership streams — no meta, no public browser."""
    o = await do_setup(client)
    ws = o["workspace_id"]
    guest = await _invited_user(client, o["token"], role="guest", email="guest@example.com")
    meta = await _meta_id(db_session, ws)

    pub = _add_stream(db_session, ws=ws, kind="channel", name="general", visibility="public")
    priv = _add_stream(db_session, ws=ws, kind="channel", name="secret", visibility="private")
    await db_session.flush()
    db_session.add(StreamMember(stream_id=priv, user_id=guest["user_id"]))  # explicit only
    await db_session.flush()

    streams = _by_id(await _sync(client, guest["token"]))

    assert set(streams) == {priv}  # ONLY the explicit membership
    assert streams[priv]["member"] is True
    assert meta not in streams  # no workspace-meta
    assert pub not in streams  # no public browser


# --- head consistency (no torn reads) -----------------------------------------


async def test_head_consistency_with_events(client: AsyncClient, db_session: AsyncSession) -> None:
    """sync head_seq matches exactly what before=head+1 returns (head never over-promises)."""
    o = await do_setup(client)
    ws, uid, did = o["workspace_id"], o["user_id"], o["device_id"]
    sid = _add_stream(db_session, ws=ws, kind="channel", name="general", visibility="public")
    await db_session.flush()
    db_session.add(StreamMember(stream_id=sid, user_id=uid))
    await db_session.flush()
    n = 7
    for i in range(1, n + 1):
        body: dict[str, Any] = build_message_created_body(
            workspace_id=ws,
            stream_id=sid,
            author_user_id=uid,
            author_device_id=did,
            client_created_at=now_rfc3339(),
            text=f"m{i}",
        ).model_dump(mode="json")
        await insert_event(db_session, stream_id=sid, body=body)
    await db_session.flush()

    streams = _by_id(await _sync(client, o["token"]))
    head = streams[sid]["head_seq"]
    assert head == n

    page = (
        await client.get(
            "/v1/events",
            params={"stream_id": sid, "before": head + 1, "limit": 500},
            headers=auth_header(o["token"]),
        )
    ).json()
    seqs = [e["server"]["server_sequence"] for e in page["events"]]
    assert seqs == list(range(1, head + 1))  # contiguous 1..head, nothing missing
    assert page["has_more"] is False


# --- adversary: private stream never leaks ------------------------------------


async def test_adversary_private_absent_and_events_404(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A non-member's sync omits the private id AND its head; events on it ⇒ 404."""
    o = await do_setup(client)
    ws, owner_uid, owner_did = o["workspace_id"], o["user_id"], o["device_id"]
    intruder = await _invited_user(client, o["token"], role="member", email="mallory@example.com")

    priv = _add_stream(db_session, ws=ws, kind="channel", name="secret", visibility="private")
    await db_session.flush()
    db_session.add(StreamMember(stream_id=priv, user_id=owner_uid))  # owner only
    await db_session.flush()
    # Give the private stream a non-trivial head so a leak would be observable.
    for i in range(3):
        body: dict[str, Any] = build_message_created_body(
            workspace_id=ws,
            stream_id=priv,
            author_user_id=owner_uid,
            author_device_id=owner_did,
            client_created_at=now_rfc3339(),
            text=f"secret {i}",
        ).model_dump(mode="json")
        await insert_event(db_session, stream_id=priv, body=body)
    await db_session.flush()

    body = await _sync(client, intruder["token"])
    # The private id appears nowhere in the intruder's payload (no head leak).
    assert priv not in _by_id(body)
    assert priv not in repr(body)

    # And a direct events pull on it is a 404 — identical to an unknown stream.
    r = await client.get(
        "/v1/events",
        params={"stream_id": priv},
        headers=auth_header(intruder["token"]),
    )
    assert r.status_code == 404
    assert r.json()["type"] == "/problems/not-found"


# --- always 200, never 404 ----------------------------------------------------


async def test_sync_after_setup_returns_meta_and_general(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Right after setup, sync is a 200 listing the meta + the seeded #general (ENG-109)."""
    o = await do_setup(client)
    meta = await _meta_id(db_session, o["workspace_id"])
    body = await _sync(client, o["token"])
    streams = _by_id(body)

    # The two streams a fresh workspace's owner sees: workspace-meta + #general.
    assert meta in streams
    assert streams[meta]["kind"] == "workspace-meta"
    kinds = {s["kind"] for s in body["streams"]}
    assert kinds == {"workspace-meta", "channel"}

    # The seeded channel: public, member:true, ready to receive messages (head 0).
    general = next(s for s in body["streams"] if s["kind"] == "channel")
    assert general["name"] == "general"
    assert general["visibility"] == "public"
    assert general["member"] is True
    assert general["head_seq"] == 0


async def test_sync_after_accept_invite_returns_general_as_member(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """An invitee's sync lists #general with member:true right after accept (ENG-112).

    Mirrors ``test_sync_after_setup_returns_meta_and_general`` for the OWNER: without
    the accept-invite channel.member_added, the invitee would see #general in the
    public browser but member:false (empty sidebar). The self-join makes it true.
    """
    o = await do_setup(client)
    invitee = await _invited_user(client, o["token"], role="member", email="joiner@example.com")
    meta = await _meta_id(db_session, o["workspace_id"])

    body = await _sync(client, invitee["token"])
    streams = _by_id(body)

    # The invitee sees the same two streams as the owner: workspace-meta + #general.
    assert meta in streams
    assert streams[meta]["kind"] == "workspace-meta"
    kinds = {s["kind"] for s in body["streams"]}
    assert kinds == {"workspace-meta", "channel"}

    # #general: public and member:true for the invitee (the sidebar is populated).
    general = next(s for s in body["streams"] if s["kind"] == "channel")
    assert general["name"] == "general"
    assert general["visibility"] == "public"
    assert general["member"] is True
    assert general["head_seq"] == 0
