"""Typed helpers shared by the ENG-66 batch-upload tests.

Builds honest §3.2 wire items (``{body, event_hash}`` with the hash computed by
:func:`hash_event` over the verbatim body dict), posts batches, and bootstraps a
writable channel by uploading a ``channel.created`` genesis event through the
real endpoint.
"""

from __future__ import annotations

from typing import Any

from authutil import auth_header, fetch_meta_stream_id
from httpx import AsyncClient, Response
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from sqlalchemy.ext.asyncio import AsyncSession

BATCH_URL = "/v1/events/batch"

#: The shape returned by ``do_setup`` / login responses that the builders read.
Auth = dict[str, Any]


def wire_item(body: dict[str, Any]) -> dict[str, Any]:
    """A §3.2 upload item with an HONEST hash over the verbatim ``body`` dict."""
    return {"body": body, "event_hash": hash_event(body)}


def message_body(
    *,
    auth: Auth,
    stream_id: str,
    text: str = "hello",
    thread_root_id: str | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    """A valid ``message.created`` v1 body authored by ``auth``'s principal.

    ``thread_root_id`` (ENG-99) makes this message a THREAD REPLY rooting on an
    existing message id (validated m_ format). ``overrides`` are applied AFTER the
    model dump, onto the raw dict — so tests can produce deliberately nonconforming
    bodies (tampered scalars, bad ids) without the builder model rejecting them.
    """
    body = build_message_created_body(
        workspace_id=auth["workspace_id"],
        stream_id=stream_id,
        author_user_id=auth["user_id"],
        author_device_id=auth["device_id"],
        client_created_at=now_rfc3339(),
        text=text,
        thread_root_id=thread_root_id,
    ).model_dump(mode="json")
    body.update(overrides)
    return body


def channel_created_body(
    *,
    auth: Auth,
    home_stream_id: str,
    channel_stream_id: str | None = None,
    name: Any = "general",
    visibility: Any = "public",
    type_version: int = 1,
    include_channel_stream_id: bool = True,
) -> dict[str, Any]:
    """A ``channel.created`` body (§2.2 homing is the CALLER's choice).

    ``type_version`` / ``visibility`` / ``name`` are deliberately typed ``Any`` and
    ``include_channel_stream_id`` toggles the field's presence, so security tests
    can build a v2 genesis whose payload (visibility=null, missing fields) skips the
    step-iv payload model and probes the totality gates.
    """
    payload: dict[str, Any] = {"name": name, "visibility": visibility}
    if include_channel_stream_id:
        payload["channel_stream_id"] = (
            channel_stream_id if channel_stream_id is not None else ids.new_stream_id()
        )
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": home_stream_id,
        "type": "channel.created",
        "type_version": type_version,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload,
    }


def lifecycle_body(
    *,
    auth: Auth,
    home_stream_id: str,
    type: str,
    payload: dict[str, Any],
    type_version: int = 1,
) -> dict[str, Any]:
    """A channel lifecycle (renamed/archived/member_*) body.

    ``type_version`` is a param so security tests can send an unknown version
    (skips the step-iv payload model) with a deliberately incomplete payload.
    """
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": home_stream_id,
        "type": type,
        "type_version": type_version,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload,
    }


def dm_created_body(
    *,
    auth: Auth,
    dm_stream_id: str | None = None,
    member_user_ids: Any = None,
    home_stream_id: str | None = None,
    type_version: int = 1,
    include_dm_stream_id: bool = True,
    **overrides: Any,
) -> dict[str, Any]:
    """A ``dm.created`` body (ENG-104), self-homed in the DM stream by default.

    §2.2: a DM genesis is self-homed in the DM's own stream. ``home_stream_id``
    overrides the home so tests can probe the homing gate; ``member_user_ids`` /
    ``type_version`` / ``include_dm_stream_id`` are deliberately open so security
    tests can build malformed / unknown-version payloads. ``member_user_ids``
    defaults to ``[auth's user]`` (the author is a participant).
    """
    dm_stream_id = dm_stream_id if dm_stream_id is not None else ids.new_stream_id()
    if member_user_ids is None:
        member_user_ids = [auth["user_id"]]
    payload: dict[str, Any] = {"member_user_ids": member_user_ids}
    if include_dm_stream_id:
        payload["dm_stream_id"] = dm_stream_id
    body: dict[str, Any] = {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": home_stream_id if home_stream_id is not None else dm_stream_id,
        "type": "dm.created",
        "type_version": type_version,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload,
    }
    body.update(overrides)
    return body


def reaction_body(
    *,
    auth: Auth,
    stream_id: str,
    message_id: str,
    emoji: str,
    removed: bool = False,
    type_version: int = 1,
    **overrides: Any,
) -> dict[str, Any]:
    """A ``reaction.added`` (or ``reaction.removed``) body authored by ``auth``.

    §2.4 homes a reaction in the stream the target message lives in, so the caller
    passes that stream as ``stream_id``. ``overrides`` are applied onto the raw
    dict (after assembly) so tests can build deliberately nonconforming bodies.
    """
    body: dict[str, Any] = {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": stream_id,
        "type": "reaction.removed" if removed else "reaction.added",
        "type_version": type_version,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": {"message_id": message_id, "emoji": emoji},
    }
    body.update(overrides)
    return body


def message_edited_body(
    *,
    auth: Auth,
    stream_id: str,
    message_id: str,
    text: str = "edited",
    format: str = "markdown",
    type_version: int = 1,
    **overrides: Any,
) -> dict[str, Any]:
    """A ``message.edited`` body authored by ``auth`` (ENG-98).

    §2.4 homes an edit in the target message's stream, so the caller passes that
    stream as ``stream_id``. ``overrides`` are applied onto the raw dict (after
    assembly) so tests can build deliberately nonconforming bodies.
    """
    body: dict[str, Any] = {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": stream_id,
        "type": "message.edited",
        "type_version": type_version,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": {"message_id": message_id, "text": text, "format": format},
    }
    body.update(overrides)
    return body


def message_deleted_body(
    *,
    auth: Auth,
    stream_id: str,
    message_id: str,
    type_version: int = 1,
    **overrides: Any,
) -> dict[str, Any]:
    """A ``message.deleted`` body (tombstone) authored by ``auth`` (ENG-98)."""
    body: dict[str, Any] = {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": stream_id,
        "type": "message.deleted",
        "type_version": type_version,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": {"message_id": message_id},
    }
    body.update(overrides)
    return body


def custom_body(
    *,
    auth: Auth,
    stream_id: str,
    type: str = "custom.thing",
    type_version: int = 1,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """An unknown-type (D9) body with a valid envelope."""
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": stream_id,
        "type": type,
        "type_version": type_version,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload if payload is not None else {"anything": True},
    }


async def post_batch(client: AsyncClient, token: str, items: list[Any]) -> Response:
    """POST the §3.2 batch request; the caller asserts on the response."""
    return await client.post(BATCH_URL, json={"events": items}, headers=auth_header(token))


async def bootstrap_channel(
    client: AsyncClient,
    db: AsyncSession,
    auth: Auth,
    *,
    visibility: str = "public",
    name: str = "general",
) -> str:
    """Create a channel through the real endpoint; return its stream id.

    §2.2 homing: a public genesis is homed in the workspace-meta stream, a
    private genesis is self-homed in the channel's own stream.
    """
    meta = await fetch_meta_stream_id(db, auth["workspace_id"])
    assert meta is not None
    channel_stream_id = ids.new_stream_id()
    home = meta if visibility == "public" else channel_stream_id
    body = channel_created_body(
        auth=auth,
        home_stream_id=home,
        channel_stream_id=channel_stream_id,
        name=name,
        visibility=visibility,
    )
    resp = await post_batch(client, auth["token"], [wire_item(body)])
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert len(payload["accepted"]) == 1, payload
    return channel_stream_id
