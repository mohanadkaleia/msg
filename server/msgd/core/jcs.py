"""RFC 8785 JSON Canonicalization Scheme (JCS) for msg.

This module provides the canonical-JSON *byte* layer that ``event_hash``
(``sha256:`` over these bytes, ENG-56) is computed against. Decision D1 fixes the
canonicalization scheme as **RFC 8785 (JCS)**; §2.1 of the technical design pins
``event_hash`` = SHA-256 over the JCS canonicalization of the event ``body`` only.
This module returns bytes and nothing else — hashing lives elsewhere.

Library vs. vendor
------------------
We depend on the ``rfc8785`` PyPI package (Trail of Bits, Apache-2.0) wrapped behind
our own :func:`canonicalize`, rather than vendoring an implementation.

The risky ~80% of a correct JCS implementation is ES6 ``Number::toString`` float
formatting (shortest round-trip + exponent normalization). ``rfc8785`` implements
that and validates it against the RFC reference vectors — including the 100M-case ES6
number set — the single hardest part to get right. It is pure-Python with **zero
runtime dependencies** (satisfying the ``msgd.core`` import-light constraint) and
ships ``py.typed`` (works under ``mypy --strict``). Re-deriving the float rules for
M0 would buy nothing and add a correctness liability.

Swappability
------------
Callers depend only on :func:`canonicalize` and :class:`JCSError`. The library's
exception types are caught here and re-raised as :class:`JCSError`, so no caller
(ENG-56 hashing, ENG-54 envelope, ``msgctl verify``) ever imports or catches
``rfc8785.*``. The library name appears in exactly one ``import`` line, so if the
package ever bit-rots we swap the body of :func:`canonicalize` for a vendored
implementation without touching any caller or test.

Pinned semantics (locked by tests in ``server/tests/test_jcs.py``)
------------------------------------------------------------------
* **Input domain:** ``dict`` / ``list`` / ``str`` / ``int`` / ``float`` / ``bool`` /
  ``None`` only, with **string** object keys. Anything else (``bytes``, ``Decimal``,
  ``datetime``, ``set``, custom objects, non-string keys) raises :class:`JCSError` —
  with one deliberate exception: the current library coerces ``tuple`` to a JSON
  array rather than rejecting it (hash-safe; ``JSONValue`` still excludes ``tuple``,
  so mypy forbids it at every call site, and no test locks the coercion in — a future
  vendored implementation remains free to reject tuples). Container nesting deeper
  than :data:`MAX_DEPTH` (128 levels) also raises :class:`JCSError` — an explicit
  protocol cap under D1, not an implementation accident, so the accept/reject
  boundary is deterministic across workers and across the Python/TypeScript
  implementations (a stack-dependent boundary would vary by process and engine).
* **Floats** serialize per RFC 8785 = ECMAScript ``Number::toString``.
* **NaN / Infinity** are rejected → :class:`JCSError`.
* **Integer range:** we adopt the RFC 8785 interop cap ``[-(2**53)+1, 2**53-1]``;
  values outside raise :class:`JCSError` (no Python-bigint support). This is
  unreachable for a real ``body``: every entity ID is a ULID *string* (§2.1),
  ``type_version`` is a small int, and all counts/sizes/sequences live in ``server``
  metadata which is **not** part of ``body`` and is never canonicalized. The cap buys
  bit-for-bit interop with any other-language JCS implementation (the web client).
* **Strings** are emitted as UTF-8 bytes; JCS escaping and UTF-16 code-unit key
  ordering are handled by the library. ``-0`` (int or float) canonicalizes to ``0``.
  JCS does **not** Unicode-normalize (NFC is the client's responsibility).
* **Determinism:** identical input → identical bytes across runs and platforms (no
  dict-ordering or locale sensitivity).

The production call site (ENG-56) passes the ``body`` **dict**; :func:`canonicalize`
accepts any JSON value, a strict superset, so the round-trip property test can feed
it arbitrary JSON.
"""

import rfc8785

__all__ = ["JSONValue", "JCSError", "MAX_DEPTH", "canonicalize"]

#: Maximum container nesting depth accepted by :func:`canonicalize`. Protocol constant:
#: part of the locked JCS input domain (D1) — the web client must enforce the same value,
#: and ENG-56 freezes it alongside the hash vectors. Depth counts container levels only:
#: a scalar is depth 0, ``{}``/``[]`` is 1, the §2.1 example body is 3 (``tuple`` counts
#: as a container too, since the library coerces tuple→array). 128 gives ~40x headroom
#: over any plausible real body, sits far below Python's ~997 stack-failure point (so
#: the RecursionError backstop is never load-bearing), is trivially within every JS
#: engine's limits for the TS mirror, and matches serde_json's well-known default.
MAX_DEPTH: int = 128

#: Any value expressible in JSON. Recursive alias (PEP 695): objects are string-keyed
#: mappings, arrays are lists, plus the JSON scalars. ``str`` is a scalar here, never
#: treated as a sequence of characters.
type JSONValue = dict[str, JSONValue] | list[JSONValue] | str | int | float | bool | None


class JCSError(ValueError):
    """Input cannot be RFC 8785 canonicalized.

    The single, library-agnostic error type for this module. Raised for
    out-of-domain integers, non-finite floats, unsupported Python types, and
    non-string object keys. Subclasses :class:`ValueError`.
    """


def _check_depth(obj: object) -> None:
    """Raise :class:`JCSError` if container nesting in ``obj`` exceeds ``MAX_DEPTH``.

    Iterative worklist traversal, never recursive — the guard itself must be immune
    to the stack-exhaustion failure it guards against. Only descends into ``dict``
    values and ``list``/``tuple`` items; scalars (including ``str``) are not iterated.
    """
    stack: list[tuple[object, int]] = [(obj, 0)]
    while stack:
        value, depth = stack.pop()
        if isinstance(value, dict):
            if depth + 1 > MAX_DEPTH:
                raise JCSError(f"nesting depth exceeds {MAX_DEPTH}")
            stack.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, (list, tuple)):
            if depth + 1 > MAX_DEPTH:
                raise JCSError(f"nesting depth exceeds {MAX_DEPTH}")
            stack.extend((child, depth + 1) for child in value)


def canonicalize(obj: JSONValue) -> bytes:
    """Return the RFC 8785 (JCS) canonicalization of ``obj`` as UTF-8 bytes.

    ``obj`` must be a JSON value: ``dict`` (string keys) / ``list`` / ``str`` /
    ``int`` / ``float`` / ``bool`` / ``None``, with container nesting no deeper than
    ``MAX_DEPTH``. The production caller passes the event ``body`` dict. Output is
    deterministic and suitable for hashing. (Caveat: the current library coerces
    ``tuple`` to a JSON array instead of rejecting it; see the module docstring —
    do not rely on either behavior.)

    Raises:
        JCSError: if ``obj`` (or a nested value) is out of the JSON domain — a
            non-finite float, an integer outside ``[-(2**53)+1, 2**53-1]``, an
            unsupported type, a non-string object key, a string key containing
            a lone surrogate, or container nesting deeper than ``MAX_DEPTH``.
    """
    _check_depth(obj)
    try:
        return rfc8785.dumps(obj)
    except (rfc8785.CanonicalizationError, UnicodeEncodeError, RecursionError) as exc:
        # UnicodeEncodeError: a lone-surrogate *object key* escapes the library's own
        # error type (it leaks from the UTF-16BE key sort), while surrogates in string
        # values are already CanonicalizationError. Client-reachable via json.loads on
        # upload, so it must surface as JCSError, not a 500. Deliberately NOT bare
        # ValueError: both already subclass it, and a blanket catch would swallow
        # unrelated bugs in our own logic as a clean reject.
        # RecursionError is defense-in-depth only: unreachable given the _check_depth
        # pre-pass (the library needs depth ~997 to blow the stack, far above
        # MAX_DEPTH=128), and safe to catch here because canonicalize is pure and the
        # stack is fully unwound by the time the handler runs.
        raise JCSError(str(exc)) from exc
