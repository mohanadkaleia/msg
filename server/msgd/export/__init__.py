"""Workspace export (TDD §9, D11, M4-1 / ENG-155).

``msgctl export <dir>`` writes a portable workspace bundle: per-stream
month-partitioned NDJSON event logs, content-addressed blobs, user/file
sidecars, and a ``manifest.json`` sealed by a ``bundle_digest``. The bundle is
the ownership pitch made real — ``msgctl verify`` (M4-2) checks it, ``msgctl
import`` (M4-3) replays it into an empty server.

All logic lives in :mod:`msgd.export.bundle`; this package is the §1.1
``export/`` slot.
"""

from msgd.export.bundle import (
    ExportError,
    ExportResult,
    MissingBlobsError,
    export_workspace,
)

__all__ = ["ExportError", "ExportResult", "MissingBlobsError", "export_workspace"]
