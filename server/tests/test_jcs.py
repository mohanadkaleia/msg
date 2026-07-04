"""Tests for :mod:`msgd.core.jcs` — RFC 8785 (JCS) canonicalization.

Covers the ticket-required acceptance surface:

* RFC 8785 Appendix B worked example + the ES6 number-formatting samples;
* the technical-design §2.1 example ``body`` (deterministic, order-invariant, snapshot);
* edge cases (key ordering, nesting, unicode incl. astral plane, numbers incl. the
  ``2**53`` boundary, escapes, null/bool, rejections);
* the round-trip property ``canonicalize(json.loads(canonicalize(x))) == canonicalize(x)``.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st
from msgd.core.jcs import MAX_DEPTH, JCSError, canonicalize

# --------------------------------------------------------------------------- #
# A. RFC 8785 appendix vectors (acceptance)
# --------------------------------------------------------------------------- #

# RFC 8785 Appendix B "string" member, decoded from its JSON escapes. The chars
# are: euro, dollar, U+000F, newline, A, apostrophe, B, quote, backslash, quote, slash.
_RFC_APPENDIX_B_STRING = '€$\nA\'B"\\"/'

RFC_APPENDIX_B_INPUT: dict[str, Any] = {
    "numbers": [
        333333333.33333329,
        1e30,
        4.50,
        2e-3,
        0.000000000000000000000000001,
    ],
    "string": _RFC_APPENDIX_B_STRING,
    "literals": [None, True, False],
}

# Expected canonical output, verbatim from RFC 8785 Appendix B.
RFC_APPENDIX_B_EXPECTED = (
    '{"literals":[null,true,false],'
    '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
    '"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}'
).encode()


def test_rfc8785_appendix_b_worked_example() -> None:
    assert canonicalize(RFC_APPENDIX_B_INPUT) == RFC_APPENDIX_B_EXPECTED


# RFC 8785 §3.2.2.3 / Appendix B ES6 ``Number::toString`` samples. This is the
# highest-signal correctness check: shortest round-trip + exponent normalization.
ES6_NUMBER_SAMPLES: list[tuple[int | float, str]] = [
    (0, "0"),
    (-0, "0"),
    (-0.0, "0"),
    (1, "1"),
    (-1, "-1"),
    (2**53 - 1, "9007199254740991"),
    (-(2**53) + 1, "-9007199254740991"),
    (0.1, "0.1"),
    (1e30, "1e+30"),
    (1e21, "1e+21"),
    (1e-7, "1e-7"),
    (9.999e22, "9.999e+22"),
    (4.50, "4.5"),
    (2e-3, "0.002"),
    (333333333.33333329, "333333333.3333333"),
    (5e-324, "5e-324"),  # smallest positive double (subnormal)
]


@pytest.mark.parametrize(("value", "expected"), ES6_NUMBER_SAMPLES)
def test_es6_number_formatting(value: int | float, expected: str) -> None:
    assert canonicalize(value) == expected.encode("ascii")


# --------------------------------------------------------------------------- #
# B. §2.1 example body fixture (acceptance — deterministic output)
# --------------------------------------------------------------------------- #

# The exact `message.created` envelope body from technical-design §2.1, with the
# `...` ULID placeholders filled in with concrete typed ULIDs.
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

# Snapshot of `canonicalize(EXAMPLE_BODY)`. This is the exact byte string ENG-56 will
# hash and freeze as a vector; any drift must fail loudly here.
EXAMPLE_BODY_CANONICAL = (
    b'{"author_device_id":"d_01JZ7N6A4M6Y8W5K2H7DGKX4PE",'
    b'"author_user_id":"u_01JZ7N6A4M6Y8W5K2H7DGKX4PD",'
    b'"client_created_at":"2026-07-04T18:22:10.123Z",'
    b'"event_id":"01JZ7N6A4M6Y8W5K2H7DGKX4PA",'
    b'"payload":{"file_ids":[],"format":"markdown",'
    b'"mentions":["u_01JZ7N6A4M6Y8W5K2H7DGKX4PG"],'
    b'"message_id":"m_01JZ7N6A4M6Y8W5K2H7DGKX4PF",'
    b'"text":"Hello everyone","thread_root_id":null},'
    b'"stream_id":"s_01JZ7N6A4M6Y8W5K2H7DGKX4PC",'
    b'"type":"message.created","type_version":1,'
    b'"workspace_id":"w_01JZ7N6A4M6Y8W5K2H7DGKX4PB"}'
)


def test_example_body_snapshot() -> None:
    assert canonicalize(EXAMPLE_BODY) == EXAMPLE_BODY_CANONICAL


def test_example_body_deterministic_across_calls() -> None:
    assert canonicalize(EXAMPLE_BODY) == canonicalize(EXAMPLE_BODY)


def test_example_body_invariant_to_key_insertion_order() -> None:
    # Rebuild the body (and its nested payload) with keys inserted in reverse order.
    shuffled: dict[str, Any] = dict(reversed(list(EXAMPLE_BODY.items())))
    shuffled["payload"] = dict(reversed(list(EXAMPLE_BODY["payload"].items())))
    assert list(shuffled) != list(EXAMPLE_BODY)  # insertion order really differs
    assert canonicalize(shuffled) == EXAMPLE_BODY_CANONICAL


# --------------------------------------------------------------------------- #
# C. Edge cases
# --------------------------------------------------------------------------- #

# --- Key ordering ---------------------------------------------------------- #


def test_key_ordering_unsorted() -> None:
    assert canonicalize({"b": 1, "a": 2, "c": 3}) == b'{"a":2,"b":1,"c":3}'


def test_key_ordering_case_sensitive() -> None:
    # Uppercase ASCII (0x41+) sorts before lowercase (0x61+).
    assert canonicalize({"b": 1, "B": 2, "a": 3, "A": 4}) == b'{"A":4,"B":2,"a":3,"b":1}'


def test_key_ordering_utf16_code_unit_astral() -> None:
    # JCS sorts keys by UTF-16 code units, not Unicode code points. An astral-plane
    # char (U+1F600) is a surrogate pair whose lead unit 0xD83D is LESS than the BMP
    # code unit 0xFFFF, so the astral key sorts BEFORE the U+FFFF key. Naive code-point
    # ordering would put U+1F600 last; this locks the UTF-16 rule.
    result = canonicalize({"￿": 1, "\U0001f600": 2})
    assert result == '{"\U0001f600":2,"￿":1}'.encode("utf-8")


# --- Nested structures ----------------------------------------------------- #


def test_empty_object_and_array() -> None:
    assert canonicalize({}) == b"{}"
    assert canonicalize([]) == b"[]"


def test_deep_nesting() -> None:
    obj: dict[str, Any] = {"z": [1, {"y": [2, {"x": [3, []]}]}], "a": {}}
    assert canonicalize(obj) == b'{"a":{},"z":[1,{"y":[2,{"x":[3,[]]}]}]}'


def test_array_of_mixed_types_preserves_order() -> None:
    # Array order is preserved (only object keys are reordered).
    assert canonicalize([3, "a", None, True, 1, {}, []]) == b'[3,"a",null,true,1,{},[]]'


# --- Unicode --------------------------------------------------------------- #


def test_unicode_astral_plane_roundtrips_as_utf8() -> None:
    # Astral chars are emitted as raw UTF-8 (not \uXXXX escaped): U+1D11E and emoji.
    assert canonicalize("\U0001d11e") == '"\U0001d11e"'.encode("utf-8")
    assert canonicalize("\U0001f600") == '"\U0001f600"'.encode("utf-8")


def test_unicode_is_not_normalized() -> None:
    # NFC "é" (U+00E9) and NFD "é" (U+0065 U+0301) are distinct inputs; JCS must NOT
    # normalize them together. NFC is the client's responsibility, not JCS's.
    nfc = "é"
    nfd = "é"
    assert nfc != nfd
    assert canonicalize(nfc) == '"é"'.encode()
    assert canonicalize(nfd) == '"é"'.encode()
    assert canonicalize(nfc) != canonicalize(nfd)


# --- Escapes --------------------------------------------------------------- #


def test_escapes_short_forms() -> None:
    # Two-character escapes mandated by JCS.
    assert canonicalize('"') == b'"\\""'
    assert canonicalize("\\") == b'"\\\\"'
    assert canonicalize("\n") == b'"\\n"'
    assert canonicalize("\t") == b'"\\t"'
    assert canonicalize("\b") == b'"\\b"'
    assert canonicalize("\f") == b'"\\f"'
    assert canonicalize("\r") == b'"\\r"'


def test_escapes_control_chars_use_uXXXX() -> None:
    # Control chars below 0x20 without a short escape use lowercase \u00XX.
    assert canonicalize("\x00") == b'"\\u0000"'
    assert canonicalize("\x1f") == b'"\\u001f"'
    assert canonicalize("\x0f") == b'"\\u000f"'
    # 0x7F (DEL) is NOT escaped by JCS.
    assert canonicalize("\x7f") == b'"\x7f"'
    # Forward slash is NOT escaped.
    assert canonicalize("a/b") == b'"a/b"'


# --- Numbers --------------------------------------------------------------- #


def test_negative_zero_int_and_float_become_zero() -> None:
    assert canonicalize(-0) == b"0"
    assert canonicalize(-0.0) == b"0"


def test_integer_interop_cap_boundary() -> None:
    # 2**53 - 1 is accepted; 2**53 is outside the RFC 8785 interop cap and rejected.
    assert canonicalize(2**53 - 1) == b"9007199254740991"
    assert canonicalize(-(2**53) + 1) == b"-9007199254740991"
    with pytest.raises(JCSError):
        canonicalize(2**53)
    with pytest.raises(JCSError):
        canonicalize(-(2**53))


def test_float_and_int_two_serialize_identically() -> None:
    # Per ES6 number formatting, 2.0 and 2 both serialize to "2".
    assert canonicalize(2.0) == b"2"
    assert canonicalize(2) == b"2"


# --- null / bool ----------------------------------------------------------- #


def test_null_and_bool() -> None:
    assert canonicalize(None) == b"null"
    assert canonicalize(True) == b"true"
    assert canonicalize(False) == b"false"


def test_bool_not_confused_with_int() -> None:
    # bool must render as true/false, never as 1/0.
    assert canonicalize(True) != canonicalize(1)
    assert canonicalize(False) != canonicalize(0)
    assert canonicalize([True, 1, False, 0]) == b"[true,1,false,0]"


# --- Rejections ------------------------------------------------------------ #


def test_nan_and_infinity_rejected() -> None:
    for bad in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(JCSError):
            canonicalize(bad)


def test_non_json_types_rejected_as_jcs_error() -> None:
    import datetime
    from decimal import Decimal

    bad_values: list[object] = [
        b"bytes",
        Decimal("1.5"),
        {1, 2, 3},
        datetime.datetime(2026, 7, 4),
        object(),
    ]
    for bad in bad_values:
        with pytest.raises(JCSError):
            canonicalize(bad)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("bad_mapping", "reason"),
    [
        pytest.param({1: "a"}, "int key", id="int-key"),
        # bool-as-key regression guard (the issubclass(bool, int) trap): the library
        # rejects non-str keys outright — it does NOT coerce True -> "true", so no
        # {True: 1} vs {"true": 1} canonicalization collision is possible.
        pytest.param({True: "a"}, "bool key", id="bool-key"),
        # Lone-surrogate key: a *valid* Python str, so it passes JSONValue typing, but
        # the library leaks UnicodeEncodeError (from its UTF-16BE key sort) instead of
        # CanonicalizationError. Client-reachable via json.loads on upload (§3.2
        # validation hardening); the wrapper must surface it as JCSError, not a 500.
        pytest.param({"\ud800": 1}, "lone-surrogate key", id="surrogate-key"),
    ],
)
def test_bad_object_key_rejected(bad_mapping: Any, reason: str) -> None:
    with pytest.raises(JCSError):
        canonicalize(bad_mapping)


def test_rejections_do_not_leak_library_exception() -> None:
    # Callers must only ever see JCSError, never a raw rfc8785.* exception. JCSError
    # is a ValueError but we assert it is exactly our type by module.
    with pytest.raises(JCSError) as exc_info:
        canonicalize(2**53)
    assert type(exc_info.value).__module__ == "msgd.core.jcs"
    assert str(exc_info.value)  # message is non-empty / actionable


# --- Nesting depth cap (MAX_DEPTH — protocol constant under D1) ------------- #


def _nested_list(depth: int) -> Any:
    obj: Any = 1
    for _ in range(depth):
        obj = [obj]
    return obj


def test_depth_at_cap_accepted() -> None:
    # A list nested exactly MAX_DEPTH deep canonicalizes, byte-exact. (128 appears
    # literally only here, in the expected-bytes literal.)
    assert canonicalize(_nested_list(MAX_DEPTH)) == b"[" * 128 + b"1" + b"]" * 128


def test_depth_over_cap_rejected_list_and_dict() -> None:
    # One level past the cap raises JCSError, for both container kinds.
    with pytest.raises(JCSError):
        canonicalize(_nested_list(MAX_DEPTH + 1))
    obj: Any = 1
    for _ in range(MAX_DEPTH + 1):
        obj = {"k": obj}
    with pytest.raises(JCSError):
        canonicalize(obj)


def test_reviewer_repro_deep_json_rejected_cleanly() -> None:
    # Security-review repro: ~4 KB of JSON (far under the 64 KB event cap) parses fine
    # via the C scanner but used to blow the interpreter stack inside rfc8785.dumps at
    # depth ~997 with RecursionError, which is NOT a ValueError and escaped the wrapper
    # (unhandled 500 at the §3.2 upload path). pytest.raises(JCSError) inherently
    # asserts no RecursionError escapes on the parse-then-canonicalize path.
    deep = json.loads("[" * 2000 + "1" + "]" * 2000)
    with pytest.raises(JCSError):
        canonicalize(deep)


def test_depth_cap_does_not_affect_real_bodies() -> None:
    # Depth-counting sanity: the §2.1 example body is depth 3 (body -> payload ->
    # file_ids/mentions), nowhere near MAX_DEPTH; the pre-pass changes nothing for
    # real bodies and the frozen snapshot is untouched.
    assert 3 < MAX_DEPTH
    assert canonicalize(EXAMPLE_BODY) == EXAMPLE_BODY_CANONICAL


# --------------------------------------------------------------------------- #
# D. Property test (acceptance — round-trip idempotence)
# --------------------------------------------------------------------------- #

# In-domain JSON values only, so the strategy never generates a value the module
# legitimately rejects:
#   * no NaN / Infinity;
#   * integers within the RFC 8785 interop cap [-(2**53)+1, 2**53-1];
#   * floats with magnitude below 2**53 — an *integral* float in [2**53, 1e21) would
#     serialize in plain form and trip the same interop cap; large exponent-form floats
#     (1e30, subnormals, ...) are covered explicitly by ES6_NUMBER_SAMPLES instead.
_SAFE_INT = st.integers(min_value=-(2**53) + 1, max_value=2**53 - 1)
_SAFE_FLOAT = st.floats(
    allow_nan=False,
    allow_infinity=False,
    min_value=-(2**53) + 1,
    max_value=2**53 - 1,
)
_json_scalars = st.one_of(
    st.none(),
    st.booleans(),
    _SAFE_INT,
    _SAFE_FLOAT,
    st.text(),
)
json_values = st.recursive(
    _json_scalars,
    lambda children: st.one_of(
        st.lists(children),
        st.dictionaries(keys=st.text(), values=children),
    ),
    max_leaves=30,
)


@given(json_values)
def test_canonicalize_is_stable_under_reparse(value: Any) -> None:
    # canonicalize(parse(canonicalize(x))) == canonicalize(x). Holds even where JSON
    # reparse collapses float(2.0)->int 2 or -0.0->0, because we compare canonical
    # OUTPUT bytes, which are stable under re-parse.
    once = canonicalize(value)
    twice = canonicalize(json.loads(once))
    assert twice == once
