"""Payload schema registry (TDD §2.2 / §2.3).

Maps ``(type, type_version)`` to the Pydantic model that validates a known
payload.  The envelope keeps ``payload`` an opaque dict; callers validate on
demand via :func:`get_payload_model`.  Unknown ``(type, version)`` pairs return
``None`` so the caller treats the payload as opaque (D9: skip in projection,
never crash).

Each event-type family gets its own module (``message.py``, later
``reaction.py``, ``membership.py``, ``file.py``) so future tickets add a module
and one registry line instead of conflicting on a single flat schemas file.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from msgd.core import ids
from msgd.core.envelope import Body
from msgd.core.payloads.file import (
    MAX_FILE_NAME_BYTES,
    MAX_FILE_SIZE_BYTES,
    MAX_MIME_TYPE_BYTES,
    FileUploadedV1,
)
from msgd.core.payloads.message import (
    MessageCreatedV1,
    MessageDeletedV1,
    MessageEditedV1,
)
from msgd.core.payloads.meta import (
    BotInstalledV1,
    BotRemovedV1,
    ChannelArchivedV1,
    ChannelCreatedV1,
    ChannelMemberAddedV1,
    ChannelMemberRemovedV1,
    ChannelRenamedV1,
    DmCreatedV1,
    UserJoinedV1,
    UserLeftV1,
    UserProfileUpdatedV1,
    WorkspaceCreatedV1,
    WorkspaceUpdatedV1,
    build_bot_installed_body,
    build_bot_removed_body,
    build_channel_created_body,
    build_channel_member_added_body,
    build_channel_member_removed_body,
    build_dm_created_body,
    build_user_joined_body,
    build_user_profile_updated_body,
    build_workspace_created_body,
    build_workspace_updated_body,
)
from msgd.core.payloads.reaction import (
    MAX_EMOJI_BYTES,
    ReactionAddedV1,
    ReactionRemovedV1,
)

__all__ = [
    "PAYLOAD_MODELS",
    "MAX_EMOJI_BYTES",
    "MAX_FILE_NAME_BYTES",
    "MAX_MIME_TYPE_BYTES",
    "MAX_FILE_SIZE_BYTES",
    "FileUploadedV1",
    "MessageCreatedV1",
    "MessageEditedV1",
    "MessageDeletedV1",
    "ReactionAddedV1",
    "ReactionRemovedV1",
    "WorkspaceCreatedV1",
    "WorkspaceUpdatedV1",
    "UserJoinedV1",
    "UserLeftV1",
    "UserProfileUpdatedV1",
    "ChannelCreatedV1",
    "ChannelRenamedV1",
    "ChannelArchivedV1",
    "ChannelMemberAddedV1",
    "ChannelMemberRemovedV1",
    "DmCreatedV1",
    "BotInstalledV1",
    "BotRemovedV1",
    "get_payload_model",
    "build_message_created_body",
    "build_workspace_created_body",
    "build_workspace_updated_body",
    "build_user_joined_body",
    "build_user_profile_updated_body",
    "build_channel_created_body",
    "build_channel_member_added_body",
    "build_channel_member_removed_body",
    "build_dm_created_body",
    "build_bot_installed_body",
    "build_bot_removed_body",
]

#: Registry of every known ``(type, type_version)`` payload model.
PAYLOAD_MODELS: dict[tuple[str, int], type[BaseModel]] = {
    ("message.created", 1): MessageCreatedV1,
    ("message.edited", 1): MessageEditedV1,
    ("message.deleted", 1): MessageDeletedV1,
    ("reaction.added", 1): ReactionAddedV1,
    ("reaction.removed", 1): ReactionRemovedV1,
    ("workspace.created", 1): WorkspaceCreatedV1,
    ("workspace.updated", 1): WorkspaceUpdatedV1,
    ("user.joined", 1): UserJoinedV1,
    ("user.left", 1): UserLeftV1,
    ("user.profile_updated", 1): UserProfileUpdatedV1,
    ("channel.created", 1): ChannelCreatedV1,
    ("channel.renamed", 1): ChannelRenamedV1,
    ("channel.archived", 1): ChannelArchivedV1,
    ("channel.member_added", 1): ChannelMemberAddedV1,
    ("channel.member_removed", 1): ChannelMemberRemovedV1,
    ("dm.created", 1): DmCreatedV1,
    ("file.uploaded", 1): FileUploadedV1,
    ("bot.installed", 1): BotInstalledV1,
    ("bot.removed", 1): BotRemovedV1,
}


def get_payload_model(type: str, type_version: int) -> type[BaseModel] | None:
    """Return the model for a known ``(type, type_version)``, else ``None``."""
    return PAYLOAD_MODELS.get((type, type_version))


def build_message_created_body(
    *,
    workspace_id: str,
    stream_id: str,
    author_user_id: str,
    author_device_id: str,
    client_created_at: str,
    text: str,
    format: str = "markdown",
    thread_root_id: str | None = None,
    file_ids: list[str] | None = None,
    mentions: list[str] | None = None,
    event_id: str | None = None,
    message_id: str | None = None,
) -> Body:
    """Mint and assemble a ``message.created`` v1 :class:`Body`.

    Mints ``event_id`` and ``message_id`` when not supplied, validates the
    payload through :class:`MessageCreatedV1`, and returns a :class:`Body` with
    the payload dumped to a plain dict.  Envelope finalization (attaching
    ``event_hash`` and ``server``) is left to ENG-56 / M1.
    """
    payload = MessageCreatedV1(
        message_id=message_id if message_id is not None else ids.new_message_id(),
        text=text,
        format=format,  # type: ignore[arg-type]  # validated by the model
        thread_root_id=thread_root_id,
        file_ids=file_ids if file_ids is not None else [],
        mentions=mentions if mentions is not None else [],
    )
    body_payload: dict[str, Any] = payload.model_dump(mode="json")
    return Body(
        event_id=event_id if event_id is not None else ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="message.created",
        type_version=1,
        author_user_id=author_user_id,
        author_device_id=author_device_id,
        client_created_at=client_created_at,
        payload=body_payload,
    )
