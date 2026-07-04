"""``msgctl verify`` — independent, read-only re-derivation of the M0 log invariants.

``verify`` walks a workspace's log tree and re-proves, from the bytes on disk alone,
the two promises ``send`` made (ENG-60, TDD §9 / §11.4):

1.  **Hash faithfulness (D1):** for every event in every stream, recompute
    ``event_hash`` = SHA-256 over the JCS canonicalization of the **raw stored body**
    and compare it to the stored ``event_hash`` string. A mismatch is exactly the
    tampering the hash exists to catch — a flipped body byte, or a payload edited
    without re-hashing.
2.  **Sequence integrity (D2):** per-stream ``server_sequence`` is gapless from 1, has
    no duplicates, and is monotonic across month files.

Plus per-event envelope schema validation (known types validated against the payload
registry; unknown types get hash + sequence + envelope-shape checks only — D9) and a
set of workspace-level cross-checks (registry vs. on-disk stream dirs, ``body``'s
``workspace_id`` vs. the manifest).

Discipline this module is built to keep
--------------------------------------
* **Read-only, always (Ruling 1).** verify has its OWN walk; it never reuses
  ``append.py``'s scan. It opens every month file with ``read_bytes()`` and NEVER
  truncates, fsyncs, repairs, or otherwise mutates the disk — a torn trailing line is
  *reported* (a warning), never fixed. Every anomaly becomes a :class:`Finding`; nothing
  raises mid-walk. verify takes no lock (it is safe to run against a live workspace; a
  concurrent ``send`` at worst yields a benign ``torn_line`` warning).
* **``streams/**/*.ndjson`` ONLY (Ruling 2, the ENG-58 anti-collision boundary).** File
  discovery is exactly ``streams/<stream_id>/*.ndjson`` plus ``workspace.json``. verify
  reads NOTHING else at the workspace root — in particular it ignores
  ``projections.sqlite3`` (which ENG-58 places at the root) and any lock/temp/WAL
  sidecar. A ``.ndjson`` directly under ``streams/`` (not inside a ``<stream_id>/``
  subdir) is not a stream log and is ignored (verbose note only).
* **Raw-hash authority (Ruling 2, non-negotiable).** The hash check calls
  ``hash_event(raw["body"])`` on the pre-model parsed dict and compares to the raw
  stored ``event_hash`` string. ``verify_hash(envelope)`` is FORBIDDEN here — see the
  comment on Pass A. Schema validation is a SEPARATE, additive pass whose result never
  feeds the hash check.
* **Collect everything (Ruling 8).** verify never stops at the first finding; it walks
  every stream, month, and line, then prints and exits. Human output is capped at
  :data:`MAX_HUMAN_FINDINGS` detail lines (summary counts stay complete); ``--json`` is
  uncapped.

Exit codes (CI contract): ``0`` clean or warnings-only, ``1`` any failure, ``2``
usage/IO (not a workspace, unreadable path).

Blob re-hashing (§9 "re-hashes every blob") is **out of scope until M4** — an M0
workspace has no ``blobs/`` tree (ENG-57 §9 subset). The ``# M4 SEAM:`` marker in
:func:`verify_workspace` is the documented slot where M4's ``_verify_blobs`` pass (with
its own ``blob_missing`` / ``blob_hash_mismatch`` classes) will attach without touching
the stream walk.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from msgd.core.envelope import Envelope
from msgd.core.hashing import hash_event
from msgd.core.jcs import JCSError
from msgd.core.payloads import get_payload_model
from pydantic import ValidationError

from msgctl.errors import CorruptLogError, UsageError, WorkspaceError
from msgctl.workspace import STREAMS_DIR, Workspace

__all__ = [
    "MAX_HUMAN_FINDINGS",
    "Severity",
    "Finding",
    "StreamSummary",
    "VerifyReport",
    "verify_workspace",
    "format_human",
    "format_json",
]

#: Cap on the number of finding detail lines the human report prints (Ruling 8). Summary
#: counts are always complete; ``--json`` is never capped.
MAX_HUMAN_FINDINGS = 100

#: Longest validation-error detail string kept in a finding (keeps a report readable).
_MAX_DETAIL = 200


class Severity(StrEnum):
    """A finding's severity. ``FAILURE`` drives exit 1; ``WARNING`` alone is exit 0."""

    FAILURE = "failure"
    WARNING = "warning"


@dataclass(frozen=True)
class Finding:
    """One thing verify observed on disk. ``sequence``/``event_id`` are ``None`` when
    unknown (e.g. an ``unparseable`` line); ``stream_id`` is ``None`` for a
    workspace-level finding such as ``manifest_invalid``. ``file`` is relative to the
    workspace root (stable across machines, CI-diffable)."""

    severity: Severity
    cls: str
    stream_id: str | None
    sequence: int | None
    event_id: str | None
    file: str
    detail: str


@dataclass
class StreamSummary:
    """Per-stream roll-up for the report. ``failures``/``warnings`` are filled in once
    all findings (including cross-checks) are collected."""

    stream_id: str
    name: str | None
    events: int
    first_seq: int | None
    last_seq: int | None
    failures: int = 0
    warnings: int = 0


@dataclass
class VerifyReport:
    """The full outcome of a verify run: findings + per-stream summaries + verbose notes."""

    root: Path
    workspace_id: str | None
    findings: list[Finding]
    streams: list[StreamSummary]
    notes: list[str] = field(default_factory=list)

    @property
    def failures(self) -> int:
        return sum(1 for f in self.findings if f.severity is Severity.FAILURE)

    @property
    def warnings(self) -> int:
        return sum(1 for f in self.findings if f.severity is Severity.WARNING)

    @property
    def total_events(self) -> int:
        return sum(s.events for s in self.streams)

    @property
    def ok(self) -> bool:
        """True iff there are no failures (warnings do not flip this)."""
        return self.failures == 0

    @property
    def exit_code(self) -> int:
        """``1`` if any failure was found, else ``0`` (a warnings-only run is clean)."""
        return 1 if self.failures else 0


def _clip(text: str) -> str:
    """Truncate an over-long detail string (e.g. a Pydantic error dump)."""
    text = " ".join(text.split())
    return text if len(text) <= _MAX_DETAIL else text[: _MAX_DETAIL - 1] + "…"


def _walk_stream(
    root: Path,
    stream_dir: Path,
    stream_id: str,
    name: str | None,
    manifest_wsid: str | None,
    findings: list[Finding],
    notes: list[str],
) -> StreamSummary:
    """Own read-only walk of one stream (Ruling 1): every month file, every line.

    Sequence/id bookkeeping (``expected``/``seen_seqs``/``seen_ids``) is carried ACROSS
    month files — ``*.ndjson`` sorted lexically is chronological, so contiguity spans
    month boundaries (matching ``append``'s scan semantics). Never mutates disk.
    """
    expected = 1
    seen_seqs: set[int] = set()
    seen_ids: dict[str, int] = {}
    events = 0
    first_seq: int | None = None
    last_seq: int | None = None

    month_files = sorted(stream_dir.glob("*.ndjson"))
    for idx, path in enumerate(month_files):
        rel = str(path.relative_to(root))
        raw_bytes = path.read_bytes()

        # Torn trailing line (Ruling 3): non-empty, no final "\n" => the bytes after the
        # last "\n" are an interrupted (never-acked) write. Report as a WARNING and drop
        # the partial chunk from checking; NEVER truncate (that is append's job).
        terminated = raw_bytes
        if raw_bytes and not raw_bytes.endswith(b"\n"):
            last_nl = raw_bytes.rfind(b"\n")
            terminated = raw_bytes[: last_nl + 1]
            detail = "unterminated trailing bytes (interrupted write)"
            if idx != len(month_files) - 1:
                detail += " on a non-final month file (suspicious)"
            findings.append(
                Finding(Severity.WARNING, "torn_line", stream_id, None, None, rel, detail)
            )

        for line in terminated.split(b"\n"):
            if not line:  # the empty element after the final "\n"
                continue

            # ---- Pass A: parse + RAW hash (Ruling 2) ----
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                findings.append(
                    Finding(
                        Severity.FAILURE, "unparseable", stream_id, None, None, rel, "invalid JSON"
                    )
                )
                continue  # a hole: do NOT advance the expected sequence
            if not isinstance(obj, dict):
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "unparseable",
                        stream_id,
                        None,
                        None,
                        rel,
                        "not a JSON object",
                    )
                )
                continue

            # Read seq + event_id defensively from the RAW dict (never a validated model),
            # so a line whose payload merely fails schema validation is still counted
            # toward the sequence rather than becoming a phantom gap.
            try:
                seq_raw = obj["server"]["server_sequence"]
                eid_raw = obj["body"]["event_id"]
            except (KeyError, TypeError):
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "unparseable",
                        stream_id,
                        None,
                        None,
                        rel,
                        "missing server.server_sequence or body.event_id",
                    )
                )
                continue
            if (
                not isinstance(seq_raw, int)
                or isinstance(seq_raw, bool)
                or not isinstance(eid_raw, str)
            ):
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "unparseable",
                        stream_id,
                        None,
                        None,
                        rel,
                        "server_sequence not an int or event_id not a string",
                    )
                )
                continue
            seq: int = seq_raw
            eid: str = eid_raw

            # HASH CHECK — RAW body -> hash_event; verify_hash(envelope) is FORBIDDEN here.
            # verify_hash re-dumps body.model_dump(), and Pydantic lax coercion would
            # silently repair a nonconforming body ("type_version": "1" -> 1), masking the
            # exact byte divergence this check exists to catch. Always hash the raw dict and
            # compare to the raw stored event_hash string (never launder either through a model).
            server_meta = obj.get("server")
            redacted = isinstance(server_meta, dict) and bool(server_meta.get("payload_redacted"))
            if not redacted:
                stored_hash = obj.get("event_hash")
                try:
                    computed = hash_event(obj["body"])
                except JCSError as exc:
                    findings.append(
                        Finding(
                            Severity.FAILURE,
                            "hash_mismatch",
                            stream_id,
                            seq,
                            eid,
                            rel,
                            f"body not canonicalizable: {_clip(str(exc))}",
                        )
                    )
                else:
                    if computed != stored_hash:
                        findings.append(
                            Finding(
                                Severity.FAILURE,
                                "hash_mismatch",
                                stream_id,
                                seq,
                                eid,
                                rel,
                                f"recomputed {computed} != stored {stored_hash}",
                            )
                        )

            # workspace_id cross-check (suppressed in best-effort mode where wsid is unknown).
            if manifest_wsid is not None:
                body_obj = obj.get("body")
                body_wsid = body_obj.get("workspace_id") if isinstance(body_obj, dict) else None
                if body_wsid != manifest_wsid:
                    findings.append(
                        Finding(
                            Severity.FAILURE,
                            "workspace_id_mismatch",
                            stream_id,
                            seq,
                            eid,
                            rel,
                            f"body.workspace_id {body_wsid!r} != manifest {manifest_wsid!r}",
                        )
                    )

            # ---- Pass B: sequence + id bookkeeping (Ruling 5B) ----
            events += 1
            if first_seq is None:
                first_seq = seq
            last_seq = seq
            if seq == expected:
                expected = seq + 1
            elif seq in seen_seqs:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "duplicate",
                        stream_id,
                        seq,
                        eid,
                        rel,
                        f"server_sequence {seq} appears more than once",
                    )
                )
            elif seq > expected:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "gap",
                        stream_id,
                        seq,
                        eid,
                        rel,
                        f"missing {expected}..{seq - 1}",
                    )
                )
                expected = seq + 1  # resync so one gap doesn't cascade per later line
            else:  # seq < expected and not previously seen
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "out_of_order",
                        stream_id,
                        seq,
                        eid,
                        rel,
                        f"server_sequence {seq} < expected {expected} (non-monotonic on disk)",
                    )
                )
            seen_seqs.add(seq)
            prior = seen_ids.get(eid)
            if prior is not None and prior != seq:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "duplicate_event_id",
                        stream_id,
                        seq,
                        eid,
                        rel,
                        f"event_id {eid} at seq {prior} and {seq}",
                    )
                )
            else:
                seen_ids.setdefault(eid, seq)

            # ---- Pass C: schema validation (Ruling 5C) — independent of A/B, additive ----
            try:
                env = Envelope.model_validate(obj)
            except ValidationError as exc:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "unparseable",
                        stream_id,
                        seq,
                        eid,
                        rel,
                        f"envelope shape invalid: {_clip(str(exc))}",
                    )
                )
                continue
            model = get_payload_model(env.body.type, env.body.type_version)
            if model is None:
                # Unknown type is NOT a finding (D9): hash + sequence + envelope-shape
                # checks already ran; payload validation is skipped. Verbose note only.
                notes.append(
                    f"unknown type {env.body.type} v{env.body.type_version} "
                    f"at {rel} seq {seq} (payload not validated, D9)"
                )
                continue
            try:
                model.model_validate(env.body.payload)
            except ValidationError as exc:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "schema_invalid",
                        stream_id,
                        seq,
                        eid,
                        rel,
                        f"{env.body.type} v{env.body.type_version} payload: {_clip(str(exc))}",
                    )
                )

    return StreamSummary(
        stream_id=stream_id,
        name=name,
        events=events,
        first_seq=first_seq,
        last_seq=last_seq,
    )


def _cross_check_registry(
    root: Path,
    ws: Workspace,
    summaries_by_sid: dict[str, StreamSummary],
    findings: list[Finding],
) -> None:
    """Registry vs. on-disk cross-checks (Ruling 6).

    A registered stream with a missing/empty dir is a legitimate never-used channel
    (``empty_registered_stream`` warning). A stream dir carrying events that no manifest
    entry knows about is unreachable data (``unregistered_stream_dir`` failure).
    (``workspace_id_mismatch`` is checked inline in Pass A.)
    """
    for sid, info in ws.streams.items():
        summary = summaries_by_sid.get(sid)
        if summary is None or summary.events == 0:
            findings.append(
                Finding(
                    Severity.WARNING,
                    "empty_registered_stream",
                    sid,
                    None,
                    None,
                    f"{STREAMS_DIR}/{sid}",
                    f"registered stream {info.name!r} has no events on disk",
                )
            )
    for sid, summary in summaries_by_sid.items():
        if sid in ws.streams or summary.events == 0:
            continue
        findings.append(
            Finding(
                Severity.FAILURE,
                "unregistered_stream_dir",
                sid,
                None,
                None,
                f"{STREAMS_DIR}/{sid}",
                f"stream dir with {summary.events} event(s) has no manifest entry",
            )
        )


def verify_workspace(root: Path | str, *, verbose: bool = False) -> VerifyReport:
    """Walk ``root`` read-only and return a :class:`VerifyReport` (Ruling 1–6, 9).

    Opens ``workspace.json`` via the read-only :meth:`Workspace.open`. A missing
    manifest (not a workspace) raises :class:`UsageError` (exit 2). A malformed manifest
    or duplicate stream name yields one ``manifest_invalid`` failure and best-effort mode
    (empty registry): all per-line hash/sequence/schema checks still run, but the
    registry/``workspace_id`` cross-checks are suppressed (unknown => noise).

    ``verbose`` collects unknown-type notes and enables per-stream OK lines in the human
    formatter.
    """
    root = Path(root)
    findings: list[Finding] = []
    notes: list[str] = []

    ws: Workspace | None
    try:
        ws = Workspace.open(root)
    except WorkspaceError as exc:
        # Not an initialized workspace: a usage error, not a finding (exit 2).
        raise UsageError(str(exc)) from exc
    except CorruptLogError as exc:
        # Malformed manifest / duplicate stream name: one failure, then best-effort mode.
        findings.append(
            Finding(
                Severity.FAILURE, "manifest_invalid", None, None, None, "workspace.json", str(exc)
            )
        )
        ws = None

    workspace_id = ws.workspace_id if ws is not None else None
    # None suppresses the workspace_id cross-check (best-effort mode).
    manifest_wsid = ws.workspace_id if ws is not None else None
    registered_names: dict[str, str] = {sid: i.name for sid, i in ws.streams.items()} if ws else {}

    streams_dir = root / STREAMS_DIR
    summaries: list[StreamSummary] = []
    try:
        dir_entries = sorted(streams_dir.iterdir()) if streams_dir.is_dir() else []
    except OSError as exc:
        raise UsageError(f"cannot read {streams_dir}: {exc}") from exc

    for entry in dir_entries:
        if not entry.is_dir():
            # A file directly under streams/ is not a stream log (Ruling 2). Ignore it;
            # note only a stray .ndjson in verbose mode.
            if verbose and entry.suffix == ".ndjson":
                notes.append(f"ignoring {entry.name}: a .ndjson directly under {STREAMS_DIR}/")
            continue
        sid = entry.name
        try:
            summaries.append(
                _walk_stream(
                    root, entry, sid, registered_names.get(sid), manifest_wsid, findings, notes
                )
            )
        except OSError as exc:
            raise UsageError(f"cannot read stream dir {entry}: {exc}") from exc

    summaries_by_sid = {s.stream_id: s for s in summaries}
    if ws is not None:
        _cross_check_registry(root, ws, summaries_by_sid, findings)

    # M4 SEAM: _verify_blobs(root, findings) would run here — re-hash blobs/sha256/**
    # and cross-check message.created file_ids against the blob store (Ruling 9). No
    # blobs/ tree exists in an M0 workspace, so there is nothing to do yet.

    # Fill in per-stream failure/warning counts now that all findings (incl. cross-checks) exist.
    for summary in summaries:
        summary.failures = sum(
            1
            for f in findings
            if f.stream_id == summary.stream_id and f.severity is Severity.FAILURE
        )
        summary.warnings = sum(
            1
            for f in findings
            if f.stream_id == summary.stream_id and f.severity is Severity.WARNING
        )

    return VerifyReport(
        root=root,
        workspace_id=workspace_id,
        findings=findings,
        streams=summaries,
        notes=notes,
    )


def _finding_sort_key(f: Finding) -> tuple[int, str, int]:
    """Failures before warnings, then by stream, then by sequence (Ruling 8 ordering)."""
    sev_rank = 0 if f.severity is Severity.FAILURE else 1
    return (sev_rank, f.stream_id or "", f.sequence if f.sequence is not None else -1)


def format_human(
    report: VerifyReport, *, cap: int = MAX_HUMAN_FINDINGS, verbose: bool = False
) -> str:
    """Render the human-readable report: per-stream summary, capped findings, totals."""
    lines: list[str] = []
    for summary in sorted(report.streams, key=lambda s: s.stream_id):
        label = f"stream {summary.stream_id}"
        if summary.name:
            label += f" ({summary.name})"
        span = (
            f"seq {summary.first_seq}..{summary.last_seq}"
            if summary.first_seq is not None
            else "no events"
        )
        if summary.failures or summary.warnings:
            lines.append(
                f"{label}: {summary.events} events, {span}, "
                f"{summary.failures} failure(s), {summary.warnings} warning(s)"
            )
        elif verbose:
            lines.append(f"{label}: {summary.events} events, {span}, OK")

    ordered = sorted(report.findings, key=_finding_sort_key)
    for finding in ordered[:cap]:
        seq = "?" if finding.sequence is None else finding.sequence
        sid = finding.stream_id or "-"
        lines.append(
            f"  [{finding.severity.value}] {finding.cls} {sid} seq={seq} "
            f"{finding.file}: {finding.detail}"
        )
    if len(ordered) > cap:
        lines.append(f"  … +{len(ordered) - cap} more findings (use --json for the full list)")

    if verbose:
        lines.extend(f"note: {note}" for note in report.notes)

    lines.append(
        f"{report.total_events} events across {len(report.streams)} streams: "
        f"{report.failures} failure(s), {report.warnings} warning(s)"
    )
    return "\n".join(lines)


def format_json(report: VerifyReport) -> str:
    """Render the uncapped machine-readable report (Ruling 7). Relative ``file`` paths."""
    payload: dict[str, Any] = {
        "root": str(report.root),
        "workspace_id": report.workspace_id,
        "ok": report.ok,
        "summary": {
            "streams": len(report.streams),
            "events": report.total_events,
            "failures": report.failures,
            "warnings": report.warnings,
            "findings_total": len(report.findings),
        },
        "streams": [
            {
                "stream_id": s.stream_id,
                "name": s.name,
                "events": s.events,
                "first_seq": s.first_seq,
                "last_seq": s.last_seq,
                "failures": s.failures,
                "warnings": s.warnings,
            }
            for s in report.streams
        ],
        "findings": [
            {
                "severity": f.severity.value,
                "class": f.cls,
                "stream_id": f.stream_id,
                "sequence": f.sequence,
                "event_id": f.event_id,
                "file": f.file,
                "detail": f.detail,
            }
            for f in report.findings
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)
