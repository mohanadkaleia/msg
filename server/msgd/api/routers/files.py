"""``/v1/files/...`` — the Files API authz spine (ENG-116, TDD §6, decision D8).

Three endpoints wire the already-merged content-addressed :class:`BlobStore`
(ENG-115) to HTTP under a strict authorization discipline. This is the M3.5
security-critical surface, so every gate here is deliberate and documented.

``POST /v1/files/initiate``
    Reserve a file row for a stream, quota-checked, and tell the client whether it
    must still upload the bytes. Order of checks is SECURITY-CRITICAL and enforced
    exactly: **authz → per-file cap → per-workspace quota (row-locked) → dedup**.

``PUT /v1/files/{file_id}/blob``
    Stream the raw bytes into the store, **server-recomputing the sha256** and
    rejecting any mismatch (the client's claimed hash is never trusted), aborting
    the instant the actual bytes cross the per-file cap, then flip the row present.

``GET /v1/files/{file_id}``
    Authorize by ``file_id → stream_id → membership`` (NEVER by hash, D8) and
    stream the bytes back as a NON-inline ``application/octet-stream`` attachment
    with a sanitized filename, so a stored ``.html``/``.svg``/``.js`` blob can
    never be rendered inline by the browser (stored-XSS neutralized).

Invariants this module upholds (each mapped to code below):

* **404-not-403 uniformity (§3.6.2):** an unknown ``file_id``/``stream_id``, a
  forbidden stream, a null ``stream_id``, and a not-present file all return the
  IDENTICAL ``404 /problems/not-found`` — no existence oracle anywhere.
* **Download by id, never by hash (D8):** there is no route that accepts a
  ``sha256``. A caller can only ever fetch bytes through a ``file_id`` it is
  authorized for; content-addressing is a storage detail, not an access key.
* **No cross-workspace existence oracle:** ``upload_needed`` and every read gate
  are scoped to the caller's workspace. A workspace initiating a ``sha256`` that a
  DIFFERENT workspace already stored is told ``upload_needed: true`` and cannot
  reach the other workspace's bytes. (Global storage-layer dedup still happens
  transparently when the PUT lands on already-present bytes — safe and invisible.)
* **Authz precedes dedup + quota:** the stream write==read gate runs FIRST, so a
  caller learns nothing (not even "this sha exists here") about a stream it cannot
  read.
"""

from __future__ import annotations

import urllib.parse
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import AppSettings, CurrentAuth, get_blob_store
from msgd.api.schemas.files import (
    FileBlobResponse,
    FileInitiateRequest,
    FileInitiateResponse,
)
from msgd.blobs.store import BlobHashMismatchError, BlobStore
from msgd.core import ids
from msgd.db.engine import get_session
from msgd.db.models import File, Workspace
from msgd.events.permissions import can_read, can_write

__all__ = ["router"]

router = APIRouter(prefix="/v1", tags=["files"])

DbSession = Annotated[AsyncSession, Depends(get_session)]
Blobs = Annotated[BlobStore, Depends(get_blob_store)]


class _StreamTooLarge(Exception):
    """Internal sentinel: the streamed body crossed the per-file cap mid-upload.

    Raised from inside the async byte stream handed to ``BlobStore.put_verified``
    so the store's temp file is discarded (its ``finally`` cleans up, promoting
    nothing) and the handler can translate it to a ``413 /problems/file-too-large``.
    Never escapes this module.
    """


async def _capped_stream(source: AsyncIterator[bytes], max_bytes: int) -> AsyncIterator[bytes]:
    """Re-yield ``source`` chunks, raising :class:`_StreamTooLarge` past ``max_bytes``.

    The authoritative disk guard for the PUT (§6): a client that declares a small
    ``size_bytes`` but streams gigabytes is aborted the moment the RUNNING TOTAL
    crosses the cap — the whole body is never buffered in memory, and because this
    raises INTO ``BlobStore.put_verified``'s consuming ``async for``, the store's
    temp file is discarded and nothing is ever promoted to a content-addressed path.
    """
    total = 0
    async for chunk in source:
        total += len(chunk)
        if total > max_bytes:
            raise _StreamTooLarge()
        yield chunk


def _content_disposition(name: str) -> str:
    """Build a safe ``Content-Disposition: attachment`` value for an arbitrary ``name``.

    The stored ``name`` is arbitrary UTF-8 (quotes, backslashes, CR/LF, control
    chars all possible), so it is NEVER interpolated raw into the header — that
    would be a header-injection / response-splitting hole. Two forms are emitted
    per RFC 6266:

    * ``filename="..."`` — an ASCII-only fallback with every control char and the
      quote/backslash metacharacters stripped (so the quoted-string cannot be
      broken out of and no CR/LF can split the response);
    * ``filename*=UTF-8''...`` — the FULL name, RFC 5987 percent-encoded, so a
      well-behaved client still recovers the original bytes. ``urllib.parse.quote``
      with an empty ``safe`` set percent-encodes every non-unreserved byte,
      including CR/LF/control chars, so this form is injection-proof too.

    ``attachment`` (never ``inline``) forces a download rather than in-browser
    rendering — belt-and-suspenders with the ``application/octet-stream`` type and
    ``X-Content-Type-Options: nosniff`` set by the caller.
    """
    ascii_fallback = "".join(ch for ch in name if 32 <= ord(ch) < 127 and ch not in '"\\')
    if not ascii_fallback:
        ascii_fallback = "download"
    encoded = urllib.parse.quote(name, safe="")
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}"


@router.post("/files/initiate", response_model=FileInitiateResponse)
async def initiate_file(
    req: FileInitiateRequest,
    ctx: CurrentAuth,
    db: DbSession,
    settings: AppSettings,
) -> FileInitiateResponse:
    """Reserve a file row for ``req.stream_id`` and report whether bytes are needed.

    The four checks run in this exact, security-critical order:

    1. **Authz first.** ``file.uploaded`` write access == read access to the
       stream (§2.4). A caller that cannot read the stream gets the uniform
       ``404 /problems/not-found`` — identical to an unknown stream, so stream
       existence is never disclosed (§3.6.2) and the later dedup answer can never
       leak across an access boundary.
    2. **Per-file cap.** ``size_bytes`` over ``settings.file_max_size_bytes`` is a
       ``413`` — checked only AFTER authz so it is not a stream-existence oracle.
    3. **Per-workspace quota, race-free.** The caller's ``workspaces`` row is
       ``SELECT ... FOR UPDATE``-locked so concurrent initiates serialize; usage is
       the SUM over the workspace's DISTINCT ``sha256`` values (dedup: a ``sha256``
       already reserved here adds ZERO new bytes and is always allowed). Holding the
       lock across read-decide-insert means two racing initiates cannot both slip
       past the cap.
    4. **Dedup, workspace-scoped, AFTER authz + quota.** If this workspace already
       has a PRESENT row for this ``sha256``, the new row is created present and
       ``upload_needed`` is ``False``; otherwise it is created not-present and
       ``upload_needed`` is ``True``. The decision never consults the global
       ``BlobStore.exists`` — that would reveal another workspace holds those bytes.
    """
    # 1. Authz FIRST — write(file.uploaded) == read(stream). Uniform 404.
    if not await can_write(db, ctx=ctx, stream_id=req.stream_id, event_type="file.uploaded"):
        raise problems.not_found("no such stream")

    # 2. Per-file size cap (declared). The streaming PUT re-checks the ACTUAL bytes.
    if req.size_bytes > settings.file_max_size_bytes:
        raise problems.file_too_large()

    # 3. Per-workspace quota under a row lock. FOR UPDATE serializes concurrent
    #    initiates so the read-decide-insert below is atomic per workspace.
    workspace = (
        await db.execute(
            select(Workspace).where(Workspace.workspace_id == ctx.workspace_id).with_for_update()
        )
    ).scalar_one()

    # Workspace-scoped dedup facts (both indexed by ix_files_workspace_id_sha256):
    #   * present_exists → the bytes are already downloadable in THIS workspace, so
    #     the new row is born present (no upload needed);
    #   * any_exists → this sha is already reserved here (present OR pending), so
    #     adding another row for it consumes ZERO additional quota.
    present_exists = await db.scalar(
        select(literal(1))
        .select_from(File)
        .where(
            File.workspace_id == ctx.workspace_id,
            File.sha256 == req.sha256,
            File.present.is_(True),
        )
        .limit(1)
    )
    any_exists = await db.scalar(
        select(literal(1))
        .select_from(File)
        .where(File.workspace_id == ctx.workspace_id, File.sha256 == req.sha256)
        .limit(1)
    )

    # Only a genuinely NEW sha adds bytes. Usage = SUM of size over DISTINCT sha in
    # the workspace; a re-used sha (present or a pending initiate) reserves nothing
    # more. Counting pending (not-yet-present) rows too is deliberately CONSERVATIVE
    # — it makes the FOR UPDATE lock actually bite (a second racing initiate sees
    # the first's just-inserted reservation) and blocks a many-pending-initiates
    # quota-bypass. See the PR body's quota-model note.
    if any_exists is None:
        distinct_by_sha = (
            select(func.max(File.size_bytes).label("sz"))
            .where(File.workspace_id == ctx.workspace_id)
            .group_by(File.sha256)
            .subquery()
        )
        usage = await db.scalar(select(func.coalesce(func.sum(distinct_by_sha.c.sz), 0)))
        current_usage = int(usage or 0)
        if current_usage + req.size_bytes > workspace.file_quota_bytes:
            raise problems.quota_exceeded()

    # 4. Insert the row. Present iff the bytes are already present in THIS workspace.
    present = present_exists is not None
    file_id = ids.new_file_id()
    db.add(
        File(
            file_id=file_id,
            workspace_id=ctx.workspace_id,
            sha256=req.sha256,
            name=req.name,
            mime_type=req.mime_type,
            size_bytes=req.size_bytes,
            uploaded_by=ctx.user_id,
            stream_id=req.stream_id,
            present=present,
        )
    )
    # Commit releases the workspace row lock immediately (tight serialization of
    # concurrent initiates, mirroring the per-event commit in events_upload).
    await db.commit()

    return FileInitiateResponse(file_id=file_id, upload_needed=not present)


@router.put("/files/{file_id}/blob", response_model=FileBlobResponse)
async def upload_blob(
    file_id: str,
    request: Request,
    ctx: CurrentAuth,
    db: DbSession,
    settings: AppSettings,
    blobs: Blobs,
) -> FileBlobResponse:
    """Stream the raw request body into the store for ``file_id`` and mark it present.

    Gates, in order:

    1. **Authz by ``file_id → stream_id → can_read``.** An unknown id, a file from
       another workspace, a null ``stream_id``, or a stream the caller cannot read
       all return the uniform ``404 /problems/not-found``.
    2. **Idempotent no-op** if the row is already present (a safe repeat PUT).
    3. **Server-recomputed hash.** The body is streamed to
       ``BlobStore.put_verified(expected_sha256=row.sha256)`` — the store hashes
       while writing and rejects on mismatch, storing NOTHING. The client's claimed
       hash is never trusted.
    4. **Per-file cap during streaming.** ``_capped_stream`` aborts the instant the
       actual bytes cross ``settings.file_max_size_bytes``; the body is never fully
       buffered, so a lying ``size_bytes`` cannot fill the disk.
    5. **Declared-size honesty.** The stored byte length must equal the ``size_bytes``
       reserved at initiate (what the quota was charged against); a mismatch is
       rejected so every present row's ``size_bytes`` is truthful.
    """
    file = await db.get(File, file_id)
    # 1. Uniform 404 for every non-authorized shape (no existence oracle). Note the
    #    workspace check is belt-and-suspenders: can_read's predicate is already
    #    workspace-scoped, but comparing explicitly keeps the gate obvious.
    if (
        file is None
        or file.workspace_id != ctx.workspace_id
        or file.stream_id is None
        or not await can_read(db, ctx=ctx, stream_id=file.stream_id)
    ):
        raise problems.not_found("no such file")

    # 2. Idempotent: a second PUT of an already-present file is a safe success.
    if file.present:
        return FileBlobResponse(file_id=file.file_id, present=True)

    # Cheap fast-reject on an honest Content-Length; the streaming guard below is
    # the authoritative cap (a chunked or lying body omits/forges this header).
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > settings.file_max_size_bytes:
                raise problems.file_too_large()
        except ValueError:
            pass  # unparseable — fall through to the streaming guard

    # 3 + 4. Stream through the cap wrapper into the verifying store. put_verified
    # recomputes the digest and raises BlobHashMismatchError (storing nothing) on a
    # mismatch; _StreamTooLarge aborts an over-cap body (store temp discarded).
    try:
        sha = await blobs.put_verified(
            _capped_stream(request.stream(), settings.file_max_size_bytes),
            expected_sha256=file.sha256,
        )
    except _StreamTooLarge:
        raise problems.file_too_large() from None
    except BlobHashMismatchError:
        raise problems.blob_hash_mismatch() from None

    # 5. Declared-size honesty: the actual bytes must be the length the quota was
    # reserved against. (The sha already matched, so the bytes are pinned; a size
    # mismatch means the initiate under/over-declared.) Reject without marking
    # present — the globally-stored blob is harmless and unreferenced.
    real_size = await blobs.size(sha)
    if real_size != file.size_bytes:
        raise problems.blob_size_mismatch()

    file.present = True
    await db.commit()
    return FileBlobResponse(file_id=file.file_id, present=True)


@router.get("/files/{file_id}")
async def download_file(
    file_id: str,
    ctx: CurrentAuth,
    db: DbSession,
    blobs: Blobs,
) -> StreamingResponse:
    """Stream ``file_id``'s bytes back as a non-inline, hardened attachment.

    Authorization is by ``file_id → stream_id → membership``, NEVER by hash (D8):
    there is deliberately no route that accepts a ``sha256``, so a caller can only
    reach bytes through an id it is authorized for. An unknown id, a file from
    another workspace, a not-present file, a null ``stream_id``, and a stream the
    caller cannot read ALL return the uniform ``404 /problems/not-found`` — the
    same body, so "exists but forbidden" is indistinguishable from "unknown".

    The response headers make a stored ``.html``/``.svg``/``.js`` blob impossible to
    render inline:

    * ``Content-Type: application/octet-stream`` — the stored ``mime_type`` is NEVER
      echoed, so the browser gets a neutral, non-renderable type;
    * ``Content-Disposition: attachment`` with a sanitized filename (see
      :func:`_content_disposition`) — a download, never inline, and no
      header-injection via a crafted ``name``;
    * ``X-Content-Type-Options: nosniff`` — the browser may not MIME-sniff its way
      back to an active type.
    """
    file = await db.get(File, file_id)
    if (
        file is None
        or not file.present
        or file.workspace_id != ctx.workspace_id
        or file.stream_id is None
        or not await can_read(db, ctx=ctx, stream_id=file.stream_id)
    ):
        raise problems.not_found("no such file")

    headers = {
        "Content-Disposition": _content_disposition(file.name),
        "X-Content-Type-Options": "nosniff",
    }
    # StreamingResponse consumes the store's async byte iterator directly, so the
    # blob is never loaded into memory. media_type is forced to octet-stream — the
    # stored mime_type is intentionally not trusted as a response Content-Type.
    return StreamingResponse(
        blobs.get(file.sha256),
        media_type="application/octet-stream",
        headers=headers,
    )
