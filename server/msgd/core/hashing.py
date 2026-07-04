"""``event_hash`` = SHA-256 over the RFC 8785 (JCS) canonicalization of ``body`` (ENG-56).

This is the thin, deterministic layer that turns ``canonicalize(body)`` bytes into
``event_hash = "sha256:<hex>"``. Per TDD §2.1 and decision D1, the hash covers the
event ``body`` **only**: ``server`` metadata and ``signature`` never affect it (they
are structurally outside ``body``, so they cannot enter the canonicalization). The
server/CLI never mutates an accepted ``body``.

Hash the RAW received body, never a re-serialized model
-------------------------------------------------------
:func:`hash_event` takes the **raw parsed dict** — the object straight out of
``json.loads``, **before** any Pydantic validation — and never touches
:class:`~msgd.core.envelope.Body` / :class:`~msgd.core.envelope.Envelope`. This is the
central correctness decision of the ticket.

Pydantic runs in lax mode on the envelope path: a client that sends
``"type_version": "1"`` (string) or ``1.0`` (float) is coerced to int ``1``, and
``model_dump`` then emits ``1``, whose JCS bytes (``…"type_version":1…``) differ from
what that client actually hashed (``…"type_version":"1"…``). Hashing ``model_dump``
would therefore compute a *different* digest than the client's — silently "repairing" a
nonconforming body, and either false-rejecting a faithful event or masking a malformed
one. So the hash is always computed over the raw bytes the client sent, never over a
model round-trip.

Upload validation order (the §3.2 contract this module fixes)
-------------------------------------------------------------
The future §3.2 upload validator MUST follow this order::

    parse (json.loads)  ->  hash_event(raw_dict) and compare to the raw event_hash
                        ->  THEN validate the Pydantic models

The raw parsed dict is the source of truth for the hash; the models are validated
*after* the hash is confirmed and are never the thing hashed. This matches §3.2's
stated validation order (schema check, then ``event_hash`` recomputation) and the DB
storing ``body`` verbatim (§4.3). ``msgctl verify`` (§11.4) likewise re-hashes the
verbatim stored JSONB dict via :func:`hash_event`, not :func:`verify_hash`.

:func:`hash_event` propagates :class:`~msgd.core.jcs.JCSError` for out-of-domain input
(non-finite float, over-cap integer, lone surrogate, over-depth nesting) rather than
swallowing it — the caller decides reject-vs-400.
"""

from __future__ import annotations

import hashlib

from msgd.core.envelope import Envelope
from msgd.core.jcs import JSONValue, canonicalize

__all__ = ["HASH_ALGORITHM", "hash_event", "verify_hash"]

#: The one hash algorithm msg uses for ``event_hash`` (D1). The serialized digest is
#: prefixed with ``"sha256:"`` so the algorithm travels with the value and a future
#: migration stays unambiguous.
HASH_ALGORITHM = "sha256"

_HASH_PREFIX = f"{HASH_ALGORITHM}:"


def hash_event(body: JSONValue) -> str:
    """Return ``event_hash`` = ``"sha256:<hex>"`` over the JCS bytes of ``body``.

    ``body`` is the **raw** JSON value — the parsed dict straight out of
    ``json.loads``, **before** Pydantic validation — never a ``model_dump`` (see the
    module docstring: lax scalar coercion makes ``model_dump`` non-byte-faithful to
    client input). The production caller passes the raw ``body`` dict; the input type
    is :data:`~msgd.core.jcs.JSONValue` (a strict superset of the body dict) so the
    vector runner can also feed it bare scalars and arrays.

    ``server`` metadata and ``signature`` are structurally excluded — they are not part
    of ``body``, so they cannot affect the digest.

    Raises:
        JCSError: if ``body`` (or a nested value) is out of the JCS input domain. The
            error is propagated, not swallowed; the caller decides reject vs. HTTP 400.
    """
    return f"{_HASH_PREFIX}{hashlib.sha256(canonicalize(body)).hexdigest()}"


def verify_hash(envelope: Envelope) -> bool:
    """Convenience re-hash of an :class:`Envelope` you already hold — model-is-source only.

    Returns ``True`` iff ``hash_event(envelope.body.model_dump(mode="json"))`` equals
    ``envelope.event_hash``. Because ``model_dump`` is definitionally faithful when the
    :class:`~msgd.core.envelope.Body` *is* the source of truth (client-side construction
    via ``build_message_created_body``, tests, re-hashing an event you built yourself),
    this is exact for that path.

    **This is NOT the §3.2 upload-verification authority.** On the upload path the raw
    client bytes are authoritative and may diverge from ``model_dump`` under Pydantic
    lax coercion (e.g. ``"type_version": "1"`` collapses to ``1``); an ``Envelope``
    parsed with ``extra="allow"`` has already lost those raw bytes, so verifying it here
    would hash the coerced form and could accept a body whose bytes never matched the
    client's ``event_hash``. The upload validator and ``msgctl verify`` MUST instead
    call ``hash_event(raw_parsed_body_dict)`` on the pre-model parsed JSON and compare to
    the raw ``event_hash`` — a one-liner, so no separate raw-verify function exists.

    Redaction exemption (§2.1): redacted events are exempt from hash verification. When
    ``envelope.server.payload_redacted`` is set the server may have nulled
    ``body.payload`` so the hash no longer matches by design; this returns ``True``.
    """
    if envelope.server is not None and envelope.server.payload_redacted:
        return True
    return hash_event(envelope.body.model_dump(mode="json")) == envelope.event_hash
