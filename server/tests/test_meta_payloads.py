"""Meta payload models + server-authored body builders (ENG-65 D2/D7).

Pure-unit (no container): model format-validation, ``extra="allow"`` round-trip,
registry wiring, and the raw-hash discipline on the construction path.
"""

from __future__ import annotations

import pytest
from msgd.core import ids
from msgd.core.envelope import Body, Envelope
from msgd.core.hashing import hash_event, verify_hash
from msgd.core.payloads import (
    PAYLOAD_MODELS,
    ChannelCreatedV1,
    DmCreatedV1,
    UserJoinedV1,
    WorkspaceCreatedV1,
    build_dm_created_body,
    build_user_joined_body,
    build_workspace_created_body,
    get_payload_model,
)
from msgd.core.time import now_rfc3339


def test_registry_has_all_meta_types() -> None:
    """Every ENG-65 meta type/version is registered (dispatch is total)."""
    for pair in [
        ("workspace.created", 1),
        ("user.joined", 1),
        ("user.left", 1),
        ("user.profile_updated", 1),
        ("channel.created", 1),
        ("channel.renamed", 1),
        ("channel.archived", 1),
        ("channel.member_added", 1),
        ("channel.member_removed", 1),
        ("dm.created", 1),
    ]:
        assert pair in PAYLOAD_MODELS
        assert get_payload_model(*pair) is PAYLOAD_MODELS[pair]


def test_channel_created_validates_visibility_literal() -> None:
    """``visibility`` is a closed literal; anything else is rejected."""
    ok = ChannelCreatedV1(
        channel_stream_id=ids.new_stream_id(), name="general", visibility="public"
    )
    assert ok.visibility == "public"
    with pytest.raises(ValueError):
        ChannelCreatedV1(
            channel_stream_id=ids.new_stream_id(),
            name="x",
            visibility="secret",  # type: ignore[arg-type]
        )


def test_id_format_validation_only() -> None:
    """Ids are format-validated (prefix + ULID); malformed ids raise."""
    with pytest.raises(ValueError):
        UserJoinedV1(user_id="not-a-user-id")
    with pytest.raises(ValueError):
        ChannelCreatedV1(channel_stream_id="u_" + "0" * 26, name="x", visibility="public")
    with pytest.raises(ValueError):
        DmCreatedV1(dm_stream_id=ids.new_stream_id(), member_user_ids=[ids.new_stream_id()])


def test_extra_fields_round_trip() -> None:
    """``extra="allow"`` retains unknown additive fields (§2.3.2)."""
    model = WorkspaceCreatedV1(name="Acme", tagline="ship it")  # type: ignore[call-arg]
    dumped = model.model_dump()
    assert dumped["tagline"] == "ship it"


def test_build_workspace_created_body_hash_discipline() -> None:
    """The builder's dict is self-consistent: ``hash_event(dict)`` is stable and
    an Envelope built from it verifies (model-is-source path, D2)."""
    ws = ids.new_workspace_id()
    stream = ids.new_stream_id()
    user = ids.new_user_id()
    device = ids.new_device_id()
    body = build_workspace_created_body(
        workspace_id=ws,
        stream_id=stream,
        author_user_id=user,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        name="Acme",
    )
    assert body["type"] == "workspace.created"
    assert body["type_version"] == 1
    assert body["author_user_id"] == user
    assert body["stream_id"] == stream
    assert body["payload"] == {"name": "Acme"}

    event_hash = hash_event(body)
    # Deterministic over the verbatim stored dict (raw-hash discipline).
    assert hash_event(body) == event_hash
    env = Envelope(body=Body(**body), event_hash=event_hash)
    assert verify_hash(env)


def test_build_user_joined_body_author_is_joiner() -> None:
    """``user.joined`` is authored by the joining user (author == payload.user_id, D2)."""
    ws = ids.new_workspace_id()
    stream = ids.new_stream_id()
    user = ids.new_user_id()
    device = ids.new_device_id()
    body = build_user_joined_body(
        workspace_id=ws,
        stream_id=stream,
        author_user_id=user,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        user_id=user,
        display_name="Dana",
    )
    assert body["type"] == "user.joined"
    assert body["author_user_id"] == user
    assert body["payload"] == {"user_id": user, "display_name": "Dana"}
    env = Envelope(body=Body(**body), event_hash=hash_event(body))
    assert verify_hash(env)


def test_build_dm_created_body_self_homed_and_hash_discipline() -> None:
    """``dm.created`` is self-homed in its DM stream and hashes honestly (D2, ENG-104)."""
    ws = ids.new_workspace_id()
    author = ids.new_user_id()
    other = ids.new_user_id()
    device = ids.new_device_id()
    dm = ids.new_stream_id()
    body = build_dm_created_body(
        workspace_id=ws,
        author_user_id=author,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        dm_stream_id=dm,
        member_user_ids=[author, other],
    )
    assert body["type"] == "dm.created"
    assert body["type_version"] == 1
    # Self-homed: the genesis event lands in the DM's own stream (never meta).
    assert body["stream_id"] == dm
    assert body["payload"] == {"dm_stream_id": dm, "member_user_ids": [author, other]}
    env = Envelope(body=Body(**body), event_hash=hash_event(body))
    assert verify_hash(env)
