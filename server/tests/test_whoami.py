"""``GET /v1/whoami`` — the caller's own identity (ENG-179).

Teeth: whoami returns the CALLER's own ids (never someone else's); it works for a
BOT token and surfaces the bot's ``device_id`` — the gap that motivated the
endpoint (``GET /v1/me`` omits ``device_id`` / ``workspace_id``, and the
``/v1/plugins/bots`` listing that carries ``device_id`` is owner/admin-gated, so
a guest bot 403s there); and it is ungated (reachable by any valid credential)
but rejects an anonymous / bad-token caller with 401.
"""

from __future__ import annotations

from typing import Any

from authutil import auth_header, do_setup
from httpx import AsyncClient


async def _create_bot_with_token(
    client: AsyncClient, owner_token: str, *, scopes: list[str]
) -> dict[str, Any]:
    """Provision a bot and mint a token; return its create body + raw token."""
    created = await client.post(
        "/v1/plugins/bots",
        json={"name": "Whoami Bot", "scopes": scopes, "stream_ids": []},
        headers=auth_header(owner_token),
    )
    assert created.status_code in (200, 201), created.text
    bot: dict[str, Any] = created.json()
    minted = await client.post(
        f"/v1/plugins/bots/{bot['bot_user_id']}/tokens",
        json={},
        headers=auth_header(owner_token),
    )
    assert minted.status_code in (200, 201), minted.text
    bot["token"] = minted.json()["token"]
    return bot


async def test_whoami_returns_the_owners_own_identity(client: AsyncClient) -> None:
    owner = await do_setup(client)
    resp = await client.get("/v1/whoami", headers=auth_header(owner["token"]))
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "user_id": owner["user_id"],
        "device_id": owner["device_id"],
        "workspace_id": owner["workspace_id"],
        "is_bot": False,
        "role": "owner",
    }


async def test_whoami_gives_a_bot_its_own_device_id(client: AsyncClient) -> None:
    """The motivating case: a bot discovers the device_id it must author with."""
    owner = await do_setup(client)
    bot = await _create_bot_with_token(client, owner["token"], scopes=["events:write"])

    resp = await client.get("/v1/whoami", headers=auth_header(bot["token"]))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "user_id": bot["bot_user_id"],
        "device_id": bot["device_id"],
        "workspace_id": owner["workspace_id"],
        "is_bot": True,
        "role": "guest",
    }


async def test_whoami_is_ungated_by_scope(client: AsyncClient) -> None:
    """A bot with NO verb scopes can still read its own identity (like GET /v1/me)."""
    owner = await do_setup(client)
    bot = await _create_bot_with_token(client, owner["token"], scopes=[])
    resp = await client.get("/v1/whoami", headers=auth_header(bot["token"]))
    assert resp.status_code == 200, resp.text
    assert resp.json()["user_id"] == bot["bot_user_id"]
    assert resp.json()["is_bot"] is True


async def test_whoami_rejects_anonymous_and_bad_tokens(client: AsyncClient) -> None:
    await do_setup(client)
    assert (await client.get("/v1/whoami")).status_code == 401
    bad = await client.get("/v1/whoami", headers=auth_header("not-a-real-token"))
    assert bad.status_code == 401
