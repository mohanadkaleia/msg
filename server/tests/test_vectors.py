"""Runner + freeze guard for the frozen cross-language vector suite (ENG-56).

``server/msgd/core/testdata/vectors.json`` is the M0 exit-criterion artifact: the golden
``raw JSON source -> canonical bytes -> sha256`` suite the M2 TypeScript client must
reproduce bit-for-bit. This module proves the Python implementation passes every vector,
that each valid case is internally consistent (``sha256(b64decode(canonical_b64)) ==
hash``), that the ``_meta`` format the M2 client consumes is intact, and that the file is
frozen: any edit changes its bytes, fails :func:`test_vectors_file_is_frozen`, and forces
a deliberate update of :data:`VECTORS_SHA256` in this second place.

Regenerate with ``uv run python server/tests/generate_vectors.py`` (which prints the new
``VECTORS_SHA256``) whenever a vector legitimately changes.
"""

from __future__ import annotations

import base64
import hashlib
import json
from importlib.resources import files
from typing import Any

import pytest
from msgd.core import jcs
from msgd.core.hashing import hash_event
from msgd.core.jcs import JCSError, canonicalize

#: SHA-256 of the frozen ``vectors.json`` raw bytes. Kept ONLY here (never inside the
#: file — that would be self-referential). Emitted by generate_vectors.py; update it in
#: lock-step whenever the frozen suite legitimately changes. The two-place edit IS the
#: "edits require a deliberate decision" acceptance criterion.
VECTORS_SHA256 = "be4c2dcbb2e68299e63adc656251609786a48227480e63a8c3783bef8ce7cdc0"

#: The §2.1 anchor hash, independently computed during planning and pinned here so the
#: golden file is not purely self-referential.
ANCHOR_HASH = "sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51"

_VECTORS_RESOURCE = files("msgd.core.testdata").joinpath("vectors.json")
_RAW_BYTES = _VECTORS_RESOURCE.read_bytes()
_DOCUMENT: dict[str, Any] = json.loads(_RAW_BYTES)
_META: dict[str, Any] = _DOCUMENT["_meta"]
_CASES: list[dict[str, Any]] = _DOCUMENT["cases"]

_VALID_CASES = [c for c in _CASES if "hash" in c]
_REJECT_CASES = [c for c in _CASES if "error" in c]


def _case_id(case: dict[str, Any]) -> str:
    return str(case["id"])


# --------------------------------------------------------------------------- #
# Valid cases: Python reproduces every canonical-bytes + hash vector.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("case", _VALID_CASES, ids=_case_id)
def test_valid_vector(case: dict[str, Any]) -> None:
    parsed = json.loads(case["input_json"])
    expected_canonical = base64.b64decode(case["canonical_b64"])

    # (a) our JCS bytes match the frozen canonical bytes (isolates JCS from hashing),
    assert canonicalize(parsed) == expected_canonical
    # (b) hash_event reproduces the frozen hash,
    assert hash_event(parsed) == case["hash"]
    # (c) internal consistency: the hash really is sha256 over those canonical bytes.
    recomputed = "sha256:" + hashlib.sha256(expected_canonical).hexdigest()
    assert recomputed == case["hash"]


# --------------------------------------------------------------------------- #
# Reject cases: the input must NOT yield a hash (stage-agnostic), and no
# unexpected exception (e.g. RecursionError) may escape.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("case", _REJECT_CASES, ids=_case_id)
def test_reject_vector(case: dict[str, Any]) -> None:
    # Wrap json.loads too, so a parse-stage rejection (e.g. a JS-like parser) also counts
    # as "no hash". Python parses NaN/Infinity/over-cap ints fine and rejects at
    # canonicalize; either way the overall attempt must raise, and RecursionError (not in
    # the tuple) escaping would fail this test — pinning the depth pre-pass.
    with pytest.raises((JCSError, json.JSONDecodeError)):
        hash_event(json.loads(case["input_json"]))


# --------------------------------------------------------------------------- #
# Format + anchor + freeze guard.
# --------------------------------------------------------------------------- #


def test_meta_format() -> None:
    assert _META["encoding"] == "base64"
    assert _META["max_depth"] == jcs.MAX_DEPTH
    assert _META["version"] == 1
    assert _META["frozen"] is True
    assert _META["hash_format"] == "sha256:<lowercase-hex>"
    assert _META["int_interop_cap"] == [-(2**53) + 1, 2**53 - 1]


def test_every_case_has_exactly_one_expectation() -> None:
    # A case carries EITHER (canonical_b64 + hash) for valid OR error for reject.
    for case in _CASES:
        is_valid = "hash" in case
        is_reject = "error" in case
        assert is_valid != is_reject, case["id"]
        if is_valid:
            assert "canonical_b64" in case, case["id"]


def test_case_ids_unique() -> None:
    ids = [c["id"] for c in _CASES]
    assert len(ids) == len(set(ids))


def test_2_1_anchor() -> None:
    (anchor,) = [c for c in _CASES if c["id"] == "tdd-2.1-example"]
    assert anchor["hash"] == ANCHOR_HASH


def test_vectors_file_is_frozen() -> None:
    digest = hashlib.sha256(_RAW_BYTES).hexdigest()
    assert digest == VECTORS_SHA256, (
        "vectors.json changed. If deliberate, regenerate via "
        "`uv run python server/tests/generate_vectors.py` and update VECTORS_SHA256."
    )
