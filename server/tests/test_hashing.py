"""Tests for :mod:`msgd.core.hashing` — ``event_hash`` = sha256 over JCS(body).

Covers the ticket's correctness surface:

* shape/determinism of :func:`hash_event` and the §2.1 anchor;
* body-only property: ``server`` metadata and ``signature`` never affect the hash;
* the raw-body-not-model contract (carryover #1) — ``"type_version":"1"`` (str) and
  ``1`` (int) hash to DIFFERENT digests, and ``model_dump`` collapses them;
* the verify_hash-is-not-the-upload-authority trap (carryover #2);
* the §2.1 redaction exemption;
* a hypothesis tamper property: single-field and single-byte mutations flip the hash
  and fail :func:`verify_hash`.
"""

from __future__ import annotations

import copy
import hashlib
import re
from typing import Any

from hypothesis import assume, given
from hypothesis import strategies as st
from msgd.core import ids
from msgd.core.envelope import Body, Envelope
from msgd.core.hashing import HASH_ALGORITHM, hash_event, verify_hash
from msgd.core.jcs import canonicalize
from msgd.core.payloads import build_message_created_body

ANCHOR_HASH = "sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51"
_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# The exact TDD §2.1 example body (ULID placeholders filled) — same input as the anchor.
EXAMPLE_BODY: dict[str, Any] = {
    "event_id": "01JZ7N6A4M6Y8W5K2H7DGKX4PA",
    "workspace_id": "w_01JZ7N6A4M6Y8W5K2H7DGKX4PB",
    "stream_id": "s_01JZ7N6A4M6Y8W5K2H7DGKX4PC",
    "type": "message.created",
    "type_version": 1,
    "author_user_id": "u_01JZ7N6A4M6Y8W5K2H7DGKX4PD",
    "author_device_id": "d_01JZ7N6A4M6Y8W5K2H7DGKX4PE",
    "client_created_at": "2026-07-04T18:22:10.123Z",
    "payload": {
        "message_id": "m_01JZ7N6A4M6Y8W5K2H7DGKX4PF",
        "text": "Hello everyone",
        "format": "markdown",
        "thread_root_id": None,
        "file_ids": [],
        "mentions": ["u_01JZ7N6A4M6Y8W5K2H7DGKX4PG"],
    },
}


def _valid_body_dict(text: str = "hello") -> dict[str, Any]:
    """A fresh valid message.created body dict (as model_dump'd json)."""
    body = build_message_created_body(
        workspace_id=ids.new_workspace_id(),
        stream_id=ids.new_stream_id(),
        author_user_id=ids.new_user_id(),
        author_device_id=ids.new_device_id(),
        client_created_at="2026-07-04T18:22:10.123Z",
        text=text,
    )
    dumped: dict[str, Any] = body.model_dump(mode="json")
    return dumped


def _envelope(body: dict[str, Any], event_hash: str, **extra: Any) -> Envelope:
    """Build an Envelope from a body dict + hash, with optional signature/server."""
    return Envelope.model_validate({"body": body, "event_hash": event_hash, **extra})


# --------------------------------------------------------------------------- #
# Shape / determinism / anchor.
# --------------------------------------------------------------------------- #


def test_hash_algorithm_constant() -> None:
    assert HASH_ALGORITHM == "sha256"


def test_hash_event_shape_and_anchor() -> None:
    digest = hash_event(EXAMPLE_BODY)
    assert _HASH_RE.match(digest)
    assert digest == ANCHOR_HASH


def test_hash_event_deterministic() -> None:
    assert hash_event(EXAMPLE_BODY) == hash_event(copy.deepcopy(EXAMPLE_BODY))


def test_hash_event_matches_manual_sha256() -> None:
    manual = "sha256:" + hashlib.sha256(canonicalize(EXAMPLE_BODY)).hexdigest()
    assert hash_event(EXAMPLE_BODY) == manual


# --------------------------------------------------------------------------- #
# Body-only: server metadata and signature never affect the hash.
# --------------------------------------------------------------------------- #


def test_verify_hash_true_on_faithful_envelope() -> None:
    body = _valid_body_dict()
    env = _envelope(body, hash_event(body))
    assert verify_hash(env)


def test_server_and_signature_do_not_affect_hash() -> None:
    body = _valid_body_dict()
    digest = hash_event(body)

    # Upload form (no server, null signature) verifies.
    assert verify_hash(_envelope(body, digest))

    # Attaching server metadata and a non-null signature does not change the hash:
    # they are outside `body`, so verify_hash still holds against the same digest.
    env = _envelope(
        body,
        digest,
        signature="sig_reserved_but_set",
        server={
            "server_sequence": 9284,
            "server_received_at": "2026-07-04T18:22:10.456Z",
            "payload_redacted": False,
        },
    )
    assert verify_hash(env)


def test_verify_hash_false_on_tampered_hash() -> None:
    body = _valid_body_dict()
    env = _envelope(body, "sha256:" + "0" * 64)
    assert not verify_hash(env)


# --------------------------------------------------------------------------- #
# Raw-body-not-model contract (carryover #1).
# --------------------------------------------------------------------------- #


def test_raw_string_vs_int_type_version_hash_differently() -> None:
    # A client that sends "type_version": "1" (string) hashed one set of bytes; a client
    # that sends 1 (int) hashed different bytes. hash_event MUST preserve that split.
    int_form = _valid_body_dict()
    str_form = copy.deepcopy(int_form)
    assert int_form["type_version"] == 1
    str_form["type_version"] = "1"

    assert hash_event(int_form) != hash_event(str_form)

    # And Pydantic's lax coercion collapses the string back to int, proving that hashing
    # a model_dump would silently lose the distinction the client actually hashed.
    coerced = Body.model_validate(str_form).model_dump(mode="json")
    assert coerced["type_version"] == 1
    assert hash_event(coerced) == hash_event(int_form)


def test_verify_hash_is_not_upload_authority() -> None:
    # Trap lock: a client faithfully hashed "type_version":"1". On the upload path that
    # raw hash is authoritative — but an Envelope has already coerced the field to int, so
    # verify_hash reflects the COERCED (model_dump) form, not the raw string form.
    str_form = _valid_body_dict()
    str_form["type_version"] = "1"

    raw_hash = hash_event(str_form)  # what the client actually computed
    env = Envelope.model_validate({"body": str_form, "event_hash": raw_hash})

    # The client's faithful raw hash does NOT verify through verify_hash (the coercion
    # has already happened) — this is exactly why §3.2 must use hash_event(raw_dict).
    assert not verify_hash(env)

    # verify_hash only agrees with the coerced-body hash:
    model_hash = hash_event(env.body.model_dump(mode="json"))
    assert raw_hash != model_hash
    assert verify_hash(Envelope.model_validate({"body": str_form, "event_hash": model_hash}))


# --------------------------------------------------------------------------- #
# Redaction exemption (§2.1).
# --------------------------------------------------------------------------- #


def test_redacted_event_is_exempt_from_verification() -> None:
    body = _valid_body_dict()
    env = _envelope(
        body,
        "sha256:" + "0" * 64,  # deliberately wrong
        server={
            "server_sequence": 1,
            "server_received_at": "2026-07-04T18:22:10.456Z",
            "payload_redacted": True,
        },
    )
    assert verify_hash(env)  # redacted -> exempt, True despite the wrong hash


def test_non_redacted_wrong_hash_still_fails() -> None:
    body = _valid_body_dict()
    env = _envelope(
        body,
        "sha256:" + "0" * 64,
        server={
            "server_sequence": 1,
            "server_received_at": "2026-07-04T18:22:10.456Z",
            "payload_redacted": False,
        },
    )
    assert not verify_hash(env)


# --------------------------------------------------------------------------- #
# Tamper property tests (hypothesis).
# --------------------------------------------------------------------------- #

# In-domain JSON values (mirrors the ENG-55 strategy): never generates a value the
# hashing layer legitimately rejects.
_SAFE_INT = st.integers(min_value=-(2**53) + 1, max_value=2**53 - 1)
_SAFE_FLOAT = st.floats(
    allow_nan=False, allow_infinity=False, min_value=-(2**53) + 1, max_value=2**53 - 1
)
_json_scalars = st.one_of(st.none(), st.booleans(), _SAFE_INT, _SAFE_FLOAT, st.text())
_json_values = st.recursive(
    _json_scalars,
    lambda children: st.one_of(
        st.lists(children), st.dictionaries(keys=st.text(), values=children)
    ),
    max_leaves=20,
)


@given(new_text=st.text())
def test_tamper_field_mutation_flips_hash_and_fails_verify(new_text: str) -> None:
    body = _valid_body_dict(text="original")
    assume(new_text != body["payload"]["text"])

    original_hash = hash_event(body)
    assert verify_hash(_envelope(body, original_hash))  # baseline verifies

    mutated = copy.deepcopy(body)
    mutated["payload"]["text"] = new_text

    # Single-field mutation changes the hash ...
    assert hash_event(mutated) != original_hash
    # ... and an envelope carrying the ORIGINAL hash over the mutated body fails verify.
    assert not verify_hash(_envelope(mutated, original_hash))


@given(value=_json_values, data=st.data())
def test_tamper_single_byte_flip_changes_digest(value: Any, data: st.DataObject) -> None:
    canonical = canonicalize(value)
    assume(len(canonical) > 0)
    index = data.draw(st.integers(min_value=0, max_value=len(canonical) - 1))

    flipped = bytearray(canonical)
    flipped[index] ^= 0xFF

    assert hashlib.sha256(bytes(flipped)).digest() != hashlib.sha256(canonical).digest()


@given(a=_json_values, b=_json_values)
def test_distinct_canonical_forms_hash_distinctly(a: Any, b: Any) -> None:
    assume(canonicalize(a) != canonicalize(b))
    assert hash_event(a) != hash_event(b)
