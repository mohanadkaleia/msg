"""Content-addressed blob storage (ENG-115, TDD §6, decision D8).

Attachments are stored as content-addressed blobs behind a small
:class:`BlobStore` interface so an S3/MinIO backend is a later drop-in
(D8: "local disk ... behind a ``BlobStore`` interface so S3/MinIO is a config
change later"). This module ships the interface plus the local-disk backend.
The HTTP surface (``/v1/files/...``) is ENG-116 and lives outside this module.

Async, streaming interface (sync-vs-async decision)
---------------------------------------------------
The interface is **async and streaming**. Blobs are large (attachments), so the
whole point is never to hold one in memory:

* :meth:`BlobStore.put` consumes an ``AsyncIterator[bytes]`` — the exact shape of
  Starlette's ``request.stream()`` that ENG-116 will hand it — hashing each chunk
  as it arrives and writing it straight to disk.
* :meth:`BlobStore.get` yields the blob back in chunks so the HTTP layer can
  stream a response without loading the file.

The blocking filesystem syscalls (open/write/fsync/rename/stat/unlink) are
offloaded with :func:`asyncio.to_thread`, matching the codebase's existing
offload discipline for blocking work (:mod:`msgd.auth.passwords` does the same
for argon2). The event loop is never blocked on disk I/O. Async also happens to
be the right shape for the future S3 backend, whose calls are network I/O — so
the interface leaks no local-disk assumptions.

Write durability & atomicity (temp -> fsync -> atomic rename)
-------------------------------------------------------------
A blob file at its content-addressed path is a *promise* that the file's bytes
hash to the name it is stored under. To keep that promise across crashes and
concurrent writers, :meth:`LocalDiskBlobStore.put` never writes the final path
directly. It:

1. streams into a fresh temp file under ``<root>/tmp/`` (same filesystem as the
   final path, so the rename in step 4 is atomic), hashing as it writes;
2. ``flush`` + ``fsync`` the temp file so its bytes are durable on disk;
3. verifies the digest (see verify mode) — a mismatch discards the temp file and
   nothing is ever promoted;
4. ``os.replace`` (atomic rename) the temp file onto the final
   ``<root>/<ab>/<sha256>`` path, then ``fsync`` the containing directory so the
   rename entry itself is durable.

Consequences:

* A partial or interrupted write only ever leaves a temp file — never a file at a
  content-addressed path — so a reader can never observe a truncated blob as a
  valid one.
* Two callers writing the *same* bytes each stream to their own unique temp file
  and then ``os.replace`` onto the same final path. ``os.replace`` is atomic, the
  bytes are identical, so last-writer-wins is a no-op: both callers succeed and
  converge on one file. The ``exists`` fast-path (dedup) is only an optimization;
  the atomic rename is the actual safety guarantee, so there is no
  time-of-check/time-of-use hole.

No garbage collection (D8): ``delete`` exists for callers/tests, but the MVP never
sweeps unreferenced blobs. Post-MVP GC is designed in the TDD, not built here.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from pathlib import Path

__all__ = [
    "BlobHashMismatchError",
    "BlobNotFoundError",
    "BlobStore",
    "BlobStoreError",
    "LocalDiskBlobStore",
]

# Blob digests are bare lowercase-hex SHA-256 (64 chars). Unlike ``event_hash``
# (``msgd.core.hashing``) there is no ``sha256:`` prefix: this is the hash of raw
# file *content*, it names a path, and §6 has the client compute ``sha256(file)``
# as bare hex. Every caller-supplied digest is validated against this pattern
# before it is used to build a path — a hard guard against ``..``/absolute-path
# traversal via a crafted "sha256".
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# Read/stream chunk size. 1 MiB balances syscall count against memory for the
# few-MB attachments this store targets.
_CHUNK_SIZE = 1 << 20


class BlobStoreError(Exception):
    """Base class for blob-store failures."""


class BlobNotFoundError(BlobStoreError):
    """Raised when a blob for the requested sha256 does not exist."""

    def __init__(self, sha256: str) -> None:
        super().__init__(f"blob not found: {sha256}")
        self.sha256 = sha256


class BlobHashMismatchError(BlobStoreError):
    """Raised by the verify path when streamed bytes do not hash to the claim.

    The temp file is discarded and never promoted, so a mismatch stores nothing.
    """

    def __init__(self, expected: str, actual: str) -> None:
        super().__init__(f"blob hash mismatch: expected {expected}, got {actual}")
        self.expected = expected
        self.actual = actual


def _validate_sha256(sha256: str) -> str:
    """Return ``sha256`` if it is 64 lowercase hex chars, else raise ``ValueError``.

    Guards every path-building operation against traversal: a "sha256" that is not
    strictly hex can never contain ``/`` or ``..`` and so can never escape the
    blob root.
    """
    if not _SHA256_RE.fullmatch(sha256):
        raise ValueError(f"not a valid sha256 hex digest: {sha256!r}")
    return sha256


class BlobStore(ABC):
    """Content-addressed blob storage interface (D8).

    Backend-agnostic: the local-disk backend is :class:`LocalDiskBlobStore`; an
    S3/MinIO backend is a later drop-in. Digests are bare lowercase-hex SHA-256.
    """

    @abstractmethod
    async def put(self, data_stream: AsyncIterator[bytes]) -> str:
        """Stream ``data_stream`` into storage; return its computed sha256 (hex).

        The digest is computed *while* streaming. If a blob with that digest
        already exists this is a no-op returning the existing sha (dedup).
        """
        raise NotImplementedError

    @abstractmethod
    async def put_verified(self, data_stream: AsyncIterator[bytes], expected_sha256: str) -> str:
        """Like :meth:`put`, but reject if the streamed bytes do not hash to the claim.

        ENG-116 uses this to reject a client whose declared sha256 does not match
        the bytes it actually uploaded.

        Returns:
            The verified sha256 (equal to ``expected_sha256``).

        Raises:
            BlobHashMismatchError: streamed bytes hashed to something else; nothing
                is stored (the temp file is discarded, never promoted).
            ValueError: ``expected_sha256`` is not a valid hex digest.
        """
        raise NotImplementedError

    @abstractmethod
    def get(self, sha256: str) -> AsyncIterator[bytes]:
        """Return an async iterator over the blob's bytes, in chunks.

        Raises:
            BlobNotFoundError: no blob for ``sha256``.
            ValueError: ``sha256`` is not a valid hex digest.
        """
        raise NotImplementedError

    @abstractmethod
    async def exists(self, sha256: str) -> bool:
        """Return whether a blob for ``sha256`` exists.

        Raises:
            ValueError: ``sha256`` is not a valid hex digest.
        """
        raise NotImplementedError

    @abstractmethod
    async def delete(self, sha256: str) -> None:
        """Delete the blob for ``sha256`` if present; a no-op if it is absent.

        There is no GC in the MVP (D8); this is for explicit callers and tests.

        Raises:
            ValueError: ``sha256`` is not a valid hex digest.
        """
        raise NotImplementedError

    @abstractmethod
    async def size(self, sha256: str) -> int:
        """Return the blob's size in bytes.

        Raises:
            BlobNotFoundError: no blob for ``sha256``.
            ValueError: ``sha256`` is not a valid hex digest.
        """
        raise NotImplementedError

    async def get_bytes(self, sha256: str) -> bytes:
        """Read a whole blob into memory. Convenience for small blobs and tests.

        Prefer :meth:`get` for anything large — this defeats streaming by design.
        """
        chunks = [chunk async for chunk in self.get(sha256)]
        return b"".join(chunks)


class LocalDiskBlobStore(BlobStore):
    """Local-disk :class:`BlobStore` rooted at a directory (D8, §6).

    Layout is content-addressed with a two-hex-char fan-out so no single
    directory holds every blob::

        <root>/<ab>/<sha256>      # ab = first two hex chars of the digest
        <root>/tmp/<random>       # in-flight writes, promoted by atomic rename

    ``root`` is ``settings.data_dir / "blobs"`` in production (the compose file
    bind-mounts it and the image pre-creates it owned by the runtime user); tests
    pass a ``tmp_path``.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._tmp_dir = root / "tmp"

    def _path_for(self, sha256: str) -> Path:
        """Content-addressed path for a *validated* digest (``<root>/<ab>/<sha>``)."""
        return self._root / sha256[:2] / sha256

    async def put(self, data_stream: AsyncIterator[bytes]) -> str:
        return await self._write(data_stream, expected_sha256=None)

    async def put_verified(self, data_stream: AsyncIterator[bytes], expected_sha256: str) -> str:
        _validate_sha256(expected_sha256)
        return await self._write(data_stream, expected_sha256=expected_sha256)

    async def _write(self, data_stream: AsyncIterator[bytes], expected_sha256: str | None) -> str:
        """Stream to a temp file, fsync, verify, atomically promote. Returns the sha."""
        await asyncio.to_thread(self._tmp_dir.mkdir, parents=True, exist_ok=True)
        fd, tmp_name = await asyncio.to_thread(tempfile.mkstemp, dir=self._tmp_dir, suffix=".part")
        tmp_path = Path(tmp_name)
        hasher = hashlib.sha256()
        promoted = False
        try:
            with os.fdopen(fd, "wb") as tmp_file:
                async for chunk in data_stream:
                    hasher.update(chunk)
                    await asyncio.to_thread(tmp_file.write, chunk)
                # Durability: flush Python + libc buffers, then fsync the fd so the
                # bytes are on the platter before the rename can expose them.
                await asyncio.to_thread(tmp_file.flush)
                await asyncio.to_thread(os.fsync, tmp_file.fileno())

            sha256 = hasher.hexdigest()
            if expected_sha256 is not None and sha256 != expected_sha256:
                raise BlobHashMismatchError(expected_sha256, sha256)

            final_path = self._path_for(sha256)
            # Dedup fast-path: if the content already exists, skip the rename. This
            # is only an optimization — the atomic rename below is the real safety
            # guarantee, so a concurrent writer racing past this check is harmless.
            if await asyncio.to_thread(final_path.exists):
                return sha256

            await asyncio.to_thread(final_path.parent.mkdir, parents=True, exist_ok=True)
            # Atomic rename onto the final path: a reader sees either no file or the
            # complete, verified blob — never a partial write. Same filesystem
            # (tmp is under root), so os.replace is atomic on POSIX.
            await asyncio.to_thread(os.replace, tmp_path, final_path)
            promoted = True
            await asyncio.to_thread(_fsync_dir, final_path.parent)
            return sha256
        finally:
            # On any early exit (hash mismatch, stream error) the temp file must not
            # linger. If it was promoted, the path no longer exists — ignore.
            if not promoted:
                await asyncio.to_thread(_unlink_quietly, tmp_path)

    async def get(self, sha256: str) -> AsyncIterator[bytes]:
        _validate_sha256(sha256)
        path = self._path_for(sha256)
        try:
            handle = await asyncio.to_thread(open, path, "rb")
        except FileNotFoundError:
            raise BlobNotFoundError(sha256) from None
        try:
            while True:
                chunk = await asyncio.to_thread(handle.read, _CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
        finally:
            await asyncio.to_thread(handle.close)

    async def exists(self, sha256: str) -> bool:
        _validate_sha256(sha256)
        return await asyncio.to_thread(self._path_for(sha256).exists)

    async def delete(self, sha256: str) -> None:
        _validate_sha256(sha256)
        await asyncio.to_thread(_unlink_quietly, self._path_for(sha256))

    async def size(self, sha256: str) -> int:
        _validate_sha256(sha256)
        try:
            return await asyncio.to_thread(lambda: self._path_for(sha256).stat().st_size)
        except FileNotFoundError:
            raise BlobNotFoundError(sha256) from None


def _fsync_dir(directory: Path) -> None:
    """fsync a directory so a rename/create entry within it is durable.

    Best-effort: some platforms disallow opening a directory for fsync; a failure
    here does not invalidate the (already fsynced) blob file, so it is swallowed.
    """
    try:
        dir_fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)


def _unlink_quietly(path: Path) -> None:
    """Unlink ``path`` if it exists; a missing file is not an error (idempotent)."""
    try:
        path.unlink()
    except FileNotFoundError:
        pass
