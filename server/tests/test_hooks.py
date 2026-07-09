"""Incoming webhooks (ENG-161, M5-2) — adversarial acceptance tests.

Every test is a tooth: it fails if the guard it exercises is removed —

* the HARD-CODED injection guards (a hostile payload naming mentions /
  file_ids / thread_root_id / another stream / markdown / a spoofed author is
  IGNORED — the stored message carries the bot author, the bound channel,
  plain format, and empty mentions/files);
* the uniform-404 matrix (unknown, revoked, disabled, deactivated-bot, and
  archived-stream tokens all collapse to the identical body; none stores an
  event);
* the per-hook AND per-IP rate limits, checked BEFORE any DB lookup (an
  unknown-token flood 429s instead of 404ing);
* the live-revocation gates (a ``stream_members`` revoke or an archival cuts
  a hook mid-flight via the SAME ``validate_event`` pipeline — no 500);
* the body cap before parsing + the 64 KB event-cap pipeline backstop;
* the owner/admin management gating, the raw-capability-URL-once discipline,
  and the ``/v1/hooks/<token>`` log redaction.
"""

from __future__ import annotations

import hashlib
import io
import logging
from typing import Any

from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_setup,
    fetch_meta_stream_id,
    fetch_stream_events,
    join_token,
    make_app,
    make_client,
)
from eventsutil import bootstrap_channel, lifecycle_body, message_body, post_batch, wire_item
from httpx import AsyncClient, Response
from msgd.core import ids
from msgd.db.models import Event, IncomingWebhook, StreamMember
from msgd.logging import RedactSecretsFilter
from msgd.settings import Settings
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

HOOKS_URL = "/v1/plugins/hooks"
BOTS_URL = "/v1/plugins/bots"

# --- helpers -------------------------------------------------------------------


async def _create_hook(
    client: AsyncClient,
    token: str,
    *,
    stream_id: str,
    name: str = "CI Notifier",
    bot_user_id: str | None = None,
) -> Response:
    """POST /v1/plugins/hooks; the caller asserts on the response."""
    payload: dict[str, Any] = {"stream_id": stream_id, "name": name}
    if bot_user_id is not None:
        payload["bot_user_id"] = bot_user_id
    return await client.post(HOOKS_URL, json=payload, headers=auth_header(token))


def _raw_token(url: str) -> str:
    """Extract the raw capability token from a ``.../v1/hooks/<token>`` URL."""
    return url.rsplit("/v1/hooks/", 1)[1]


async def _deliver(client: AsyncClient, raw: str, payload: Any) -> Response:
    """POST a delivery to the PUBLIC receiver — deliberately NO auth header."""
    return await client.post(f"/v1/hooks/{raw}", json=payload)


async def _hook(
    client: AsyncClient, token: str, *, stream_id: str, name: str = "CI Notifier"
) -> dict[str, Any]:
    """Create a hook (auto-provisioned bot) and return its create-response JSON."""
    resp = await _create_hook(client, token, stream_id=stream_id, name=name)
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _messages(events: list[Any]) -> list[Any]:
    return [e for e in events if e.type == "message.created"]


async def _message_count(db: AsyncSession, workspace_id: str) -> int:
    """ALL stored message.created events in the workspace (leak-proof count)."""
    count = await db.scalar(
        select(func.count())
        .select_from(Event)
        .where(Event.workspace_id == workspace_id, Event.type == "message.created")
    )
    assert count is not None
    return int(count)


async def _create_bot(
    client: AsyncClient, token: str, *, stream_ids: list[str], name: str = "Helper Bee"
) -> dict[str, Any]:
    resp = await client.post(
        BOTS_URL,
        json={"name": name, "scopes": ["events:write"], "stream_ids": stream_ids},
        headers=auth_header(token),
    )
    assert resp.status_code == 201, resp.text
    body: dict[str, Any] = resp.json()
    return body


async def _invite(client: AsyncClient, owner: dict[str, Any], *, role: str) -> dict[str, Any]:
    invite = await create_invite(client, owner["token"], role=role)
    raw = join_token(invite.json()["url"])
    accepted = await accept_invite(client, raw, email=f"{ids.new_ulid().lower()}@example.com")
    assert accepted.status_code == 200, accepted.text
    body: dict[str, Any] = accepted.json()
    return body


async def _archive_channel(
    client: AsyncClient, db: AsyncSession, owner: dict[str, Any], channel: str
) -> None:
    """Archive a PUBLIC channel through the real lifecycle upload path."""
    meta = await fetch_meta_stream_id(db, owner["workspace_id"])
    assert meta is not None
    body = lifecycle_body(
        auth=owner,
        home_stream_id=meta,
        type="channel.archived",
        payload={"channel_stream_id": channel},
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert len(resp.json()["accepted"]) == 1, resp.text


# --- happy path -------------------------------------------------------------------


async def test_text_delivery_stores_bot_authored_plain_message(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A Slack-shaped ``{"text": ...}`` → 200 {"ok": true} and ONE message.created
    in the bound channel: bot author, plain format, empty mentions/files — and the
    auto-provisioned bot went through the full M5-1 path (roster is_bot, meta events).
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    hook = await _hook(client, owner["token"], stream_id=channel, name="Deploy Bot")
    raw = _raw_token(hook["url"])
    bot_id = hook["bot_user_id"]

    resp = await _deliver(client, raw, {"text": "build #42 passed"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}

    (message,) = _messages(await fetch_stream_events(db_session, channel))
    assert message.body["author_user_id"] == bot_id
    assert message.body["workspace_id"] == owner["workspace_id"]
    payload = message.body["payload"]
    assert payload["text"] == "build #42 passed"
    assert payload["format"] == "plain"
    assert payload["mentions"] == []
    assert payload["file_ids"] == []
    assert payload["thread_root_id"] is None

    # The auto-provisioned bot is a REAL M5-1 bot: roster is_bot=true, and the
    # meta log carries its user.joined + bot.installed + the channel grant.
    roster = await client.get("/v1/admin/members", headers=auth_header(owner["token"]))
    entry = next(m for m in roster.json()["members"] if m["user_id"] == bot_id)
    assert entry["is_bot"] is True
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None
    meta_events = await fetch_stream_events(db_session, meta)
    joined = [
        e for e in meta_events if e.type == "user.joined" and e.body["payload"]["user_id"] == bot_id
    ]
    assert len(joined) == 1
    installed = [
        e
        for e in meta_events
        if e.type == "bot.installed" and e.body["payload"]["bot_user_id"] == bot_id
    ]
    assert len(installed) == 1
    assert installed[0].body["payload"]["scopes"] == ["events:write"]
    granted = [
        e
        for e in meta_events
        if e.type == "channel.member_added" and e.body["payload"]["user_id"] == bot_id
    ]
    assert [e.body["payload"]["channel_stream_id"] for e in granted] == [channel]
    assert await db_session.get(StreamMember, (channel, bot_id)) is not None


async def test_blocks_only_delivery_flattens_sections(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A blocks-only payload flattens section.text.text (unknown blocks ignored);
    mrkdwn syntax arrives as INERT plain text."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    hook = await _hook(client, owner["token"], stream_id=channel)

    resp = await _deliver(
        client,
        _raw_token(hook["url"]),
        {
            "blocks": [
                {"type": "section", "text": {"type": "mrkdwn", "text": "*alert* line one"}},
                {"type": "divider"},
                {"type": "context", "elements": [{"type": "plain_text", "text": "ignored"}]},
                {"type": "section", "text": {"type": "plain_text", "text": "line two"}},
                "not-even-a-dict",
            ]
        },
    )
    assert resp.status_code == 200, resp.text

    (message,) = _messages(await fetch_stream_events(db_session, channel))
    assert message.body["payload"]["text"] == "*alert* line one\nline two"
    assert message.body["payload"]["format"] == "plain"  # the * stays inert


# --- injection guard ----------------------------------------------------------------


async def test_payload_cannot_inject_mentions_files_thread_stream_format_or_author(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A hostile payload naming every author-controlled field is IGNORED: the
    stored message has the bot author, the bound stream, plain format, and empty
    mentions/files — so a delivery can never mint a mention notification, attach
    a file, thread, re-target a stream, or spoof authorship."""
    owner = await do_setup(client)
    bound = await bootstrap_channel(client, db_session, owner, name="bound")
    other = await bootstrap_channel(client, db_session, owner, name="other", visibility="private")
    hook = await _hook(client, owner["token"], stream_id=bound)

    # Seed a real message in the bound channel so a thread injection WOULD have
    # a valid root to latch onto if the guard were missing.
    seeded = await post_batch(
        client,
        owner["token"],
        [wire_item(message_body(auth=owner, stream_id=bound, text="root"))],
    )
    root_id = None
    for event in await fetch_stream_events(db_session, bound):
        if event.type == "message.created":
            root_id = event.body["payload"]["message_id"]
    assert seeded.status_code == 200 and root_id is not None

    hostile = {
        "text": "pwned <!channel>",
        "mentions": [owner["user_id"]],
        "file_ids": ["f_01HZZZZZZZZZZZZZZZZZZZZZZZ"],
        "thread_root_id": root_id,
        "stream_id": other,
        "channel": other,
        "format": "markdown",
        "author_user_id": owner["user_id"],
        "author_device_id": owner["device_id"],
        "workspace_id": "w_01HZZZZZZZZZZZZZZZZZZZZZZZ",
        "event_id": "e_01HZZZZZZZZZZZZZZZZZZZZZZZ",
    }
    resp = await _deliver(client, _raw_token(hook["url"]), hostile)
    assert resp.status_code == 200, resp.text

    messages = _messages(await fetch_stream_events(db_session, bound))
    delivered = [m for m in messages if m.body["payload"]["text"] == "pwned <!channel>"]
    assert len(delivered) == 1
    body = delivered[0].body
    payload = body["payload"]
    # Every injected field was discarded — the server built the body itself.
    assert body["author_user_id"] == hook["bot_user_id"]  # not the spoofed owner
    assert body["stream_id"] == bound  # not the redirected stream
    assert body["workspace_id"] == owner["workspace_id"]
    assert body["event_id"] != hostile["event_id"]
    assert payload["mentions"] == []  # no mention notification can be minted
    assert payload["file_ids"] == []
    assert payload["thread_root_id"] is None  # not threaded onto the seeded root
    assert payload["format"] == "plain"  # not markdown

    # And the OTHER (private) stream received nothing.
    assert _messages(await fetch_stream_events(db_session, other)) == []


# --- uniform 404 matrix ----------------------------------------------------------------


async def test_uniform_404_matrix_and_no_events(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Unknown token, hard-revoked hook, disabled_at hook, deactivated bot, and
    archived bound stream ALL return the byte-identical 404 — and none stores an
    event. No 401/403 ever escapes the receiver."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    doomed = await bootstrap_channel(client, db_session, owner, name="doomed")
    headers = auth_header(owner["token"])

    revoked = await _hook(client, owner["token"], stream_id=channel, name="revoked")
    disabled = await _hook(client, owner["token"], stream_id=channel, name="disabled")
    dead_bot = await _hook(client, owner["token"], stream_id=channel, name="dead-bot")
    archived = await _hook(client, owner["token"], stream_id=doomed, name="archived")

    # Arm the matrix.
    assert (await client.delete(f"{HOOKS_URL}/{revoked['id']}", headers=headers)).status_code == 204
    await db_session.execute(
        update(IncomingWebhook)
        .where(IncomingWebhook.token_hash == disabled["id"])
        .values(disabled_at=func.now())
    )
    deactivate = await client.patch(
        f"/v1/admin/members/{dead_bot['bot_user_id']}", json={"active": False}, headers=headers
    )
    assert deactivate.status_code == 200, deactivate.text
    await _archive_channel(client, db_session, owner, doomed)

    before = await _message_count(db_session, owner["workspace_id"])
    cases = {
        "unknown": "A" * 43,
        "revoked": _raw_token(revoked["url"]),
        "disabled": _raw_token(disabled["url"]),
        "deactivated-bot": _raw_token(dead_bot["url"]),
        "archived-stream": _raw_token(archived["url"]),
    }
    bodies: list[tuple[Any, ...]] = []
    for label, raw in cases.items():
        resp = await _deliver(client, raw, {"text": "should never land"})
        assert resp.status_code == 404, f"{label}: {resp.status_code} {resp.text}"
        problem = resp.json()
        # Compare everything except ``instance`` (the RFC 9457 path echo, which
        # necessarily differs per token and discloses nothing new to the caller).
        bodies.append((problem["type"], problem["status"], problem["title"], problem["detail"]))

    assert len(set(bodies)) == 1, f"404 bodies diverge (oracle!): {bodies}"
    assert await _message_count(db_session, owner["workspace_id"]) == before


# --- rate limits ----------------------------------------------------------------------


async def test_per_hook_rate_limit(settings: Settings, db_session: AsyncSession) -> None:
    """Exceeding the per-hook budget → 429 with Retry-After; a sibling hook's
    bucket is untouched."""
    tight = settings.model_copy(update={"hook_rate_limit_per_minute": 2})
    app = make_app(tight, db_session)
    async with make_client(app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)
        hook = await _hook(client, owner["token"], stream_id=channel, name="hot")
        sibling = await _hook(client, owner["token"], stream_id=channel, name="cold")

        for _ in range(2):
            ok = await _deliver(client, _raw_token(hook["url"]), {"text": "x"})
            assert ok.status_code == 200
        limited = await _deliver(client, _raw_token(hook["url"]), {"text": "x"})
        assert limited.status_code == 429
        assert limited.json()["type"] == "/problems/rate-limited"
        assert int(limited.headers["retry-after"]) > 0
        # Per-HOOK isolation: the sibling still delivers.
        cold = await _deliver(client, _raw_token(sibling["url"]), {"text": "y"})
        assert cold.status_code == 200


async def test_per_ip_rate_limit_fires_before_db_lookup(
    settings: Settings, db_session: AsyncSession
) -> None:
    """Many UNKNOWN tokens from one IP trip the per-IP bucket: the over-budget
    request 429s instead of 404ing — proving the limiter runs BEFORE the token
    lookup, so an unknown-token flood cannot hammer the DB."""
    tight = settings.model_copy(update={"hook_rate_limit_per_ip_per_minute": 2})
    app = make_app(tight, db_session)
    async with make_client(app) as client:
        for i in range(2):
            resp = await _deliver(client, f"unknownunknownunknown{i:022d}", {"text": "x"})
            assert resp.status_code == 404  # within budget → the lookup miss shows
        over_budget = "unknownunknownunknown9999999999999999999999"
        flooded = await _deliver(client, over_budget, {"text": "x"})
        assert flooded.status_code == 429  # over budget → rejected BEFORE the lookup
        assert flooded.json()["type"] == "/problems/rate-limited"


# --- live-revocation gates ---------------------------------------------------------------


async def test_membership_revoke_cuts_live_hook(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Revoking the bot's stream_members grant makes the NEXT delivery fail via
    the pipeline's can_write gate (uniform 404, no message, no 500)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    bot = await _create_bot(client, owner["token"], stream_ids=[channel])
    created = await _create_hook(
        client, owner["token"], stream_id=channel, bot_user_id=bot["bot_user_id"]
    )
    assert created.status_code == 201, created.text
    raw = _raw_token(created.json()["url"])

    assert (await _deliver(client, raw, {"text": "before revoke"})).status_code == 200

    revoke = await client.delete(
        f"{BOTS_URL}/{bot['bot_user_id']}/streams/{channel}", headers=auth_header(owner["token"])
    )
    assert revoke.status_code == 204
    assert await db_session.get(StreamMember, (channel, bot["bot_user_id"])) is None

    after = await _deliver(client, raw, {"text": "after revoke"})
    assert after.status_code == 404  # the uniform miss — not a 500, not a 403
    assert after.json()["type"] == "/problems/not-found"
    stored = _messages(await fetch_stream_events(db_session, channel))
    assert "after revoke" not in [m.body["payload"]["text"] for m in stored]


async def test_archival_cuts_live_hook(client: AsyncClient, db_session: AsyncSession) -> None:
    """Archiving the bound channel makes the NEXT delivery fail (uniform 404,
    no message, no 500)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    hook = await _hook(client, owner["token"], stream_id=channel)
    raw = _raw_token(hook["url"])
    assert (await _deliver(client, raw, {"text": "before archive"})).status_code == 200

    await _archive_channel(client, db_session, owner, channel)

    after = await _deliver(client, raw, {"text": "after archive"})
    assert after.status_code == 404
    stored = _messages(await fetch_stream_events(db_session, channel))
    assert "after archive" not in [m.body["payload"]["text"] for m in stored]


# --- size + parse faults ---------------------------------------------------------------


async def test_body_cap_413_before_parsing(client: AsyncClient, db_session: AsyncSession) -> None:
    """An oversize body 413s BEFORE parsing (garbage bytes over the cap are 413,
    not a JSON 400); malformed small JSON is 400; missing/empty text is 400.
    None of these stores an event."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    hook = await _hook(client, owner["token"], stream_id=channel)
    raw = _raw_token(hook["url"])
    url = f"/v1/hooks/{raw}"

    # 17 KB of NON-JSON garbage: the cap must fire before the parser ever sees it.
    oversize = await client.post(
        url, content=b"x" * (17 * 1024), headers={"content-type": "application/json"}
    )
    assert oversize.status_code == 413
    assert oversize.json()["type"] == "/problems/payload-too-large"

    # Small malformed JSON → 400 (the parse fault, distinct from the cap).
    garbled = await client.post(
        url, content=b"not-json", headers={"content-type": "application/json"}
    )
    assert garbled.status_code == 400
    assert garbled.json()["type"] == "/problems/invalid-hook-payload"

    # Parseable but text-less / empty / wrong-typed → 400.
    text_less: list[Any] = [{}, {"text": ""}, {"text": "   "}, {"text": 42}, []]
    text_less.append({"blocks": [{"type": "divider"}]})
    for bad in text_less:
        resp = await _deliver(client, raw, bad)
        assert resp.status_code == 400, f"{bad!r}: {resp.status_code}"

    assert _messages(await fetch_stream_events(db_session, channel)) == []


async def test_event_cap_pipeline_backstop(settings: Settings, db_session: AsyncSession) -> None:
    """With the BODY cap raised past 64 KB, a payload that parses fine but blows
    the single-event wire cap is rejected by the SAME pipeline every upload runs
    (payload_too_large → 400) — proving the receiver has no private bypass."""
    roomy = settings.model_copy(update={"hook_max_body_bytes": 128 * 1024})
    app = make_app(roomy, db_session)
    async with make_client(app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)
        hook = await _hook(client, owner["token"], stream_id=channel)

        resp = await _deliver(client, _raw_token(hook["url"]), {"text": "y" * (70 * 1024)})
        assert resp.status_code == 400
        assert resp.json()["type"] == "/problems/invalid-hook-payload"
        assert _messages(await fetch_stream_events(db_session, channel)) == []


# --- management surface ---------------------------------------------------------------


async def test_management_is_owner_admin_only(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """member/guest — and a bot bearer — are 403d on every /v1/plugins/hooks verb."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    member = await _invite(client, owner, role="member")
    guest = await _invite(client, owner, role="guest")
    bot = await _create_bot(client, owner["token"], stream_ids=[channel])
    minted = await client.post(
        f"{BOTS_URL}/{bot['bot_user_id']}/tokens", json={}, headers=auth_header(owner["token"])
    )
    assert minted.status_code == 201
    hook = await _hook(client, owner["token"], stream_id=channel)

    for caller in (member["token"], guest["token"], minted.json()["token"]):
        assert (await _create_hook(client, caller, stream_id=channel)).status_code == 403
        assert (await client.get(HOOKS_URL, headers=auth_header(caller))).status_code == 403
        assert (
            await client.delete(f"{HOOKS_URL}/{hook['id']}", headers=auth_header(caller))
        ).status_code == 403
    # ...and none of those 403s revoked the hook.
    alive = await _deliver(client, _raw_token(hook["url"]), {"text": "still alive"})
    assert alive.status_code == 200

    # An admin (not just the owner) may drive the surface.
    admin = await _invite(client, owner, role="admin")
    assert (await client.get(HOOKS_URL, headers=auth_header(admin["token"]))).status_code == 200


async def test_management_uniform_404s(client: AsyncClient, db_session: AsyncSession) -> None:
    """Unknown handles, cross-workspace handles, non-channel and unknown streams,
    and human/unknown bot ids all collapse to the identical not_found."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None
    headers = auth_header(owner["token"])
    hook = await _hook(client, owner["token"], stream_id=channel)

    # A hook row in ANOTHER workspace: the owner's revoke must miss it (and
    # leave it untouched) exactly like an unknown handle.
    foreign = IncomingWebhook(
        token_hash="f" * 64,
        workspace_id="w_01HZZZZZZZZZZZZZZZZZZZZZZZ",
        stream_id=channel,
        bot_user_id=hook["bot_user_id"],
        name="foreign",
        created_by=owner["user_id"],
    )
    db_session.add(foreign)
    await db_session.flush()

    bodies: list[tuple[Any, ...]] = []
    # DELETE: unknown handle + the cross-workspace handle.
    for handle in ("0" * 64, "f" * 64):
        resp = await client.delete(f"{HOOKS_URL}/{handle}", headers=headers)
        assert resp.status_code == 404
        problem = resp.json()
        bodies.append((problem["type"], problem["status"], problem["title"], problem["detail"]))
    # POST: unknown stream, a NON-channel stream (workspace-meta), an unknown
    # bot id, and a HUMAN user id as the bot.
    for payload in (
        {"stream_id": ids.new_stream_id(), "name": "x"},
        {"stream_id": meta, "name": "x"},
        {"stream_id": channel, "name": "x", "bot_user_id": ids.new_user_id()},
        {"stream_id": channel, "name": "x", "bot_user_id": owner["user_id"]},
    ):
        resp = await client.post(HOOKS_URL, json=payload, headers=headers)
        assert resp.status_code == 404, resp.text
        problem = resp.json()
        bodies.append((problem["type"], problem["status"]))

    assert {b[0] for b in bodies} == {"/problems/not-found"}
    assert {b[1] for b in bodies} == {404}
    # The cross-workspace row survived the miss.
    assert await db_session.get(IncomingWebhook, "f" * 64) is not None
    # The owner's own hook is untouched.
    assert (await _deliver(client, _raw_token(hook["url"]), {"text": "ok"})).status_code == 200


async def test_capability_url_returned_exactly_once(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """The raw token appears ONLY in the create response URL; storage and the
    listing carry its sha256 handle; a listing can never leak the capability."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    hook = await _hook(client, owner["token"], stream_id=channel, name="Once Only")
    raw = _raw_token(hook["url"])

    # Hash discipline: the returned id == sha256(raw); only the hash is stored.
    assert hook["id"] == hashlib.sha256(raw.encode()).hexdigest()
    row = await db_session.get(IncomingWebhook, hook["id"])
    assert row is not None
    assert raw not in (row.token_hash, row.name, row.stream_id, row.bot_user_id)
    # ENG-148 discipline: never a leading '-'/'_' (argv-safe capability URLs).
    assert raw[0] not in "-_"

    listing = await client.get(HOOKS_URL, headers=auth_header(owner["token"]))
    assert listing.status_code == 200
    assert raw not in listing.text  # the capability appears NOWHERE after create
    entry = next(h for h in listing.json()["hooks"] if h["id"] == hook["id"])
    assert entry["stream_id"] == channel
    assert entry["bot_user_id"] == hook["bot_user_id"]
    assert entry["disabled"] is False


async def test_existing_bot_binding_and_grant_idempotence(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Binding an EXISTING bot reuses it (no second grant when already a member;
    an event-sourced grant when not); a deactivated bot is refused 403."""
    owner = await do_setup(client)
    granted_ch = await bootstrap_channel(client, db_session, owner, name="granted")
    ungranted_ch = await bootstrap_channel(client, db_session, owner, name="ungranted")
    bot = await _create_bot(client, owner["token"], stream_ids=[granted_ch])
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None

    def _grants(events: list[Any]) -> list[str]:
        return [
            e.body["payload"]["channel_stream_id"]
            for e in events
            if e.type == "channel.member_added"
            and e.body["payload"]["user_id"] == bot["bot_user_id"]
        ]

    # Already a member → NO duplicate channel.member_added is emitted.
    created = await _create_hook(
        client, owner["token"], stream_id=granted_ch, bot_user_id=bot["bot_user_id"]
    )
    assert created.status_code == 201, created.text
    assert created.json()["bot_user_id"] == bot["bot_user_id"]
    assert _grants(await fetch_stream_events(db_session, meta)) == [granted_ch]

    # Not yet a member → the grant is event-sourced and materialized.
    created = await _create_hook(
        client, owner["token"], stream_id=ungranted_ch, bot_user_id=bot["bot_user_id"]
    )
    assert created.status_code == 201, created.text
    assert sorted(_grants(await fetch_stream_events(db_session, meta))) == sorted(
        [granted_ch, ungranted_ch]
    )
    assert await db_session.get(StreamMember, (ungranted_ch, bot["bot_user_id"])) is not None
    # ...and the hook delivers into the newly granted channel.
    resp = await _deliver(client, _raw_token(created.json()["url"]), {"text": "hi"})
    assert resp.status_code == 200

    # A deactivated bot gets NO new capability (the mint-token rule).
    patched = await client.patch(
        f"/v1/admin/members/{bot['bot_user_id']}",
        json={"active": False},
        headers=auth_header(owner["token"]),
    )
    assert patched.status_code == 200
    refused = await _create_hook(
        client, owner["token"], stream_id=granted_ch, bot_user_id=bot["bot_user_id"]
    )
    assert refused.status_code == 403


# --- log redaction ---------------------------------------------------------------------


def test_redact_filter_scrubs_hook_path() -> None:
    """The ``/v1/hooks/<token>`` request-path shape — the ONE place the raw
    capability necessarily appears (uvicorn's access request line) — is scrubbed;
    prose naming the route template survives."""
    raw = "kJ8mQx2Lm9Pv4Rt7Nc1Yb3Fj6Hs0Ad5Ge8Ku2Iw4Qo"  # url-safe, 43 chars

    access_line = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=f'203.0.113.9:0 - "POST /v1/hooks/{raw} HTTP/1.1" 200',
        args=None,
        exc_info=None,
    )
    assert RedactSecretsFilter().filter(access_line) is True
    assert raw not in access_line.getMessage()
    assert "/v1/hooks/[REDACTED]" in access_line.getMessage()

    # The %-args form (uvicorn builds access lines from args) is scrubbed too.
    formatted = logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/1.1" %d',
        args=("203.0.113.9:0", "POST", f"/v1/hooks/{raw}", 200),
        exc_info=None,
    )
    assert RedactSecretsFilter().filter(formatted) is True
    assert raw not in formatted.getMessage()
    assert "/v1/hooks/[REDACTED]" in formatted.getMessage()

    # Prose with the literal route template (or the management path) is untouched.
    benign = logging.LogRecord(
        name="app",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="mounted /v1/hooks/{hook_token}; manage at /v1/plugins/hooks",
        args=None,
        exc_info=None,
    )
    assert RedactSecretsFilter().filter(benign) is True
    assert "[REDACTED]" not in benign.getMessage()


async def test_hook_token_never_logged_end_to_end(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Drive create + deliveries (success, 404 after revoke) while capturing every
    log line through the production filter: the raw capability token appears in
    no record."""
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setLevel(logging.DEBUG)
    handler.addFilter(RedactSecretsFilter())  # the same filter the app installs
    root = logging.getLogger()
    previous_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)
        hook = await _hook(client, owner["token"], stream_id=channel)
        raw = _raw_token(hook["url"])
        assert (await _deliver(client, raw, {"text": "logged?"})).status_code == 200
        assert (
            await client.delete(f"{HOOKS_URL}/{hook['id']}", headers=auth_header(owner["token"]))
        ).status_code == 204
        assert (await _deliver(client, raw, {"text": "after revoke"})).status_code == 404
        # Simulate the uvicorn access line the harness transport never emits, so
        # the assertion below is non-vacuous even without a real server process.
        logging.getLogger("uvicorn.access").info(
            '203.0.113.9:0 - "POST /v1/hooks/%s HTTP/1.1" 200', raw
        )
    finally:
        root.removeHandler(handler)
        root.setLevel(previous_level)

    output = buffer.getvalue()
    assert "/v1/hooks/[REDACTED]" in output  # the simulated access line was scrubbed
    assert raw not in output, "the raw hook capability token leaked into the logs"
