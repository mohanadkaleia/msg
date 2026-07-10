"""Generate the frozen NDJSON byte-parity fixture for M6-3 (ENG-167).

Writes ``parity.ndjson``: one line per vector, each produced by THE server
serializer (``msgd.events.serialize.event_ndjson_line`` — the exact bytes
``msgctl pull`` / the §9 export writer emit). The TS runner
(``web/tests/unit/worker/mirror-serialize.spec.ts``) parses each line and
asserts ``eventNdjsonLine(JSON.parse(line))`` reproduces it byte-for-byte, so
the desktop mirror's log is pinned byte-identical to the Python reference.

Every ``event_hash`` is REAL (``hash_event`` over the body), so the same
fixture also exercises the TS hash re-verification path.

Regenerate (from the repo root)::

    uv run python web/tests/fixtures/ndjson/generate_parity_fixture.py

The output is committed; regeneration must be a no-op unless the wire format
itself changes (which would be a protocol event, not a refactor).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from msgd.core.hashing import hash_event
from msgd.events.serialize import event_ndjson_line

OUT = Path(__file__).parent / "parity.ndjson"


def envelope(body: dict[str, Any], seq: int, received: str) -> dict[str, Any]:
    """A served-event envelope in the exact `serialize_stored_event` shape."""
    return {
        "body": body,
        "event_hash": hash_event(body),
        "signature": None,
        "server": {
            "server_sequence": seq,
            "server_received_at": received,
            "payload_redacted": False,
        },
    }


def body(seq: int, payload: dict[str, Any], type_: str = "message.created") -> dict[str, Any]:
    return {
        "event_id": f"01JGXW5C8RXY9AAAAAAAAA{seq:04d}"[:26],
        "workspace_id": "w_01JGXW5C8RXY9TESTWORKSPCE",
        "stream_id": "s_01JGXW5C8RXY9TESTSTREAM01",
        "type": type_,
        "type_version": 1,
        "author_user_id": "u_01JGXW5C8RXY9TESTAUTHOR01",
        "author_device_id": "d_01JGXW5C8RXY9TESTDEVICE01",
        "client_created_at": "2026-01-05T10:00:00.000Z",
        "payload": payload,
    }


VECTORS: list[dict[str, Any]] = [
    # Plain ASCII.
    envelope(
        body(1, {"message_id": "m_01JGXW5C8RXY9TESTMSG00001", "text": "hello", "format": "plain"}),
        1,
        "2026-01-05T10:00:00.000Z",
    ),
    # Raw non-ASCII stays raw (ensure_ascii=False ≡ JSON.stringify): accents,
    # CJK, RTL, and a non-BMP emoji (astral pair).
    envelope(
        body(
            2,
            {
                "message_id": "m_01JGXW5C8RXY9TESTMSG00002",
                "text": "héllo wörld — 日本語 עברית 😀🎉",
                "format": "markdown",
            },
        ),
        2,
        "2026-01-05T10:00:01.000Z",
    ),
    # Escaping edges: quotes, backslash, the short escapes, low control chars
    # (0x07, 0x1f), and DEL (0x7f - NOT escaped by either serializer).
    envelope(
        body(
            3,
            {
                "message_id": "m_01JGXW5C8RXY9TESTMSG00003",
                "text": 'quote " backslash \\ nl \n tab \t cr \r bell \x07 us \x1f del \x7f',
                "format": "plain",
            },
        ),
        3,
        "2026-01-05T10:00:02.000Z",
    ),
    # Number formatting parity (ES6 Number::toString ≡ repr on round-tripped
    # doubles): ints, negative, zero, floats, exponents, tiny/huge magnitudes.
    envelope(
        body(
            4,
            {
                "message_id": "m_01JGXW5C8RXY9TESTMSG00004",
                "text": "numbers",
                "format": "plain",
                "extra_numbers": [
                    0,
                    1,
                    -1,
                    42,
                    1.5,
                    -0.25,
                    0.1,
                    1e21,
                    9.999e22,
                    5e-324,
                    123456789012345,
                ],
            },
        ),
        4,
        "2026-02-01T00:00:00.000Z",
    ),
    # Nested objects/arrays + null/bool + empty containers + an unknown-type
    # event (D9 tolerance: unknown types still round-trip verbatim).
    envelope(
        body(
            5,
            {
                "message_id": "m_01JGXW5C8RXY9TESTMSG00005",
                "text": "structs",
                "format": "plain",
                "extra": {"a": [True, False, None, {}, []], "b": {"nested": {"deep": "值"}}},
            },
            type_="future.type",
        ),
        5,
        "2026-02-01T00:00:01.000Z",
    ),
]


def main() -> None:
    OUT.write_text("".join(event_ndjson_line(v) for v in VECTORS), encoding="utf-8")
    print(f"wrote {len(VECTORS)} vectors to {OUT}")


if __name__ == "__main__":
    main()
