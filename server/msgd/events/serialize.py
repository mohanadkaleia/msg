"""The ONE canonical serialization of a stored event (ENG-155, D1 raw discipline).

Every surface that emits a stored event as JSON — the ``GET /v1/events`` pull
endpoint, and the ``msgctl export`` bundle writer (TDD §9: "one NDJSON line = one
full envelope exactly as served by the API") — builds the envelope dict through
:func:`serialize_stored_event`, so the two can never drift. The dict is assembled
verbatim from **raw** DB row values:

* ``body`` is the stored JSONB dict straight through — the exact value the hash
  was computed over — so ``hash_event(result["body"]) == result["event_hash"]``
  holds for every event, including unknown-type events (opaque bodies survive
  untouched). It is never regenerated through ``core.Envelope`` /
  ``Body.model_dump``.
* ``signature`` has no column (reserved-null); ``server`` is unhashed metadata.

:func:`event_ndjson_line` is the byte-level companion: the compact
``json.dumps(..., ensure_ascii=False, separators=(",", ":")) + "\\n"`` form the
CLI sync engine writes (``msgctl.sync._write_page``), so an exported month file
is byte-identical to what a fully-pulled client holds on disk.
"""

from __future__ import annotations

import json
from typing import Any

from msgd.core.time import to_rfc3339
from msgd.db.models import Event

__all__ = ["event_ndjson_line", "serialize_stored_event"]


def serialize_stored_event(row: Event) -> dict[str, Any]:
    """Assemble one wire event from **raw** DB row values (D1 raw-hash discipline).

    ``body`` is the verbatim stored JSONB dict — the exact value the hash was
    computed over — so ``hash_event(result["body"]) == result["event_hash"]``.
    ``signature`` has no column (reserved-null). ``server`` is unhashed metadata.
    """
    return {
        "body": row.body,
        "event_hash": row.event_hash,
        "signature": None,
        "server": {
            "server_sequence": row.server_sequence,
            "server_received_at": to_rfc3339(row.server_received_at),
            "payload_redacted": row.payload_redacted,
        },
    }


def event_ndjson_line(event: dict[str, Any]) -> str:
    """One NDJSON log line for a serialized event — the canonical compact form.

    Byte-identical to the M0 log writer and ``msgctl.sync._write_page``:
    ``json.dumps(evt, ensure_ascii=False, separators=(",", ":")) + "\\n"``.
    """
    return json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
