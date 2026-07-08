"""Files API — initiate + blob upload + download authz spine (ENG-116, TDD §6).

This is the deterministic acceptance suite for the M3.5 security-critical Files
surface. Every exit-criterion is an explicit assertion, one security invariant per
test (or per clearly-labelled block):

* upload → download round-trips byte-identical, with the hardened attachment headers;
* non-member download → the uniform ``404`` (same body as an unknown id — no oracle);
* oversized initiate (declared over the cap) → 413; oversized PUT (streams past the
  cap despite a small declared size) → rejected, nothing stored;
* per-workspace quota → 413, AND a true-concurrency test proving two racing
  initiates cannot both exceed the quota (committing app, mirrors
  ``test_events_batch_concurrency``);
* server-recomputed-hash mismatch → rejected, blob not stored;
* declared-size lie → rejected, not marked present;
* stored HTML/SVG blobs are served ``application/octet-stream`` +
  ``attachment`` + ``nosniff`` (never inline), and a ``name`` with a quote/newline
  is safely encoded into ``Content-Disposition`` (no header injection);
* no cross-workspace existence oracle: workspace B initiating a sha workspace A
  uploaded gets ``upload_needed: true`` and cannot download A's file by id;
* an adversary cannot download a private-stream file by an id they are not a member of;
* download is by id only — there is deliberately no route that takes a sha256.

Isolation note (invariant-4 / §12.4): the permission-isolation *simulation*
(``server/tests/simulation``) was NOT extended — wiring the two-phase file
initiate+upload into the hypothesis World/runner/client would be invasive and risk
destabilizing that gate. Instead the download-isolation invariant is proven
deterministically here (``test_non_member_download_uniform_404``,
``test_adversary_cannot_download_private_file_by_id``,
``test_cross_workspace_no_existence_oracle``), which the ticket allows.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import struct
import zlib
from datetime import timedelta
from typing import Any

import pytest
from authutil import (
    accept_invite,
    auth_header,
    committing_app,
    create_invite,
    do_setup,
    join_token,
    make_app,
    make_client,
    truncate_auth_tables,
)
from eventsutil import bootstrap_channel, lifecycle_body, post_batch, wire_item
from httpx import AsyncClient, Response
from msgd.auth.sessions import utcnow
from msgd.auth.tokens import hash_token
from msgd.blobs.store import LocalDiskBlobStore
from msgd.core import ids
from msgd.db.models import Device, File, Session, Stream, User, Workspace
from msgd.settings import Settings
from PIL import Image
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

INITIATE_URL = "/v1/files/initiate"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _blob_store(settings: Settings) -> LocalDiskBlobStore:
    """A store rooted where the app writes its blobs (same as ``create_app``)."""
    return LocalDiskBlobStore(settings.data_dir / "blobs")


async def _initiate(
    client: AsyncClient,
    token: str,
    *,
    sha256: str,
    stream_id: str,
    name: str = "photo.png",
    mime_type: str = "image/png",
    size_bytes: int | None = None,
    data: bytes | None = None,
) -> Response:
    """POST /v1/files/initiate. ``size_bytes`` defaults to ``len(data)`` when honest."""
    if size_bytes is None:
        size_bytes = len(data) if data is not None else 0
    body = {
        "sha256": sha256,
        "name": name,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "stream_id": stream_id,
    }
    return await client.post(INITIATE_URL, json=body, headers=auth_header(token))


async def _put_blob(client: AsyncClient, token: str, file_id: str, data: bytes) -> Response:
    return await client.put(f"/v1/files/{file_id}/blob", content=data, headers=auth_header(token))


async def _download(client: AsyncClient, token: str, file_id: str) -> Response:
    return await client.get(f"/v1/files/{file_id}", headers=auth_header(token))


async def _thumbnail(client: AsyncClient, token: str, file_id: str) -> Response:
    return await client.get(f"/v1/files/{file_id}/thumbnail", headers=auth_header(token))


def _png_bytes(width: int, height: int, color: tuple[int, int, int] = (10, 120, 200)) -> bytes:
    """A real PNG of the given dimensions (ENG-118 thumbnail tests)."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def _decompression_bomb_png() -> bytes:
    """A tiny PNG whose IHDR CLAIMS 100000×100000 pixels — a decompression bomb.

    A few dozen bytes on disk, but 10^10 declared pixels. Crafted by hand (Pillow would
    refuse to WRITE such an image) so the upload PUT stores a small, valid-header blob;
    the thumbnailer then rejects it at ``Image.open`` via the ``MAX_IMAGE_PIXELS`` guard,
    before decoding, so no giant buffer is ever allocated.
    """

    def chunk(typ: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 100000, 100000, 8, 2, 0, 0, 0)  # width, height, bit depth, ...
    return (
        sig
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"\x00" * 16))
        + chunk(b"IEND", b"")
    )


async def _thumbnail_sha(db: Any, file_id: str) -> str | None:
    """Read a file row's stored ``thumbnail_sha256`` (or None)."""
    value: str | None = await db.scalar(
        select(File.thumbnail_sha256).where(File.file_id == file_id)
    )
    return value


async def _upload(
    client: AsyncClient,
    token: str,
    *,
    stream_id: str,
    data: bytes,
    name: str = "photo.png",
    mime_type: str = "image/png",
) -> str:
    """initiate → PUT the honest bytes; return the ``file_id`` of the present file."""
    sha = _sha(data)
    resp = await _initiate(
        client, token, sha256=sha, stream_id=stream_id, name=name, mime_type=mime_type, data=data
    )
    assert resp.status_code == 200, resp.text
    file_id: str = resp.json()["file_id"]
    put = await _put_blob(client, token, file_id, data)
    assert put.status_code == 200, put.text
    assert put.json() == {"file_id": file_id, "present": True}
    return file_id


def _problem_without_instance(resp: Response) -> dict[str, Any]:
    """A problem body minus ``instance`` (which legitimately varies by path)."""
    body = dict(resp.json())
    body.pop("instance", None)
    return body


async def _seed_workspace(db: Any, *, name: str) -> dict[str, str]:
    """Seed a full second workspace (owner user + device + live session + streams).

    ``/v1/setup`` is single-tenant (409 once a user exists), so a SECOND workspace
    for the cross-workspace-oracle test is seeded directly on the bound test
    session — the same session the app's ``get_session`` override yields, so a
    ``Bearer`` token authenticates against it. Returns an auth dict shaped like the
    setup/login response plus the workspace's public channel id.
    """
    ws_id = ids.new_workspace_id()
    user_id = ids.new_user_id()
    device_id = ids.new_device_id()
    meta_id = ids.new_stream_id()
    public_id = ids.new_stream_id()
    raw_token = f"seed-token-{ws_id}"

    db.add(Workspace(workspace_id=ws_id, name=name))
    await db.flush()
    db.add(
        User(
            user_id=user_id,
            workspace_id=ws_id,
            email=f"owner@{name}.example.com",
            password_hash="x",
            display_name="Seed Owner",
            role="owner",
        )
    )
    await db.flush()
    db.add(Device(device_id=device_id, user_id=user_id))
    await db.flush()
    db.add(
        Session(
            token_hash=hash_token(raw_token),
            user_id=user_id,
            device_id=device_id,
            expires_at=utcnow() + timedelta(days=1),
        )
    )
    db.add(Stream(stream_id=meta_id, workspace_id=ws_id, kind="workspace-meta"))
    db.add(
        Stream(
            stream_id=public_id,
            workspace_id=ws_id,
            kind="channel",
            name="general",
            visibility="public",
        )
    )
    await db.flush()
    return {
        "workspace_id": ws_id,
        "user_id": user_id,
        "device_id": device_id,
        "token": raw_token,
        "public_stream": public_id,
    }


async def _join_workspace(
    client: AsyncClient, owner: dict[str, Any], *, email: str, role: str = "member"
) -> dict[str, Any]:
    """Invite + accept a second same-workspace user; return their auth dict."""
    invite = await create_invite(client, owner["token"], role=role)
    assert invite.status_code == 201, invite.text
    accepted = await accept_invite(client, join_token(invite.json()["url"]), email=email)
    assert accepted.status_code == 200, accepted.text
    body: dict[str, Any] = accepted.json()
    return body


async def _add_channel_member(
    client: AsyncClient, owner: dict[str, Any], *, channel_stream_id: str, user_id: str
) -> None:
    """Owner adds ``user_id`` to a channel via a ``channel.member_added`` event."""
    body = lifecycle_body(
        auth=owner,
        home_stream_id=channel_stream_id,
        type="channel.member_added",
        payload={"channel_stream_id": channel_stream_id, "user_id": user_id},
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert resp.status_code == 200 and len(resp.json()["accepted"]) == 1, resp.text


# --- happy path --------------------------------------------------------------


async def test_upload_download_round_trip(client: AsyncClient, db_session: Any) -> None:
    """initiate (upload_needed) → PUT → GET returns byte-identical content, hardened."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = b"round-trip payload \x00\x01\x02 unique-A" * 4
    sha = _sha(data)

    init = await _initiate(client, owner["token"], sha256=sha, stream_id=channel, data=data)
    assert init.status_code == 200, init.text
    assert init.json()["upload_needed"] is True
    file_id = init.json()["file_id"]
    assert file_id.startswith("f_")

    put = await _put_blob(client, owner["token"], file_id, data)
    assert put.status_code == 200, put.text

    resp = await _download(client, owner["token"], file_id)
    assert resp.status_code == 200, resp.text
    assert resp.content == data  # bytes come back identical
    # Hardened, non-inline serving (stored-XSS impossible).
    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-disposition"].startswith("attachment")


async def test_initiate_dedup_within_workspace(client: AsyncClient, db_session: Any) -> None:
    """A second initiate of an already-present sha in the SAME workspace skips upload."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = b"dedup-within-workspace unique-B" * 3
    first = await _upload(client, owner["token"], stream_id=channel, data=data)

    again = await _initiate(client, owner["token"], sha256=_sha(data), stream_id=channel, data=data)
    assert again.status_code == 200, again.text
    assert again.json()["upload_needed"] is False  # present → no upload needed
    new_file_id = again.json()["file_id"]
    assert new_file_id != first  # a distinct row, already present

    # The deduped row is immediately downloadable without any PUT.
    resp = await _download(client, owner["token"], new_file_id)
    assert resp.status_code == 200
    assert resp.content == data


async def test_put_is_idempotent(client: AsyncClient, db_session: Any) -> None:
    """A second PUT of an already-present file is a safe no-op success."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = b"idempotent-put unique-C" * 3
    file_id = await _upload(client, owner["token"], stream_id=channel, data=data)

    second = await _put_blob(client, owner["token"], file_id, data)
    assert second.status_code == 200, second.text
    assert second.json() == {"file_id": file_id, "present": True}


# --- authz: 404-not-403 uniformity, no oracle --------------------------------


async def test_initiate_forbidden_stream_is_uniform_404(
    client: AsyncClient, db_session: Any
) -> None:
    """Authz FIRST: an unknown stream and a forbidden stream give the identical 404."""
    owner = await do_setup(client)
    data = b"forbidden-initiate unique-D"
    sha = _sha(data)

    # Unknown stream id → 404.
    unknown = await _initiate(
        client, owner["token"], sha256=sha, stream_id=ids.new_stream_id(), data=data
    )
    assert unknown.status_code == 404
    assert unknown.json()["type"] == "/problems/not-found"

    # Existing but unreadable (private channel the owner is NOT a member of) → 404,
    # byte-identical body (minus the path-derived ``instance``). No 403, no oracle.
    private_id = ids.new_stream_id()
    db_session.add(
        Stream(
            stream_id=private_id,
            workspace_id=owner["workspace_id"],
            kind="channel",
            name="secret",
            visibility="private",
        )
    )
    await db_session.flush()
    forbidden = await _initiate(client, owner["token"], sha256=sha, stream_id=private_id, data=data)
    assert forbidden.status_code == 404
    assert _problem_without_instance(forbidden) == _problem_without_instance(unknown)


async def test_non_member_download_uniform_404(client: AsyncClient, db_session: Any) -> None:
    """A non-member's download 404 is byte-identical to an unknown-id 404 (no oracle)."""
    owner = await do_setup(client)
    private = await bootstrap_channel(client, db_session, owner, visibility="private")
    data = b"private-bytes unique-E" * 3
    file_id = await _upload(client, owner["token"], stream_id=private, data=data)

    # A second workspace member who is NOT in the private channel.
    invite = await create_invite(client, owner["token"])
    assert invite.status_code == 201, invite.text
    accepted = await accept_invite(
        client, join_token(invite.json()["url"]), email="member@example.com"
    )
    assert accepted.status_code == 200, accepted.text
    member_token = accepted.json()["token"]

    forbidden = await _download(client, member_token, file_id)
    unknown = await _download(client, member_token, ids.new_file_id())
    assert forbidden.status_code == 404
    assert unknown.status_code == 404
    # Existence is never disclosed: "exists but forbidden" == "unknown".
    assert _problem_without_instance(forbidden) == _problem_without_instance(unknown)


async def test_adversary_cannot_download_private_file_by_id(
    client: AsyncClient, db_session: Any
) -> None:
    """An adversary cannot download a private-stream file by an id it isn't a member of.

    Distinct from the uniform-404 test: here the adversary KNOWS the exact
    ``file_id`` (it is handed to them) and still cannot reach the bytes.
    """
    owner = await do_setup(client)
    private = await bootstrap_channel(client, db_session, owner, visibility="private")
    data = b"adversary-target unique-F" * 3
    file_id = await _upload(client, owner["token"], stream_id=private, data=data)

    invite = await create_invite(client, owner["token"])
    accepted = await accept_invite(
        client, join_token(invite.json()["url"]), email="adv@example.com"
    )
    adversary_token = accepted.json()["token"]

    resp = await _download(client, adversary_token, file_id)
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


async def test_download_by_hash_is_impossible(client: AsyncClient, db_session: Any) -> None:
    """There is no route that takes a sha256 — a hash-shaped path is just an unknown id."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = b"by-hash unique-G" * 3
    await _upload(client, owner["token"], stream_id=channel, data=data)

    # A caller who knows the sha cannot turn it into a download: the only download
    # route is /v1/files/{file_id}, and a 64-hex path is not a known file id → 404.
    resp = await client.get(f"/v1/files/{_sha(data)}", headers=auth_header(owner["token"]))
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


# --- size caps ---------------------------------------------------------------


async def test_oversized_initiate_413(client: AsyncClient, db_session: Any) -> None:
    """A declared ``size_bytes`` over the per-file cap is a 413 (before any upload)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    resp = await _initiate(
        client,
        owner["token"],
        sha256=_sha(b"whatever unique-H"),
        stream_id=channel,
        size_bytes=52428800 + 1,  # one over the 50 MiB default cap
    )
    assert resp.status_code == 413
    assert resp.json()["type"] == "/problems/file-too-large"


async def test_oversized_put_streams_past_cap_rejected_nothing_stored(
    settings: Settings, db_session: Any
) -> None:
    """A client that declares a small size but streams past the cap is aborted, nothing stored."""
    capped = settings.model_copy(update={"file_max_size_bytes": 1024})
    app = make_app(capped, db_session)
    async with make_client(app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        big = b"L" * 4096  # 4 KiB, far past the 1 KiB cap
        sha = _sha(big)
        # LIE: declare a tiny size so initiate's declared-size gate passes.
        init = await _initiate(
            client, owner["token"], sha256=sha, stream_id=channel, size_bytes=100
        )
        assert init.status_code == 200, init.text
        file_id = init.json()["file_id"]

        put = await _put_blob(client, owner["token"], file_id, big)
        assert put.status_code == 413
        assert put.json()["type"] == "/problems/file-too-large"

    # Nothing was promoted to storage, and the row never became present.
    assert await _blob_store(settings).exists(sha) is False
    gone = await _download_via_new_client(capped, db_session, owner["token"], file_id)
    assert gone == 404


async def _download_via_new_client(
    settings: Settings, db_session: Any, token: str, file_id: str
) -> int:
    """Download status via a fresh capped-app client (helper for post-abort checks)."""
    app = make_app(settings, db_session)
    async with make_client(app) as client:
        resp = await _download(client, token, file_id)
        return resp.status_code


# --- hash + size honesty -----------------------------------------------------


async def test_server_recomputed_hash_mismatch_rejected(
    client: AsyncClient, db_session: Any, settings: Settings
) -> None:
    """PUTting bytes whose sha != the initiated sha is rejected; blob not stored."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    honest = b"the-bytes-i-committed unique-I" * 3
    lie = b"totally-different-bytes unique-I2" * 3
    declared_sha = _sha(honest)

    init = await _initiate(
        client, owner["token"], sha256=declared_sha, stream_id=channel, data=honest
    )
    assert init.status_code == 200, init.text
    file_id = init.json()["file_id"]

    put = await _put_blob(client, owner["token"], file_id, lie)
    assert put.status_code == 422
    assert put.json()["type"] == "/problems/blob-hash-mismatch"

    # The store recomputed the hash and promoted nothing — neither the declared sha
    # nor the lie's sha is present.
    store = _blob_store(settings)
    assert await store.exists(declared_sha) is False
    assert await store.exists(_sha(lie)) is False
    # The row never flipped present → still not downloadable.
    resp = await _download(client, owner["token"], file_id)
    assert resp.status_code == 404


async def test_declared_size_mismatch_rejected(client: AsyncClient, db_session: Any) -> None:
    """Bytes that hash correctly but whose length != declared size_bytes are rejected."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = b"honest-hash-wrong-size unique-J" * 3
    sha = _sha(data)

    # Declare a size one larger than the real length (a quota-accounting lie).
    init = await _initiate(
        client, owner["token"], sha256=sha, stream_id=channel, size_bytes=len(data) + 1
    )
    assert init.status_code == 200, init.text
    file_id = init.json()["file_id"]

    put = await _put_blob(client, owner["token"], file_id, data)
    assert put.status_code == 422
    assert put.json()["type"] == "/problems/blob-size-mismatch"
    # Not marked present.
    resp = await _download(client, owner["token"], file_id)
    assert resp.status_code == 404


# --- quota -------------------------------------------------------------------


async def test_quota_exceeded_413(client: AsyncClient, db_session: Any) -> None:
    """Adding a file that would push the workspace over its quota is a 413."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    # Shrink this workspace's quota to 100 bytes for the test.
    await db_session.execute(
        update(Workspace)
        .where(Workspace.workspace_id == owner["workspace_id"])
        .values(file_quota_bytes=100)
    )
    await db_session.flush()

    a = await _initiate(
        client, owner["token"], sha256=_sha(b"a" * 60), stream_id=channel, size_bytes=60
    )
    assert a.status_code == 200, a.text  # 0 + 60 <= 100

    b = await _initiate(
        client, owner["token"], sha256=_sha(b"b" * 60), stream_id=channel, size_bytes=60
    )
    assert b.status_code == 413  # 60 + 60 > 100
    assert b.json()["type"] == "/problems/quota-exceeded"

    # Re-initiating an ALREADY-RESERVED sha adds zero bytes and is always allowed,
    # even though the workspace is at quota.
    again = await _initiate(
        client, owner["token"], sha256=_sha(b"a" * 60), stream_id=channel, size_bytes=60
    )
    assert again.status_code == 200, again.text


async def test_quota_race_two_initiates_cannot_both_exceed(
    settings: Settings, migrated_db: str
) -> None:
    """Two racing initiates that TOGETHER exceed quota → exactly one 413 (row lock).

    Uses the committing app (real, independently-committing sessions) because the
    shared rollback-isolated harness serializes every request through one session
    and cannot exercise the ``SELECT ... FOR UPDATE`` on the workspace row.
    """
    cleanup_engine = create_async_engine(settings.database_url)
    await truncate_auth_tables(cleanup_engine)

    client, engine = committing_app(settings)
    try:
        async with client:
            owner = await do_setup(client)
            channel = await _bootstrap_public_channel(client, engine, owner)
            # Quota = 100; each initiate declares 60 → each alone fits, together
            # (120) exceeds. Without the lock both read usage 0 and both pass.
            await _set_quota(engine, owner["workspace_id"], 100)

            r1, r2 = await asyncio.gather(
                _initiate(
                    client, owner["token"], sha256=_sha(b"x" * 60), stream_id=channel, size_bytes=60
                ),
                _initiate(
                    client, owner["token"], sha256=_sha(b"y" * 60), stream_id=channel, size_bytes=60
                ),
            )
            statuses = sorted([r1.status_code, r2.status_code])
            assert statuses == [200, 413], (r1.text, r2.text)
            loser = r1 if r1.status_code == 413 else r2
            assert loser.json()["type"] == "/problems/quota-exceeded"

            # Exactly one row landed → committed usage is 60, not 120.
            maker = async_sessionmaker(engine, expire_on_commit=False)
            async with maker() as db:
                rows = (
                    (
                        await db.execute(
                            select(File.size_bytes).where(
                                File.workspace_id == owner["workspace_id"]
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
            assert list(rows) == [60]
    finally:
        await truncate_auth_tables(cleanup_engine)
        await engine.dispose()
        await cleanup_engine.dispose()


async def _bootstrap_public_channel(
    client: AsyncClient, engine: AsyncEngine, owner: dict[str, Any]
) -> str:
    """Create a public channel through the endpoint (committing-app variant)."""
    from eventsutil import channel_created_body, post_batch, wire_item

    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        meta = await db.scalar(
            select(Stream.stream_id).where(
                Stream.workspace_id == owner["workspace_id"],
                Stream.kind == "workspace-meta",
            )
        )
    assert meta is not None
    channel_stream_id = ids.new_stream_id()
    body = channel_created_body(
        auth=owner, home_stream_id=meta, channel_stream_id=channel_stream_id
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert resp.status_code == 200 and len(resp.json()["accepted"]) == 1, resp.text
    return channel_stream_id


async def _set_quota(engine: AsyncEngine, workspace_id: str, quota: int) -> None:
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        await db.execute(
            update(Workspace)
            .where(Workspace.workspace_id == workspace_id)
            .values(file_quota_bytes=quota)
        )
        await db.commit()


# --- stored-XSS neutralization + header injection ----------------------------


@pytest.mark.parametrize(
    ("name", "mime_type", "data"),
    [
        ('ev"il\r\nInjected: yes.html', "text/html", b"<html><script>alert(1)</script></html>"),
        ("draw\r\n.svg", "image/svg+xml", b"<svg onload='alert(1)' xmlns='http://x'></svg>"),
    ],
)
async def test_stored_active_content_served_as_inert_attachment(
    client: AsyncClient, db_session: Any, name: str, mime_type: str, data: bytes
) -> None:
    """HTML/SVG blobs are served inert (octet-stream + attachment + nosniff), safely encoded."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    file_id = await _upload(
        client, owner["token"], stream_id=channel, data=data, name=name, mime_type=mime_type
    )

    resp = await _download(client, owner["token"], file_id)
    assert resp.status_code == 200
    assert resp.content == data
    # The browser can NEVER render this inline: neutral type, no sniffing, attachment.
    assert resp.headers["content-type"] == "application/octet-stream"
    assert resp.headers["x-content-type-options"] == "nosniff"
    cd = resp.headers["content-disposition"]
    assert cd.startswith("attachment")
    # Header injection is impossible: the CR/LF that would start a smuggled header
    # is stripped from the ascii fallback and percent-encoded in filename*, so it
    # never appears verbatim. (Printable residue like "Injected: yes" inside the
    # quoted-string is inert — it cannot break out to become a real header line.)
    assert "\r" not in cd and "\n" not in cd
    assert cd.count('"') == 2  # exactly the two wrapping the ascii fallback (no break-out)
    assert "filename*=UTF-8''" in cd  # RFC 5987 percent-encoded full name present
    assert "%0D%0A" in cd  # the smuggled CR/LF is encoded, never a raw line break


# --- cross-workspace: no existence oracle ------------------------------------


async def test_cross_workspace_no_existence_oracle(client: AsyncClient, db_session: Any) -> None:
    """Workspace B initiating a sha A uploaded gets upload_needed=true and can't read A's file."""
    # Workspace A (the setup workspace) uploads a file.
    a_owner = await do_setup(client)
    a_channel = await bootstrap_channel(client, db_session, a_owner)
    data = b"cross-workspace-secret unique-K" * 3
    sha = _sha(data)
    a_file_id = await _upload(client, a_owner["token"], stream_id=a_channel, data=data)

    # Workspace B (seeded) initiates the SAME sha into its own public channel.
    b = await _seed_workspace(db_session, name="workspace-b")
    b_init = await _initiate(
        client, b["token"], sha256=sha, stream_id=b["public_stream"], size_bytes=len(data)
    )
    assert b_init.status_code == 200, b_init.text
    # Scoped dedup: B has never uploaded this sha, so it MUST still upload — the
    # global blob (from A) is NOT revealed as present.
    assert b_init.json()["upload_needed"] is True

    # And B cannot download A's file by A's id — cross-workspace read is a 404.
    resp = await _download(client, b["token"], a_file_id)
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


# --- authentication ----------------------------------------------------------


async def test_endpoints_require_auth(client: AsyncClient) -> None:
    """All three endpoints reject an unauthenticated caller with 401."""
    init = await client.post(
        INITIATE_URL,
        json={
            "sha256": _sha(b"x"),
            "name": "n",
            "mime_type": "text/plain",
            "size_bytes": 1,
            "stream_id": ids.new_stream_id(),
        },
    )
    assert init.status_code == 401
    put = await client.put(f"/v1/files/{ids.new_file_id()}/blob", content=b"x")
    assert put.status_code == 401
    get = await client.get(f"/v1/files/{ids.new_file_id()}")
    assert get.status_code == 401


# --- review round: integrity, availability, oracle hardening -----------------


async def test_dedup_present_ignores_inflated_client_size(
    client: AsyncClient, db_session: Any
) -> None:
    """Re-initiating a known sha with an inflated size stores the TRUE size, not the claim.

    Fix 1: the dedup-present branch must COPY the already-present row's size rather
    than trust the client — otherwise a member could over-count workspace usage and
    grief others toward quota_exceeded, and the "size_bytes is truthful" guarantee
    would be false.
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = b"x" * 100  # a real 100-byte blob
    sha = _sha(data)
    await _upload(client, owner["token"], stream_id=channel, data=data)

    # Re-initiate the SAME sha declaring a 50 MiB size (a lie).
    inflated = await _initiate(
        client, owner["token"], sha256=sha, stream_id=channel, size_bytes=52428800
    )
    assert inflated.status_code == 200, inflated.text
    assert inflated.json()["upload_needed"] is False  # deduped
    new_file_id = inflated.json()["file_id"]

    # The stored size is the TRUE 100 bytes, not the inflated claim.
    stored_size = await db_session.scalar(
        select(File.size_bytes).where(File.file_id == new_file_id)
    )
    assert stored_size == 100

    # Workspace usage did not jump: distinct-sha usage is still 100, so a second
    # distinct file just under the (default huge) quota is unaffected — assert the
    # concrete stored sizes are all the true value.
    all_sizes = (
        (
            await db_session.execute(
                select(File.size_bytes).where(
                    File.workspace_id == owner["workspace_id"], File.sha256 == sha
                )
            )
        )
        .scalars()
        .all()
    )
    assert set(all_sizes) == {100}  # every row for this sha carries the true size


async def test_size_zero_rejected(client: AsyncClient, db_session: Any) -> None:
    """Fix 4: size_bytes=0 is a 422 (empty files disallowed — unbounded-row DoS guard)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    resp = await _initiate(
        client, owner["token"], sha256=_sha(b""), stream_id=channel, size_bytes=0
    )
    assert resp.status_code == 422  # request validation (ge=1)


async def test_write_rate_limit_trips(settings: Settings, db_session: Any) -> None:
    """Fix 2: the per-user write limiter trips on the 2nd initiate when the budget is 1."""
    capped = settings.model_copy(update={"file_rate_limit_per_minute": 1})
    app = make_app(capped, db_session)
    async with make_client(app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        first = await _initiate(
            client, owner["token"], sha256=_sha(b"rl-1" * 8), stream_id=channel, size_bytes=32
        )
        assert first.status_code == 200, first.text
        second = await _initiate(
            client, owner["token"], sha256=_sha(b"rl-2" * 8), stream_id=channel, size_bytes=32
        )
        assert second.status_code == 429
        assert second.json()["type"] == "/problems/rate-limited"
        assert int(second.headers["retry-after"]) > 0


async def test_download_rate_limit_is_separate_budget(settings: Settings, db_session: Any) -> None:
    """Downloads have their OWN limiter, distinct from writes, and it trips on its budget."""
    # Generous write budget (so initiate + PUT succeed) but a tiny download budget.
    capped = settings.model_copy(
        update={"file_rate_limit_per_minute": 60, "file_download_rate_limit_per_minute": 2}
    )
    app = make_app(capped, db_session)
    async with make_client(app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)
        data = b"separate-budget unique-RL" * 3
        file_id = await _upload(client, owner["token"], stream_id=channel, data=data)

        # The 2/min download budget allows two reads; the third trips 429 — proving
        # downloads are gated by a limiter separate from the (untouched) write budget.
        assert (await _download(client, owner["token"], file_id)).status_code == 200
        assert (await _download(client, owner["token"], file_id)).status_code == 200
        third = await _download(client, owner["token"], file_id)
        assert third.status_code == 429
        assert third.json()["type"] == "/problems/rate-limited"


async def test_within_workspace_cross_stream_no_oracle(
    client: AsyncClient, db_session: Any
) -> None:
    """Fix 5 (F3): a sha present ONLY in an unreadable stream → upload_needed=true.

    A member who holds a file's bytes must not be able to confirm those bytes exist
    in a private channel they are not in by reading ``upload_needed:false``.
    """
    owner = await do_setup(client)
    private = await bootstrap_channel(client, db_session, owner, visibility="private")
    data = b"cross-stream-secret unique-L" * 3
    sha = _sha(data)
    owner_file_id = await _upload(client, owner["token"], stream_id=private, data=data)

    # A second member NOT in the private channel, with their own readable channel.
    member = await _join_workspace(client, owner, email="cross-stream@example.com")
    member_channel = await bootstrap_channel(client, db_session, member, name="member-chan")

    # The member initiates the SAME sha into a stream THEY can read. The only present
    # copy lives in the private channel they cannot read → they must still upload.
    init = await _initiate(
        client, member["token"], sha256=sha, stream_id=member_channel, size_bytes=len(data)
    )
    assert init.status_code == 200, init.text
    assert init.json()["upload_needed"] is True  # no cross-stream existence leak

    # And they still cannot download the owner's private file by its id.
    resp = await _download(client, member["token"], owner_file_id)
    assert resp.status_code == 404


async def test_exactly_at_cap_initiate_and_put_succeed(settings: Settings, db_session: Any) -> None:
    """Edge: a file exactly AT the per-file cap initiates, uploads, and downloads."""
    cap = 2048
    capped = settings.model_copy(update={"file_max_size_bytes": cap})
    app = make_app(capped, db_session)
    async with make_client(app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)
        data = b"C" * cap  # exactly at the cap
        sha = _sha(data)

        init = await _initiate(
            client, owner["token"], sha256=sha, stream_id=channel, size_bytes=cap
        )
        assert init.status_code == 200, init.text  # == cap is allowed (only > cap fails)
        file_id = init.json()["file_id"]
        put = await _put_blob(client, owner["token"], file_id, data)
        assert put.status_code == 200, put.text  # streamed exactly to the cap, not over

        resp = await _download(client, owner["token"], file_id)
        assert resp.status_code == 200
        assert resp.content == data


async def test_guest_member_can_use_files_and_is_isolated(
    client: AsyncClient, db_session: Any
) -> None:
    """A guest can round-trip a file in a channel they're an explicit member of; 404 otherwise."""
    owner = await do_setup(client)
    allowed = await bootstrap_channel(client, db_session, owner, visibility="private", name="allow")
    denied = await bootstrap_channel(client, db_session, owner, visibility="private", name="deny")

    guest = await _join_workspace(client, owner, email="guest@example.com", role="guest")
    await _add_channel_member(client, owner, channel_stream_id=allowed, user_id=guest["user_id"])

    # In the channel they were added to: full round-trip works.
    data = b"guest-allowed unique-G2" * 3
    file_id = await _upload(client, guest["token"], stream_id=allowed, data=data)
    got = await _download(client, guest["token"], file_id)
    assert got.status_code == 200 and got.content == data

    # A channel they are NOT a member of: initiate → uniform 404 (authz first).
    denied_init = await _initiate(
        client, guest["token"], sha256=_sha(b"nope unique-G3"), stream_id=denied, size_bytes=14
    )
    assert denied_init.status_code == 404
    assert denied_init.json()["type"] == "/problems/not-found"

    # A file living in that channel: the guest cannot download it by id either.
    owner_file = await _upload(
        client, owner["token"], stream_id=denied, data=b"owner-only unique-G4" * 3
    )
    denied_dl = await _download(client, guest["token"], owner_file)
    assert denied_dl.status_code == 404


# --- image thumbnails (ENG-118) ----------------------------------------------


async def test_image_upload_generates_thumbnail(client: AsyncClient, db_session: Any) -> None:
    """An image PUT generates a thumbnail; GET .../thumbnail serves it inline as WEBP."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = _png_bytes(1600, 900)  # larger than the 720px bound → will be downscaled
    file_id = await _upload(
        client, owner["token"], stream_id=channel, data=data, name="pic.png", mime_type="image/png"
    )

    # A derived thumbnail blob was recorded on the row.
    thumb_sha = await _thumbnail_sha(db_session, file_id)
    assert thumb_sha is not None

    resp = await _thumbnail(client, owner["token"], file_id)
    assert resp.status_code == 200, resp.text
    # Server-generated, re-encoded → safe to serve inline as a real image type.
    assert resp.headers["content-type"] == "image/webp"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["content-disposition"] == "inline"
    # The body is a genuine WEBP whose long edge respects the 720px bound.
    with Image.open(io.BytesIO(resp.content)) as thumb:
        assert thumb.format == "WEBP"
        assert max(thumb.size) <= 720


async def test_non_image_upload_has_no_thumbnail(client: AsyncClient, db_session: Any) -> None:
    """Non-image bytes (even declaring an image mime) get NO thumbnail; .../thumbnail 404s.

    The declared ``mime_type`` is only a cheap hint — here it LIES (``image/png`` on
    plain text). Pillow is the real guard: it fails to decode, so ``thumbnail_sha256``
    stays NULL and the thumbnail endpoint returns the uniform 404.
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = b"this is definitely not a PNG despite the mime type" * 4
    file_id = await _upload(
        client, owner["token"], stream_id=channel, data=data, name="fake.png", mime_type="image/png"
    )

    assert await _thumbnail_sha(db_session, file_id) is None
    resp = await _thumbnail(client, owner["token"], file_id)
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


async def test_thumbnail_no_thumb_404_matches_unknown_id(
    client: AsyncClient, db_session: Any
) -> None:
    """A file-with-no-thumbnail 404 is byte-identical to an unknown-id 404 (no oracle)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    file_id = await _upload(
        client, owner["token"], stream_id=channel, data=b"plain text", mime_type="text/plain"
    )
    # A non-image mime skips decoding entirely — still NULL, still a uniform 404.
    assert await _thumbnail_sha(db_session, file_id) is None

    no_thumb = await _thumbnail(client, owner["token"], file_id)
    unknown = await _thumbnail(client, owner["token"], ids.new_file_id())
    assert no_thumb.status_code == 404
    assert unknown.status_code == 404
    assert _problem_without_instance(no_thumb) == _problem_without_instance(unknown)


async def test_thumbnail_non_member_uniform_404(client: AsyncClient, db_session: Any) -> None:
    """A non-member cannot reach a private-stream file's thumbnail; 404 == unknown id."""
    owner = await do_setup(client)
    private = await bootstrap_channel(client, db_session, owner, visibility="private")
    file_id = await _upload(client, owner["token"], stream_id=private, data=_png_bytes(200, 200))
    # The owner's thumbnail exists and serves.
    assert (await _thumbnail(client, owner["token"], file_id)).status_code == 200

    invite = await create_invite(client, owner["token"])
    accepted = await accept_invite(
        client, join_token(invite.json()["url"]), email="outsider@example.com"
    )
    outsider_token = accepted.json()["token"]

    forbidden = await _thumbnail(client, outsider_token, file_id)
    unknown = await _thumbnail(client, outsider_token, ids.new_file_id())
    assert forbidden.status_code == 404
    assert unknown.status_code == 404
    # "exists but forbidden" is indistinguishable from "unknown" — no existence oracle.
    assert _problem_without_instance(forbidden) == _problem_without_instance(unknown)


async def test_no_by_hash_thumbnail_route(client: AsyncClient, db_session: Any) -> None:
    """There is no by-hash thumbnail route — a hash-shaped id is just an unknown file."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = _png_bytes(120, 120)
    await _upload(client, owner["token"], stream_id=channel, data=data)

    # Knowing the content sha buys nothing: the only thumbnail route takes a file_id.
    resp = await _thumbnail(client, owner["token"], _sha(data))
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


async def test_decompression_bomb_via_api_best_effort_no_thumbnail(
    client: AsyncClient, db_session: Any
) -> None:
    """A bomb image uploads as a FILE (best-effort) but yields NO thumbnail, no hang.

    The crafted PNG declares 100000×100000 pixels. Its bytes upload fine (small, valid
    header), but the thumbnailer rejects it at the decompression-bomb guard → NULL
    thumbnail, 404 thumbnail endpoint. Wrapping the upload in a timeout asserts the PUT
    returns PROMPTLY (never hangs on the hostile decode); a follow-up request proves the
    server stayed responsive.
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    bomb = _decompression_bomb_png()

    # The whole initiate+PUT completes well within the timeout (no hang on the decode).
    file_id = await asyncio.wait_for(
        _upload(client, owner["token"], stream_id=channel, data=bomb, mime_type="image/png"),
        timeout=30,
    )

    # File succeeded; thumbnail did not (best-effort).
    assert await _thumbnail_sha(db_session, file_id) is None
    thumb = await _thumbnail(client, owner["token"], file_id)
    assert thumb.status_code == 404
    # The file itself is still downloadable and the server is responsive.
    dl = await _download(client, owner["token"], file_id)
    assert dl.status_code == 200 and dl.content == bomb


async def test_dedup_inherits_thumbnail(client: AsyncClient, db_session: Any) -> None:
    """A deduped image row inherits the source row's thumbnail (generated once per sha)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    data = _png_bytes(400, 300)
    sha = _sha(data)
    first = await _upload(client, owner["token"], stream_id=channel, data=data)
    original_thumb = await _thumbnail_sha(db_session, first)
    assert original_thumb is not None

    # Re-initiate the SAME sha: dedup-present, no upload needed.
    again = await _initiate(client, owner["token"], sha256=sha, stream_id=channel, data=data)
    assert again.status_code == 200, again.text
    assert again.json()["upload_needed"] is False
    new_file_id = again.json()["file_id"]
    assert new_file_id != first

    # The new row inherited the identical derived-blob sha — no re-generation.
    assert await _thumbnail_sha(db_session, new_file_id) == original_thumb

    # And it serves the byte-identical thumbnail.
    from_first = await _thumbnail(client, owner["token"], first)
    from_dedup = await _thumbnail(client, owner["token"], new_file_id)
    assert from_first.status_code == 200 and from_dedup.status_code == 200
    assert from_dedup.content == from_first.content
