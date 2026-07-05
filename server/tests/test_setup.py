"""POST /v1/setup — first-run registration + advisory-lock race (ENG-64 D1)."""

from __future__ import annotations

import asyncio

from authutil import OWNER, auth_header, committing_app, do_setup, truncate_auth_tables
from httpx import AsyncClient
from msgd.settings import Settings
from sqlalchemy.ext.asyncio import create_async_engine


async def test_first_run_creates_owner(client: AsyncClient) -> None:
    """First setup creates the workspace + owner and returns a working token."""
    body = await do_setup(client)
    assert body["role"] == "owner"
    assert body["user_id"].startswith("u_")
    assert body["workspace_id"].startswith("w_")
    assert body["device_id"].startswith("d_")
    assert body["token"]

    # The returned token authenticates immediately.
    resp = await client.get("/v1/auth/sessions", headers=auth_header(body["token"]))
    assert resp.status_code == 200
    sessions = resp.json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["current"] is True


async def test_second_setup_conflicts(client: AsyncClient) -> None:
    """Once a user exists, setup returns 409 problem+json (already-initialized)."""
    await do_setup(client)
    resp = await client.post("/v1/setup", json=OWNER)
    assert resp.status_code == 409
    assert resp.headers["content-type"] == "application/problem+json"
    body = resp.json()
    assert body["type"] == "/problems/already-initialized"
    assert body["status"] == 409


# --- concurrency: committing fixture lives in authutil (shared with invites) --


async def test_setup_race_exactly_one_winner(settings: Settings, migrated_db: str) -> None:
    """Two concurrent setups against committing sessions ⇒ exactly one 200, one 409.

    The advisory lock serializes them: the winner inserts the owner and commits;
    the loser, unblocked, sees ``count(users) > 0`` and returns 409.
    """
    cleanup_engine = create_async_engine(settings.database_url)
    await truncate_auth_tables(cleanup_engine)  # start from an empty server

    c1, e1 = committing_app(settings)
    c2, e2 = committing_app(settings)
    try:
        async with c1, c2:
            r1, r2 = await asyncio.gather(
                c1.post("/v1/setup", json={**OWNER, "email": "a@example.com"}),
                c2.post("/v1/setup", json={**OWNER, "email": "b@example.com"}),
            )
        assert sorted([r1.status_code, r2.status_code]) == [200, 409]
        winner = r1 if r1.status_code == 200 else r2
        assert winner.json()["role"] == "owner"
    finally:
        await truncate_auth_tables(cleanup_engine)  # no committed-row leakage
        await e1.dispose()
        await e2.dispose()
        await cleanup_engine.dispose()


async def test_setup_short_password_422(client: AsyncClient) -> None:
    """A sub-12-char password is rejected by the schema as 422 problem+json."""
    resp = await client.post("/v1/setup", json={**OWNER, "password": "short"})
    assert resp.status_code == 422
    assert resp.headers["content-type"] == "application/problem+json"
