"""``msgctl rebuild`` — drop the projection and replay the whole log (ENG-59).

``rebuild`` is the user-facing form of the projection invariant "drop tables +
reset cursors + replay-from-log" (TDD §2.3 rule 5). It truncates the SQLite
projection and replays **every** event from the NDJSON logs in
``(stream_id, server_sequence)`` order, yielding a ``messages`` table byte-equal
(under :func:`msgctl.projection.dump_messages`) to what incremental
:func:`~msgctl.projection.project` produces on the same logs — the ``rebuild ≡
incremental`` invariant ENG-61 gates on. Three hard properties:

- **Read-only over the source of truth.** The logs under ``streams/**/*.ndjson``
  are never written, truncated, or repaired — rebuild is a pure reader, reusing
  ENG-58's read-only ``_read_stream_events`` transitively via ``project``. A
  byte-compare of every log before/after a rebuild is identical.
- **Resilient — safe to interrupt and re-run.** Rebuild builds into a **temp DB**
  (``<dir>/projections.sqlite3.rebuild``) and **atomically swaps** it over the
  live ``projections.sqlite3`` with :func:`os.replace` only on success. An
  interrupt (kill / exception) at any point before the swap leaves the previous
  projection byte-for-byte intact; a stale ``.rebuild`` leftover is removed at
  the start of the next run, so re-running always converges.
- **Version-normalizing.** Because the temp DB is built fresh through
  :func:`~msgctl.projection.open_db`, the swapped-in projection is always stamped
  at the current :data:`~msgctl.projection.PROJECTION_VERSION`, regardless of the
  old DB's version.

**Why a fresh temp DB + swap, not ENG-58's in-place ``_rebuild_schema`` seam.**
ENG-58 designed ``_rebuild_schema(conn)`` then ``project(ws, conn)`` for an
in-place reset of the *live* DB. ENG-59 deliberately supersedes that with a
fresh temp DB + atomic swap, which is strictly stronger: the in-place path can
leave a mid-rebuild half-empty *live* DB (acceptable in ENG-58 only because the
version stamp is written last, making it self-healing on the next ``project``);
this ticket demands the old DB stay intact under interruption, which only the
temp-file variant can promise. ``open_db(temp)`` on a just-removed path hits its
fresh-DB branch (empty schema, current-version stamp, empty cursors) — the same
starting point ``_rebuild_schema`` would produce, without touching anything live.
``_rebuild_schema`` remains in use by ``open_db``'s auto-on-mismatch branch, so
it is not dead code; rebuild simply chose the temp-file variant of the same idea.

**The load-bearing primitive is ``os.replace``'s atomicity, not the fsync.**
"Interrupted rebuild leaves the previous projection intact" holds purely because
we write only ``temp`` and rename atomically: a crash *before* ``os.replace``
cannot have touched ``live``; a crash *after* it means ``live`` already points at
the complete new DB. The ``fsync(temp)`` + :func:`~msgctl.workspace._fsync_dir`
are cheap belt-and-suspenders so a power loss *immediately after* the rename
leaves a durable, complete new projection rather than a torn one. **This is a
deliberate, narrow exception to ENG-58's "projection durability is cheap"
ruling.** That ruling governs per-``project`` incremental writes (a torn one is a
self-healing no-op); here atomicity *is* the whole point of the temp-DB design,
so we spend the two extra fsyncs. Do not "simplify" the fsyncs away, and do not,
conversely, "restore consistency" by adding fsyncs to the incremental ``project``
path — that path is correctly cheap.

**Locking (M0).** ``rebuild`` holds the existing workspace lock
(``ws.lock_path``, via ``flock_exclusive``) around cleanup + build + swap. This
closes the one destructive same-tool race — two ``rebuild``s racing on the shared
``.rebuild`` temp name and the swap — and harmlessly serializes against ``send``'s
registry mutation. It does **not** block appends to existing streams (those take
the per-stream lock): rebuild reads a point-in-time log snapshot, and any
straggler append is picked up by the next incremental ``project``.
``project``↔``rebuild`` non-concurrency is a **documented M0 single-operator
assumption**, not enforced: msgctl M0 is a single-operator local tool, ENG-61's
CI runs ``project`` and ``rebuild`` sequentially, and enforcing it would require
locking ``project`` (out of scope — projection.py is read-only for this ticket).
A hand-run ``project`` racing a ``rebuild`` is unsupported in M0.
"""

from __future__ import annotations

import os
from typing import Final

from msgctl.append import flock_exclusive
from msgctl.projection import PROJECTION_DB_NAME, ProjectResult, open_db, project
from msgctl.workspace import Workspace, _fsync_dir

__all__ = [
    "PROJECTION_REBUILD_DB_NAME",
    "rebuild_projection",
]

#: The temp DB rebuild builds into before atomically swapping it over the live
#: projection — a sibling of ``projections.sqlite3`` at the workspace root,
#: outside ``streams/``. Excluded from the export/verify walk **by path** (those
#: enumerate ``streams/<id>/*.ndjson`` + the two named manifests, never globbing
#: the root), so a transient ``.rebuild`` leftover can never enter a
#: hash/contiguity check. Defined here (not in ``projection.py``) to keep
#: projection.py at a zero-line diff.
PROJECTION_REBUILD_DB_NAME: Final = PROJECTION_DB_NAME + ".rebuild"


def rebuild_projection(ws: Workspace) -> ProjectResult:
    """Drop the projection and replay the whole log into a fresh, swapped-in DB.

    Mechanics, in order, under the workspace lock:

    1. Remove any stale ``.rebuild`` (and its transient ``-journal``) left by a
       killed prior rebuild — this is what makes re-run after an interrupt safe.
    2. ``open_db(temp)`` on the just-removed path → fresh schema, current version,
       empty cursors; then ``project(ws, conn)`` replays the entire log.
       ``conn.close()`` (under ``journal_mode=DELETE``) commits and removes the
       temp ``-journal``, leaving ``temp`` a single clean file ready to swap.
    3. Durable atomic swap: ``fsync(temp)`` → ``os.replace(temp, live)`` →
       ``_fsync_dir(ws.root)`` — the exact discipline ``write_manifest`` uses.

    On a ``project`` exception (e.g. :class:`~msgctl.errors.CorruptLogError`) the
    swap is never reached, the temp conn is closed by ``finally``, ``live`` is
    untouched, and the stale ``.rebuild`` is cleaned by the *next* run's step 1.
    No failure-path unlink is added: startup cleanup must exist regardless (a
    hard crash cannot run a ``finally`` anyway), so a failure-path unlink would be
    pure redundancy.

    Returns the :class:`~msgctl.projection.ProjectResult` of the full replay for
    the CLI summary.
    """
    live = ws.root / PROJECTION_DB_NAME
    temp = ws.root / PROJECTION_REBUILD_DB_NAME
    temp_journal = ws.root / (PROJECTION_REBUILD_DB_NAME + "-journal")

    with flock_exclusive(ws.lock_path):
        # Crash leftovers from a killed prior rebuild: start from a clean slot.
        temp.unlink(missing_ok=True)
        temp_journal.unlink(missing_ok=True)

        conn = open_db(temp)  # fresh schema, current version, empty cursors
        try:
            result = project(ws, conn)  # full replay; may raise CorruptLogError
        finally:
            conn.close()  # commit + drop -journal → single clean file

        # Durable atomic swap. os.replace's atomicity is what leaves the OLD
        # projection intact on interrupt; the fsyncs are cheap belt-and-suspenders
        # (deliberate exception to ENG-58's cheap-durability rule — module docstring).
        fd = os.open(temp, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, live)
        _fsync_dir(ws.root)

    return result
