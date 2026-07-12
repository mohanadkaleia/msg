"""LIVE end-to-end proof that the SDK's envelope + hash are server-valid.

Boots a REAL msgd (subprocess uvicorn + Postgres testcontainer, the shared
``cli/tests/_e2e_server`` harness), provisions an owner + a channel + a bot with
a minted token via the real ``/v1/setup`` and ``/v1/plugins/*`` endpoints, then
drives :class:`msg_sdk.MsgClient` against it over real HTTP/WebSocket:

* ``whoami`` discovers the bot's own ``user_id`` / ``device_id`` / ``workspace_id``;
* ``post_message`` builds the envelope, computes the frozen ``event_hash``, and
  the server ACCEPTS it (no ``hash_mismatch`` / author-binding rejection) — the
  proof the SDK's hash equals the server's on the wire;
* the message is READABLE via ``list_messages`` with the bot as author;
* the live ``events()`` WebSocket stream receives a message posted by another
  client (the owner).

Needs Docker (``postgres:17``) and the ``websockets`` package — both present in
CI's Python job. Skipped only if Docker is unreachable.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from msg_sdk import MsgClient, hash_event, ids

try:
    from _e2e_server import start_live_server
except ImportError:  # pragma: no cover - harness always importable in-repo
    start_live_server = None  # type: ignore[assignment]

_OWNER = {
    "workspace_name": "SDK E2E",
    "email": "owner@example.com",
    "password": "correct-horse-battery-staple",
    "display_name": "The Owner",
}


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def provisioned(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Boot a real server and provision owner + channel + bot + token."""
    if start_live_server is None:  # pragma: no cover
        pytest.skip("live-server harness not importable")
    try:
        cm = start_live_server(tmp_path_factory)
        handle = cm.__enter__()
    except Exception as exc:  # pragma: no cover - environment without Docker
        pytest.skip(f"live server unavailable (Docker required): {exc}")

    base_url = handle.base_url
    try:
        with httpx.Client(base_url=base_url, timeout=30.0) as http:
            owner = http.post("/v1/setup", json=_OWNER)
            assert owner.status_code == 200, owner.text
            owner = owner.json()

            # Discover the workspace-meta stream (a public channel genesis homes there).
            sync = http.get("/v1/sync", headers=_auth(owner["token"]))
            assert sync.status_code == 200, sync.text
            meta = next(s for s in sync.json()["streams"] if s["kind"] == "workspace-meta")

            # Create a public channel by uploading a channel.created event as owner —
            # dogfooding the SDK hasher on a non-message body.
            channel_id = ids.new_stream_id()
            channel_body = {
                "event_id": ids.new_event_id(),
                "workspace_id": owner["workspace_id"],
                "stream_id": meta["stream_id"],
                "type": "channel.created",
                "type_version": 1,
                "author_user_id": owner["user_id"],
                "author_device_id": owner["device_id"],
                "client_created_at": "2026-07-04T12:00:00.000Z",
                "payload": {
                    "name": "sdk-e2e",
                    "visibility": "public",
                    "channel_stream_id": channel_id,
                },
            }
            resp = http.post(
                "/v1/events/batch",
                headers=_auth(owner["token"]),
                json={"events": [{"body": channel_body, "event_hash": hash_event(channel_body)}]},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["accepted"], resp.json()

            # Create a bot granted the channel, then mint its token.
            bot = http.post(
                "/v1/plugins/bots",
                headers=_auth(owner["token"]),
                json={
                    "name": "SDK Bot",
                    "scopes": ["events:read", "events:write"],
                    "stream_ids": [channel_id],
                },
            )
            assert bot.status_code in (200, 201), bot.text
            bot = bot.json()

            minted = http.post(
                f"/v1/plugins/bots/{bot['bot_user_id']}/tokens",
                headers=_auth(owner["token"]),
                json={},
            )
            assert minted.status_code in (200, 201), minted.text
            bot_token = minted.json()["token"]

        yield {
            "base_url": base_url,
            "owner_token": owner["token"],
            "channel_id": channel_id,
            "bot_user_id": bot["bot_user_id"],
            "bot_device_id": bot["device_id"],
            "workspace_id": owner["workspace_id"],
            "bot_token": bot_token,
        }
    finally:
        cm.__exit__(None, None, None)


def test_whoami_identity(provisioned: dict[str, Any]) -> None:
    bot = MsgClient(provisioned["base_url"], provisioned["bot_token"])
    ident = bot.identity
    assert ident.user_id == provisioned["bot_user_id"]
    assert ident.device_id == provisioned["bot_device_id"]
    assert ident.workspace_id == provisioned["workspace_id"]
    assert ident.is_bot is True


def test_post_message_accepted_and_readable(provisioned: dict[str, Any]) -> None:
    bot = MsgClient(provisioned["base_url"], provisioned["bot_token"])
    channel = provisioned["channel_id"]

    posted = bot.post_message(channel, "hello from the SDK bot")
    # Server ACCEPTED the SDK-built envelope: proves the hash matched (no
    # hash_mismatch) and author binding held.
    assert posted.server_sequence is not None
    assert posted.message_id.startswith("m_")

    messages = bot.list_messages(channel, limit=100)
    match = next(m for m in messages if m.message_id == posted.message_id)
    assert match.text == "hello from the SDK bot"
    assert match.author_user_id == provisioned["bot_user_id"]
    assert match.author_device_id == provisioned["bot_device_id"]
    # The read-back event is byte-faithful: its stored hash re-derives from body.
    assert hash_event(match.raw["body"]) == match.raw["event_hash"]


def test_live_events_receives_other_clients_message(provisioned: dict[str, Any]) -> None:
    bot = MsgClient(provisioned["base_url"], provisioned["bot_token"])
    owner = MsgClient(provisioned["base_url"], provisioned["owner_token"])
    channel = provisioned["channel_id"]

    received: list[Any] = []
    errors: list[BaseException] = []

    def listen() -> None:
        try:
            for event in bot.events(channels=[channel]):
                if event.type == "message.created":
                    received.append(event)
                    break
        except BaseException as exc:  # pragma: no cover - surfaced via `errors`
            errors.append(exc)

    thread = threading.Thread(target=listen, daemon=True)
    thread.start()
    time.sleep(2.0)  # let the WebSocket handshake complete before posting

    # Post from ANOTHER client (the owner). Retry so a connect race can't lose the
    # only live frame (fanout is live-only, never backfilled).
    deadline = time.time() + 20.0
    while time.time() < deadline and not received and not errors:
        owner.post_message(channel, "live hello from the owner")
        time.sleep(1.0)

    thread.join(timeout=3.0)
    assert not errors, f"listener errored: {errors[0]!r}"
    assert received, "bot did not receive the live event over the WebSocket"
    assert received[0].payload["text"] == "live hello from the owner"
    assert received[0].body["author_user_id"] != provisioned["bot_user_id"]
