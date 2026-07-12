"""The SDK hash MUST equal the server's, byte for byte.

Pins :func:`msg_sdk.canonicalize` / :func:`msg_sdk.hash_event` against the repo's
frozen cross-language JCS+hash vectors
(``server/msgd/core/testdata/vectors.json``) — the same file the server, CLI, and
web client are all verified against. Every vector inside the event-body JSON
domain (objects/arrays/strings/ints/bools/null, incl. every ``message.created`` /
``reaction.*`` / ``message.edited`` body) must reproduce the frozen canonical
bytes and hash exactly. Float and must-reject vectors (fractional/exponential
floats, over-cap ints, NaN, over-depth, lone surrogates) are outside the body
domain and are asserted to be *rejected*, never silently mis-hashed.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest
from msg_sdk import JCSError, canonicalize, hash_event

_VECTORS = json.loads(
    (Path(__file__).parents[3] / "server/msgd/core/testdata/vectors.json").read_text("utf-8")
)
_CASES: list[dict[str, Any]] = _VECTORS["cases"]

# Body-shaped vectors that MUST verify — the ones the SDK actually produces.
_MUST_VERIFY = {
    "tdd-2.1-example",
    "body-optional-empty",
    "body-nested-populated",
    "body-unknown-extra-fields",
    "reaction-added-canonical",
    "reaction-added-emoji-bmp-vs16",
    "reaction-added-emoji-max-64-bytes",
    "reaction-removed-canonical",
    "message-edited-markdown",
    "message-edited-plain",
}


def _case(case_id: str) -> dict[str, Any]:
    for case in _CASES:
        if case["id"] == case_id:
            return case
    raise AssertionError(f"vector {case_id!r} not found")


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["id"])
def test_vector(case: dict[str, Any]) -> None:
    try:
        value = json.loads(case["input_json"])
    except ValueError:
        # A must-reject parse case (NaN/Infinity/lone surrogate): never hashed.
        return
    try:
        canonical = canonicalize(value)
    except JCSError:
        # Outside the body domain (fractional float, over-cap int, over-depth):
        # the SDK refuses rather than emit a divergent hash. Such a case must NOT
        # be one of the body vectors the SDK is required to produce.
        assert case["id"] not in _MUST_VERIFY, case["id"]
        return
    assert canonical == base64.b64decode(case["canonical_b64"]), case["id"]
    assert hash_event(value) == case["hash"], case["id"]


def test_all_body_vectors_verified() -> None:
    """Every message/reaction body vector reproduces the frozen hash exactly."""
    for case_id in _MUST_VERIFY:
        case = _case(case_id)
        value = json.loads(case["input_json"])
        assert canonicalize(value) == base64.b64decode(case["canonical_b64"]), case_id
        assert hash_event(value) == case["hash"], case_id


def test_anchor_hash_literal() -> None:
    """A hard-coded regression guard on the TDD §2.1 anchor vector's hash."""
    body = json.loads(_case("tdd-2.1-example")["input_json"])
    expected = "sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51"
    assert hash_event(body) == expected


def test_key_ordering_is_utf16_codeunit() -> None:
    """Astral key U+1F600 sorts BEFORE U+FFFF (UTF-16 code units, not code points)."""
    got = canonicalize({"￿": 1, "\U0001f600": 2})
    assert got == base64.b64decode(_case("keys-utf16-astral")["canonical_b64"])
