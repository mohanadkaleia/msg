"""Freeze guard for the published JSON Schemas (ENG-62).

``docs/schemas/envelope.schema.json`` and
``docs/schemas/message.created.v1.schema.json`` are the M0 exit-criterion
artifacts the M2 web client and M5 plugin authors consume (§2.2). They are
generated from the Pydantic models by ``server/tests/generate_schemas.py`` and
frozen here: this module regenerates each document in memory and asserts
**byte-equality** to the committed file.

Unlike ``vectors.json`` (data consumed elsewhere, pinned by a SHA constant), a
schema file is self-contained, so a direct string compare is enough — no SHA
needed. Any drift between the models and the committed schemas — including a
pydantic upgrade that changes ``model_json_schema()`` output — fails these tests
until the files are deliberately regenerated and reviewed.

Regenerate with ``uv run python server/tests/generate_schemas.py``.
"""

from __future__ import annotations

import pytest
from generate_schemas import SCHEMAS_DIR, build_documents, serialize

_REGENERATE_HINT = (
    "Committed schema drifted from the Pydantic models (or pydantic changed its "
    "model_json_schema() output). If deliberate, regenerate via "
    "`uv run python server/tests/generate_schemas.py` and review the diff."
)

_DOCUMENTS = build_documents()


@pytest.mark.parametrize("filename", sorted(_DOCUMENTS), ids=lambda f: f)
def test_committed_schema_is_frozen(filename: str) -> None:
    expected = serialize(_DOCUMENTS[filename])
    committed = (SCHEMAS_DIR / filename).read_text(encoding="ascii")
    assert committed == expected, f"{filename}: {_REGENERATE_HINT}"


def test_every_payload_type_is_published() -> None:
    # ENG-73 (ENG-65 M1-exit flag): every registered payload type publishes a
    # frozen `<type>.v<version>.schema.json` alongside the envelope — the M1 meta
    # types (workspace/user/channel/dm) as well as message.created. A newly
    # registered payload model that forgets its published schema fails here.
    from msgd.core.payloads import PAYLOAD_MODELS

    expected = {"envelope.schema.json"} | {
        f"{type_name}.v{version}.schema.json" for (type_name, version) in PAYLOAD_MODELS
    }
    assert set(_DOCUMENTS) == expected
    for filename in expected:
        assert (SCHEMAS_DIR / filename).is_file(), f"{filename} not committed under docs/schemas/"


def test_schema_wrapper_metadata() -> None:
    # Every published schema carries the 2020-12 dialect, a stable msg.dev $id
    # matching its filename, and a human title — the shape M2/M5 tooling keys off.
    for filename, doc in _DOCUMENTS.items():
        assert doc["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert doc["$id"] == f"https://msg.dev/schemas/{filename}"
        assert isinstance(doc["title"], str) and doc["title"]


def test_envelope_schema_keeps_payload_opaque() -> None:
    # The envelope deliberately keeps `payload` an open object (D9) and inlines
    # Body/ServerMetadata as $defs — the typed payload contract lives separately.
    envelope = _DOCUMENTS["envelope.schema.json"]
    assert set(envelope["$defs"]) == {"Body", "ServerMetadata"}
    payload = envelope["$defs"]["Body"]["properties"]["payload"]
    assert payload["type"] == "object"
    assert payload["additionalProperties"] is True


def test_message_schema_locks_format_domain() -> None:
    # §2.2 lock: message.created.format is exactly "markdown" | "plain".
    message = _DOCUMENTS["message.created.v1.schema.json"]
    assert message["properties"]["format"]["enum"] == ["markdown", "plain"]


def test_message_edited_schema_locks_format_domain() -> None:
    # §2.2 lock: message.edited.format reuses the same "markdown" | "plain" domain.
    edited = _DOCUMENTS["message.edited.v1.schema.json"]
    assert edited["properties"]["format"]["enum"] == ["markdown", "plain"]
    assert set(edited["required"]) == {"message_id", "text"}


def test_reaction_schemas_shape() -> None:
    # M3: reaction.added / reaction.removed require (message_id, emoji). The
    # 64-byte emoji bound is a field validator (not a JSON Schema keyword), so the
    # published schema is structural; the byte cap is asserted in the model tests.
    for filename in ("reaction.added.v1.schema.json", "reaction.removed.v1.schema.json"):
        doc = _DOCUMENTS[filename]
        assert set(doc["required"]) == {"message_id", "emoji"}
        assert doc["properties"]["emoji"]["type"] == "string"


def test_message_deleted_schema_shape() -> None:
    deleted = _DOCUMENTS["message.deleted.v1.schema.json"]
    assert deleted["required"] == ["message_id"]
