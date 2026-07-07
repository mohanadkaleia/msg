"""``workspace-meta`` + channel/DM lifecycle payload schemas (TDD §2.2).

Same modeling discipline as :class:`~msgd.core.payloads.message.MessageCreatedV1`:

* ``model_config = ConfigDict(extra="allow")`` so additive-only v1 changes
  (§2.3.2) round-trip losslessly through an older reader.
* **Format-validation only** — typed-id prefix + ULID validity, and the
  ``visibility`` literal.  Referential *existence* (does the user/stream exist?)
  is a server concern (§3.2), never enforced here.

Server-authored body builders (:func:`build_workspace_created_body`,
:func:`build_user_joined_body`) mirror ``build_message_created_body``: the model
is the source of truth, so ``hash_event(model_dump(body)) == event_hash`` holds
exactly on the construction path (the ENG-56 lax-coercion hazard is upload-only).

**CROSS-CUTTING FLAG (ENG-73 / M1-exit):** ``core/`` is shared protocol surface.
The JSON-Schema mirror in ``docs/schemas/`` *and* cross-language test vectors for
these meta types are an ENG-73 concern — ENG-65 ships only the Pydantic models +
registry entries.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, field_validator

from msgd.core import ids
from msgd.core.envelope import Body

__all__ = [
    "WorkspaceCreatedV1",
    "UserJoinedV1",
    "UserLeftV1",
    "UserProfileUpdatedV1",
    "ChannelCreatedV1",
    "ChannelRenamedV1",
    "ChannelArchivedV1",
    "ChannelMemberAddedV1",
    "ChannelMemberRemovedV1",
    "DmCreatedV1",
    "build_workspace_created_body",
    "build_user_joined_body",
    "build_channel_created_body",
    "build_channel_member_added_body",
    "build_dm_created_body",
]


def _require_user_id(value: str) -> str:
    if not ids.is_valid_typed_id(value, ids.IdKind.USER):
        raise ValueError(f"not a valid u_ id: {value!r}")
    return value


def _require_stream_id(value: str) -> str:
    if not ids.is_valid_typed_id(value, ids.IdKind.STREAM):
        raise ValueError(f"not a valid s_ id: {value!r}")
    return value


class WorkspaceCreatedV1(BaseModel):
    """Payload for ``workspace.created`` v1 (§2.2) — first meta event, seq 1."""

    model_config = ConfigDict(extra="allow")

    name: str


class UserJoinedV1(BaseModel):
    """Payload for ``user.joined`` v1 (§2.2) — workspace membership grant."""

    model_config = ConfigDict(extra="allow")

    user_id: str
    display_name: str | None = None

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, value: str) -> str:
        return _require_user_id(value)


class UserLeftV1(BaseModel):
    """Payload for ``user.left`` v1 (§2.2) — workspace membership revoke."""

    model_config = ConfigDict(extra="allow")

    user_id: str
    display_name: str | None = None

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, value: str) -> str:
        return _require_user_id(value)


class UserProfileUpdatedV1(BaseModel):
    """Payload for ``user.profile_updated`` v1 (§2.2).

    Only ``user_id`` is required; the changed profile fields are open-ended
    (carried through ``extra="allow"``) so new profile attributes are additive.
    """

    model_config = ConfigDict(extra="allow")

    user_id: str

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, value: str) -> str:
        return _require_user_id(value)


class ChannelCreatedV1(BaseModel):
    """Payload for ``channel.created`` v1 (§2.2)."""

    model_config = ConfigDict(extra="allow")

    channel_stream_id: str
    name: str
    visibility: Literal["public", "private"]

    @field_validator("channel_stream_id")
    @classmethod
    def _check_channel_stream_id(cls, value: str) -> str:
        return _require_stream_id(value)


class ChannelRenamedV1(BaseModel):
    """Payload for ``channel.renamed`` v1 (§2.2)."""

    model_config = ConfigDict(extra="allow")

    channel_stream_id: str
    name: str

    @field_validator("channel_stream_id")
    @classmethod
    def _check_channel_stream_id(cls, value: str) -> str:
        return _require_stream_id(value)


class ChannelArchivedV1(BaseModel):
    """Payload for ``channel.archived`` v1 (§2.2)."""

    model_config = ConfigDict(extra="allow")

    channel_stream_id: str

    @field_validator("channel_stream_id")
    @classmethod
    def _check_channel_stream_id(cls, value: str) -> str:
        return _require_stream_id(value)


class ChannelMemberAddedV1(BaseModel):
    """Payload for ``channel.member_added`` v1 (§2.2)."""

    model_config = ConfigDict(extra="allow")

    channel_stream_id: str
    user_id: str

    @field_validator("channel_stream_id")
    @classmethod
    def _check_channel_stream_id(cls, value: str) -> str:
        return _require_stream_id(value)

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, value: str) -> str:
        return _require_user_id(value)


class ChannelMemberRemovedV1(BaseModel):
    """Payload for ``channel.member_removed`` v1 (§2.2)."""

    model_config = ConfigDict(extra="allow")

    channel_stream_id: str
    user_id: str

    @field_validator("channel_stream_id")
    @classmethod
    def _check_channel_stream_id(cls, value: str) -> str:
        return _require_stream_id(value)

    @field_validator("user_id")
    @classmethod
    def _check_user_id(cls, value: str) -> str:
        return _require_user_id(value)


class DmCreatedV1(BaseModel):
    """Payload for ``dm.created`` v1 (§2.2) — DM/group-DM stream genesis."""

    model_config = ConfigDict(extra="allow")

    dm_stream_id: str
    member_user_ids: list[str]

    @field_validator("dm_stream_id")
    @classmethod
    def _check_dm_stream_id(cls, value: str) -> str:
        return _require_stream_id(value)

    @field_validator("member_user_ids")
    @classmethod
    def _check_member_user_ids(cls, value: list[str]) -> list[str]:
        for uid in value:
            _require_user_id(uid)
        return value


# --- server-authored body builders (ENG-65 D2) -------------------------------


def build_workspace_created_body(
    *,
    workspace_id: str,
    stream_id: str,
    author_user_id: str,
    author_device_id: str,
    client_created_at: str,
    name: str,
    event_id: str | None = None,
) -> dict[str, Any]:
    """Assemble a server-authored ``workspace.created`` v1 body dict (§2.2).

    The model is the source of truth, so the returned dict is exactly what
    :func:`~msgd.events.insert.insert_event` stores verbatim and hashes — i.e.
    ``hash_event(returned dict) == event_hash`` holds by construction (D2).
    """
    payload = WorkspaceCreatedV1(name=name)
    body = Body(
        event_id=event_id if event_id is not None else ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="workspace.created",
        type_version=1,
        author_user_id=author_user_id,
        author_device_id=author_device_id,
        client_created_at=client_created_at,
        payload=payload.model_dump(mode="json"),
    )
    dumped: dict[str, Any] = body.model_dump(mode="json")
    return dumped


def build_user_joined_body(
    *,
    workspace_id: str,
    stream_id: str,
    author_user_id: str,
    author_device_id: str,
    client_created_at: str,
    user_id: str,
    display_name: str | None = None,
    event_id: str | None = None,
) -> dict[str, Any]:
    """Assemble a server-authored ``user.joined`` v1 body dict (§2.2).

    The acting (joining) user authors their own ``user.joined`` (D2), so
    ``author_user_id == payload.user_id`` on both setup and accept-invite.
    """
    payload = UserJoinedV1(user_id=user_id, display_name=display_name)
    body = Body(
        event_id=event_id if event_id is not None else ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="user.joined",
        type_version=1,
        author_user_id=author_user_id,
        author_device_id=author_device_id,
        client_created_at=client_created_at,
        payload=payload.model_dump(mode="json"),
    )
    dumped: dict[str, Any] = body.model_dump(mode="json")
    return dumped


def build_channel_created_body(
    *,
    workspace_id: str,
    stream_id: str,
    author_user_id: str,
    author_device_id: str,
    client_created_at: str,
    channel_stream_id: str,
    name: str,
    visibility: str = "public",
    event_id: str | None = None,
) -> dict[str, Any]:
    """Assemble a ``channel.created`` v1 body dict (§2.2).

    §2.2 homing (which stream the genesis event lands in) is the CALLER's choice:
    ``stream_id`` is the *home* stream (``workspace-meta`` for a public channel,
    the channel's own stream for a private one), while ``payload.channel_stream_id``
    is the channel's own stream id the reducer creates.  Shared by the server's
    ``/v1/setup`` (server-authored default ``#general``) and ``msgctl``'s lazy
    channel auto-create, so there is a single hash-honest body shape.  The model is
    the source of truth, so ``hash_event(returned dict) == event_hash`` holds by
    construction (D2).
    """
    payload = ChannelCreatedV1(
        channel_stream_id=channel_stream_id,
        name=name,
        visibility=visibility,  # type: ignore[arg-type]  # validated by the model
    )
    body = Body(
        event_id=event_id if event_id is not None else ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="channel.created",
        type_version=1,
        author_user_id=author_user_id,
        author_device_id=author_device_id,
        client_created_at=client_created_at,
        payload=payload.model_dump(mode="json"),
    )
    dumped: dict[str, Any] = body.model_dump(mode="json")
    return dumped


def build_channel_member_added_body(
    *,
    workspace_id: str,
    stream_id: str,
    author_user_id: str,
    author_device_id: str,
    client_created_at: str,
    channel_stream_id: str,
    user_id: str,
    event_id: str | None = None,
) -> dict[str, Any]:
    """Assemble a ``channel.member_added`` v1 body dict (§2.2).

    Mirrors :func:`build_channel_created_body`: §2.2 homing is the CALLER's choice
    — ``stream_id`` is the *home* stream (``workspace-meta`` for a public channel,
    the channel's own stream for a private one; validated by ``validate.py`` on the
    upload path), while ``payload.channel_stream_id`` is the channel whose
    ``stream_members`` the reducer grows and ``payload.user_id`` is the added
    member.  Used by ``/v1/auth/accept-invite`` to self-join the invitee to the
    default ``#general`` channel (server-authored, ungated).  The model is the
    source of truth, so ``hash_event(returned dict) == event_hash`` holds by
    construction (D2).
    """
    payload = ChannelMemberAddedV1(channel_stream_id=channel_stream_id, user_id=user_id)
    body = Body(
        event_id=event_id if event_id is not None else ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="channel.member_added",
        type_version=1,
        author_user_id=author_user_id,
        author_device_id=author_device_id,
        client_created_at=client_created_at,
        payload=payload.model_dump(mode="json"),
    )
    dumped: dict[str, Any] = body.model_dump(mode="json")
    return dumped


def build_dm_created_body(
    *,
    workspace_id: str,
    author_user_id: str,
    author_device_id: str,
    client_created_at: str,
    dm_stream_id: str,
    member_user_ids: list[str],
    event_id: str | None = None,
) -> dict[str, Any]:
    """Assemble a ``dm.created`` v1 body dict (§2.2, ENG-104).

    A DM is a private stream whose members are the participant set; the genesis
    event is **self-homed** in the DM's own stream (``stream_id == dm_stream_id``)
    — a DM is never homed in workspace-meta (which every non-guest member can read,
    §3.6). The server enforces that ``author_user_id`` is one of ``member_user_ids``
    (:func:`msgd.events.validate._check_referential`); the builder does not, so a
    caller can construct a body and let the server reject a bad participant set. The
    model is the source of truth, so ``hash_event(returned dict) == event_hash``
    holds by construction (D2), and this one shared builder gives the server and the
    web client a single hash-honest body shape (the frozen cross-language vector is
    deferred to ENG-110).
    """
    payload = DmCreatedV1(dm_stream_id=dm_stream_id, member_user_ids=member_user_ids)
    body = Body(
        event_id=event_id if event_id is not None else ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=dm_stream_id,
        type="dm.created",
        type_version=1,
        author_user_id=author_user_id,
        author_device_id=author_device_id,
        client_created_at=client_created_at,
        payload=payload.model_dump(mode="json"),
    )
    dumped: dict[str, Any] = body.model_dump(mode="json")
    return dumped
