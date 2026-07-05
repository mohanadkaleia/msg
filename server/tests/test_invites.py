"""Invites — create (owner/admin), single-use, TTL, role restriction (D7)."""

from __future__ import annotations

import asyncio
from datetime import timedelta

from authutil import (
    accept_invite,
    auth_header,
    committing_app,
    create_invite,
    do_setup,
    join_token,
    truncate_auth_tables,
)
from httpx import AsyncClient
from msgd.auth.sessions import utcnow
from msgd.auth.tokens import hash_token
from msgd.db.models import Invite
from msgd.settings import Settings
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine


async def test_owner_creates_invite(client: AsyncClient) -> None:
    """An owner mints an invite and gets a one-time join URL back."""
    owner_token = (await do_setup(client))["token"]
    resp = await create_invite(client, owner_token, role="member")
    assert resp.status_code == 201
    body = resp.json()
    assert "/join/" in body["url"]
    assert body["expires_at"]


async def test_accept_creates_user_and_autologin(client: AsyncClient) -> None:
    """Accepting an invite creates the user with the invite role and logs in."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])

    accepted = await accept_invite(client, raw, email="joiner@example.com")
    assert accepted.status_code == 200
    body = accepted.json()
    assert body["role"] == "member"
    assert body["token"]
    # The minted token authenticates.
    me = await client.get("/v1/auth/sessions", headers=auth_header(body["token"]))
    assert me.status_code == 200


async def test_member_cannot_create_invite(client: AsyncClient) -> None:
    """A member hitting the admin invite endpoint is forbidden (403)."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])
    member_token = (await accept_invite(client, raw, email="m@example.com")).json()["token"]

    resp = await create_invite(client, member_token, role="member")
    assert resp.status_code == 403
    assert resp.json()["type"] == "/problems/forbidden"


async def test_single_use_second_accept_410(client: AsyncClient) -> None:
    """A second accept of the same token is rejected (single-use, 410)."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])

    first = await accept_invite(client, raw, email="first@example.com")
    assert first.status_code == 200
    second = await accept_invite(client, raw, email="second@example.com")
    assert second.status_code == 410
    assert second.json()["type"] == "/problems/invite-used"


async def test_expired_invite_410(client: AsyncClient, db_session: AsyncSession) -> None:
    """An expired invite is rejected 410 invite-expired."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])

    row = await db_session.get(Invite, hash_token(raw))
    assert row is not None
    row.expires_at = utcnow() - timedelta(seconds=1)
    await db_session.flush()

    resp = await accept_invite(client, raw, email="late@example.com")
    assert resp.status_code == 410
    assert resp.json()["type"] == "/problems/invite-expired"


async def test_invite_cannot_request_owner_role(client: AsyncClient) -> None:
    """An invite may not mint an owner — the schema rejects it as 422."""
    owner_token = (await do_setup(client))["token"]
    resp = await client.post(
        "/v1/admin/invites", json={"role": "owner"}, headers=auth_header(owner_token)
    )
    assert resp.status_code == 422
    assert resp.headers["content-type"] == "application/problem+json"


async def test_admin_role_can_create_invite(client: AsyncClient) -> None:
    """An 'admin' (invited as admin) can also create invites (owner/admin gate)."""
    owner_token = (await do_setup(client))["token"]
    admin_invite = await create_invite(client, owner_token, role="admin")
    raw = join_token(admin_invite.json()["url"])
    admin_token = (await accept_invite(client, raw, email="admin@example.com")).json()["token"]

    resp = await create_invite(client, admin_token, role="member")
    assert resp.status_code == 201


async def test_duplicate_email_409_and_invite_not_burned(client: AsyncClient) -> None:
    """Duplicate-email accept → generic 409; the invite stays usable (claim rollback).

    Security round 1: the atomic claim runs first, the UNIQUE(workspace_id,
    email) violation rolls the transaction back — un-claiming the invite — and
    the 409 body is generic (no email-existence oracle, the email is not echoed).
    """
    owner_token = (await do_setup(client))["token"]
    invite1 = await create_invite(client, owner_token, role="member")
    raw1 = join_token(invite1.json()["url"])
    first = await accept_invite(client, raw1, email="taken@example.com")
    assert first.status_code == 200

    invite2 = await create_invite(client, owner_token, role="member")
    raw2 = join_token(invite2.json()["url"])

    # Same email through a *different* invite → generic 409 problem+json.
    dup = await accept_invite(client, raw2, email="taken@example.com")
    assert dup.status_code == 409
    assert dup.headers["content-type"] == "application/problem+json"
    body = dup.json()
    assert body["type"] == "/problems/account-conflict"
    assert "taken@example.com" not in dup.text  # generic detail, no oracle

    # The failed accept did NOT consume invite2: a different email succeeds.
    retry = await accept_invite(client, raw2, email="fresh@example.com")
    assert retry.status_code == 200, retry.text
    assert retry.json()["role"] == "member"


async def test_concurrent_same_email_different_invites(
    settings: Settings, migrated_db: str
) -> None:
    """Two invites accepted concurrently with the same email ⇒ one 200, one 409.

    Real committing sessions: the loser's INSERT blocks on the unique index
    until the winner commits, then raises — surfaced as a clean 409 (never a
    500), and the loser's invite is un-claimed by the rollback.
    """
    cleanup_engine = create_async_engine(settings.database_url)
    await truncate_auth_tables(cleanup_engine)  # start from an empty server

    c, engine = committing_app(settings)
    try:
        async with c:
            owner_token = (
                await c.post(
                    "/v1/setup",
                    json={
                        "workspace_name": "Acme",
                        "email": "own@example.com",
                        "password": "correct-horse-battery-staple",
                        "display_name": "Owner",
                    },
                )
            ).json()["token"]
            inv1 = await create_invite(c, owner_token, role="member")
            inv2 = await create_invite(c, owner_token, role="member")
            raw1 = join_token(inv1.json()["url"])
            raw2 = join_token(inv2.json()["url"])

            r1, r2 = await asyncio.gather(
                accept_invite(c, raw1, email="race@example.com"),
                accept_invite(c, raw2, email="race@example.com"),
            )
            statuses = sorted([r1.status_code, r2.status_code])
            assert statuses == [200, 409], (r1.text, r2.text)
            loser = r1 if r1.status_code == 409 else r2
            assert loser.json()["type"] == "/problems/account-conflict"

            # The loser's invite was un-claimed → still usable for another email.
            loser_raw = raw1 if r1.status_code == 409 else raw2
            retry = await accept_invite(c, loser_raw, email="other@example.com")
            assert retry.status_code == 200, retry.text
    finally:
        await truncate_auth_tables(cleanup_engine)
        await engine.dispose()
        await cleanup_engine.dispose()
