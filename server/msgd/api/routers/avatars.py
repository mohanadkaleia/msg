"""Profile pictures (ENG-152): avatar upload/clear + the workspace-readable serve.

Three endpoints, two trust levels:

``POST /v1/me/avatar`` / ``DELETE /v1/me/avatar``
    STRUCTURALLY SELF-ONLY, like ``PATCH /v1/me`` (no ``user_id`` anywhere — the
    target is always ``ctx.user_id``), and gated the same way: ``events:write``
    (both emit a ``user.profile_updated`` meta event) plus the file WRITE rate
    limit (both are disk-touching writes). The upload pipeline treats the body
    as HOSTILE end to end:

    1. **Byte cap BEFORE decode.** The body is streamed with a cap-and-abort
       read (``settings.avatar_max_size_bytes``, 5 MiB) — an over-cap or lying
       body is aborted mid-stream (413), never buffered past the cap.
    2. **Cheap content-type hint.** A non-``image/*`` declared type is rejected
       (400) before any decode — a hint gate only; the REAL image check is next.
    3. **Safe decode + normalize** (:func:`msgd.blobs.thumbnails.render_avatar`,
       the ENG-118 untrusted-decode machinery): magic-byte identification by
       Pillow (the extension/mime is never trusted), the explicit PRE-DECODE
       decompression-bomb bound (``thumbnail_max_source_pixels`` — a crafted
       100000×100000 header is rejected before any pixel buffer exists), and a
       center-crop + resize to a fixed square. Runs on the DEDICATED bounded
       thumbnail executor, never the event loop or its default pool. Any
       undecodable input → uniform 400 ``/problems/invalid-image``.
    4. **Store ONLY the re-encode.** The blob written (and content-addressed
       into ``users.avatar_sha256``) is the freshly-encoded WEBP of the decoded
       raster — the RAW upload is DISCARDED. Re-encoding strips EXIF/metadata
       (GPS, device serials — a privacy leak on a workspace-public image) and
       cannot carry the original container's exploit payload; there is no code
       path by which attacker-controlled bytes reach the serve endpoint below.
    5. **One meta event.** The row update + ONE self-authored
       ``user.profile_updated`` (carrying the resulting profile INCLUDING
       ``avatar_sha256``) commit together — the client directory fold is how
       every member's UI learns the new avatar. Clearing sets NULL + the same
       event shape (``avatar_sha256: null``).

``GET /v1/users/{user_id}/avatar`` — THE NEW READ-AUTHZ SURFACE (review focus)
    Avatars are WORKSPACE-PUBLIC: any authenticated principal of the SAME
    workspace may fetch any member's avatar (everyone sees everyone's face in
    messages/sidebar — deliberately NOT stream-gated, unlike file downloads).
    What keeps this narrow:

    * **Resolution is ``user_id → users.avatar_sha256``, never by hash.** There
      is NO route parameter that accepts a sha256, so the endpoint can only ever
      serve a blob some same-workspace user row currently names as their avatar
      — and every such blob is a server-minted re-encode (step 4 above). A
      caller cannot fetch an arbitrary blob, a file attachment, or a
      private-channel upload through this route by knowing/guessing its digest:
      those digests simply never appear in ``avatar_sha256`` (the column is
      written ONLY with the re-encode's digest by the POST above / restored
      verbatim from a bundle's users.json). This is the same
      "download by id, never by hash" discipline as ``/v1/files`` (D8).
    * **Uniform 404** (§3.6.2): unknown user, cross-workspace user, and
      no-avatar-set all return the identical ``/problems/not-found`` — no
      existence oracle for users or avatars. Unauthenticated → the standard 401.
    * **Serving inline ``image/webp`` is safe HERE** for exactly the reason the
      thumbnail route documents: the bytes are OURS (decoded + re-encoded
      server-side), not the uploader's. ``nosniff`` is kept as defense in depth.
    * **Caching:** the payload is content-addressed, so the response carries a
      strong ``ETag`` (the digest) and honors ``If-None-Match`` with a 304;
      ``Cache-Control: private, max-age`` keeps revalidation cheap without a
      shared-cache leak. The URL is keyed by ``user_id`` (which MUTATES when the
      avatar changes), so it must NOT be ``immutable`` — the ETag is what makes
      the cache correct across avatar changes.
"""

from __future__ import annotations

import asyncio
import functools
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import (
    AppSettings,
    CurrentAuth,
    file_download_rate_limit,
    file_rate_limit,
    get_blob_store,
    get_thumbnail_executor,
    require_scope,
)
from msgd.api.routers.me import emit_profile_updated, me_response
from msgd.api.schemas.me import MeResponse
from msgd.blobs.store import BlobStore
from msgd.blobs.thumbnails import render_avatar
from msgd.db.engine import get_session
from msgd.db.models import User

__all__ = ["BodyTooLarge", "bytes_to_async_iter", "read_capped", "router"]

router = APIRouter(prefix="/v1", tags=["avatars"])

DbSession = Annotated[AsyncSession, Depends(get_session)]
Blobs = Annotated[BlobStore, Depends(get_blob_store)]
ThumbnailExecutor = Annotated[ThreadPoolExecutor, Depends(get_thumbnail_executor)]


class BodyTooLarge(Exception):
    """Sentinel: the streamed image body crossed the byte cap.

    Raised from inside :func:`read_capped` so the handler can translate it to a
    ``413 /problems/file-too-large`` without ever holding more than the cap in
    memory. Shared with the workspace-icon upload (ENG-152), which runs the
    identical capped-read step.
    """


async def read_capped(source: AsyncIterator[bytes], max_bytes: int) -> bytes:
    """Buffer ``source`` fully, aborting the moment the running total crosses the cap.

    The avatar pipeline NEEDS the whole body in memory for the decode (unlike the
    streaming file PUT), so the cap — not the client's honesty — is what bounds
    that buffer: a chunked/lying body is cut off at ``max_bytes`` (+ one chunk),
    long before anything is decoded or stored. Raises :class:`BodyTooLarge` on an
    over-cap body. Shared with the workspace-icon upload (ENG-152).
    """
    chunks: list[bytes] = []
    total = 0
    async for chunk in source:
        total += len(chunk)
        if total > max_bytes:
            raise BodyTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


async def bytes_to_async_iter(data: bytes) -> AsyncIterator[bytes]:
    """Yield ``data`` once — the adapter feeding the re-encoded WEBP into the store."""
    yield data


@router.post(
    "/me/avatar",
    response_model=MeResponse,
    # Same verb gate as PATCH /v1/me (this is an event-log write) + the file
    # WRITE rate limit (this is a disk-touching, decode-triggering write).
    dependencies=[Depends(require_scope("events:write")), Depends(file_rate_limit)],
)
async def upload_avatar(
    request: Request,
    ctx: CurrentAuth,
    db: DbSession,
    settings: AppSettings,
    blobs: Blobs,
    thumbnail_executor: ThumbnailExecutor,
) -> MeResponse:
    """Set the CALLER's avatar from the raw image body; return the updated profile.

    The full hostile-input pipeline (module docstring): cap-and-abort read →
    content-type hint gate → bounded decode + re-encode to a normalized square
    WEBP (EXIF stripped, bomb-guarded, on the dedicated executor) → store the
    RE-ENCODED bytes only → row update + ONE ``user.profile_updated`` in one
    transaction.
    """
    # Cheap hint gate BEFORE reading the body: a declared non-image type is an
    # honest client error. NOT a security control — render_avatar's decode is.
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("image/"):
        raise problems.invalid_image()

    # Fast-reject an honest oversized Content-Length; the streaming cap below is
    # authoritative for chunked/lying bodies.
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > settings.avatar_max_size_bytes:
                raise problems.file_too_large()
        except ValueError:
            pass  # unparseable — the streaming cap decides

    try:
        raw = await read_capped(request.stream(), settings.avatar_max_size_bytes)
    except BodyTooLarge:
        raise problems.file_too_large() from None

    # Bounded, contained decode of UNTRUSTED bytes + re-encode (ENG-118 machinery,
    # dedicated executor). None covers non-image / truncated / bomb → uniform 400.
    loop = asyncio.get_running_loop()
    avatar = await loop.run_in_executor(
        thumbnail_executor,
        functools.partial(
            render_avatar,
            raw,
            px=settings.avatar_px,
            max_source_pixels=settings.thumbnail_max_source_pixels,
        ),
    )
    if avatar is None:
        raise problems.invalid_image()

    # Store ONLY the re-encoded bytes; the raw upload is never written anywhere.
    sha256 = await blobs.put(bytes_to_async_iter(avatar))

    # Row lock + update + event + commit — the PATCH /v1/me transaction shape.
    user = await db.scalar(select(User).where(User.user_id == ctx.user_id).with_for_update())
    assert user is not None  # require_auth just authenticated this user id
    user.avatar_sha256 = sha256
    await emit_profile_updated(db, ctx=ctx, user=user)
    await db.commit()
    return me_response(user)


@router.delete(
    "/me/avatar",
    response_model=MeResponse,
    dependencies=[Depends(require_scope("events:write")), Depends(file_rate_limit)],
)
async def clear_avatar(ctx: CurrentAuth, db: DbSession) -> MeResponse:
    """Clear the CALLER's avatar (``avatar_sha256 = NULL``) + emit the profile event.

    Idempotent from the client's perspective (clearing an already-absent avatar
    succeeds); like ``PATCH /v1/me`` it always appends one event carrying the
    resulting state, so every directory fold converges on ``avatar_sha256: null``.
    The blob itself is NOT deleted — content-addressed blobs are shared (another
    user may have the identical avatar) and the MVP has no GC (D8), exactly like
    file blobs.
    """
    user = await db.scalar(select(User).where(User.user_id == ctx.user_id).with_for_update())
    assert user is not None  # require_auth just authenticated this user id
    user.avatar_sha256 = None
    await emit_profile_updated(db, ctx=ctx, user=user)
    await db.commit()
    return me_response(user)


@router.get(
    "/users/{user_id}/avatar",
    dependencies=[Depends(file_download_rate_limit)],
)
async def get_user_avatar(
    user_id: str,
    request: Request,
    ctx: CurrentAuth,
    db: DbSession,
    blobs: Blobs,
) -> Response:
    """Serve ``user_id``'s avatar bytes to any same-workspace authenticated caller.

    THE authorization decision (module docstring, review focus): resolve
    ``user_id → users.avatar_sha256`` WORKSPACE-SCOPED and serve exactly that
    blob — never a caller-supplied hash, so this route cannot read any blob that
    is not currently some same-workspace user's server-re-encoded avatar. An
    unknown user, a cross-workspace user, and a user with no avatar are all the
    IDENTICAL uniform 404 (no existence oracle). Deactivated members' avatars
    still serve — their historical messages still render for everyone.
    """
    avatar_sha256 = await db.scalar(
        select(User.avatar_sha256).where(
            User.user_id == user_id,
            User.workspace_id == ctx.workspace_id,
        )
    )
    if avatar_sha256 is None:
        raise problems.not_found("no such avatar")

    # Content-addressed payload → strong ETag revalidation. The URL is keyed by
    # user_id (mutable ref), so no `immutable`; the ETag keeps caches honest.
    etag = f'"{avatar_sha256}"'
    cache_headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)

    # Inline image/webp is safe: these bytes are OUR re-encode (never the raw
    # upload) — the exact reasoning documented on the thumbnail route.
    return StreamingResponse(
        blobs.get(avatar_sha256),
        media_type="image/webp",
        headers={**cache_headers, "Content-Disposition": "inline"},
    )
