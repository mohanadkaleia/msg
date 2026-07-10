"""Workspace icon (ENG-152) — admin upload pipeline + the workspace-readable serve.

The workspace sibling of ``test_avatars``, adversarial where it matters:

* a valid admin upload stores the SERVER RE-ENCODE (normalized 256×256 WEBP,
  EXIF stripped, sha of the re-encode — never the raw bytes), sets
  ``workspaces.icon_sha256``, and emits EXACTLY ONE ``workspace.updated``
  carrying the icon ref;
* clear → NULL + one event carrying ``icon_sha256: null``; idempotent;
* hostile input — a non-image, a lying ``image/*`` content type, an oversized
  body (declared AND chunked/undeclared), and a decompression bomb whose header
  claims 100000×100000 pixels — is rejected 400/413 BEFORE any giant decode,
  and nothing is stored / the row is untouched;
* AUTHZ: upload/delete are owner/admin ONLY (member/guest → 403); a forged
  ``workspace.updated`` carrying an icon via ``/v1/events/batch`` →
  ``permission_denied``;
* serve authz: any authenticated workspace member gets the icon (200); no icon
  set → uniform 404; a cross-workspace caller reads THEIR OWN icon (or its 404)
  and can never name another workspace; unauthenticated → 401; and the route is
  NOT a blob oracle — it takes NO parameter (no sha, no id), so a known
  file-attachment sha cannot be fetched through it.
"""

from __future__ import annotations

import hashlib
import io
import struct
import zlib
from collections.abc import AsyncIterator
from datetime import timedelta
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
from eventsutil import bootstrap_channel, post_batch, wire_item
from httpx import AsyncClient, Response
from msgd.auth.sessions import utcnow
from msgd.auth.tokens import hash_token
from msgd.blobs.store import LocalDiskBlobStore
from msgd.core import ids
from msgd.core.time import now_rfc3339
from msgd.db.models import Device, Session, Stream, User, Workspace
from msgd.settings import Settings
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

UPLOAD_URL = "/v1/admin/workspace/icon"
SERVE_URL = "/v1/workspace/icon"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _blob_store(settings: Settings) -> LocalDiskBlobStore:
    """A store rooted where the app writes its blobs (same as ``create_app``)."""
    return LocalDiskBlobStore(settings.data_dir / "blobs")


def _png_bytes(width: int, height: int, color: tuple[int, int, int] = (10, 120, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_with_exif(width: int = 320, height: int = 480) -> bytes:
    """A real JPEG carrying EXIF metadata — the privacy payload the re-encode must strip."""
    img = Image.new("RGB", (width, height), (200, 30, 40))
    exif = Image.Exif()
    exif[0x010F] = "EvilCorp CameraPhone"
    exif[0x0110] = "Model X"
    exif[0x0131] = "leaky-editor/1.0"
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif)
    data = buf.getvalue()
    assert b"EvilCorp" in data
    return data


def _decompression_bomb_png() -> bytes:
    """A tiny PNG whose IHDR CLAIMS 100000×100000 pixels — must be rejected pre-decode."""

    def chunk(typ: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 100000, 100000, 8, 2, 0, 0, 0)
    return (
        sig
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"\x00" * 16))
        + chunk(b"IEND", b"")
    )


async def _upload(
    client: AsyncClient, token: str, data: bytes, *, content_type: str = "image/png"
) -> Response:
    return await client.post(
        UPLOAD_URL, content=data, headers={**auth_header(token), "Content-Type": content_type}
    )


async def _serve(client: AsyncClient, token: str) -> Response:
    return await client.get(SERVE_URL, headers=auth_header(token))


async def _seed_role(
    client: AsyncClient, owner_token: str, role: str, *, email: str | None = None
) -> dict[str, Any]:
    inv = await create_invite(client, owner_token, role=role)
    raw = join_token(inv.json()["url"])
    body: dict[str, Any] = (
        await accept_invite(client, raw, email=email or f"{role}@example.com")
    ).json()
    return body


def _problem_without_instance(resp: Response) -> dict[str, Any]:
    body = dict(resp.json())
    body.pop("instance", None)
    return body


async def _seed_workspace_b(db: AsyncSession) -> dict[str, str]:
    """Seed a second workspace + live session directly (setup is single-tenant)."""
    ws_id = ids.new_workspace_id()
    user_id = ids.new_user_id()
    device_id = ids.new_device_id()
    meta_id = ids.new_stream_id()
    raw_token = f"seed-token-{ws_id}"

    db.add(Workspace(workspace_id=ws_id, name="other"))
    await db.flush()
    db.add(
        User(
            user_id=user_id,
            workspace_id=ws_id,
            email="owner@other.example.com",
            password_hash="x",
            display_name="Other Owner",
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
    await db.flush()
    return {"workspace_id": ws_id, "user_id": user_id, "token": raw_token}


# --- upload: the safe re-encode pipeline ---------------------------------------


async def test_upload_stores_normalized_reencode_not_the_raw_bytes(
    client: AsyncClient, db_session: AsyncSession, settings: Settings
) -> None:
    """A valid admin upload → 200 with ``icon_sha256`` set; the STORED blob is the
    server's 256×256 WEBP re-encode (raw bytes discarded), EXIF stripped."""
    owner = await do_setup(client)
    raw = _jpeg_with_exif(320, 480)

    resp = await _upload(client, owner["token"], raw, content_type="image/jpeg")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    sha = body["icon_sha256"]
    assert isinstance(sha, str) and len(sha) == 64
    assert sha != _sha(raw)  # the stored object is the re-encode

    stored = await _blob_store(settings).get_bytes(sha)
    assert _sha(stored) == sha
    assert stored != raw
    with Image.open(io.BytesIO(stored)) as img:
        assert img.format == "WEBP"
        assert img.size == (settings.avatar_px, settings.avatar_px)
        assert dict(img.getexif()) == {}
    assert b"EvilCorp" not in stored

    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 == sha
    got = (await client.get("/v1/admin/workspace", headers=auth_header(owner["token"]))).json()
    assert got["icon_sha256"] == sha


async def test_upload_emits_exactly_one_workspace_updated_with_icon_ref(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    owner = await do_setup(client)
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    resp = await _upload(client, owner["token"], _png_bytes(300, 300))
    assert resp.status_code == 200, resp.text
    sha = resp.json()["icon_sha256"]

    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before) + 1
    event = after[-1]
    assert event.type == "workspace.updated"
    assert event.body["author_user_id"] == owner["user_id"]
    # Presence-significant: only the icon changed, so name/description are ABSENT.
    assert event.body["payload"] == {"icon_sha256": sha}


async def test_admin_can_upload_icon(client: AsyncClient, db_session: AsyncSession) -> None:
    """An ADMIN (not only the owner) may set the icon."""
    owner = await do_setup(client)
    admin = await _seed_role(client, owner["token"], "admin")

    resp = await _upload(client, admin["token"], _png_bytes(64, 64))
    assert resp.status_code == 200, resp.text
    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 == resp.json()["icon_sha256"]


async def test_clear_icon_nulls_row_and_emits_event(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    owner = await do_setup(client)
    h = auth_header(owner["token"])
    assert (await _upload(client, owner["token"], _png_bytes(64, 64))).status_code == 200
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    resp = await client.delete(UPLOAD_URL, headers=h)
    assert resp.status_code == 200, resp.text
    assert resp.json()["icon_sha256"] is None

    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 is None
    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before) + 1
    assert after[-1].type == "workspace.updated"
    assert after[-1].body["payload"] == {"icon_sha256": None}

    # Clearing an already-absent icon still succeeds (idempotent surface).
    again = await client.delete(UPLOAD_URL, headers=h)
    assert again.status_code == 200
    assert again.json()["icon_sha256"] is None


# --- hostile input --------------------------------------------------------------


async def test_non_image_bytes_with_image_content_type_rejected_400(
    client: AsyncClient, db_session: AsyncSession, settings: Settings
) -> None:
    owner = await do_setup(client)
    data = b"definitely not a PNG despite the content type" * 10

    resp = await _upload(client, owner["token"], data, content_type="image/png")
    assert resp.status_code == 400, resp.text
    assert resp.json()["type"] == "/problems/invalid-image"

    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 is None
    assert not await _blob_store(settings).exists(_sha(data))


async def test_non_image_content_type_rejected_400(client: AsyncClient) -> None:
    owner = await do_setup(client)
    resp = await _upload(client, owner["token"], _png_bytes(32, 32), content_type="text/plain")
    assert resp.status_code == 400
    assert resp.json()["type"] == "/problems/invalid-image"


async def test_oversized_upload_rejected_413(
    client: AsyncClient, db_session: AsyncSession, settings: Settings
) -> None:
    owner = await do_setup(client)
    too_big = b"\x89PNG\r\n\x1a\n" + b"\x00" * settings.avatar_max_size_bytes

    resp = await _upload(client, owner["token"], too_big)
    assert resp.status_code == 413, resp.text
    assert resp.json()["type"] == "/problems/file-too-large"

    async def _chunks() -> AsyncIterator[bytes]:
        for _ in range(6):
            yield b"\x00" * 1_048_576

    chunked = await client.post(
        UPLOAD_URL,
        content=_chunks(),
        headers={**auth_header(owner["token"]), "Content-Type": "image/png"},
    )
    assert chunked.status_code == 413, chunked.text

    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 is None
    assert not await _blob_store(settings).exists(_sha(too_big))


async def test_decompression_bomb_rejected_400_before_decode(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    owner = await do_setup(client)
    bomb = _decompression_bomb_png()
    assert len(bomb) < 200

    resp = await _upload(client, owner["token"], bomb)
    assert resp.status_code == 400, resp.text
    assert resp.json()["type"] == "/problems/invalid-image"

    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 is None


# --- write authz (owner/admin only) ----------------------------------------------


async def test_upload_and_clear_are_owner_admin_only(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Member and guest are 403'd on BOTH verbs; no bearer is a 401."""
    owner = await do_setup(client)

    assert (await client.post(UPLOAD_URL, content=b"x")).status_code == 401
    assert (await client.delete(UPLOAD_URL)).status_code == 401

    for role in ("member", "guest"):
        who = await _seed_role(client, owner["token"], role)
        up = await _upload(client, who["token"], _png_bytes(32, 32))
        assert up.status_code == 403, role
        rm = await client.delete(UPLOAD_URL, headers=auth_header(who["token"]))
        assert rm.status_code == 403, role

    # Nothing was stored by the rejected uploads.
    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 is None


def _forged_body(
    *, auth: dict[str, Any], home_stream_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": home_stream_id,
        "type": "workspace.updated",
        "type_version": 1,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload,
    }


async def test_forged_workspace_updated_with_icon_is_rejected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A client uploading ``workspace.updated`` (icon ref) → ``permission_denied``.

    Without the SERVER_AUTHORED guard a member could set the workspace icon in
    every client's fold. Nothing may be appended and the row must not change.
    """
    owner = await do_setup(client)
    member = await _seed_role(client, owner["token"], "member")
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    forged = _forged_body(
        auth=member,
        home_stream_id=meta_stream_id,
        payload={"icon_sha256": "a" * 64},
    )
    resp = await post_batch(client, member["token"], [wire_item(forged)])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] == []
    assert body["rejected"][0]["code"] == "permission_denied"

    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before)
    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.icon_sha256 is None


# --- serve authz (the read surface) ----------------------------------------------


async def test_any_member_can_fetch_the_icon(
    client: AsyncClient, db_session: AsyncSession, settings: Settings
) -> None:
    """Owner, member AND guest fetch the workspace icon: 200, the re-encoded WEBP,
    inline image/webp + nosniff + a content-addressed ETag; If-None-Match → 304."""
    owner = await do_setup(client)
    member = await _seed_role(client, owner["token"], "member")
    guest = await _seed_role(client, owner["token"], "guest", email="g@example.com")
    up = await _upload(client, owner["token"], _png_bytes(500, 200))
    sha = up.json()["icon_sha256"]
    stored = await _blob_store(settings).get_bytes(sha)

    for caller in (owner, member, guest):
        resp = await _serve(client, caller["token"])
        assert resp.status_code == 200, (caller["user_id"], resp.text)
        assert resp.content == stored
        assert resp.headers["content-type"] == "image/webp"
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["etag"] == f'"{sha}"'
        assert "private" in resp.headers["cache-control"]

    revalidated = await client.get(
        SERVE_URL, headers={**auth_header(member["token"]), "If-None-Match": f'"{sha}"'}
    )
    assert revalidated.status_code == 304
    assert revalidated.content == b""


async def test_serve_uniform_404_and_401(client: AsyncClient, db_session: AsyncSession) -> None:
    """No icon set → uniform 404; unauthenticated → 401."""
    owner = await do_setup(client)
    member = await _seed_role(client, owner["token"], "member")

    no_icon = await _serve(client, member["token"])
    assert no_icon.status_code == 404
    assert (await client.get(SERVE_URL)).status_code == 401


async def test_serve_is_scoped_to_the_callers_own_workspace(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A caller only ever reads THEIR OWN workspace's icon — there is no parameter
    to name another workspace, so B's caller gets B's 404, never A's icon."""
    owner = await do_setup(client)
    assert (await _upload(client, owner["token"], _png_bytes(64, 64))).status_code == 200
    other = await _seed_workspace_b(db_session)

    # Workspace B has no icon → its member gets a uniform 404, never A's bytes.
    resp = await _serve(client, other["token"])
    assert resp.status_code == 404


async def test_serve_route_is_not_a_blob_oracle(
    client: AsyncClient, db_session: AsyncSession, settings: Settings
) -> None:
    """Knowing a PRIVATE file attachment's sha256 gains nothing: the icon serve
    route takes NO parameter (no sha, no id), and there is no by-hash route."""
    owner = await do_setup(client)
    member = await _seed_role(client, owner["token"], "member")
    private = await bootstrap_channel(
        client, db_session, owner, visibility="private", name="secret"
    )
    secret = b"private attachment bytes the member must never read" * 4
    secret_sha = _sha(secret)
    init = await client.post(
        "/v1/files/initiate",
        json={
            "sha256": secret_sha,
            "name": "secret.bin",
            "mime_type": "application/octet-stream",
            "size_bytes": len(secret),
            "stream_id": private,
        },
        headers=auth_header(owner["token"]),
    )
    assert init.status_code == 200, init.text
    file_id = init.json()["file_id"]
    put = await client.put(
        f"/v1/files/{file_id}/blob", content=secret, headers=auth_header(owner["token"])
    )
    assert put.status_code == 200, put.text
    assert await _blob_store(settings).exists(secret_sha)

    # The attachment sha is unreachable through every icon-shaped path.
    for url in (
        f"/v1/workspace/icon/{secret_sha}",  # no by-hash route exists
        f"/v1/workspace/icon?sha256={secret_sha}",  # a query param is ignored
    ):
        resp = await client.get(url, headers=auth_header(member["token"]))
        assert resp.status_code in (404, 405), (url, resp.status_code)
        assert secret not in resp.content

    # The real serve route yields the workspace's OWN icon re-encode only.
    up = await _upload(client, owner["token"], _png_bytes(64, 64))
    served = await _serve(client, member["token"])
    assert served.status_code == 200
    assert _sha(served.content) == up.json()["icon_sha256"] != secret_sha
    assert served.content != secret
