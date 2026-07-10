"""Tests for :mod:`msgd.core.envelope` — the locked §2.1 envelope shape."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st
from msgd.core import ids
from msgd.core.envelope import (
    MAX_EVENT_SIZE_BYTES,
    Body,
    Envelope,
    EventTooLargeError,
    ServerMetadata,
    check_event_size,
    serialized_size_bytes,
)
from msgd.core.payloads import PAYLOAD_MODELS, build_message_created_body, get_payload_model

_FIXTURE_PATH = Path(__file__).parent / "data" / "eng54_envelope_example.json"


def _load_example() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(_FIXTURE_PATH.read_text())
    return data


def _valid_envelope_dict() -> dict[str, Any]:
    """A minimal fresh valid envelope dict built from minted ids."""
    body = build_message_created_body(
        workspace_id=ids.new_workspace_id(),
        stream_id=ids.new_stream_id(),
        author_user_id=ids.new_user_id(),
        author_device_id=ids.new_device_id(),
        client_created_at="2026-07-04T18:22:10.123Z",
        text="hello",
    )
    return {
        "body": body.model_dump(mode="json"),
        "event_hash": "sha256:" + "0" * 64,
        "signature": None,
        "server": {
            "server_sequence": 1,
            "server_received_at": "2026-07-04T18:22:10.456Z",
            "payload_redacted": False,
        },
    }


# --- headline acceptance criterion -------------------------------------------


def test_2_1_example_round_trips_losslessly() -> None:
    # Asserts structural (dict deep-)equality, not byte-verbatim reserialization:
    # event_hash is SHA-256 over JCS(body) and JCS re-sorts keys canonically, so
    # hash reproducibility depends only on structural fidelity (no field dropped
    # or mutated) — key order is irrelevant and extra="allow" does not preserve it.
    original = _load_example()
    env = Envelope.model_validate(original)
    assert env.model_dump(mode="json") == original


# --- extra="allow": unknown fields survive -----------------------------------


def test_unknown_body_field_survives() -> None:
    data = _load_example()
    data["body"]["future_body_field"] = {"nested": [1, 2, 3]}
    dumped = Envelope.model_validate(data).model_dump(mode="json")
    assert dumped["body"]["future_body_field"] == {"nested": [1, 2, 3]}


def test_unknown_payload_field_survives() -> None:
    # NOTE: this exercises dict passthrough, not extra="allow" — payload is typed
    # dict[str, Any] on Body, so unknown keys inside it survive as plain dict
    # data regardless of model config. The payload-model config guard lives in
    # test_payloads.py::test_message_created_v1_unknown_field_survives.
    data = _load_example()
    data["body"]["payload"]["future_payload_field"] = "kept"
    dumped = Envelope.model_validate(data).model_dump(mode="json")
    assert dumped["body"]["payload"]["future_payload_field"] == "kept"


def test_unknown_server_field_survives() -> None:
    data = _load_example()
    data["server"]["future_server_field"] = 42
    dumped = Envelope.model_validate(data).model_dump(mode="json")
    assert dumped["server"]["future_server_field"] == 42


def test_unknown_top_level_field_survives() -> None:
    data = _load_example()
    data["future_top_level"] = ["a", "b"]
    dumped = Envelope.model_validate(data).model_dump(mode="json")
    assert dumped["future_top_level"] == ["a", "b"]


# --- unknown event types (D9): preserve, never crash -------------------------


def test_unknown_event_type_round_trips() -> None:
    data = _load_example()
    data["body"]["type"] = "widget.exploded"
    data["body"]["type_version"] = 7
    data["body"]["payload"] = {"anything": {"deeply": [True, None, 1.5]}}
    env = Envelope.model_validate(data)  # must not raise
    assert env.model_dump(mode="json") == data
    # And the registry reports it unknown so callers treat it as opaque.
    assert get_payload_model("widget.exploded", 7) is None


# --- reserved fields present + defaulted -------------------------------------


def test_signature_defaults_null() -> None:
    data = _load_example()
    del data["signature"]
    env = Envelope.model_validate(data)
    assert env.signature is None
    assert "signature" in env.model_dump(mode="json")


def test_payload_redacted_defaults_false() -> None:
    data = _load_example()
    del data["server"]["payload_redacted"]
    env = Envelope.model_validate(data)
    assert env.server is not None
    assert env.server.payload_redacted is False


def test_client_upload_form_has_no_server() -> None:
    data = _load_example()
    upload = {"body": data["body"], "event_hash": data["event_hash"]}
    env = Envelope.model_validate(upload)
    assert env.server is None
    assert env.signature is None


# --- per registered (type, version) round-trip -------------------------------


def _sample_payload(type_: str) -> dict[str, Any]:
    """A representative valid payload for each registered event ``type``."""
    u = ids.new_user_id()
    s = ids.new_stream_id()
    m = ids.new_message_id()
    samples: dict[str, dict[str, Any]] = {
        "message.created": {
            "message_id": ids.new_message_id(),
            "text": "hello",
            "format": "markdown",
            "thread_root_id": None,
            "file_ids": [],
            "mentions": [],
        },
        "message.edited": {"message_id": m, "text": "edited", "format": "markdown"},
        "message.deleted": {"message_id": m},
        "reaction.added": {"message_id": m, "emoji": "👍"},
        "reaction.removed": {"message_id": m, "emoji": "👍"},
        "workspace.created": {"name": "Acme"},
        "workspace.updated": {"name": "Acme Corp", "description": "About us"},
        "user.joined": {"user_id": u, "display_name": "Dana"},
        "user.left": {"user_id": u, "display_name": "Dana"},
        "user.profile_updated": {"user_id": u},
        "channel.created": {"channel_stream_id": s, "name": "general", "visibility": "public"},
        "channel.renamed": {"channel_stream_id": s, "name": "general"},
        "channel.archived": {"channel_stream_id": s},
        "channel.member_added": {"channel_stream_id": s, "user_id": u},
        "channel.member_removed": {"channel_stream_id": s, "user_id": u},
        "dm.created": {"dm_stream_id": s, "member_user_ids": [u]},
        "bot.installed": {"bot_user_id": u, "name": "Bee", "scopes": ["events:write"]},
        "bot.removed": {"bot_user_id": u},
        "file.uploaded": {
            "file_id": ids.new_file_id(),
            "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "name": "diagram.png",
            "mime_type": "image/png",
            "size_bytes": 15243,
        },
    }
    return samples[type_]


@pytest.mark.parametrize("type_version", sorted(PAYLOAD_MODELS.keys()))
def test_round_trip_per_registered_type_version(type_version: tuple[str, int]) -> None:
    type_, version = type_version
    body = {
        "event_id": ids.new_event_id(),
        "workspace_id": ids.new_workspace_id(),
        "stream_id": ids.new_stream_id(),
        "type": type_,
        "type_version": version,
        "author_user_id": ids.new_user_id(),
        "author_device_id": ids.new_device_id(),
        "client_created_at": "2026-07-04T18:22:10.123Z",
        "payload": _sample_payload(type_),
    }
    data: dict[str, Any] = {
        "body": body,
        "event_hash": "sha256:" + "0" * 64,
        "signature": None,
        "server": {
            "server_sequence": 1,
            "server_received_at": "2026-07-04T18:22:10.456Z",
            "payload_redacted": False,
        },
    }
    original = copy.deepcopy(data)
    env = Envelope.model_validate(data)
    assert env.model_dump(mode="json") == original
    # The payload validates against its registered model.
    model = get_payload_model(type_, version)
    assert model is not None
    model.model_validate(env.body.payload)


# --- size cap ----------------------------------------------------------------
# The cap is measured over the §3.2 upload wire form {body, event_hash} only
# ("hard reject at upload", §2.1) — never the full stored envelope, so the
# measured size of a given body is independent of attached server metadata.


def test_size_cap_accepts_normal_event() -> None:
    env = Envelope.model_validate(_valid_envelope_dict())
    assert serialized_size_bytes(env) <= MAX_EVENT_SIZE_BYTES
    check_event_size(env)  # must not raise


def test_size_cap_rejects_oversized() -> None:
    data = _valid_envelope_dict()
    data["body"]["payload"]["text"] = "x" * (MAX_EVENT_SIZE_BYTES + 1000)
    env = Envelope.model_validate(data)
    with pytest.raises(EventTooLargeError):
        check_event_size(env)


def test_size_cap_boundary() -> None:
    data = _valid_envelope_dict()
    env = Envelope.model_validate(data)
    base = serialized_size_bytes(env)
    # Pad the text so the {body, event_hash} wire form is exactly the limit
    # (the envelope's server block is present but excluded from measurement).
    pad = MAX_EVENT_SIZE_BYTES - base
    assert pad > 0
    data["body"]["payload"]["text"] += "y" * pad
    env_exact = Envelope.model_validate(data)
    assert serialized_size_bytes(env_exact) == MAX_EVENT_SIZE_BYTES
    check_event_size(env_exact)  # exactly at the limit passes

    data["body"]["payload"]["text"] += "z"
    env_over = Envelope.model_validate(data)
    assert serialized_size_bytes(env_over) == MAX_EVENT_SIZE_BYTES + 1
    with pytest.raises(EventTooLargeError):
        check_event_size(env_over)


def test_size_cap_is_form_stable() -> None:
    # The key guarantee of the wire-form measurement: an identical body +
    # event_hash measures the same with and without server metadata attached.
    data = _valid_envelope_dict()
    upload_form = Envelope.model_validate({"body": data["body"], "event_hash": data["event_hash"]})
    stored_form = Envelope.model_validate(data)
    assert upload_form.server is None
    assert stored_form.server is not None
    assert serialized_size_bytes(upload_form) == serialized_size_bytes(stored_form)


# --- direct model construction -----------------------------------------------


def test_server_metadata_rejects_bad_timestamp() -> None:
    with pytest.raises(ValueError):
        ServerMetadata(server_sequence=1, server_received_at="not-a-timestamp")


def test_body_rejects_bad_ids() -> None:
    good = _valid_envelope_dict()["body"]
    bad = dict(good)
    bad["workspace_id"] = "u_" + good["workspace_id"][2:]  # wrong prefix
    with pytest.raises(ValueError):
        Body.model_validate(bad)


# --- hypothesis: arbitrary bodies round-trip losslessly ----------------------

_json_scalars = st.none() | st.booleans() | st.integers() | st.text()
_json_values = st.recursive(
    _json_scalars,
    lambda children: (
        st.lists(children, max_size=4)
        | st.dictionaries(st.text(min_size=1, max_size=8), children, max_size=4)
    ),
    max_leaves=10,
)


@st.composite
def _bodies(draw: st.DrawFn) -> dict[str, Any]:
    body: dict[str, Any] = {
        "event_id": ids.new_event_id(),
        "workspace_id": ids.new_workspace_id(),
        "stream_id": ids.new_stream_id(),
        "type": draw(st.text(min_size=1, max_size=20)),
        "type_version": draw(st.integers(min_value=1, max_value=99)),
        "author_user_id": ids.new_user_id(),
        "author_device_id": ids.new_device_id(),
        "client_created_at": "2026-07-04T18:22:10.123Z",
        "payload": draw(st.dictionaries(st.text(min_size=1, max_size=8), _json_values, max_size=5)),
    }
    # Random unknown extra fields on the body.
    extras = draw(st.dictionaries(st.text(min_size=1, max_size=8), _json_values, max_size=3))
    for key, value in extras.items():
        if key not in body:
            body[key] = value
    return body


@given(body=_bodies())
def test_arbitrary_body_round_trips(body: dict[str, Any]) -> None:
    env_dict = {"body": body, "event_hash": "sha256:" + "0" * 64}
    env = Envelope.model_validate(env_dict)
    assert env.model_dump(mode="json")["body"] == body
