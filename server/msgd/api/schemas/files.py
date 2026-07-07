"""Request/response shapes for the Files API (``/v1/files/...``, ENG-116).

Three endpoints, three tiny models. Unlike the event-batch endpoint (which reads
its raw body so the client bytes reach ``hash_event`` untouched, ENG-66), the
Files API carries NO hashed-verbatim body, so binding a Pydantic model here is
safe and buys strict wire validation:

* ``sha256`` is pinned to the BlobStore's bare-lowercase-hex-64 domain (the same
  ``^[0-9a-f]{64}$`` the store validates before it builds any path) — a malformed
  digest is a 422 at the edge, and it is stream-INDEPENDENT so it discloses
  nothing about which streams exist (the 404-not-403 discipline is unaffected).
* ``name`` is capped at 255 UTF-8 BYTES (the frozen ``file.uploaded`` bound). It
  is otherwise arbitrary bytes — quotes, control chars, newlines are all allowed
  here and neutralized only when echoed into the ``Content-Disposition`` header on
  download (never interpolated raw — header-injection guard).
* ``size_bytes`` is a non-negative int; the per-file cap is enforced in the
  handler against ``settings.file_max_size_bytes`` (it is config, not a wire
  constant) AFTER the authz gate, so it is never a stream-existence oracle.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

__all__ = [
    "FileInitiateRequest",
    "FileInitiateResponse",
    "FileBlobResponse",
]

#: The frozen ``file.uploaded`` name bound (ENG-114): at most 255 UTF-8 bytes.
MAX_NAME_BYTES = 255
#: A defensive cap on the declared MIME type string — it is never trusted as the
#: response Content-Type (download always serves ``application/octet-stream``), so
#: this only bounds the stored value.
MAX_MIME_TYPE_LEN = 255


class FileInitiateRequest(BaseModel):
    """Body of ``POST /v1/files/initiate``."""

    #: Bare lowercase-hex sha256 of the file content (no ``sha256:`` prefix).
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    #: Client filename — arbitrary UTF-8, sanitized only on download.
    name: str = Field(min_length=1)
    #: Client-declared MIME type — stored, but NEVER echoed as a response type.
    mime_type: str = Field(min_length=1, max_length=MAX_MIME_TYPE_LEN)
    #: Declared content length; the real length is enforced to equal it at upload.
    size_bytes: int = Field(ge=0)
    #: The stream the file is attached to; authorized as write==read (§2.4).
    stream_id: str = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def _name_within_byte_bound(cls, value: str) -> str:
        """Reject a ``name`` over 255 UTF-8 bytes (the frozen payload bound)."""
        if len(value.encode("utf-8")) > MAX_NAME_BYTES:
            raise ValueError(f"name exceeds {MAX_NAME_BYTES} UTF-8 bytes")
        return value


class FileInitiateResponse(BaseModel):
    """Response of ``POST /v1/files/initiate``.

    ``upload_needed`` is ``False`` only when THIS workspace already holds a
    *present* file with the same ``sha256`` (workspace-scoped dedup) — it is never
    derived from a global ``BlobStore.exists`` check, so it can never reveal that
    some OTHER workspace happens to hold those exact bytes (no cross-workspace
    existence oracle).
    """

    file_id: str
    upload_needed: bool


class FileBlobResponse(BaseModel):
    """Response of a successful ``PUT /v1/files/{file_id}/blob``."""

    file_id: str
    present: bool
