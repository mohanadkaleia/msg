"""``message.*`` payload schemas (TDD §2.2)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from msgd.core import ids

__all__ = ["MessageCreatedV1", "MessageEditedV1", "MessageDeletedV1"]


def _require_message_id(value: str) -> str:
    if not ids.is_valid_typed_id(value, ids.IdKind.MESSAGE):
        raise ValueError(f"message_id is not a valid m_ id: {value!r}")
    return value


class MessageCreatedV1(BaseModel):
    """Payload for ``message.created`` v1 (§2.2).

    ``model_config`` uses ``extra="allow"`` so additive-only v1 changes (§2.3.2)
    round-trip without loss when validated by an older reader.

    Id fields are **format-validated only** — the prefix and ULID validity are
    checked here to catch malformed references early.  Referential *existence*
    (does the message/user/file exist?) is a server-side concern (§3.2) and out
    of scope for this model.
    """

    model_config = ConfigDict(extra="allow")

    message_id: str
    text: str
    #: New format values arrive via a ``type_version`` bump (§2.3), so this
    #: Literal does not violate D9's additive-only rule.
    format: Literal["markdown", "plain"] = "markdown"
    #: First reply *is* the thread (D7); when set, an ``m_`` id in the same stream.
    thread_root_id: str | None = None
    file_ids: list[str] = []
    mentions: list[str] = []

    @field_validator("message_id")
    @classmethod
    def _check_message_id(cls, value: str) -> str:
        return _require_message_id(value)

    @field_validator("thread_root_id")
    @classmethod
    def _check_thread_root_id(cls, value: str | None) -> str | None:
        if value is not None and not ids.is_valid_typed_id(value, ids.IdKind.MESSAGE):
            raise ValueError(f"thread_root_id is not a valid m_ id: {value!r}")
        return value

    @field_validator("file_ids")
    @classmethod
    def _check_file_ids(cls, value: list[str]) -> list[str]:
        for fid in value:
            if not ids.is_valid_typed_id(fid, ids.IdKind.FILE):
                raise ValueError(f"file_ids contains an invalid f_ id: {fid!r}")
        return value

    @field_validator("mentions")
    @classmethod
    def _check_mentions(cls, value: list[str]) -> list[str]:
        for uid in value:
            if not ids.is_valid_typed_id(uid, ids.IdKind.USER):
                raise ValueError(f"mentions contains an invalid u_ id: {uid!r}")
        return value


class MessageEditedV1(BaseModel):
    """Payload for ``message.edited`` v1 (§2.2 / §2.4).

    Carries the *new* body of an existing message: the target ``message_id``
    plus the replacement ``text`` and ``format``.  ``text``/``format`` reuse
    exactly the ``message.created`` rules — ``format`` is the same locked
    ``"markdown" | "plain"`` domain (a new value ⇒ ``type_version`` bump).

    Edits are last-write-wins by ``server_sequence`` (§2.4); prior payloads
    remain in the log for the edit-history UI.  Ordering/LWW is a server
    projection concern, not enforced here — this model validates shape only.
    """

    model_config = ConfigDict(extra="allow")

    message_id: str
    text: str
    #: Same locked domain as ``message.created.format`` (§2.2); a new value
    #: arrives via a ``type_version`` bump, never an additive enum widening.
    format: Literal["markdown", "plain"] = "markdown"

    @field_validator("message_id")
    @classmethod
    def _check_message_id(cls, value: str) -> str:
        return _require_message_id(value)


class MessageDeletedV1(BaseModel):
    """Payload for ``message.deleted`` v1 (§2.2 / §2.4).

    A tombstone naming the target ``message_id``; the projection hides the
    message (§2.4).  No other fields — the deletion carries no new content.
    """

    model_config = ConfigDict(extra="allow")

    message_id: str

    @field_validator("message_id")
    @classmethod
    def _check_message_id(cls, value: str) -> str:
        return _require_message_id(value)
