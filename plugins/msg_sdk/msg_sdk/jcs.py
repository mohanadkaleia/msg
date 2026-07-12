"""Minimal RFC 8785 (JCS) canonicalization for the msg event-body domain.

The msg ``event_hash`` is ``"sha256:" + sha256(JCS(body))`` (see
:mod:`msg_sdk.hashing`), where JCS is RFC 8785 JSON Canonicalization. The server
computes it with the ``rfc8785`` library over the RAW parsed body dict
(``server/msgd/core/jcs.py``); this module is a dependency-free port that must
produce **byte-identical** output for every value that can appear in an event
``body``.

Scope — the event-body JSON domain
----------------------------------
An event ``body`` only ever contains: ``dict`` (string keys) / ``list`` / ``str``
/ ``int`` / ``bool`` / ``None``. It never contains a fractional or exponential
float (every id is a ULID *string*, ``type_version`` is a small int, all counts
live in server metadata outside ``body``). So this port implements the exact,
easy 95% of RFC 8785 — string escaping, UTF-16 code-unit key ordering, and
integer/`bool`/`null` emission — and deliberately does NOT implement ES6
``Number::toString`` float formatting (the risky part). A non-integral float
raises :class:`JCSError` rather than risk a silently divergent hash; an
integral-valued float (``2.0``) is emitted as the integer ``2`` to match RFC 8785.
Correctness is pinned against the repo's frozen cross-language vectors
(``server/msgd/core/testdata/vectors.json``) and the live end-to-end test.
"""

from __future__ import annotations

from typing import Any

__all__ = ["JCSError", "MAX_DEPTH", "INT_MIN", "INT_MAX", "canonicalize"]

#: Container-nesting cap, matching the server's protocol constant (D1). A real
#: body nests ~3 deep, so this is only a defensive backstop.
MAX_DEPTH = 128

#: RFC 8785 integer interop range ``[-(2**53)+1, 2**53-1]`` — the server rejects
#: integers outside it. Unreachable for a real body (``type_version`` is tiny).
INT_MAX = (1 << 53) - 1
INT_MIN = -INT_MAX

# RFC 8785 two-char string escapes; every other control char < 0x20 uses \u00XX.
_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


class JCSError(ValueError):
    """A value is outside the RFC 8785 input domain this port supports.

    Raised for a non-integral / non-finite float, an integer outside the interop
    range, a non-string object key, or container nesting deeper than
    :data:`MAX_DEPTH`. Subclasses :class:`ValueError`.
    """


def _encode_string(value: str, out: list[str]) -> None:
    out.append('"')
    for ch in value:
        cp = ord(ch)
        esc = _ESCAPES.get(cp)
        if esc is not None:
            out.append(esc)
        elif cp < 0x20:
            out.append(f"\\u{cp:04x}")
        else:
            # RFC 8785 emits every other code point (incl. 0x7f and all
            # non-ASCII) as raw UTF-8; the final ``.encode`` produces the bytes.
            out.append(ch)
    out.append('"')


def _encode_number(value: int | float, out: list[str]) -> None:
    # NB: bool is a subclass of int and is handled before this in _encode.
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise JCSError("non-finite floats are not canonicalizable")
        if not value.is_integer():
            raise JCSError(
                "fractional/exponential floats are outside the event-body JSON "
                "domain and are not supported by this port"
            )
        value = int(value)
    if value == 0:  # collapse -0 (int or float) to 0 per RFC 8785
        out.append("0")
        return
    if not (INT_MIN <= value <= INT_MAX):
        raise JCSError(f"integer {value} is outside the RFC 8785 interop range")
    out.append(str(value))


def _encode(value: Any, out: list[str], depth: int) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        _encode_string(value, out)
    elif isinstance(value, bool):  # pragma: no cover - covered by the identity checks above
        out.append("true" if value else "false")
    elif isinstance(value, (int, float)):
        _encode_number(value, out)
    elif isinstance(value, (list, tuple)):
        if depth + 1 > MAX_DEPTH:
            raise JCSError(f"nesting depth exceeds {MAX_DEPTH}")
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _encode(item, out, depth + 1)
        out.append("]")
    elif isinstance(value, dict):
        if depth + 1 > MAX_DEPTH:
            raise JCSError(f"nesting depth exceeds {MAX_DEPTH}")
        for key in value:
            if not isinstance(key, str):
                raise JCSError(f"object keys must be strings, got {type(key).__name__}")
        # RFC 8785 sorts object keys by UTF-16 code units. Comparing the
        # UTF-16-BE encoding of each key orders by code unit sequence, which is
        # what the spec (and V8/the web client) do — a plain code-point sort gets
        # astral vs. U+FFFF keys wrong.
        items = sorted(value.items(), key=lambda kv: kv[0].encode("utf-16-be"))
        out.append("{")
        for i, (key, val) in enumerate(items):
            if i:
                out.append(",")
            _encode_string(key, out)
            out.append(":")
            _encode(val, out, depth + 1)
        out.append("}")
    else:
        raise JCSError(f"unsupported type for JCS: {type(value).__name__}")


def canonicalize(value: Any) -> bytes:
    """Return the RFC 8785 (JCS) canonicalization of ``value`` as UTF-8 bytes.

    ``value`` must be a JSON value within the event-body domain (``dict`` with
    string keys / ``list`` / ``str`` / ``int`` / ``bool`` / ``None``). Output is
    deterministic and suitable for hashing.

    Raises:
        JCSError: if ``value`` (or a nested value) is outside the supported
            domain — a fractional/non-finite float, an out-of-range integer, a
            non-string object key, or nesting deeper than :data:`MAX_DEPTH`.
    """
    out: list[str] = []
    try:
        _encode(value, out, 0)
        return "".join(out).encode("utf-8")
    except UnicodeEncodeError as exc:
        # A lone surrogate (an unpaired \ud800 in a string value, or in an object
        # KEY where it surfaces during the UTF-16 sort) is not encodable and is
        # outside the JSON text domain; the server rejects it too. Surface as
        # JCSError, never a raw UnicodeEncodeError.
        raise JCSError(f"value is not encodable as UTF-8: {exc}") from exc
