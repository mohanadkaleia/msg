"""PERMANENT GATE — never delete.

``rebuild ≡ incremental`` is a permanent projection invariant (TDD §5 M0 exit
criterion, §12 invariant 6). This file is the CI gate that proves it holds
end-to-end, forever:

1. **rebuild ≡ incremental** — an incrementally-built projection and a full
   :func:`~msgctl.rebuild.rebuild_projection` of the same log produce a
   **byte-identical** :func:`~msgctl.projection.dump_messages`.
2. **verify green** — ``msgctl verify`` exits 0 on every generated workspace.
3. **idempotence** — re-``project``-ing applies 0 rows and leaves the dump
   unchanged.

Extend this gate at M1 (server projections — sibling file in ``server/tests``)
and M2 (client Dexie — ``web/``); **never remove it**. The mutation/teeth test
lives in this same file so the gate and its divergence-detection proof are never
separated.

Design notes (ENG-61 plan, pinned):

- **In-process property loop.** The hypothesis property drives
  ``resolve_or_create_stream`` + ``append_event`` (send), ``open_db`` /
  ``project`` / ``dump_messages`` (project), ``rebuild_projection`` (rebuild)
  and ``verify.verify_workspace`` (verify) as library calls — a subprocess per
  send across dozens of examples would blow the CI time budget. One plain
  subprocess smoke test (``test_cli_end_to_end_smoke``) proves the real
  argparse → ``cmd_project`` → ``cmd_rebuild`` → ``cmd_verify`` wiring end to
  end.
- **Fresh dir per example, NOT the ``tmp_path`` fixture.** A ``@given`` body
  runs many times against the *same* fixture values, so ``tmp_path`` would be
  one dir reused across all examples, cross-contaminating workspaces. Each
  example mints its own ``tempfile.mkdtemp`` and removes it in ``finally``.
- **Close the incremental connection BEFORE rebuild.** ``rebuild_projection``
  atomically swaps ``projections.sqlite3``; the incremental dump is captured
  and its connection closed first, then a fresh connection reads the swapped-in
  DB. Getting this order wrong compares a dump against a half-swapped file.
- **Determinism profiles.** The ``ci`` profile (loaded when the ``CI`` env var
  is truthy — GitHub Actions sets ``CI=true``) uses ``derandomize=True`` for a
  deterministic example selection from a fixed internal seed, ``database=None``
  for hermeticity, ``deadline=None`` so fsync/SQLite IO variance never flakes,
  and ``max_examples=60`` for a ~30–60s budget. The local ``dev`` profile stays
  random so developers keep finding new cases.
- **Timestamps.** ``dump_messages`` includes wall-clock timestamps, so dump
  *text* differs run to run — but within one example both sides read the same
  log, so the equality holds. The gate asserts equivalence *within a run*,
  never dump-byte reproducibility across runs.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path

import msgctl.projection as projection
import pytest
from conftest import run_cli
from hypothesis import given, settings
from hypothesis import strategies as st
from msgctl import verify
from msgctl.append import append_event
from msgctl.projection import PROJECTION_DB_NAME, dump_messages, open_db, project
from msgctl.rebuild import rebuild_projection
from msgctl.workspace import (
    Workspace,
    init_workspace,
    now_rfc3339,
    resolve_or_create_stream,
)
from msgd.core import ids
from msgd.core.envelope import Body, Envelope, ServerMetadata
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body

# --- determinism profiles (module docstring: "Determinism profiles") ---------

settings.register_profile("ci", max_examples=60, deadline=None, derandomize=True, database=None)
settings.register_profile("dev", max_examples=100, deadline=None)
_CI = os.environ.get("CI", "").strip().lower() in {"1", "true", "yes", "on"}
settings.load_profile("ci" if _CI else "dev")


# --- send plan strategy -------------------------------------------------------


@dataclass(frozen=True)
class _Action:
    """One randomized send: a ``message.created`` or an unknown-type injection."""

    kind: str  # "created" | "unknown"
    stream: str
    text: str = ""
    format: str = "markdown"
    thread_root_id: str | None = None
    mentions: tuple[str, ...] = ()
    file_ids: tuple[str, ...] = ()


@st.composite
def _send_plan(draw: st.DrawFn) -> list[_Action]:
    """1–4 streams, 0–30 randomly-interleaved actions across them.

    ~90% ``message.created`` / ~10% unknown-type. ``min_size=0`` covers the
    empty-workspace edge (dump == "", equivalence + verify must still hold).
    Interleaving falls out of the flat list; per-stream sequencing is handled
    by ``append_event``.

    ``st.text(st.characters(codec="utf-8"))`` is load-bearing: it excludes lone
    surrogates (U+D800–DFFF), which ``append``'s UTF-8 encode and JCS both
    reject upstream — we generate only text msgctl can actually store. Full
    unicode (emoji, CJK, combining marks) stays in range, exercising
    ``ensure_ascii=False``; empty text is valid. ``mentions``/``file_ids`` are
    not in ``_DUMP_COLUMNS`` (projection+verify robustness only);
    ``thread_root_id`` IS dumped. Ids are format-only validated at M0.
    """
    n_streams = draw(st.integers(min_value=1, max_value=4))
    streams = [f"s{i}" for i in range(n_streams)]

    created = st.builds(
        _Action,
        kind=st.just("created"),
        stream=st.sampled_from(streams),
        text=st.text(st.characters(codec="utf-8"), min_size=0, max_size=200),
        format=st.sampled_from(["markdown", "plain"]),
        thread_root_id=st.none() | st.builds(ids.new_message_id),
        mentions=st.lists(st.builds(ids.new_user_id), max_size=3).map(tuple),
        file_ids=st.lists(st.builds(ids.new_file_id), max_size=3).map(tuple),
    )
    unknown = st.builds(
        _Action,
        kind=st.just("unknown"),
        stream=st.sampled_from(streams),
    )
    # ~90% created / ~10% unknown, via a weighted integer draw.
    action = st.integers(min_value=0, max_value=9).flatmap(lambda n: unknown if n == 0 else created)
    return draw(st.lists(action, min_size=0, max_size=30))


# --- in-process send helpers (both set `server` exactly like cmd_send) --------


def _send_created(ws: Workspace, action: _Action) -> None:
    """Append one ``message.created`` v1 through the real in-process sequencer."""
    stream_id = resolve_or_create_stream(ws, action.stream)

    def build_envelope(server_sequence: int, server_received_at: str) -> Envelope:
        body = build_message_created_body(
            workspace_id=ws.workspace_id,
            stream_id=stream_id,
            author_user_id=ws.local_author.user_id,
            author_device_id=ws.local_author.device_id,
            client_created_at=now_rfc3339(),
            text=action.text,
            format=action.format,
            thread_root_id=action.thread_root_id,
            mentions=list(action.mentions),
            file_ids=list(action.file_ids),
        )
        return Envelope(
            body=body,
            event_hash=hash_event(body.model_dump(mode="json")),
            signature=None,
            server=ServerMetadata(
                server_sequence=server_sequence,
                server_received_at=server_received_at,
                payload_redacted=False,
            ),
        )

    append_event(ws, stream_id, build_envelope=build_envelope)


def _send_unknown(ws: Workspace, action: _Action) -> None:
    """Inject an unknown-type event through the real sequencer (D9).

    ``widget.exploded`` v7 with an opaque payload, real ``hash_event``, real
    gapless ``server_sequence``. The projection must skip it (cursor still
    advances) and verify must treat it as a note, not a finding.
    """
    stream_id = resolve_or_create_stream(ws, action.stream)

    def build_envelope(server_sequence: int, server_received_at: str) -> Envelope:
        body = Body(
            event_id=ids.new_event_id(),
            workspace_id=ws.workspace_id,
            stream_id=stream_id,
            type="widget.exploded",
            type_version=7,
            author_user_id=ws.local_author.user_id,
            author_device_id=ws.local_author.device_id,
            client_created_at=now_rfc3339(),
            payload={"blast_radius": 3},
        )
        return Envelope(
            body=body,
            event_hash=hash_event(body.model_dump(mode="json")),
            signature=None,
            server=ServerMetadata(
                server_sequence=server_sequence,
                server_received_at=server_received_at,
                payload_redacted=False,
            ),
        )

    append_event(ws, stream_id, build_envelope=build_envelope)


def _apply_action(ws: Workspace, action: _Action) -> None:
    if action.kind == "created":
        _send_created(ws, action)
    else:
        _send_unknown(ws, action)


# --- the gate: property test ---------------------------------------------------


@given(plan=_send_plan())
def test_rebuild_equals_incremental_property(plan: list[_Action]) -> None:
    """rebuild ≡ incremental + verify green + idempotent re-project (the gate).

    Fresh ``tempfile.mkdtemp`` per example — NEVER ``tmp_path`` inside
    ``@given`` (module docstring). Projection is stepped after EVERY append so
    the per-stream cursors genuinely advance incrementally, not in one batch.
    """
    base = tempfile.mkdtemp(prefix="eng61-gate-")
    try:
        root = Path(base) / "ws"
        init_workspace(root)
        ws = Workspace.open(root)

        # Incremental build: project after each append on one persistent conn.
        conn = open_db(root / PROJECTION_DB_NAME)
        try:
            for action in plan:
                _apply_action(ws, action)
                project(ws, conn)
            dump_incremental = dump_messages(conn)
        finally:
            # MUST close before rebuild_projection swaps the live DB file (R4).
            conn.close()

        # Full rebuild (real ENG-59 path: temp DB + atomic swap), then re-read.
        rebuild_projection(ws)
        conn2 = open_db(root / PROJECTION_DB_NAME)
        try:
            dump_rebuilt = dump_messages(conn2)
            # 1. The permanent invariant: byte-identical dumps.
            assert dump_rebuilt == dump_incremental

            # 3. Idempotence: one more project applies nothing, changes nothing.
            result = project(ws, conn2)
            assert result.applied == 0
            assert dump_messages(conn2) == dump_rebuilt
        finally:
            conn2.close()

        # 2. verify green (walks logs only; injected unknown types are D9
        # notes, not findings).
        assert verify.verify_workspace(root).exit_code == 0
    finally:
        shutil.rmtree(base, ignore_errors=True)


# --- the teeth: mutation test ----------------------------------------------------


def test_gate_detects_single_row_divergence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Standing proof the gate's ``==`` has teeth: one corrupt row is detected.

    The ``("message.created", 1)`` handler is monkeypatched for the REBUILD
    pass only, corrupting exactly one row post-insert. Patching only one side
    is essential — a global patch would corrupt both sides identically and
    they would still match, demonstrating nothing. A clean positive control
    first proves the equality fires on a correct rebuild.
    """
    root = tmp_path / "ws"
    init_workspace(root)
    ws = Workspace.open(root)
    for stream, text in [("alpha", "a1"), ("beta", "b1"), ("alpha", "a2"), ("beta", "b2")]:
        _send_created(ws, _Action(kind="created", stream=stream, text=text))

    # Incremental build.
    conn = open_db(root / PROJECTION_DB_NAME)
    try:
        project(ws, conn)
        dump_incremental = dump_messages(conn)
    finally:
        conn.close()

    # Positive control: an UNpatched rebuild matches the incremental dump.
    rebuild_projection(ws)
    conn = open_db(root / PROJECTION_DB_NAME)
    try:
        dump_clean = dump_messages(conn)
    finally:
        conn.close()
    assert dump_clean == dump_incremental

    # Corrupting rebuild: real handler, then mutate exactly ONE row once.
    real = projection._apply_message_created
    target_stream = sorted(ws.streams)[0]

    def corrupt(handler_conn: sqlite3.Connection, env: Envelope) -> None:
        real(handler_conn, env)
        assert env.server is not None
        if env.body.stream_id == target_stream and env.server.server_sequence == 1:
            handler_conn.execute(
                "UPDATE messages SET text = text || 'X' "
                "WHERE stream_id = ? AND server_sequence = 1",
                (target_stream,),
            )

    monkeypatch.setitem(projection._HANDLERS, ("message.created", 1), corrupt)
    rebuild_projection(ws)
    monkeypatch.undo()

    conn = open_db(root / PROJECTION_DB_NAME)
    try:
        dump_corrupt = dump_messages(conn)
    finally:
        conn.close()

    # A single-cell divergence makes the gate's equality assertion raise.
    assert dump_corrupt != dump_incremental


# --- honest end-to-end wiring: subprocess smoke ----------------------------------


def test_cli_end_to_end_smoke(tmp_path: Path) -> None:
    """Real CLI init → send×6 → project → rebuild → verify, all exit 0.

    The one subprocess slice: proves argparse → ``cmd_project`` →
    ``cmd_rebuild`` → ``cmd_verify`` wiring is intact end to end, with the
    in-process dump compared across the rebuild.
    """
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0

    sends = [
        ("general", "hello"),
        ("general", "wörld — ünïcode ✓ 🌍"),
        ("random", "第三条消息"),
        ("general", ""),  # empty text is valid
        ("random", "plain five"),
        ("general", "six"),
    ]
    for stream, text in sends:
        proc = run_cli("send", str(root), "--stream", stream, "--text", text)
        assert proc.returncode == 0, proc.stderr

    proc = run_cli("project", str(root))
    assert proc.returncode == 0, proc.stderr

    conn = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        dump_before = dump_messages(conn)
    finally:
        conn.close()
    assert dump_before.count("\n") == len(sends) - 1  # all six rows projected

    proc = run_cli("rebuild", str(root))
    assert proc.returncode == 0, proc.stderr

    conn = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        dump_after = dump_messages(conn)
    finally:
        conn.close()
    assert dump_after == dump_before  # rebuild ≡ incremental through the real CLI

    proc = run_cli("verify", str(root), "--json")
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["ok"] is True
