"""Workspace icon (ENG-152): admin upload/clear + the workspace-readable serve.

The workspace sibling of the ENG-152 avatar pipeline
(:mod:`msgd.api.routers.avatars`), with the SAME hostile-input machinery but a
different trust model at each end: the WRITE is owner/admin-gated (the
``AdminAuth`` / ``require_role`` pattern) instead of self-only, and the READ is
scoped to the caller's OWN workspace icon (no id/sha parameter at all).

``POST /v1/admin/workspace/icon`` / ``DELETE /v1/admin/workspace/icon`` (review focus)
    Owner/admin only (``require_role("owner","admin")`` — member/guest 403'd
    before the body runs), plus the file WRITE rate limit (a disk-touching,
    decode-triggering write). The upload treats the body as HOSTILE end to end,
    reusing the avatar helpers verbatim:

    1. **Byte cap BEFORE decode** (:func:`msgd.api.routers.avatars.read_capped`,
       ``settings.avatar_max_size_bytes``) — an over-cap / lying body is aborted
       mid-stream (413), never buffered past the cap.
    2. **Cheap content-type hint** — a declared non-``image/*`` type is a 400
       before any decode (a hint gate only; the decode is the real check).
    3. **Safe decode + normalize** (:func:`msgd.blobs.thumbnails.render_avatar`,
       the shared ENG-118 untrusted-decode machinery on the dedicated bounded
       executor): magic-byte identification, the explicit pre-decode
       decompression-bomb bound, center-crop + resize to a fixed square. Any
       undecodable input → uniform 400.
    4. **Store ONLY the re-encode.** The blob written (and content-addressed into
       ``workspaces.icon_sha256``) is the freshly-encoded WEBP of the decoded
       raster — the RAW upload is DISCARDED, so EXIF/metadata and any container
       exploit payload never survive, and no attacker-controlled bytes reach the
       serve endpoint.
    5. **One meta event.** The row update + ONE server-authored
       ``workspace.updated`` (carrying the resulting ``icon_sha256``) commit
       together — the client ``workspace.info`` fold is how every member's rail
       learns the new icon. Clearing sets NULL + the same event shape
       (``icon_sha256: null``). ``workspace.updated`` is in
       ``SERVER_AUTHORED_EVENT_TYPES``, so a forged client upload of it is
       rejected ``permission_denied`` — these handlers + the name/description
       PATCH are its only producers.

``GET /v1/workspace/icon`` — THE READ-AUTHZ SURFACE (review focus)
    The workspace icon is WORKSPACE-READABLE: any AUTHENTICATED member of the
    caller's own workspace may fetch it. What keeps this NARROW and prevents a
    blob oracle:

    * **Resolution is ``ctx.workspace_id → workspaces.icon_sha256``, never by
      hash.** There is NO route parameter — not a workspace id, not a sha — so
      the endpoint can only ever serve the ONE blob the caller's own workspace
      row currently names as its icon, and that blob is always a server-minted
      re-encode (step 4). A caller cannot fetch an arbitrary blob, a file
      attachment, or another workspace's icon: those digests never appear in
      THIS workspace's ``icon_sha256`` column. This is the avatar route's
      "resolve entity→sha, never accept a caller sha" discipline, tightened
      further (the entity is fixed to the caller's own workspace).
    * **Uniform 404** when no icon is set (no existence oracle);
      unauthenticated → the standard 401. A cross-workspace caller simply reads
      THEIR OWN workspace's icon (or its 404) — there is no vector to name
      another workspace here.
    * **Serving inline ``image/webp`` is safe HERE** — the bytes are OURS
      (decoded + re-encoded server-side). ``nosniff`` is kept as defense in
      depth, and the content-addressed payload carries a strong ``ETag``
      (the digest) with ``If-None-Match`` → 304 and ``Cache-Control: private``.
"""

from __future__ import annotations

import asyncio
import functools
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
    require_role,
)
from msgd.api.routers.admin import workspace_info_response
from msgd.api.routers.avatars import BodyTooLarge, bytes_to_async_iter, read_capped
from msgd.api.schemas.admin import WorkspaceInfo
from msgd.auth.context import AuthContext
from msgd.blobs.store import BlobStore
from msgd.blobs.thumbnails import render_avatar
from msgd.core.payloads import build_workspace_updated_body
from msgd.core.time import now_rfc3339
from msgd.db.engine import get_session
from msgd.db.models import Stream, Workspace
from msgd.events.emit import emit_event

__all__ = ["router"]

router = APIRouter(prefix="/v1", tags=["workspace-icon"])

DbSession = Annotated[AsyncSession, Depends(get_session)]
Blobs = Annotated[BlobStore, Depends(get_blob_store)]
ThumbnailExecutor = Annotated[ThreadPoolExecutor, Depends(get_thumbnail_executor)]
AdminAuth = Annotated[AuthContext, Depends(require_role("owner", "admin"))]


async def _emit_workspace_icon_updated(
    db: AsyncSession, *, ctx: AuthContext, icon_sha256: str | None
) -> None:
    """Append ONE server-authored ``workspace.updated`` carrying the icon ref.

    Authored by the acting owner/admin on their current device, homed in the
    single workspace-meta stream (setup always creates it, seq 1). Only
    ``icon_sha256`` is carried (presence-significant: name/description are
    untouched, so they are ABSENT — a fold never misreads "unchanged" as
    "cleared"); a carried explicit ``null`` means the icon was cleared.
    """
    meta_stream_id = await db.scalar(
        select(Stream.stream_id).where(
            Stream.workspace_id == ctx.workspace_id,
            Stream.kind == "workspace-meta",
        )
    )
    assert meta_stream_id is not None  # setup always creates it
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_workspace_updated_body(
            workspace_id=ctx.workspace_id,
            stream_id=meta_stream_id,
            author_user_id=ctx.user_id,
            author_device_id=ctx.device_id,
            client_created_at=now_rfc3339(),
            icon_sha256=icon_sha256,
        ),
    )


@router.post(
    "/admin/workspace/icon",
    response_model=WorkspaceInfo,
    dependencies=[Depends(file_rate_limit)],
)
async def upload_workspace_icon(
    request: Request,
    ctx: AdminAuth,
    db: DbSession,
    settings: AppSettings,
    blobs: Blobs,
    thumbnail_executor: ThumbnailExecutor,
) -> WorkspaceInfo:
    """Set the workspace icon from the raw image body (owner/admin only, ENG-152).

    The full hostile-input pipeline (module docstring), REUSING the avatar
    machinery verbatim: cap-and-abort read → content-type hint gate → bounded
    decode + re-encode to a normalized square WEBP (EXIF stripped, bomb-guarded,
    on the dedicated executor) → store the RE-ENCODED bytes only → row update +
    ONE ``workspace.updated`` in one transaction. Returns the updated settings
    row (the same shape ``GET/PATCH /v1/admin/workspace`` echoes).
    """
    # Cheap hint gate BEFORE reading the body (an honest client error, NOT the
    # security control — render_avatar's decode is).
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

    # Bounded, contained decode of UNTRUSTED bytes + re-encode (shared ENG-118
    # machinery, dedicated executor). None covers non-image / truncated / bomb.
    loop = asyncio.get_running_loop()
    icon = await loop.run_in_executor(
        thumbnail_executor,
        functools.partial(
            render_avatar,
            raw,
            px=settings.avatar_px,
            max_source_pixels=settings.thumbnail_max_source_pixels,
        ),
    )
    if icon is None:
        raise problems.invalid_image()

    # Store ONLY the re-encoded bytes; the raw upload is never written anywhere.
    sha256 = await blobs.put(bytes_to_async_iter(icon))

    ws = await db.scalar(
        select(Workspace).where(Workspace.workspace_id == ctx.workspace_id).with_for_update()
    )
    assert ws is not None  # the session's workspace row always exists
    ws.icon_sha256 = sha256
    await _emit_workspace_icon_updated(db, ctx=ctx, icon_sha256=sha256)
    await db.commit()
    return workspace_info_response(ws)


@router.delete(
    "/admin/workspace/icon",
    response_model=WorkspaceInfo,
    dependencies=[Depends(file_rate_limit)],
)
async def clear_workspace_icon(ctx: AdminAuth, db: DbSession) -> WorkspaceInfo:
    """Clear the workspace icon (``icon_sha256 = NULL``) + emit the event (ENG-152).

    Idempotent (clearing an already-absent icon succeeds); like the PATCH it
    always appends one server-authored ``workspace.updated`` carrying
    ``icon_sha256: null``, so every ``workspace.info`` fold converges on "no
    icon". The blob itself is NOT deleted — content-addressed blobs are shared
    and the MVP has no GC (D8), exactly like avatar/file blobs.
    """
    ws = await db.scalar(
        select(Workspace).where(Workspace.workspace_id == ctx.workspace_id).with_for_update()
    )
    assert ws is not None  # the session's workspace row always exists
    ws.icon_sha256 = None
    await _emit_workspace_icon_updated(db, ctx=ctx, icon_sha256=None)
    await db.commit()
    return workspace_info_response(ws)


@router.get(
    "/workspace/icon",
    dependencies=[Depends(file_download_rate_limit)],
)
async def get_workspace_icon(
    request: Request,
    ctx: CurrentAuth,
    db: DbSession,
    blobs: Blobs,
) -> Response:
    """Serve the CALLER'S OWN workspace icon to any authenticated member (ENG-152).

    THE authorization decision (module docstring, review focus): resolve
    ``ctx.workspace_id → workspaces.icon_sha256`` and serve exactly that blob —
    there is NO route parameter (no sha, no workspace id), so this route can
    only ever serve the one blob the caller's own workspace names as its icon
    (always a server re-encode). No icon set → uniform 404 (no oracle);
    unauthenticated → 401.
    """
    icon_sha256 = await db.scalar(
        select(Workspace.icon_sha256).where(Workspace.workspace_id == ctx.workspace_id)
    )
    if icon_sha256 is None:
        raise problems.not_found("no workspace icon")

    # Content-addressed payload → strong ETag revalidation. The URL is fixed
    # (keyed by the session's workspace), so no `immutable`; the ETag keeps
    # caches honest across an icon change.
    etag = f'"{icon_sha256}"'
    cache_headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache_headers)

    # Inline image/webp is safe: these bytes are OUR re-encode (never the raw
    # upload) — the avatar/thumbnail-route reasoning.
    return StreamingResponse(
        blobs.get(icon_sha256),
        media_type="image/webp",
        headers={**cache_headers, "Content-Disposition": "inline"},
    )
