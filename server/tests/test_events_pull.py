"""``GET /v1/events`` — pagination, window/has_more exactness, clamp, 404, raw-hash (ENG-67).

Streams and events are seeded **directly at the DB layer** (``insert_event`` +
``Stream`` rows), never via the upload endpoint — ENG-67 is independently
testable of ENG-66. Requests are driven through the in-process ``client`` (which
shares the rolled-back ``db_session``), so seeded-but-uncommitted rows are
visible to the endpoint.
"""

from __future__ import annotations

from typing import Any

import pytest
from authutil import auth_header, do_setup
from httpx import AsyncClient
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import Stream
from msgd.events.insert import insert_event
from sqlalchemy.ext.asyncio import AsyncSession


async def _owner(client: AsyncClient) -> dict[str, Any]:
    """Set up the workspace + owner; return the login body (token/ids)."""
    return await do_setup(client)


def _message_body(*, ws: str, sid: str, uid: str, did: str, text: str) -> dict[str, Any]:
    body: dict[str, Any] = build_message_created_body(
        workspace_id=ws,
        stream_id=sid,
        author_user_id=uid,
        author_device_id=did,
        client_created_at=now_rfc3339(),
        text=text,
    ).model_dump(mode="json")
    return body


def _unknown_body(*, ws: str, sid: str, uid: str, did: str) -> dict[str, Any]:
    """A raw, unknown-type event body — opaque payload, valid typed ids only."""
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": ws,
        "stream_id": sid,
        "type": "x.custom",
        "type_version": 1,
        "author_user_id": uid,
        "author_device_id": did,
        "client_created_at": now_rfc3339(),
        "payload": {"anything": "goes", "n": 42, "nested": {"a": [1, 2, 3]}},
    }


async def _seed_channel(
    db: AsyncSession,
    *,
    ws: str,
    uid: str,
    did: str,
    count: int,
    visibility: str = "public",
    unknown_at: int | None = None,
) -> str:
    """Create a channel and insert ``count`` message events (1..count).

    ``unknown_at`` (1-based) makes that one event an unknown-type event to prove
    opaque bodies survive the raw-serve path.
    """
    sid = ids.new_stream_id()
    db.add(
        Stream(
            stream_id=sid, workspace_id=ws, kind="channel", name="general", visibility=visibility
        )
    )
    await db.flush()
    for i in range(1, count + 1):
        if unknown_at is not None and i == unknown_at:
            body = _unknown_body(ws=ws, sid=sid, uid=uid, did=did)
        else:
            body = _message_body(ws=ws, sid=sid, uid=uid, did=did, text=f"msg {i}")
        await insert_event(db, stream_id=sid, body=body)
    await db.flush()
    return sid


async def _get(client: AsyncClient, token: str, sid: str, **params: int) -> Any:
    q: dict[str, Any] = {"stream_id": sid, **params}
    return await client.get("/v1/events", params=q, headers=auth_header(token))


def _seqs(page: dict[str, Any]) -> list[int]:
    return [e["server"]["server_sequence"] for e in page["events"]]


# --- pagination: gapless / duplicate-free across boundaries, both directions ---


@pytest.mark.parametrize(("total", "page"), [(23, 10), (20, 10)])
async def test_forward_pagination_gapless(
    client: AsyncClient, db_session: AsyncSession, total: int, page: int
) -> None:
    """Walk forward with ``after=last_seq`` until ``has_more`` is false ⇒ exactly [1..M]."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=total
    )

    seen: list[int] = []
    cursor = 0
    guard = 0
    while True:
        guard += 1
        assert guard < total + 5  # loop can never run away
        r = await _get(client, o["token"], sid, after=cursor, limit=page)
        assert r.status_code == 200, r.text
        body = r.json()
        s = _seqs(body)
        assert s == sorted(s)  # ascending within the page
        seen += s
        if not body["has_more"]:
            break
        cursor = s[-1]
    assert seen == list(range(1, total + 1))  # no gaps, no dupes


@pytest.mark.parametrize(("total", "page"), [(23, 10), (20, 10)])
async def test_backward_pagination_gapless(
    client: AsyncClient, db_session: AsyncSession, total: int, page: int
) -> None:
    """Walk backward with ``before=first_seq`` until ``has_more`` is false ⇒ [1..M]."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=total
    )

    seen: list[int] = []
    cursor = total + 1
    guard = 0
    while True:
        guard += 1
        assert guard < total + 5
        r = await _get(client, o["token"], sid, before=cursor, limit=page)
        assert r.status_code == 200, r.text
        body = r.json()
        s = _seqs(body)
        assert s == sorted(s)  # ascending within the page even walking backward
        seen = s + seen  # prepend: older page comes first
        if not body["has_more"]:
            break
        cursor = s[0]
    assert seen == list(range(1, total + 1))


# --- window exactness + has_more at every boundary ----------------------------


async def test_window_and_has_more_edges(client: AsyncClient, db_session: AsyncSession) -> None:
    """Exact seq lists + has_more at after=0/M and before=1/2/M+1."""
    total, limit = 12, 5
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=total
    )
    tok = o["token"]

    # forward: after=0 → [1..limit], more newer exists
    b = (await _get(client, tok, sid, after=0, limit=limit)).json()
    assert _seqs(b) == [1, 2, 3, 4, 5] and b["has_more"] is True

    # forward mid: after=7 → [8..12], last page
    b = (await _get(client, tok, sid, after=7, limit=limit)).json()
    assert _seqs(b) == [8, 9, 10, 11, 12] and b["has_more"] is False

    # forward at head: after=M → empty, has_more false
    b = (await _get(client, tok, sid, after=total, limit=limit)).json()
    assert _seqs(b) == [] and b["has_more"] is False

    # backward: before=M+1 → newest `limit` ascending, more older exists
    b = (await _get(client, tok, sid, before=total + 1, limit=limit)).json()
    assert _seqs(b) == [8, 9, 10, 11, 12] and b["has_more"] is True

    # backward mid: before=6 → [1..5], last page (no older)
    b = (await _get(client, tok, sid, before=6, limit=limit)).json()
    assert _seqs(b) == [1, 2, 3, 4, 5] and b["has_more"] is False

    # backward edge: before=2 → [1], before=1 → [] — both last page
    b = (await _get(client, tok, sid, before=2, limit=limit)).json()
    assert _seqs(b) == [1] and b["has_more"] is False
    b = (await _get(client, tok, sid, before=1, limit=limit)).json()
    assert _seqs(b) == [] and b["has_more"] is False


async def test_no_param_default_is_ascending_from_one(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Neither cursor ⇒ first ascending page from seq 1 (≡ after=0)."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=12
    )
    none = (await _get(client, o["token"], sid, limit=5)).json()
    after0 = (await _get(client, o["token"], sid, after=0, limit=5)).json()
    assert _seqs(none) == [1, 2, 3, 4, 5]
    assert none == after0


async def test_both_params_422_invalid_cursor(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """after and before together ⇒ 422 /problems/invalid-cursor."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=3
    )
    r = await _get(client, o["token"], sid, after=0, before=3)
    assert r.status_code == 422
    assert r.json()["type"] == "/problems/invalid-cursor"


# --- limit clamping -----------------------------------------------------------


async def test_limit_clamping_small(client: AsyncClient, db_session: AsyncSession) -> None:
    """limit=0 and limit=-5 clamp to 1; a huge limit never errors and returns ≤500."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=5
    )
    tok = o["token"]

    b = (await _get(client, tok, sid, after=0, limit=0)).json()
    assert _seqs(b) == [1] and b["has_more"] is True

    b = (await _get(client, tok, sid, after=0, limit=-5)).json()
    assert _seqs(b) == [1] and b["has_more"] is True

    b = (await _get(client, tok, sid, after=0, limit=99999)).json()
    assert _seqs(b) == [1, 2, 3, 4, 5] and b["has_more"] is False
    assert len(b["events"]) <= 500


async def test_limit_upper_cap_bites(client: AsyncClient, db_session: AsyncSession) -> None:
    """A huge limit is capped at 500 even when more events exist (§4.3 page cap)."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=501
    )
    b = (await _get(client, o["token"], sid, after=0, limit=99999)).json()
    assert len(b["events"]) == 500
    assert _seqs(b) == list(range(1, 501))
    assert b["has_more"] is True  # the 501st exists beyond the cap


async def test_limit_non_integer_422(client: AsyncClient, db_session: AsyncSession) -> None:
    """A non-integer limit is a framework 422 (int coercion)."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session, ws=o["workspace_id"], uid=o["user_id"], did=o["device_id"], count=3
    )
    r = await client.get(
        "/v1/events",
        params={"stream_id": sid, "limit": "abc"},
        headers=auth_header(o["token"]),
    )
    assert r.status_code == 422


# --- raw-hash discipline (the load-bearing test) ------------------------------


async def test_raw_hash_discipline_every_event(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """For EVERY served event (incl. an unknown-type one): re-hash(body) == event_hash.

    Also asserts signature is null and server_sequence is present/monotonic —
    proving the raw-serve path never round-trips through Envelope/Body.
    """
    total = 8
    o = await _owner(client)
    sid = await _seed_channel(
        db_session,
        ws=o["workspace_id"],
        uid=o["user_id"],
        did=o["device_id"],
        count=total,
        unknown_at=4,  # one opaque unknown-type event mid-stream
    )
    body = (await _get(client, o["token"], sid, after=0, limit=total)).json()
    events = body["events"]
    assert len(events) == total

    saw_unknown = False
    for i, e in enumerate(events, start=1):
        assert hash_event(e["body"]) == e["event_hash"]  # verbatim body rehashes
        assert e["signature"] is None
        assert e["server"]["server_sequence"] == i
        assert set(e["server"]) == {"server_sequence", "server_received_at", "payload_redacted"}
        assert e["server"]["payload_redacted"] is False
        if e["body"]["type"] == "x.custom":
            saw_unknown = True
            assert e["body"]["payload"] == {"anything": "goes", "n": 42, "nested": {"a": [1, 2, 3]}}
    assert saw_unknown  # the unknown-type event was actually served


# --- 404 / 422 discipline -----------------------------------------------------


async def test_404_private_non_member(client: AsyncClient, db_session: AsyncSession) -> None:
    """A private stream the caller is not a member of ⇒ 404 /problems/not-found."""
    o = await _owner(client)
    sid = await _seed_channel(
        db_session,
        ws=o["workspace_id"],
        uid=o["user_id"],
        did=o["device_id"],
        count=3,
        visibility="private",  # owner gets no membership row → unreadable
    )
    r = await _get(client, o["token"], sid)
    assert r.status_code == 404
    assert r.json()["type"] == "/problems/not-found"


async def test_404_unknown_stream_identical(client: AsyncClient, db_session: AsyncSession) -> None:
    """An unknown stream id ⇒ the identical 404 (existence never disclosed)."""
    o = await _owner(client)
    r = await _get(client, o["token"], ids.new_stream_id())
    assert r.status_code == 404
    assert r.json()["type"] == "/problems/not-found"


async def test_422_missing_stream_id(client: AsyncClient, db_session: AsyncSession) -> None:
    """A missing required stream_id ⇒ 422 (framework required-query-param)."""
    o = await _owner(client)
    r = await client.get("/v1/events", headers=auth_header(o["token"]))
    assert r.status_code == 422
