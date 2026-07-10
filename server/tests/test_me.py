"""Self-profile surface — ``GET /v1/me`` + ``PATCH /v1/me``.

The endpoint is STRUCTURALLY self-only (no ``user_id`` parameter anywhere), so
the teeth here are: the read returns the CALLER's row (not someone else's), the
PATCH updates exactly the caller's row + emits the ``user.profile_updated``
meta event the client directory folds renames from, validation mirrors the
signup ``DisplayName`` bounds, and there is no cross-user vector (a smuggled
``user_id`` in the body is ignored; a path-suffixed id is not a route).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_setup,
    fetch_meta_stream_id,
    fetch_stream_events,
    join_token,
)
from eventsutil import post_batch, wire_item
from httpx import AsyncClient
from msgd.core import ids
from msgd.core.time import now_rfc3339
from msgd.db.models import User
from sqlalchemy.ext.asyncio import AsyncSession


async def _seed_member(client: AsyncClient, owner_token: str) -> dict[str, Any]:
    """Invite + accept a member; return their login body (token, user_id, ...)."""
    inv = await create_invite(client, owner_token, role="member")
    raw = join_token(inv.json()["url"])
    body: dict[str, Any] = (await accept_invite(client, raw, email="member@example.com")).json()
    return body


# --- read ---------------------------------------------------------------------


async def test_get_me_returns_the_callers_own_profile(client: AsyncClient) -> None:
    """Each caller sees THEIR row: id, display name, email, role, is_bot."""
    owner = await do_setup(client)
    member = await _seed_member(client, owner["token"])

    resp = await client.get("/v1/me", headers=auth_header(owner["token"]))
    assert resp.status_code == 200
    assert resp.json() == {
        "user_id": owner["user_id"],
        "display_name": "The Owner",
        "email": "owner@example.com",
        "role": "owner",
        "is_bot": False,
        # ENG-164 profile fields — null until set.
        "title": None,
        "description": None,
        "status_emoji": None,
        "status_text": None,
        "status_expires_at": None,
    }

    resp = await client.get("/v1/me", headers=auth_header(member["token"]))
    assert resp.status_code == 200
    body = resp.json()
    assert body["user_id"] == member["user_id"]
    assert body["display_name"] == "Invited User"
    assert body["email"] == "member@example.com"
    assert body["role"] == "member"


async def test_me_requires_authentication(client: AsyncClient) -> None:
    """No bearer → 401 on both the read and the write."""
    assert (await client.get("/v1/me")).status_code == 401
    assert (await client.patch("/v1/me", json={"display_name": "X"})).status_code == 401


# --- update -------------------------------------------------------------------


async def test_patch_me_updates_display_name_and_persists(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """PATCH returns the updated profile; the row and a re-read agree."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    resp = await client.patch("/v1/me", json={"display_name": "Renamed Owner"}, headers=h)
    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "Renamed Owner"
    assert body["user_id"] == owner["user_id"]
    # Non-name fields are untouched.
    assert body["email"] == "owner@example.com"
    assert body["role"] == "owner"

    # Persisted: the users row AND a fresh GET both show the new name.
    row = await db_session.get(User, owner["user_id"])
    assert row is not None and row.display_name == "Renamed Owner"
    assert (await client.get("/v1/me", headers=h)).json()["display_name"] == "Renamed Owner"


async def test_patch_me_emits_user_profile_updated_meta_event(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The rename appends exactly one self-authored ``user.profile_updated``.

    The client member directory is a fold over the workspace-meta log — this
    event is what renames the member on every client, so it must carry the new
    ``display_name`` and be authored by the caller (self, like ``user.joined``).
    """
    owner = await do_setup(client)
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    resp = await client.patch(
        "/v1/me", json={"display_name": "New Name"}, headers=auth_header(owner["token"])
    )
    assert resp.status_code == 200

    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before) + 1
    event = after[-1]
    assert event.type == "user.profile_updated"
    body = event.body
    assert body["author_user_id"] == owner["user_id"]
    assert body["payload"]["user_id"] == owner["user_id"]
    assert body["payload"]["display_name"] == "New Name"


async def test_patch_me_rejects_empty_and_oversized_names(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The signup ``DisplayName`` bounds (1..200) apply: 422, row untouched."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    for bad in ("", "x" * 201):
        resp = await client.patch("/v1/me", json={"display_name": bad}, headers=h)
        assert resp.status_code == 422, bad
        assert resp.json()["type"] == "/problems/validation-error"

    # A missing field is a 422 too (there is nothing else to PATCH).
    assert (await client.patch("/v1/me", json={}, headers=h)).status_code == 422

    row = await db_session.get(User, owner["user_id"])
    assert row is not None and row.display_name == "The Owner"


# --- ENG-164: title / description / custom status ------------------------------


async def test_patch_me_updates_title_description_individually(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Each new field PATCHes alone; unnamed fields are untouched (subset semantics)."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    resp = await client.patch("/v1/me", json={"title": "Staff Engineer"}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["title"] == "Staff Engineer"
    assert resp.json()["display_name"] == "The Owner"  # untouched
    assert resp.json()["description"] is None

    resp = await client.patch("/v1/me", json={"description": "I build things."}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["description"] == "I build things."
    assert resp.json()["title"] == "Staff Engineer"  # kept from the prior PATCH

    row = await db_session.get(User, owner["user_id"])
    assert row is not None
    assert row.title == "Staff Engineer"
    assert row.description == "I build things."

    # A fresh GET agrees.
    body = (await client.get("/v1/me", headers=h)).json()
    assert body["title"] == "Staff Engineer"
    assert body["description"] == "I build things."


async def test_patch_me_sets_and_clears_status(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The status PATCHes as a unit; ``clear_after`` becomes a future expiry; null clears."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    before = datetime.now(UTC)
    resp = await client.patch(
        "/v1/me",
        json={"status": {"emoji": "🌴", "text": "On vacation", "clear_after": "1h"}},
        headers=h,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status_emoji"] == "🌴"
    assert body["status_text"] == "On vacation"
    expires = datetime.fromisoformat(body["status_expires_at"])
    assert before + timedelta(minutes=59) < expires <= before + timedelta(minutes=61)

    # No clear_after → never auto-clears (null expiry).
    resp = await client.patch("/v1/me", json={"status": {"emoji": "🎧"}}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["status_emoji"] == "🎧"
    assert resp.json()["status_text"] is None
    assert resp.json()["status_expires_at"] is None

    # Explicit null clears the whole trio.
    resp = await client.patch("/v1/me", json={"status": None}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["status_emoji"] is None
    assert resp.json()["status_text"] is None
    assert resp.json()["status_expires_at"] is None
    row = await db_session.get(User, owner["user_id"])
    assert row is not None
    assert row.status_emoji is None and row.status_text is None
    assert row.status_expires_at is None


async def test_patch_me_all_fields_together_emits_one_event_with_resulting_values(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """One PATCH of everything → EXACTLY ONE event carrying the resulting state."""
    owner = await do_setup(client)
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    resp = await client.patch(
        "/v1/me",
        json={
            "display_name": "Dana S.",
            "title": "Agent",
            "description": "The truth is out there.",
            "status": {"emoji": "👽", "text": "Investigating", "clear_after": "30m"},
        },
        headers=auth_header(owner["token"]),
    )
    assert resp.status_code == 200

    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before) + 1  # exactly ONE appended event
    event = after[-1]
    assert event.type == "user.profile_updated"
    payload = event.body["payload"]
    assert payload["user_id"] == owner["user_id"]
    assert payload["display_name"] == "Dana S."
    assert payload["title"] == "Agent"
    assert payload["description"] == "The truth is out there."
    assert payload["status_emoji"] == "👽"
    assert payload["status_text"] == "Investigating"
    assert isinstance(payload["status_expires_at"], str)
    assert event.body["author_user_id"] == owner["user_id"]


async def test_patch_me_display_name_only_event_carries_resulting_nulls(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A name-only PATCH still records the resulting (unset → null) new fields."""
    owner = await do_setup(client)
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None

    resp = await client.patch(
        "/v1/me", json={"display_name": "Just Renamed"}, headers=auth_header(owner["token"])
    )
    assert resp.status_code == 200
    event = (await fetch_stream_events(db_session, meta_stream_id))[-1]
    payload = event.body["payload"]
    assert payload["display_name"] == "Just Renamed"
    assert payload["title"] is None
    assert payload["status_emoji"] is None
    assert payload["status_expires_at"] is None


async def test_patch_me_clears_title_with_null(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """An explicit ``null`` (or empty string) clears; an ABSENT field is untouched."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])
    assert (
        await client.patch("/v1/me", json={"title": "Keep?", "description": "Desc"}, headers=h)
    ).status_code == 200

    resp = await client.patch("/v1/me", json={"title": None}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["title"] is None
    assert resp.json()["description"] == "Desc"  # absent → untouched

    resp = await client.patch("/v1/me", json={"description": ""}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["description"] is None


async def test_patch_me_validation_bounds_for_new_fields(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Bounds → 422: title ≤100, description ≤500, status text ≤100, emoji shape,
    unknown clear_after. The row stays untouched on every rejection."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    bad_bodies: list[dict[str, Any]] = [
        {"title": "x" * 101},
        {"description": "x" * 501},
        {"status": {"text": "x" * 101}},
        # Non-single-emoji: whitespace-carrying text in the emoji slot.
        {"status": {"emoji": "not an emoji"}},
        # Oversized "emoji" (beyond the reaction-precedent 64-byte cap).
        {"status": {"emoji": "🌴" * 20}},
        # clear_after is a CLOSED vocabulary.
        {"status": {"text": "hi", "clear_after": "next-week"}},
        # display_name is NOT clearable (NOT NULL column).
        {"display_name": None},
    ]
    for bad in bad_bodies:
        resp = await client.patch("/v1/me", json=bad, headers=h)
        assert resp.status_code == 422, bad
        assert resp.json()["type"] == "/problems/validation-error"

    row = await db_session.get(User, owner["user_id"])
    assert row is not None
    assert row.display_name == "The Owner"
    assert row.title is None and row.description is None
    assert row.status_emoji is None and row.status_text is None


async def test_expired_status_reads_as_cleared(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """LAZY expiry: a past ``status_expires_at`` reads as cleared from GET (no job).

    The expiry is simulated by writing a past timestamp straight to the row —
    the PATCH surface itself can only mint future expiries (closed durations).
    """
    owner = await do_setup(client)
    h = auth_header(owner["token"])
    assert (
        await client.patch(
            "/v1/me",
            json={"status": {"emoji": "🍜", "text": "Lunch", "clear_after": "30m"}},
            headers=h,
        )
    ).status_code == 200

    row = await db_session.get(User, owner["user_id"])
    assert row is not None
    row.status_expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await db_session.commit()

    body = (await client.get("/v1/me", headers=h)).json()
    assert body["status_emoji"] is None
    assert body["status_text"] is None
    assert body["status_expires_at"] is None
    # The non-status profile fields are unaffected by expiry.
    assert body["display_name"] == "The Owner"


# --- structurally self-only ---------------------------------------------------


async def test_patch_me_has_no_cross_user_vector(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A member's PATCH changes ONLY the member; no route/body targets another user.

    ``/v1/me`` takes no ``user_id`` path parameter (a suffixed id is not a
    route), and a smuggled ``user_id`` in the body is ignored by the schema —
    the target is always the session's own user.
    """
    owner = await do_setup(client)
    member = await _seed_member(client, owner["token"])
    h = auth_header(member["token"])

    # A smuggled user_id in the body is ignored: the member renames THEMSELVES.
    resp = await client.patch(
        "/v1/me", json={"display_name": "Sneaky", "user_id": owner["user_id"]}, headers=h
    )
    assert resp.status_code == 200
    assert resp.json()["user_id"] == member["user_id"]

    member_row = await db_session.get(User, member["user_id"])
    owner_row = await db_session.get(User, owner["user_id"])
    assert member_row is not None and member_row.display_name == "Sneaky"
    assert owner_row is not None and owner_row.display_name == "The Owner"

    # There is no per-user route to aim at another account.
    resp = await client.patch(
        f"/v1/me/{owner['user_id']}", json={"display_name": "Nope"}, headers=h
    )
    assert resp.status_code in (404, 405)


# --- forged meta-event upload (PR #91 security review) -------------------------


def _meta_body(
    *,
    auth: dict[str, Any],
    home_stream_id: str,
    type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """A server-authored meta body forged by a CLIENT (author = the session).

    ``author_user_id`` / ``author_device_id`` / ``workspace_id`` are the caller's
    own (so the §3.2 session binding passes), but ``type`` is a server-authored
    meta type a client must never be able to upload.
    """
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": home_stream_id,
        "type": type,
        "type_version": 1,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload,
    }


async def test_forged_profile_updated_upload_is_rejected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A member forging ``user.profile_updated`` to rename the OWNER is rejected.

    This is the impersonation vector from the PR #91 review: the event passes the
    §3.2 session binding (the member authors it as themselves) but names the owner
    in ``payload.user_id``. The server MUST reject it (``permission_denied``), append
    NO event, and leave the owner's name unchanged. Without the server-authored-type
    guard this returned 200 accepted and renamed the owner on every client.
    """
    owner = await do_setup(client)
    member = await _seed_member(client, owner["token"])
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    forged = _meta_body(
        auth=member,
        home_stream_id=meta_stream_id,
        type="user.profile_updated",
        payload={"user_id": owner["user_id"], "display_name": "PWNED"},
    )
    resp = await post_batch(client, member["token"], [wire_item(forged)])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] == []
    assert len(body["rejected"]) == 1
    assert body["rejected"][0]["code"] == "permission_denied"

    # No event was appended and the victim's name is unchanged.
    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before)
    owner_row = await db_session.get(User, owner["user_id"])
    assert owner_row is not None and owner_row.display_name == "The Owner"


async def test_forged_profile_updated_upload_by_guest_is_rejected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A guest forging ``user.profile_updated`` is rejected too (whole-family guard)."""
    owner = await do_setup(client)
    inv = await create_invite(client, owner["token"], role="guest")
    guest: dict[str, Any] = (
        await accept_invite(client, join_token(inv.json()["url"]), email="guest@example.com")
    ).json()
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None

    forged = _meta_body(
        auth=guest,
        home_stream_id=meta_stream_id,
        type="user.profile_updated",
        payload={"user_id": owner["user_id"], "display_name": "PWNED"},
    )
    resp = await post_batch(client, guest["token"], [wire_item(forged)])
    assert resp.status_code == 200, resp.text
    assert resp.json()["rejected"][0]["code"] == "permission_denied"
    owner_row = await db_session.get(User, owner["user_id"])
    assert owner_row is not None and owner_row.display_name == "The Owner"


async def test_forged_profile_updated_with_extended_payload_is_rejected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The guard holds for the ENG-164 payload too: a forged title/status upload
    is ``permission_denied`` — the type check fires before any payload field."""
    owner = await do_setup(client)
    member = await _seed_member(client, owner["token"])
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    forged = _meta_body(
        auth=member,
        home_stream_id=meta_stream_id,
        type="user.profile_updated",
        payload={
            "user_id": owner["user_id"],
            "display_name": "PWNED",
            "title": "Fake CEO",
            "description": "Forged",
            "status_emoji": "💀",
            "status_text": "hacked",
            "status_expires_at": None,
        },
    )
    resp = await post_batch(client, member["token"], [wire_item(forged)])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] == []
    assert body["rejected"][0]["code"] == "permission_denied"
    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before)
    owner_row = await db_session.get(User, owner["user_id"])
    assert owner_row is not None
    assert owner_row.display_name == "The Owner" and owner_row.title is None


async def test_forged_user_joined_upload_is_rejected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The whole server-authored family is rejected on upload — e.g. ``user.joined``.

    ``user.joined`` grants membership; a client uploading one is forging authority.
    Same rejection shape as ``user.profile_updated``.
    """
    owner = await do_setup(client)
    member = await _seed_member(client, owner["token"])
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    forged = _meta_body(
        auth=member,
        home_stream_id=meta_stream_id,
        type="user.joined",
        payload={"user_id": ids.new_user_id(), "display_name": "Ghost"},
    )
    resp = await post_batch(client, member["token"], [wire_item(forged)])
    assert resp.status_code == 200, resp.text
    assert resp.json()["rejected"][0]["code"] == "permission_denied"
    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before)
