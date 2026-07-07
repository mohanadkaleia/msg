"""Deterministic generator for the frozen cross-language vector suite (ENG-56).

Run it to (re)produce ``server/msgd/core/testdata/vectors.json``::

    uv run python server/tests/generate_vectors.py

It defines every case as **raw JSON source text** (``input_json``) plus a valid/reject
classification, computes ``canonical_b64`` + ``hash`` for the valid cases via
``msgd.core.jcs.canonicalize`` / ``msgd.core.hashing.hash_event``, records an ``error``
expectation for the reject cases (never computing a hash), writes the file with a fixed
deterministic serialization (``ensure_ascii=True``, ``indent=2``, LF newlines, trailing
newline, explicit stable key order), and prints the resulting file's SHA-256.

The printed SHA-256 is what ``server/tests/test_vectors.py`` pins in ``VECTORS_SHA256``.
Regenerating on a legitimate vector change is the deliberate path: re-run this script,
the freeze test then fails, and you update the constant in the second place.

This file is the golden suite's producer; it must stay importless of anything beyond
``msgd.core`` + stdlib so it can run anywhere the package is installed.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any, TypedDict

from msgd.core.hashing import hash_event
from msgd.core.jcs import MAX_DEPTH, canonicalize

_INT_INTEROP_MAX = 2**53 - 1
_INT_INTEROP_MIN = -(2**53) + 1

#: Output location: <repo>/server/msgd/core/testdata/vectors.json (this file lives in
#: <repo>/server/tests/), so the JSON ships inside the msgd wheel.
VECTORS_PATH = (
    Path(__file__).resolve().parent.parent / "msgd" / "core" / "testdata" / "vectors.json"
)


class _Case(TypedDict, total=False):
    id: str
    desc: str
    input_json: str
    valid: bool
    error: dict[str, str]


def _depth_list(n: int) -> str:
    """Raw JSON source for a list nested ``n`` deep: ``[`` * n + ``1`` + ``]`` * n."""
    return "[" * n + "1" + "]" * n


def _depth_dict(n: int) -> str:
    """Raw JSON source for a dict nested ``n`` deep: ``{"k":`` * n + ``1`` + ``}`` * n."""
    return '{"k":' * n + "1" + "}" * n


def _compact(obj: Any) -> str:
    """Deterministic compact JSON source text for a structured case value."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


# --- Fixed ids for the body/payload cases (valid typed ULIDs) ------------------------
_EV = "01JZ7N6A4M6Y8W5K2H7DGKX4PA"
_WS = "w_01JZ7N6A4M6Y8W5K2H7DGKX4PB"
_ST = "s_01JZ7N6A4M6Y8W5K2H7DGKX4PC"
_AU = "u_01JZ7N6A4M6Y8W5K2H7DGKX4PD"
_AD = "d_01JZ7N6A4M6Y8W5K2H7DGKX4PE"
_MSG = "m_01JZ7N6A4M6Y8W5K2H7DGKX4PF"
_MEN0 = "u_01JZ7N6A4M6Y8W5K2H7DGKX4PG"
_F1 = "f_01JZ7N6A4M6Y8W5K2H7DGKX4Q1"
_F2 = "f_01JZ7N6A4M6Y8W5K2H7DGKX4Q2"
_MEN1 = "u_01JZ7N6A4M6Y8W5K2H7DGKX4Q3"
_MEN2 = "u_01JZ7N6A4M6Y8W5K2H7DGKX4Q4"
_THREAD = "m_01JZ7N6A4M6Y8W5K2H7DGKX4Q5"


def _body(**overrides: Any) -> dict[str, Any]:
    """A message.created body skeleton, overridable per case."""
    body: dict[str, Any] = {
        "event_id": _EV,
        "workspace_id": _WS,
        "stream_id": _ST,
        "type": "message.created",
        "type_version": 1,
        "author_user_id": _AU,
        "author_device_id": _AD,
        "client_created_at": "2026-07-04T18:22:10.123Z",
        "payload": {
            "message_id": _MSG,
            "text": "Hello everyone",
            "format": "markdown",
            "thread_root_id": None,
            "file_ids": [],
            "mentions": [_MEN0],
        },
    }
    body.update(overrides)
    return body


# --- The frozen case list (§5). ids are stable; the M2 runner keys off them. ---------
CASES: list[_Case] = [
    # Valid — §2.1 & structure
    {
        "id": "tdd-2.1-example",
        "desc": "The exact TDD §2.1 message.created body (ULIDs filled). Anchor vector.",
        "input_json": _compact(_body()),
        "valid": True,
    },
    {"id": "empty-object", "desc": "Empty object.", "input_json": "{}", "valid": True},
    {"id": "empty-array", "desc": "Empty array.", "input_json": "[]", "valid": True},
    {"id": "scalar-null", "desc": "Bare null scalar.", "input_json": "null", "valid": True},
    {"id": "scalar-true", "desc": "Bare true scalar.", "input_json": "true", "valid": True},
    {"id": "scalar-false", "desc": "Bare false scalar.", "input_json": "false", "valid": True},
    {
        "id": "mixed-array",
        "desc": "Heterogeneous array; element order preserved (only object keys reorder).",
        "input_json": '[3,"a",null,true,1,{},[]]',
        "valid": True,
    },
    {
        "id": "nested-under-cap",
        "desc": "Moderate nesting well under MAX_DEPTH; keys reorder, arrays do not.",
        "input_json": '{"a":{},"z":[1,{"y":[2,{"x":[3,[]]}]}]}',
        "valid": True,
    },
    {
        "id": "dup-key-last-wins",
        "desc": (
            "Duplicate object key: json.loads keeps the LAST value (CPython and V8 are "
            "both last-wins). Pins parse-then-hash semantics so a future non-standard TS "
            "parser cannot silently diverge; consumers MUST parse with a last-wins parser."
        ),
        "input_json": '{"a":1,"a":2}',
        "valid": True,
    },
    # Valid — key ordering
    {
        "id": "keys-unsorted",
        "desc": "Object keys emitted in sorted order.",
        "input_json": '{"b":1,"a":2,"c":3}',
        "valid": True,
    },
    {
        "id": "keys-case-sensitive",
        "desc": "Uppercase ASCII keys sort before lowercase (byte/code-unit order).",
        "input_json": '{"b":1,"B":2,"a":3,"A":4}',
        "valid": True,
    },
    {
        "id": "keys-utf16-astral",
        "desc": (
            "Keys sorted by UTF-16 code units: U+1F600 (lead surrogate 0xD83D) sorts "
            "BEFORE U+FFFF. Naive code-point sort and json.dumps(sort_keys=True) get "
            "this wrong."
        ),
        "input_json": '{"\\uffff":1,"\\ud83d\\ude00":2}',
        "valid": True,
    },
    # Valid — unicode text
    {
        "id": "unicode-bmp",
        "desc": "BMP accents and CJK, emitted as raw UTF-8.",
        "input_json": '"caf\\u00e9 \\u00fcn\\u00efc\\u00f6 \\u4e16\\u754c"',
        "valid": True,
    },
    {
        "id": "unicode-astral",
        "desc": "Astral chars U+1F600 (emoji) and U+1D11E (G-clef) as raw UTF-8, not escaped.",
        "input_json": '{"clef":"\\ud834\\udd1e","emoji":"\\ud83d\\ude00"}',
        "valid": True,
    },
    {
        "id": "unicode-nfc",
        "desc": "Composed e-acute (NFC, U+00E9). Distinct hash from unicode-nfd; JCS never normalizes.",  # noqa: E501
        "input_json": '"\\u00e9"',
        "valid": True,
    },
    {
        "id": "unicode-nfd",
        "desc": "Decomposed e-acute (NFD, U+0065 U+0301). Distinct hash from unicode-nfc.",
        "input_json": '"e\\u0301"',
        "valid": True,
    },
    # Valid — escapes (incl. the raw-byte case that forces base64)
    {
        "id": "escapes-short",
        "desc": 'JCS two-char escapes for " \\ \\n \\t \\b \\f \\r.',
        "input_json": '"\\"\\\\\\n\\t\\b\\f\\r"',
        "valid": True,
    },
    {
        "id": "escapes-control",
        "desc": "Control chars below 0x20 without a short escape use lowercase \\u00XX.",
        "input_json": '"\\u0000\\u0001\\u001f"',
        "valid": True,
    },
    {
        "id": "raw-0x7f",
        "desc": (
            "Canonical bytes contain a literal 0x7f (DEL is NOT escaped by JCS) — the "
            "concrete reason canonical_b64 cannot be a JSON string."
        ),
        "input_json": '{"a":1,"x":"\\u007f"}',
        "valid": True,
    },
    # Valid — numbers (ES6 Number::toString table, each its own vector)
    {"id": "num-int-zero", "desc": "Integer 0.", "input_json": "0", "valid": True},
    {
        "id": "num-neg-zero-int",
        "desc": "Source -0 (integer) canonicalizes to 0.",
        "input_json": "-0",
        "valid": True,
    },  # noqa: E501
    {
        "id": "num-neg-zero-float",
        "desc": "Source -0.0 (float) canonicalizes to 0.",
        "input_json": "-0.0",
        "valid": True,
    },  # noqa: E501
    {"id": "num-int-one", "desc": "Integer 1.", "input_json": "1", "valid": True},
    {"id": "num-neg-one", "desc": "Integer -1.", "input_json": "-1", "valid": True},
    {
        "id": "num-float-two",
        "desc": "Source 2.0 (float) canonicalizes to 2.",
        "input_json": "2.0",
        "valid": True,
    },  # noqa: E501
    {
        "id": "num-cap-max",
        "desc": "2^53-1, the largest accepted integer (interop cap boundary).",
        "input_json": "9007199254740991",
        "valid": True,
    },
    {"id": "num-frac", "desc": "0.1.", "input_json": "0.1", "valid": True},
    {
        "id": "num-exp-large",
        "desc": "1e30 canonicalizes to 1e+30.",
        "input_json": "1e30",
        "valid": True,
    },  # noqa: E501
    {"id": "num-exp-small", "desc": "1e-7.", "input_json": "1e-7", "valid": True},
    {
        "id": "num-9999e22",
        "desc": "9.999e22 canonicalizes to 9.999e+22.",
        "input_json": "9.999e22",
        "valid": True,
    },  # noqa: E501
    {"id": "num-1e21", "desc": "1e21 canonicalizes to 1e+21.", "input_json": "1e21", "valid": True},
    {
        "id": "num-subnormal",
        "desc": "5e-324, smallest positive double (subnormal).",
        "input_json": "5e-324",
        "valid": True,
    },  # noqa: E501
    # Valid — bodies / payloads / extras
    {
        "id": "body-optional-empty",
        "desc": "message.created body with null thread_root_id and empty file_ids/mentions.",
        "input_json": _compact(
            _body(
                payload={
                    "message_id": _MSG,
                    "text": "hi",
                    "format": "markdown",
                    "thread_root_id": None,
                    "file_ids": [],
                    "mentions": [],
                }
            )
        ),
        "valid": True,
    },
    {
        "id": "body-nested-populated",
        "desc": "Body with populated file_ids, mentions, and a non-null thread_root_id.",
        "input_json": _compact(
            _body(
                payload={
                    "message_id": _MSG,
                    "text": "with refs",
                    "format": "markdown",
                    "thread_root_id": _THREAD,
                    "file_ids": [_F1, _F2],
                    "mentions": [_MEN1, _MEN2],
                }
            )
        ),
        "valid": True,
    },
    {
        "id": "body-unknown-extra-fields",
        "desc": (
            "Body with an extra top-level field AND an extra field inside payload "
            "(§2.3 additive). Unknown fields are part of body, are canonicalized, and "
            "DO change the hash — unlike server metadata."
        ),
        "input_json": _compact(
            _body(
                future_field={"anything": [1, 2, 3]},
                payload={
                    "message_id": _MSG,
                    "text": "Hello everyone",
                    "format": "markdown",
                    "thread_root_id": None,
                    "file_ids": [],
                    "mentions": [_MEN0],
                    "future_payload_field": "kept",
                },
            )
        ),
        "valid": True,
    },
    # Valid — M3 new payload types (reaction.added/removed, message.edited/deleted).
    # These prove the new payload *bodies* canonicalize + hash byte-identically in
    # Python and TS. Payload-shape *validation* (empty/oversized emoji, bad ULID,
    # missing message_id) is model-level — it hashes fine, so it lives in the
    # payload model unit tests, not this JCS+hash suite. The only new-type reject
    # that belongs here is a JCS-level one (lone surrogate in emoji), below.
    {
        "id": "reaction-added-canonical",
        "desc": "reaction.added body; single multi-byte emoji (U+1F44D, 4 UTF-8 bytes).",
        "input_json": _compact(
            _body(
                type="reaction.added",
                payload={"message_id": _MSG, "emoji": "\U0001f44d"},
            )
        ),
        "valid": True,
    },
    {
        "id": "reaction-added-emoji-bmp-vs16",
        "desc": (
            "reaction.added with a BMP emoji + variation selector (U+2764 U+FE0F, "
            "6 UTF-8 bytes) — a multi-code-point grapheme, emitted as raw UTF-8."
        ),
        "input_json": _compact(
            _body(
                type="reaction.added",
                payload={"message_id": _MSG, "emoji": "❤️"},
            )
        ),
        "valid": True,
    },
    {
        "id": "reaction-added-emoji-max-64-bytes",
        "desc": (
            "reaction.added at the emoji domain boundary: 16 x U+1F600 = exactly "
            "64 UTF-8 bytes (MAX_EMOJI_BYTES). Pins the accept edge of the locked "
            "emoji domain; canonicalization is byte-identical cross-language."
        ),
        "input_json": _compact(
            _body(
                type="reaction.added",
                payload={"message_id": _MSG, "emoji": "\U0001f600" * 16},
            )
        ),
        "valid": True,
    },
    {
        "id": "reaction-removed-canonical",
        "desc": "reaction.removed body; single multi-byte emoji (U+1F389).",
        "input_json": _compact(
            _body(
                type="reaction.removed",
                payload={"message_id": _MSG, "emoji": "\U0001f389"},
            )
        ),
        "valid": True,
    },
    {
        "id": "message-edited-markdown",
        "desc": "message.edited body with the replacement text and format=markdown.",
        "input_json": _compact(
            _body(
                type="message.edited",
                payload={"message_id": _MSG, "text": "edited body", "format": "markdown"},
            )
        ),
        "valid": True,
    },
    {
        "id": "message-edited-plain",
        "desc": "message.edited body with format=plain (the other locked format value).",
        "input_json": _compact(
            _body(
                type="message.edited",
                payload={"message_id": _MSG, "text": "plain edit", "format": "plain"},
            )
        ),
        "valid": True,
    },
    {
        "id": "message-deleted-canonical",
        "desc": "message.deleted tombstone body; payload is just the target message_id.",
        "input_json": _compact(
            _body(
                type="message.deleted",
                payload={"message_id": _MSG},
            )
        ),
        "valid": True,
    },
    # Valid — depth cap acceptance boundary (MAX_DEPTH)
    {
        "id": "depth-at-cap-list",
        "desc": "List nested exactly MAX_DEPTH deep; accepted. Pins the acceptance boundary.",
        "input_json": _depth_list(MAX_DEPTH),
        "valid": True,
    },
    {
        "id": "depth-at-cap-dict",
        "desc": "Dict nested exactly MAX_DEPTH deep; accepted.",
        "input_json": _depth_dict(MAX_DEPTH),
        "valid": True,
    },
    # Reject — invalid input (error, no hash)
    {
        "id": "reject-nan",
        "desc": "NaN is non-finite (Python parses it, canonicalize rejects; JS rejects at parse).",
        "input_json": "NaN",
        "error": {"kind": "non_finite_float", "stage": "canonicalize"},
    },
    {
        "id": "reject-infinity",
        "desc": "Infinity is non-finite.",
        "input_json": "Infinity",
        "error": {"kind": "non_finite_float", "stage": "canonicalize"},
    },
    {
        "id": "reject-neg-infinity",
        "desc": "-Infinity is non-finite.",
        "input_json": "-Infinity",
        "error": {"kind": "non_finite_float", "stage": "canonicalize"},
    },
    {
        "id": "reject-surrogate-key",
        "desc": "Lone-surrogate object key (\\ud800). Key path — must surface as a reject, not a 500.",  # noqa: E501
        "input_json": '{"\\ud800":1}',
        "error": {"kind": "lone_surrogate", "stage": "canonicalize"},
    },
    {
        "id": "reject-surrogate-value",
        "desc": "Lone-surrogate string value (\\ud800).",
        "input_json": '{"x":"\\ud800"}',
        "error": {"kind": "lone_surrogate", "stage": "canonicalize"},
    },
    {
        "id": "reject-reaction-emoji-lone-surrogate",
        "desc": (
            "reaction.added whose emoji carries a lone surrogate (\\ud800). The new "
            "payload types ride the SAME canonicalization: an unpaired surrogate in "
            "emoji must reject cross-language, never produce a hash."
        ),
        "input_json": '{"message_id":"m_01JZ7N6A4M6Y8W5K2H7DGKX4PF","emoji":"\\ud800"}',
        "error": {"kind": "lone_surrogate", "stage": "canonicalize"},
    },
    {
        "id": "reject-int-over-cap",
        "desc": (
            "2^53 exceeds the interop cap. Cross-language caveat: JS JSON.parse silently "
            "truncates to 2^53, so the TS client must reject on magnitude, not exact compare."
        ),
        "input_json": "9007199254740992",
        "error": {"kind": "integer_out_of_range", "stage": "canonicalize"},
    },
    {
        "id": "reject-int-over-cap-plus1",
        "desc": "2^53+1 exceeds the interop cap.",
        "input_json": "9007199254740993",
        "error": {"kind": "integer_out_of_range", "stage": "canonicalize"},
    },
    {
        "id": "reject-depth-over-cap-list",
        "desc": "List nested MAX_DEPTH+1 deep; over the cap.",
        "input_json": _depth_list(MAX_DEPTH + 1),
        "error": {"kind": "max_depth_exceeded", "stage": "canonicalize"},
    },
    {
        "id": "reject-depth-over-cap-dict",
        "desc": "Dict nested MAX_DEPTH+1 deep; over the cap.",
        "input_json": _depth_dict(MAX_DEPTH + 1),
        "error": {"kind": "max_depth_exceeded", "stage": "canonicalize"},
    },
    {
        "id": "reject-depth-pathological",
        "desc": (
            "2000-deep list (the reviewer repro). Must reject cleanly via the iterative "
            "depth pre-pass — no RecursionError escapes on the parse-then-hash path."
        ),
        "input_json": _depth_list(2000),
        "error": {"kind": "max_depth_exceeded", "stage": "canonicalize"},
    },
]


def _build_meta() -> dict[str, Any]:
    return {
        "purpose": "Frozen cross-language JCS+hash vectors for msg (M0 exit criterion).",
        "spec": "event_hash = 'sha256:' + hex(sha256(RFC8785-JCS(body)))",
        "input": (
            "input_json is raw JSON SOURCE TEXT. Consumers MUST json-parse it with their "
            "standard parser, then hash the parsed value — this mirrors the §3.2 wire path "
            "(bytes -> parse -> hash) and is the ONLY representation that can carry the "
            "must-reject inputs (NaN, lone surrogates, over-depth, over-cap integers)."
        ),
        "encoding": "base64",
        "hash_format": "sha256:<lowercase-hex>",
        "max_depth": MAX_DEPTH,
        "int_interop_cap": [_INT_INTEROP_MIN, _INT_INTEROP_MAX],
        "version": 1,
        "frozen": True,
        "note_ts_client": (
            "JSON.parse loses precision >= 2^53 and rejects NaN/Infinity at PARSE time; "
            "error cases are stage-agnostic ('must not produce a hash') — the 'stage' field "
            "is a hint, not a hard assertion, because parsers differ."
        ),
    }


def _render_case(case: _Case) -> dict[str, Any]:
    """Turn a source case into its serialized form, computing hashes for valid cases."""
    out: dict[str, Any] = {"id": case["id"], "desc": case["desc"], "input_json": case["input_json"]}
    if case.get("valid"):
        value = json.loads(case["input_json"])
        canonical = canonicalize(value)
        out["canonical_b64"] = base64.b64encode(canonical).decode("ascii")
        out["hash"] = hash_event(value)
    else:
        out["error"] = case["error"]
    return out


def build_document() -> dict[str, Any]:
    """Assemble the full ``{_meta, cases}`` document."""
    seen: set[str] = set()
    for case in CASES:
        if case["id"] in seen:
            raise ValueError(f"duplicate case id: {case['id']!r}")
        seen.add(case["id"])
    return {"_meta": _build_meta(), "cases": [_render_case(c) for c in CASES]}


def serialize(document: dict[str, Any]) -> str:
    """Deterministic serialization: ASCII, indent=2, LF, trailing newline, explicit order."""
    return json.dumps(document, ensure_ascii=True, indent=2, sort_keys=False) + "\n"


def main() -> None:
    document = build_document()
    text = serialize(document)
    VECTORS_PATH.write_text(text, encoding="ascii", newline="\n")
    digest = hashlib.sha256(text.encode("ascii")).hexdigest()
    n_valid = sum(1 for c in CASES if c.get("valid"))
    n_reject = len(CASES) - n_valid
    print(f"wrote {VECTORS_PATH} ({len(CASES)} cases: {n_valid} valid, {n_reject} reject)")
    print(f"VECTORS_SHA256 = {digest!r}")


if __name__ == "__main__":
    main()
