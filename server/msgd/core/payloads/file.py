"""``file.*`` payload schemas (TDD §2.2 / M3.5 Phase-A).

Same modeling discipline as
:class:`~msgd.core.payloads.message.MessageCreatedV1`:

* ``model_config = ConfigDict(extra="allow")`` so additive-only v1 changes
  (§2.3.2) round-trip losslessly through an older reader.
* **Format-validation only** — ``file_id`` prefix + ULID validity, the content
  hash format, and the bounded ``name`` / ``mime_type`` / ``size_bytes`` domains
  (below).  Referential *existence* (does the blob exist? was it actually
  uploaded?) is a server concern (ENG-116, §3.2), never enforced here.

**LOCKED DECISIONS (§2.2-style — changing any of these ⇒ ``type_version`` bump):**

* ``sha256`` is the blob's content hash as a **bare 64-char lowercase hex**
  string (``^[0-9a-f]{64}$``) — NOT the ``sha256:<hex>`` prefixed form used by
  ``event_hash``.  This deliberately matches the content-addressed BlobStore
  (ENG-115): blobs are keyed by bare-hex sha256, §6 has clients compute
  ``sha256(file)`` as bare hex, and the Files API (ENG-116) matches the streamed
  blob to this field, all bare-hex.  The algorithm is fixed by the field name, so
  no ``sha256:`` prefix is carried.
* ``name`` is a bounded, **opaque** filename: a non-empty Unicode string of at
  most :data:`MAX_FILE_NAME_BYTES` (255) UTF-8 bytes.  It is treated as opaque
  display text — no path/extension/charset interpretation happens here.
* ``mime_type`` is a bounded ``type/subtype`` string: non-empty, at most
  :data:`MAX_MIME_TYPE_BYTES` (255) UTF-8 bytes, exactly one ``"/"`` with a
  non-empty type and subtype.  Deliberately **not** the full RFC 6838 token
  grammar — the payload only gates the coarse shape and the length; richer
  sniffing/allow-listing is a server (ENG-116) concern.
* ``size_bytes`` is a non-negative integer within the JCS interop cap
  (``0 <= size_bytes <= 2**53 - 1``; see :mod:`msgd.core.jcs`).  The **50 MB
  business cap is a SERVER-validation concern (ENG-116), NOT the payload** — the
  frozen payload only bounds it as a non-negative in-range integer so the number
  round-trips byte-identically cross-language.
"""

from __future__ import annotations

import re
from typing import Final

from pydantic import BaseModel, ConfigDict, field_validator

from msgd.core import ids

__all__ = [
    "MAX_FILE_NAME_BYTES",
    "MAX_MIME_TYPE_BYTES",
    "MAX_FILE_SIZE_BYTES",
    "FileUploadedV1",
]

#: Upper bound on the UTF-8 byte length of a ``file.uploaded`` ``name`` (locked
#: at ``type_version`` 1).  255 bytes matches the common filesystem ``NAME_MAX``.
MAX_FILE_NAME_BYTES: Final = 255

#: Upper bound on the UTF-8 byte length of a ``mime_type`` (locked at v1).
MAX_MIME_TYPE_BYTES: Final = 255

#: Upper bound on ``size_bytes`` — the JCS integer interop cap ``2**53 - 1``
#: (:mod:`msgd.core.jcs`).  This is the *protocol* bound; the 50 MB business cap
#: is enforced server-side (ENG-116), not here.
MAX_FILE_SIZE_BYTES: Final = 2**53 - 1

#: Bare 64-char lowercase hex — the content-addressed BlobStore key form (ENG-115),
#: NOT the ``sha256:<hex>`` prefixed form used by ``event_hash``.
_SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")

#: Coarse ``type/subtype`` shape: exactly one ``/`` with non-empty, slash-free halves.
_MIME_TYPE_RE: Final = re.compile(r"^[^/]+/[^/]+$")


def _require_file_id(value: str) -> str:
    if not ids.is_valid_typed_id(value, ids.IdKind.FILE):
        raise ValueError(f"file_id is not a valid f_ id: {value!r}")
    return value


def _require_sha256(value: str) -> str:
    if not _SHA256_RE.fullmatch(value):
        raise ValueError(f"sha256 must be 64 lowercase hex chars (bare, no prefix), got {value!r}")
    return value


def _require_name(value: str) -> str:
    if value == "":
        raise ValueError("name must be non-empty")
    n = len(value.encode("utf-8"))
    if n > MAX_FILE_NAME_BYTES:
        raise ValueError(f"name is {n} bytes UTF-8, exceeds the {MAX_FILE_NAME_BYTES}-byte limit")
    return value


def _require_mime_type(value: str) -> str:
    n = len(value.encode("utf-8"))
    if n == 0:
        raise ValueError("mime_type must be non-empty")
    if n > MAX_MIME_TYPE_BYTES:
        raise ValueError(
            f"mime_type is {n} bytes UTF-8, exceeds the {MAX_MIME_TYPE_BYTES}-byte limit"
        )
    if not _MIME_TYPE_RE.fullmatch(value):
        raise ValueError(f"mime_type is not a type/subtype string: {value!r}")
    return value


def _require_size_bytes(value: int) -> int:
    if value < 0:
        raise ValueError(f"size_bytes must be >= 0, got {value}")
    if value > MAX_FILE_SIZE_BYTES:
        raise ValueError(
            f"size_bytes {value} exceeds the interop cap {MAX_FILE_SIZE_BYTES} (2**53 - 1)"
        )
    return value


class FileUploadedV1(BaseModel):
    """Payload for ``file.uploaded`` v1 (§2.2 / M3.5 Phase-A).

    The frozen cross-language descriptor of an uploaded blob: its ``file_id``,
    content ``sha256``, opaque ``name``, ``mime_type``, and ``size_bytes``.  This
    model validates the event *shape* only — blob existence, the 50 MB business
    cap, and dedup-by-content-hash are server concerns (ENG-116), never enforced
    here (see the module docstring).
    """

    model_config = ConfigDict(extra="allow")

    file_id: str
    sha256: str
    name: str
    mime_type: str
    size_bytes: int

    @field_validator("file_id")
    @classmethod
    def _check_file_id(cls, value: str) -> str:
        return _require_file_id(value)

    @field_validator("sha256")
    @classmethod
    def _check_sha256(cls, value: str) -> str:
        return _require_sha256(value)

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        return _require_name(value)

    @field_validator("mime_type")
    @classmethod
    def _check_mime_type(cls, value: str) -> str:
        return _require_mime_type(value)

    @field_validator("size_bytes")
    @classmethod
    def _check_size_bytes(cls, value: int) -> int:
        return _require_size_bytes(value)
