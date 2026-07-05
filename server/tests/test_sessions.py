"""GET/DELETE /v1/auth/sessions — listing, current flag, instant revoke (D5)."""

from __future__ import annotations

from authutil import (
    OWNER,
    accept_invite,
    auth_header,
    create_invite,
    do_login,
    do_setup,
    join_token,
)
from httpx import AsyncClient
from msgd.auth.tokens import hash_token


async def test_list_flags_current_session(client: AsyncClient) -> None:
    """Multiple sessions are listed; only the caller's is flagged current."""
    setup_body = await do_setup(client)
    token_a = setup_body["token"]
    login_b = await do_login(client, email=OWNER["email"], password=OWNER["password"])
    token_b = login_b.json()["token"]

    resp = await client.get("/v1/auth/sessions", headers=auth_header(token_a))
    assert resp.status_code == 200
    sessions = resp.json()["sessions"]
    assert len(sessions) == 2
    current = [s for s in sessions if s["current"]]
    assert len(current) == 1
    assert current[0]["id"] == hash_token(token_a)
    assert token_a not in resp.text  # the raw token is never echoed back
    assert token_b not in resp.text


async def test_revoke_is_instant(client: AsyncClient) -> None:
    """Deleting a session immediately invalidates its token."""
    token_a = (await do_setup(client))["token"]
    login_b = await do_login(client, email=OWNER["email"], password=OWNER["password"])
    token_b = login_b.json()["token"]

    # Owner revokes session B using session A.
    resp = await client.delete(
        f"/v1/auth/sessions/{hash_token(token_b)}", headers=auth_header(token_a)
    )
    assert resp.status_code == 204

    # Token B no longer authenticates.
    after = await client.get("/v1/auth/sessions", headers=auth_header(token_b))
    assert after.status_code == 401


async def test_cannot_revoke_another_users_session(client: AsyncClient) -> None:
    """A user revoking another user's session id gets 404 (scoped delete)."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])
    accepted = await accept_invite(client, raw, email="member@example.com")
    member_token = accepted.json()["token"]

    # Member tries to revoke the owner's session → 404 (matches no row of theirs).
    resp = await client.delete(
        f"/v1/auth/sessions/{hash_token(owner_token)}", headers=auth_header(member_token)
    )
    assert resp.status_code == 404

    # The owner's session is untouched.
    still = await client.get("/v1/auth/sessions", headers=auth_header(owner_token))
    assert still.status_code == 200
