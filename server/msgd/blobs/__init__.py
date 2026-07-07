"""Content-addressed blob storage (ENG-115, TDD §6 / D8).

The :class:`~msgd.blobs.store.BlobStore` interface and its local-disk backend.
No HTTP here — ENG-116 wires the ``/v1/files/...`` API onto this layer.
"""

from __future__ import annotations

from msgd.blobs.store import (
    BlobHashMismatchError,
    BlobNotFoundError,
    BlobStore,
    BlobStoreError,
    LocalDiskBlobStore,
)

__all__ = [
    "BlobHashMismatchError",
    "BlobNotFoundError",
    "BlobStore",
    "BlobStoreError",
    "LocalDiskBlobStore",
]
