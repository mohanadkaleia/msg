"""``reaction.*`` payload schemas (TDD §2.2 / §2.4).

Same modeling discipline as
:class:`~msgd.core.payloads.message.MessageCreatedV1`:

* ``model_config = ConfigDict(extra="allow")`` so additive-only v1 changes
  (§2.3.2) round-trip losslessly through an older reader.
* **Format-validation only** — ``message_id`` prefix + ULID validity and the
  emoji domain (below).  Referential *existence* (does the target message
  exist?) is a server concern (§3.2), never enforced here.

**Emoji domain (LOCKED DECISION, §2.2-style — changing it ⇒ ``type_version``
bump):** ``emoji`` is a bounded **Unicode string**: non-empty and at most
:data:`MAX_EMOJI_BYTES` (64) bytes when UTF-8 encoded.  There is deliberately
**no server-side emoji whitelist** — clients may send any Unicode grapheme
(base emoji, ZWJ sequences, skin-tone modifiers, keycaps, or even a short
non-emoji string); the 64-byte bound is the only gate.  Widening or narrowing
this domain later (e.g. adding a whitelist, or raising the byte cap) is a
breaking change under D9 and must arrive via a ``type_version`` bump, exactly
like ``message.created.format``.

**Idempotency is NOT enforced here.** The reaction set is keyed on
``(message_id, author_user_id, emoji)`` (§2.4) — ``author_user_id`` lives on the
envelope, not the payload, and dedup/idempotent set semantics are a server
projection concern (ENG-97).  This model validates a single reaction event's
shape only.
"""

from __future__ import annotations

from typing import Final

from pydantic import BaseModel, ConfigDict, field_validator

from msgd.core import ids

__all__ = ["MAX_EMOJI_BYTES", "ReactionAddedV1", "ReactionRemovedV1"]

#: Upper bound on the UTF-8 byte length of a reaction ``emoji`` (locked at
#: ``type_version`` 1; see the module docstring).  64 bytes comfortably holds
#: the longest realistic ZWJ emoji sequence while bounding the payload.
MAX_EMOJI_BYTES: Final = 64


def _require_message_id(value: str) -> str:
    if not ids.is_valid_typed_id(value, ids.IdKind.MESSAGE):
        raise ValueError(f"message_id is not a valid m_ id: {value!r}")
    return value


def _require_emoji(value: str) -> str:
    if value == "":
        raise ValueError("emoji must be non-empty")
    n = len(value.encode("utf-8"))
    if n > MAX_EMOJI_BYTES:
        raise ValueError(f"emoji is {n} bytes UTF-8, exceeds the {MAX_EMOJI_BYTES}-byte limit")
    return value


class ReactionAddedV1(BaseModel):
    """Payload for ``reaction.added`` v1 (§2.2).

    Idempotent-add on ``(message_id, author_user_id, emoji)`` at projection time
    (§2.4); this model only validates the event shape (see the module docstring).
    """

    model_config = ConfigDict(extra="allow")

    message_id: str
    emoji: str

    @field_validator("message_id")
    @classmethod
    def _check_message_id(cls, value: str) -> str:
        return _require_message_id(value)

    @field_validator("emoji")
    @classmethod
    def _check_emoji(cls, value: str) -> str:
        return _require_emoji(value)


class ReactionRemovedV1(BaseModel):
    """Payload for ``reaction.removed`` v1 (§2.2) — idempotent remove (§2.4)."""

    model_config = ConfigDict(extra="allow")

    message_id: str
    emoji: str

    @field_validator("message_id")
    @classmethod
    def _check_message_id(cls, value: str) -> str:
        return _require_message_id(value)

    @field_validator("emoji")
    @classmethod
    def _check_emoji(cls, value: str) -> str:
        return _require_emoji(value)
