"""Workspace export (TDD §9, D11, M4-1 / ENG-155).

``msgctl export <dir>`` writes a portable workspace bundle: per-stream
month-partitioned NDJSON event logs, content-addressed blobs, user/file
sidecars, and a ``manifest.json`` sealed by a ``bundle_digest``. The bundle is
the ownership pitch made real — ``msgctl verify`` (M4-2) checks it, ``msgctl
import`` (M4-3) replays it into an empty server.

Export logic lives in :mod:`msgd.export.bundle`; the restore side (``msgctl
import``, ENG-157 / M4-3) in :mod:`msgd.export.restore`. This package is the
§1.1 ``export/`` slot.
"""

from msgd.export.bundle import (
    ExportError,
    ExportResult,
    MissingBlobsError,
    export_workspace,
)
from msgd.export.restore import (
    UNUSABLE_PASSWORD_HASH,
    ImportResult,
    RestoreError,
    import_event,
    import_workspace,
)

__all__ = [
    "ExportError",
    "ExportResult",
    "ImportResult",
    "MissingBlobsError",
    "RestoreError",
    "UNUSABLE_PASSWORD_HASH",
    "export_workspace",
    "import_event",
    "import_workspace",
]
