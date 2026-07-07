"""Tests for :mod:`msgd.blobs.store` — content-addressed local-disk BlobStore (ENG-115).

Teeth:

* put -> get round-trips identical bytes and the returned sha256 is the real digest;
* put_verified accepts a correct claim and, on a WRONG claim, raises and stores
  nothing (temp cleaned, ``exists()`` False, no stray files under root);
* dedup: putting the same bytes twice yields one on-disk file and the same sha;
* an interrupted/partial write leaves no file at a content-addressed path (the
  temp -> rename discipline), and a raising stream cleans its temp;
* two concurrent puts of the same bytes both succeed and converge on one file;
* exists / delete / size behave, delete is idempotent;
* a caller-supplied non-hex "sha256" is rejected (path-traversal guard);
* a few-MB stream round-trips without the store buffering the whole blob.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from msgd.blobs.store import (
    BlobHashMismatchError,
    BlobNotFoundError,
    LocalDiskBlobStore,
)


async def _aiter(data: bytes, chunk_size: int = 64 * 1024) -> AsyncIterator[bytes]:
    """Yield ``data`` in chunks as an async stream, like Starlette's request.stream()."""
    for start in range(0, len(data), chunk_size):
        yield data[start : start + chunk_size]
        await asyncio.sleep(0)  # force real interleaving points


def _store(tmp_path: Path) -> LocalDiskBlobStore:
    return LocalDiskBlobStore(tmp_path / "blobs")


def _blob_files(root: Path) -> list[Path]:
    """Every promoted blob file under root (excludes the tmp/ staging dir)."""
    tmp_dir = root / "tmp"
    return [
        p
        for p in root.rglob("*")
        if p.is_file() and tmp_dir not in p.parents and p.parent != tmp_dir
    ]


async def test_put_get_round_trip_and_sha(tmp_path: Path) -> None:
    store = _store(tmp_path)
    data = b"hello content-addressed world" * 10
    expected = hashlib.sha256(data).hexdigest()

    sha = await store.put(_aiter(data))

    assert sha == expected
    assert await store.get_bytes(sha) == data
    assert await store.exists(sha) is True
    assert await store.size(sha) == len(data)


async def test_get_streams_in_chunks(tmp_path: Path) -> None:
    store = _store(tmp_path)
    data = bytes(range(256)) * 5000  # ~1.3 MB
    sha = await store.put(_aiter(data))

    chunks = [chunk async for chunk in store.get(sha)]

    assert b"".join(chunks) == data
    assert len(chunks) > 1  # actually streamed, not one giant read


async def test_content_addressed_layout(tmp_path: Path) -> None:
    store = _store(tmp_path)
    data = b"layout check"
    sha = await store.put(_aiter(data))

    root = tmp_path / "blobs"
    assert (root / sha[:2] / sha).is_file()
    assert _blob_files(root) == [root / sha[:2] / sha]


async def test_put_verified_correct_claim(tmp_path: Path) -> None:
    store = _store(tmp_path)
    data = b"verify me please"
    expected = hashlib.sha256(data).hexdigest()

    sha = await store.put_verified(_aiter(data), expected)

    assert sha == expected
    assert await store.get_bytes(sha) == data


async def test_put_verified_wrong_claim_stores_nothing(tmp_path: Path) -> None:
    store = _store(tmp_path)
    data = b"the real bytes"
    wrong = hashlib.sha256(b"different bytes").hexdigest()
    real = hashlib.sha256(data).hexdigest()

    with pytest.raises(BlobHashMismatchError) as exc:
        await store.put_verified(_aiter(data), wrong)

    assert exc.value.expected == wrong
    assert exc.value.actual == real
    # Nothing promoted, and the temp file was cleaned up.
    root = tmp_path / "blobs"
    assert await store.exists(real) is False
    assert await store.exists(wrong) is False
    assert _blob_files(root) == []
    assert list((root / "tmp").glob("*")) == []


async def test_dedup_same_bytes_one_file(tmp_path: Path) -> None:
    store = _store(tmp_path)
    data = b"dedup me" * 100

    sha1 = await store.put(_aiter(data))
    sha2 = await store.put(_aiter(data))

    assert sha1 == sha2
    assert _blob_files(tmp_path / "blobs") == [tmp_path / "blobs" / sha1[:2] / sha1]


async def test_interrupted_write_leaves_no_valid_blob(tmp_path: Path) -> None:
    """A stream that raises mid-flight must not leave a content-addressed file."""
    store = _store(tmp_path)
    data = b"x" * (256 * 1024)
    sha = hashlib.sha256(data).hexdigest()

    async def _boom() -> AsyncIterator[bytes]:
        yield data
        raise RuntimeError("connection dropped")

    with pytest.raises(RuntimeError, match="connection dropped"):
        await store.put(_boom())

    root = tmp_path / "blobs"
    assert await store.exists(sha) is False
    assert _blob_files(root) == []
    # Temp staging is cleaned; no half-written .part lingers.
    assert list((root / "tmp").glob("*")) == []


async def test_no_partial_file_at_content_path_during_write(tmp_path: Path) -> None:
    """While bytes are still streaming, nothing appears at the final path.

    Proves the temp->rename discipline: the content path only materializes after
    the stream completes, so a reader can never observe a truncated blob.
    """
    store = _store(tmp_path)
    data = b"a" * (128 * 1024)
    sha = hashlib.sha256(data).hexdigest()
    final_path = tmp_path / "blobs" / sha[:2] / sha
    seen_during_stream: list[bool] = []

    async def _slow() -> AsyncIterator[bytes]:
        half = len(data) // 2
        yield data[:half]
        seen_during_stream.append(final_path.exists())  # mid-stream snapshot
        yield data[half:]

    await store.put(_slow())

    assert seen_during_stream == [False]  # not present until after the rename
    assert final_path.is_file()


async def test_concurrent_puts_same_bytes_converge(tmp_path: Path) -> None:
    store = _store(tmp_path)
    data = b"concurrent bytes" * 500

    shas = await asyncio.gather(*(store.put(_aiter(data)) for _ in range(8)))

    assert len(set(shas)) == 1
    sha = shas[0]
    assert _blob_files(tmp_path / "blobs") == [tmp_path / "blobs" / sha[:2] / sha]
    assert await store.get_bytes(sha) == data
    assert list((tmp_path / "blobs" / "tmp").glob("*")) == []


async def test_delete_and_idempotent_delete(tmp_path: Path) -> None:
    store = _store(tmp_path)
    sha = await store.put(_aiter(b"to be deleted"))
    assert await store.exists(sha) is True

    await store.delete(sha)
    assert await store.exists(sha) is False

    # Deleting an absent blob is a no-op, not an error.
    await store.delete(sha)


async def test_get_missing_raises(tmp_path: Path) -> None:
    store = _store(tmp_path)
    absent = hashlib.sha256(b"never stored").hexdigest()

    with pytest.raises(BlobNotFoundError):
        await store.get_bytes(absent)
    with pytest.raises(BlobNotFoundError):
        await store.size(absent)
    assert await store.exists(absent) is False


async def test_empty_blob(tmp_path: Path) -> None:
    store = _store(tmp_path)
    empty_sha = hashlib.sha256(b"").hexdigest()

    sha = await store.put(_aiter(b""))

    assert sha == empty_sha
    assert await store.get_bytes(sha) == b""
    assert await store.size(sha) == 0


@pytest.mark.parametrize(
    "bad",
    [
        "../../etc/passwd",
        "not-hex",
        "ABCDEF" + "0" * 58,  # uppercase rejected
        "0" * 63,  # too short
        "0" * 65,  # too long
        "a/b",
        "",
    ],
)
async def test_invalid_sha_rejected(tmp_path: Path, bad: str) -> None:
    """A caller-supplied non-hex digest never reaches the filesystem (traversal guard)."""
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        await store.exists(bad)
    with pytest.raises(ValueError):
        await store.delete(bad)
    with pytest.raises(ValueError):
        await store.size(bad)
    with pytest.raises(ValueError):
        await store.put_verified(_aiter(b"x"), bad)
    with pytest.raises(ValueError):
        await store.get_bytes(bad)


async def test_large_stream_round_trip(tmp_path: Path) -> None:
    """A few-MB blob round-trips; put is fed a chunked stream, not one buffer."""
    store = _store(tmp_path)
    data = bytes((i * 2654435761) & 0xFF for i in range(5 * 1024 * 1024))  # 5 MiB
    expected = hashlib.sha256(data).hexdigest()

    sha = await store.put(_aiter(data, chunk_size=64 * 1024))

    assert sha == expected
    assert await store.size(sha) == len(data)
    assert await store.get_bytes(sha) == data
