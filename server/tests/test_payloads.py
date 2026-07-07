"""Tests for :mod:`msgd.core.payloads`."""

from __future__ import annotations

import pytest
from msgd.core import ids
from msgd.core.payloads import (
    MAX_EMOJI_BYTES,
    MAX_FILE_NAME_BYTES,
    MAX_FILE_SIZE_BYTES,
    MAX_MIME_TYPE_BYTES,
    FileUploadedV1,
    MessageCreatedV1,
    MessageDeletedV1,
    MessageEditedV1,
    ReactionAddedV1,
    ReactionRemovedV1,
    build_message_created_body,
    get_payload_model,
)
from pydantic import ValidationError


def test_required_fields_and_defaults() -> None:
    msg = MessageCreatedV1(message_id=ids.new_message_id(), text="hi")
    # Locked at M0 (review round 1 ruling): omitting `format` yields "markdown".
    # The model is a validation-only view — defaulting never mutates the stored
    # payload dict, so it cannot cause a hash mismatch.
    assert msg.format == "markdown"
    assert msg.thread_root_id is None
    assert msg.file_ids == []
    assert msg.mentions == []


def test_missing_required_field_raises() -> None:
    with pytest.raises(ValidationError):
        MessageCreatedV1(text="no message id")  # type: ignore[call-arg]


def test_bad_message_id_prefix_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageCreatedV1(message_id=ids.new_user_id(), text="hi")


def test_non_user_mention_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageCreatedV1(
            message_id=ids.new_message_id(),
            text="hi",
            mentions=[ids.new_message_id()],
        )


def test_non_file_file_id_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageCreatedV1(
            message_id=ids.new_message_id(),
            text="hi",
            file_ids=[ids.new_user_id()],
        )


def test_thread_root_id_must_be_message_id() -> None:
    with pytest.raises(ValidationError):
        MessageCreatedV1(
            message_id=ids.new_message_id(),
            text="hi",
            thread_root_id=ids.new_user_id(),
        )
    # A valid m_ id is accepted.
    root = ids.new_message_id()
    msg = MessageCreatedV1(message_id=ids.new_message_id(), text="reply", thread_root_id=root)
    assert msg.thread_root_id == root


def test_format_literal_domain() -> None:
    assert (
        MessageCreatedV1(message_id=ids.new_message_id(), text="x", format="plain").format
        == "plain"
    )
    with pytest.raises(ValidationError):
        MessageCreatedV1(message_id=ids.new_message_id(), text="x", format="html")  # type: ignore[arg-type]


def test_message_created_v1_unknown_field_survives() -> None:
    # The real extra="allow" guard for the payload *model* (§2.3.2 additive-only
    # evolution): this test fails if extra="allow" is dropped from
    # MessageCreatedV1. (The envelope-level test_unknown_payload_field_survives
    # only covers dict passthrough on Body.payload.)
    msg = MessageCreatedV1.model_validate(
        {"message_id": ids.new_message_id(), "text": "x", "future_field": 7}
    )
    assert msg.model_dump()["future_field"] == 7


def test_get_payload_model() -> None:
    assert get_payload_model("message.created", 1) is MessageCreatedV1
    assert get_payload_model("message.created", 2) is None
    assert get_payload_model("widget.exploded", 1) is None
    # M3 additive types are registered at v1.
    assert get_payload_model("message.edited", 1) is MessageEditedV1
    assert get_payload_model("message.deleted", 1) is MessageDeletedV1
    assert get_payload_model("reaction.added", 1) is ReactionAddedV1
    assert get_payload_model("reaction.removed", 1) is ReactionRemovedV1
    # M3.5 additive type is registered at v1.
    assert get_payload_model("file.uploaded", 1) is FileUploadedV1


# --------------------------------------------------------------------------- #
# message.edited (§2.2 / §2.4)
# --------------------------------------------------------------------------- #


def test_message_edited_valid_and_defaults() -> None:
    mid = ids.new_message_id()
    edited = MessageEditedV1(message_id=mid, text="new body")
    assert edited.message_id == mid
    assert edited.text == "new body"
    # Reuses message.created's format default + locked domain.
    assert edited.format == "markdown"
    assert MessageEditedV1(message_id=mid, text="x", format="plain").format == "plain"


def test_message_edited_bad_message_id_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageEditedV1(message_id=ids.new_user_id(), text="x")


def test_message_edited_missing_message_id_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageEditedV1(text="x")  # type: ignore[call-arg]


def test_message_edited_format_domain_locked() -> None:
    with pytest.raises(ValidationError):
        MessageEditedV1(message_id=ids.new_message_id(), text="x", format="html")  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# message.deleted (§2.2 / §2.4)
# --------------------------------------------------------------------------- #


def test_message_deleted_valid() -> None:
    mid = ids.new_message_id()
    assert MessageDeletedV1(message_id=mid).message_id == mid


def test_message_deleted_bad_message_id_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageDeletedV1(message_id="not-an-id")


def test_message_deleted_missing_message_id_rejected() -> None:
    with pytest.raises(ValidationError):
        MessageDeletedV1()  # type: ignore[call-arg]


# --------------------------------------------------------------------------- #
# reaction.added / reaction.removed — emoji domain (locked at v1)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("model", [ReactionAddedV1, ReactionRemovedV1])
def test_reaction_valid_multibyte_emoji(model: type) -> None:
    mid = ids.new_message_id()
    r = model(message_id=mid, emoji="👍")
    assert r.message_id == mid
    assert r.emoji == "👍"


@pytest.mark.parametrize("model", [ReactionAddedV1, ReactionRemovedV1])
def test_reaction_emoji_at_64_byte_cap_accepted(model: type) -> None:
    # 16 x U+1F600 = exactly MAX_EMOJI_BYTES UTF-8 bytes — the accept edge.
    emoji = "\U0001f600" * 16
    assert len(emoji.encode("utf-8")) == MAX_EMOJI_BYTES
    assert model(message_id=ids.new_message_id(), emoji=emoji).emoji == emoji


@pytest.mark.parametrize("model", [ReactionAddedV1, ReactionRemovedV1])
def test_reaction_emoji_over_64_bytes_rejected(model: type) -> None:
    over = "\U0001f600" * 16 + "a"  # 65 bytes
    assert len(over.encode("utf-8")) == MAX_EMOJI_BYTES + 1
    with pytest.raises(ValidationError):
        model(message_id=ids.new_message_id(), emoji=over)


@pytest.mark.parametrize("model", [ReactionAddedV1, ReactionRemovedV1])
def test_reaction_empty_emoji_rejected(model: type) -> None:
    with pytest.raises(ValidationError):
        model(message_id=ids.new_message_id(), emoji="")


@pytest.mark.parametrize("model", [ReactionAddedV1, ReactionRemovedV1])
def test_reaction_bad_message_id_rejected(model: type) -> None:
    with pytest.raises(ValidationError):
        model(message_id=ids.new_user_id(), emoji="👍")


@pytest.mark.parametrize("model", [ReactionAddedV1, ReactionRemovedV1])
def test_reaction_missing_fields_rejected(model: type) -> None:
    with pytest.raises(ValidationError):
        model(message_id=ids.new_message_id())
    with pytest.raises(ValidationError):
        model(emoji="👍")


@pytest.mark.parametrize("model", [ReactionAddedV1, ReactionRemovedV1])
def test_reaction_no_whitelist_accepts_any_short_unicode(model: type) -> None:
    # LOCKED DECISION: no emoji whitelist — any non-empty <=64-byte Unicode string
    # is accepted (a plain ASCII "+1" is a valid reaction under the byte-bound domain).
    assert model(message_id=ids.new_message_id(), emoji="+1").emoji == "+1"


# --------------------------------------------------------------------------- #
# file.uploaded (§2.2 / M3.5 Phase-A) — the payload validation domain.
# The frozen JCS+hash proof lives in test_vectors.py; these pin the shape rules
# that hash fine but are still rejected by the model.
# --------------------------------------------------------------------------- #

_GOOD_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def _file_kwargs(**overrides: object) -> dict[str, object]:
    kwargs: dict[str, object] = {
        "file_id": ids.new_file_id(),
        "sha256": _GOOD_SHA,
        "name": "diagram.png",
        "mime_type": "image/png",
        "size_bytes": 15243,
    }
    kwargs.update(overrides)
    return kwargs


def test_file_uploaded_valid() -> None:
    f = FileUploadedV1(**_file_kwargs())  # type: ignore[arg-type]
    assert f.mime_type == "image/png"
    assert f.size_bytes == 15243
    assert f.sha256 == _GOOD_SHA


def test_file_uploaded_missing_field_rejected() -> None:
    kwargs = _file_kwargs()
    del kwargs["sha256"]
    with pytest.raises(ValidationError):
        FileUploadedV1(**kwargs)  # type: ignore[arg-type]


def test_file_uploaded_bad_file_id_prefix_rejected() -> None:
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(file_id=ids.new_message_id()))  # type: ignore[arg-type]


def test_file_uploaded_empty_name_rejected() -> None:
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(name=""))  # type: ignore[arg-type]


def test_file_uploaded_name_at_255_bytes_accepted() -> None:
    name = "a" * MAX_FILE_NAME_BYTES
    assert len(name.encode("utf-8")) == MAX_FILE_NAME_BYTES
    assert FileUploadedV1(**_file_kwargs(name=name)).name == name  # type: ignore[arg-type]


def test_file_uploaded_name_over_255_bytes_rejected() -> None:
    over = "a" * (MAX_FILE_NAME_BYTES + 1)
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(name=over))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "bad_sha",
    [
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",  # prefixed form
        "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",  # uppercase
        "deadbeef",  # too short
        "a" * 65,  # too long
        "g" * 64,  # non-hex
        "",  # empty
    ],
)
def test_file_uploaded_malformed_sha256_rejected(bad_sha: str) -> None:
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(sha256=bad_sha))  # type: ignore[arg-type]


@pytest.mark.parametrize("bad_mime", ["png", "image/", "/png", "image/png/extra", ""])
def test_file_uploaded_malformed_mime_type_rejected(bad_mime: str) -> None:
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(mime_type=bad_mime))  # type: ignore[arg-type]


def test_file_uploaded_mime_type_over_255_bytes_rejected() -> None:
    over = "application/" + "a" * MAX_MIME_TYPE_BYTES
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(mime_type=over))  # type: ignore[arg-type]


def test_file_uploaded_negative_size_rejected() -> None:
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(size_bytes=-1))  # type: ignore[arg-type]


def test_file_uploaded_size_zero_and_cap_accepted() -> None:
    assert FileUploadedV1(**_file_kwargs(size_bytes=0)).size_bytes == 0  # type: ignore[arg-type]
    cap = MAX_FILE_SIZE_BYTES
    assert FileUploadedV1(**_file_kwargs(size_bytes=cap)).size_bytes == cap  # type: ignore[arg-type]


def test_file_uploaded_size_over_cap_rejected() -> None:
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(size_bytes=MAX_FILE_SIZE_BYTES + 1))  # type: ignore[arg-type]


def test_file_uploaded_wrong_size_type_rejected() -> None:
    # A non-integer float is not a valid size (pydantic lax still rejects 1.5 -> int).
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(size_bytes=1.5))  # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        FileUploadedV1(**_file_kwargs(size_bytes="lots"))  # type: ignore[arg-type]


def test_file_uploaded_unknown_field_survives() -> None:
    # extra="allow" guard for the payload model (§2.3.2 additive-only evolution).
    f = FileUploadedV1.model_validate({**_file_kwargs(), "future_field": 7})
    assert f.model_dump()["future_field"] == 7


def test_build_message_created_body_mints_ids() -> None:
    body = build_message_created_body(
        workspace_id=ids.new_workspace_id(),
        stream_id=ids.new_stream_id(),
        author_user_id=ids.new_user_id(),
        author_device_id=ids.new_device_id(),
        client_created_at="2026-07-04T18:22:10.123Z",
        text="Hello everyone",
    )
    assert body.type == "message.created"
    assert body.type_version == 1
    assert ids.is_valid_ulid(body.event_id)
    assert ids.is_valid_typed_id(body.payload["message_id"], "m_")
    # The payload validates cleanly through the registered model.
    model = get_payload_model(body.type, body.type_version)
    assert model is not None
    model.model_validate(body.payload)
