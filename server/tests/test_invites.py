"""Invites — create (owner/admin), single-use, TTL, role restriction (D7)."""

from __future__ import annotations

import asyncio
import hashlib
import re
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


async def test_guest_cannot_create_invite(client: AsyncClient) -> None:
    """A guest hitting the admin invite endpoint is forbidden (403), like a member."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="guest")
    raw = join_token(invite.json()["url"])
    guest_token = (await accept_invite(client, raw, email="g@example.com")).json()["token"]

    resp = await create_invite(client, guest_token, role="member")
    assert resp.status_code == 403
    assert resp.json()["type"] == "/problems/forbidden"


async def test_invite_token_high_entropy_and_only_hash_stored(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The raw join token is a fresh 256-bit urlsafe secret; only its sha256 is stored.

    Teeth: ``secrets.token_urlsafe(32)`` yields ≥43 urlsafe chars — every mint is
    distinct and matches that shape (not a counter, uuid, or hash of inputs); the
    DB row's PK is exactly ``sha256(raw)`` hex, and the raw token appears in no
    other stored column. The raw token also round-trips through accept (the hash
    lookup is the credential check).
    """
    owner_token = (await do_setup(client))["token"]

    raws: list[str] = []
    for _ in range(5):
        resp = await create_invite(client, owner_token, role="member")
        assert resp.status_code == 201
        raws.append(join_token(resp.json()["url"]))

    assert len(set(raws)) == 5  # never repeated
    for raw in raws:
        assert len(raw) >= 43  # 32 bytes → 43 base64url chars (256 bits)
        assert re.fullmatch(r"[A-Za-z0-9_-]+", raw)  # urlsafe alphabet, no padding
        row = await db_session.get(Invite, hash_token(raw))
        assert row is not None  # stored under sha256(raw) …
        assert row.token_hash == hashlib.sha256(raw.encode()).hexdigest()
        # … and the raw token itself is persisted NOWHERE on the row.
        assert raw not in (row.token_hash, row.workspace_id, row.created_by, row.role)

    # The minted token is a working credential end-to-end (hash-lookup accept).
    accepted = await accept_invite(client, raws[0], email="minted@example.com")
    assert accepted.status_code == 200


async def test_invite_ttl_respected_and_clamped(
    client: AsyncClient, db_session: AsyncSession, settings: Settings
) -> None:
    """``ttl_seconds`` drives ``expires_at``; an over-max request clamps to the cap."""
    owner_token = (await do_setup(client))["token"]

    short = await create_invite(client, owner_token, ttl_seconds=3600)
    assert short.status_code == 201
    row = await db_session.get(Invite, hash_token(join_token(short.json()["url"])))
    assert row is not None
    delta = (row.expires_at - utcnow()).total_seconds()
    assert 3500 < delta <= 3600

    huge = await create_invite(client, owner_token, ttl_seconds=10**9)
    assert huge.status_code == 201
    row = await db_session.get(Invite, hash_token(join_token(huge.json()["url"])))
    assert row is not None
    delta = (row.expires_at - utcnow()).total_seconds()
    assert delta <= settings.invite_max_ttl_seconds  # clamped, not honored
    assert delta > settings.invite_max_ttl_seconds - 120


async def test_created_invite_listed_by_hash_then_accept_consumes_it(
    client: AsyncClient,
) -> None:
    """Create → list shows it (id = sha256, raw absent) → accept → gone from list."""
    owner_token = (await do_setup(client))["token"]
    owner_h = auth_header(owner_token)

    created = await create_invite(client, owner_token, role="admin")
    assert created.status_code == 201
    raw = join_token(created.json()["url"])

    listed = await client.get("/v1/admin/invites", headers=owner_h)
    assert listed.status_code == 200
    (entry,) = listed.json()["invites"]
    assert entry["id"] == hash_token(raw)
    assert entry["role"] == "admin"
    assert raw not in listed.text  # the raw token existed exactly once, at create

    accepted = await accept_invite(client, raw, email="a@example.com")
    assert accepted.status_code == 200
    assert accepted.json()["role"] == "admin"

    after = await client.get("/v1/admin/invites", headers=owner_h)
    assert after.json()["invites"] == []  # used → no longer pending


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


async def test_list_invites_pending_only_and_raw_token_absent(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET /v1/admin/invites returns only pending invites; the raw token appears NOWHERE.

    A used invite and an expired invite are both excluded; the id is the sha256
    ``token_hash`` (the revoke handle), and the raw join token — returned once at
    create — is not a substring of the serialized list body.
    """
    owner_token = (await do_setup(client))["token"]

    pending = await create_invite(client, owner_token, role="member")
    pending_raw = join_token(pending.json()["url"])

    # A used invite (accepted) — must be excluded.
    used = await create_invite(client, owner_token, role="member")
    used_raw = join_token(used.json()["url"])
    await accept_invite(client, used_raw, email="used@example.com")

    # An expired invite — must be excluded.
    expired = await create_invite(client, owner_token, role="guest")
    expired_raw = join_token(expired.json()["url"])
    row = await db_session.get(Invite, hash_token(expired_raw))
    assert row is not None
    row.expires_at = utcnow() - timedelta(seconds=1)
    await db_session.flush()

    resp = await client.get("/v1/admin/invites", headers=auth_header(owner_token))
    assert resp.status_code == 200
    invites = resp.json()["invites"]
    ids = {i["id"] for i in invites}
    assert ids == {hash_token(pending_raw)}  # only the pending one
    assert invites[0]["role"] == "member"
    # The RAW token is never serialized (create-time only).
    assert pending_raw not in resp.text
    assert used_raw not in resp.text
    assert expired_raw not in resp.text


async def test_list_invites_workspace_gated(client: AsyncClient) -> None:
    """A member cannot list invites (owner/admin only)."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])
    member_token = (await accept_invite(client, raw, email="m@example.com")).json()["token"]
    resp = await client.get("/v1/admin/invites", headers=auth_header(member_token))
    assert resp.status_code == 403


async def test_revoke_invite_then_accept_404_and_uniform(client: AsyncClient) -> None:
    """DELETE a pending invite → 204; the raw token then 404s invalid_invite.

    Revoke again, revoke a used invite, and revoke an unknown id all return the
    IDENTICAL uniform 404 body (no revoked-vs-used-vs-nonexistent oracle).
    """
    owner_token = (await do_setup(client))["token"]
    owner_h = auth_header(owner_token)

    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])
    invite_id = hash_token(raw)

    # Revoke it (204), then accepting with the raw token is invalid_invite (404).
    r = await client.delete(f"/v1/admin/invites/{invite_id}", headers=owner_h)
    assert r.status_code == 204
    accepted = await accept_invite(client, raw, email="late@example.com")
    assert accepted.status_code == 404
    assert accepted.json()["type"] == "/problems/invalid-invite"

    def sans_instance(body: dict[str, object]) -> dict[str, object]:
        return {k: v for k, v in body.items() if k != "instance"}

    # Revoke again → 404 (already revoked).
    again = await client.delete(f"/v1/admin/invites/{invite_id}", headers=owner_h)
    assert again.status_code == 404

    # Revoke a USED invite → 404.
    used = await create_invite(client, owner_token, role="member")
    used_raw = join_token(used.json()["url"])
    await accept_invite(client, used_raw, email="used@example.com")
    revoke_used = await client.delete(f"/v1/admin/invites/{hash_token(used_raw)}", headers=owner_h)
    assert revoke_used.status_code == 404

    # Revoke an UNKNOWN id → 404. All three bodies are identical (sans path).
    unknown = await client.delete("/v1/admin/invites/deadbeef", headers=owner_h)
    assert unknown.status_code == 404
    b_again = sans_instance(again.json())
    assert b_again == sans_instance(revoke_used.json())
    assert b_again == sans_instance(unknown.json())
    assert again.json()["type"] == "/problems/not-found"


async def test_revoke_invite_cross_workspace_404(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoking another workspace's invite → 404 (workspace-scoped, uniform)."""
    owner_token = (await do_setup(client))["token"]

    # Seed a second workspace + an invite in it directly on the bound session.
    from msgd.core import ids as _ids
    from msgd.db.models import User, Workspace

    other_ws = _ids.new_workspace_id()
    other_user = _ids.new_user_id()
    db_session.add(Workspace(workspace_id=other_ws, name="Other"))
    await db_session.flush()
    db_session.add(
        User(
            user_id=other_user,
            workspace_id=other_ws,
            email="o@example.com",
            password_hash="x",
            display_name="O",
            role="owner",
        )
    )
    await db_session.flush()
    other_hash = hash_token("cross-workspace-raw-token")
    db_session.add(
        Invite(
            token_hash=other_hash,
            workspace_id=other_ws,
            created_by=other_user,
            role="member",
            expires_at=utcnow() + timedelta(days=1),
        )
    )
    await db_session.flush()

    resp = await client.delete(f"/v1/admin/invites/{other_hash}", headers=auth_header(owner_token))
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


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
