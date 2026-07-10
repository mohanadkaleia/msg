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
  feeds the hash check. **No redaction waiver at M0 (security round 1):** the plan's
  ``payload_redacted`` exemption is withdrawn — redaction does not exist at M0, so the
  self-asserted flag has no authority; the hash check runs unconditionally and a truthy
  flag is itself a FAILURE (``redacted_line``). The §2.1 exemption returns at M1 only
  for authenticated, audited server redactions validated against their audit record.
* **TTY-safe human output.** Untrusted strings (stored hashes, dir/file names, manifest
  stream names, event types) are escaped (C0/C1/DEL → visible ``\\xNN``) at the
  ``format_human`` boundary only — ESC enables ANSI rewriting and CR enables line
  overwrite, and the human report is the operator's decision surface. ``Finding``
  values stay raw so ``--json`` keeps byte-fidelity (``json.dumps`` escapes control
  characters itself).
* **Collect everything (Ruling 8).** verify never stops at the first finding; it walks
  every stream, month, and line, then prints and exits. Human output is capped at
  :data:`MAX_HUMAN_FINDINGS` detail lines (summary counts stay complete); ``--json`` is
  uncapped.

Exit codes (CI contract): ``0`` clean or warnings-only, ``1`` any failure, ``2``
usage/IO (not a workspace, unreadable path).

Bundle mode (M4-2, ENG-156)
---------------------------
:func:`verify_path` dispatches on the target's marker file: a ``manifest.json``
means a §9 **export bundle** (:func:`verify_bundle`); otherwise ``workspace.json``
means the live-workspace walk above (:func:`verify_workspace`, unchanged). The §9
bundle deliberately has **no prev-hash chain** — its integrity story is per-event
``event_hash`` + gapless ``server_sequence`` + the sealed manifest: every month
file's sha256/bytes/counts and both sidecar digests are embedded in
``manifest.json``, which ``bundle_digest`` (SHA-256 over the JCS canonicalization
of the manifest sans that key) transitively commits — so a reorder/renumber that
keeps every per-event hash valid is still caught by the month-file digest. Bundle
mode adds the blob pass this module's ``# M4 SEAM`` always reserved
(``blob_hash_mismatch`` / ``blob_missing`` / ``blob_unreferenced``), the manifest
cross-checks (``manifest_digest_mismatch`` / ``file_digest_mismatch`` /
``count_mismatch``), and workspace-global ``event_id`` uniqueness. All the
disciplines above (read-only, raw-hash authority, collect-everything, TTY-safe
human output, the exit-code contract) apply unchanged.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Final

from msgd.core.envelope import Envelope
from msgd.core.hashing import hash_event
from msgd.core.jcs import JCSError, canonicalize
from msgd.core.payloads import get_payload_model
from pydantic import ValidationError

from msgctl.errors import CorruptLogError, UsageError, WorkspaceError
from msgctl.workspace import STREAMS_DIR, Workspace

__all__ = [
    "BUNDLE_MANIFEST_NAME",
    "MAX_HUMAN_FINDINGS",
    "Severity",
    "Finding",
    "StreamSummary",
    "VerifyReport",
    "verify_path",
    "verify_workspace",
    "verify_bundle",
    "format_human",
    "format_json",
]

#: The §9 export-bundle manifest — its presence is what makes a directory a bundle
#: (mode detection in :func:`verify_path`). Distinct from the live ``workspace.json``.
BUNDLE_MANIFEST_NAME: Final = "manifest.json"

#: The bundle's content-addressed blob tree (``blobs/<ab>/<sha256hex>``), mirroring
#: the server's BlobStore layout.
_BLOBS_DIR: Final = "blobs"

#: The two JSON sidecars every bundle carries, each digest-pinned by the manifest.
_SIDECAR_NAMES: Final = ("users.json", "files.json")

#: A content-addressed blob filename: bare 64-char lowercase hex (the BlobStore key
#: form — NOT the ``sha256:<hex>`` prefixed form used by ``event_hash``).
_BLOB_HEX_RE: Final = re.compile(r"[0-9a-f]{64}")

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


#: C0 controls, DEL, and C1 controls — the classes that can rewrite a terminal.
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _sanitize_for_terminal(text: str) -> str:
    """Escape C0/C1 control chars for TTY-safe display (``\\xNN`` form).

    Untrusted log/manifest content must never reach a terminal raw: ESC enables ANSI
    rewriting, CR enables line overwrite. Applied ONLY in :func:`format_human` —
    ``Finding`` values stay raw so ``--json`` keeps byte-fidelity (``json.dumps``
    escapes control chars itself, so the JSON path is already safe). Escape-visibly,
    never strip: the escaped bytes are themselves evidence an injection was attempted.
    """
    return _CTRL_RE.sub(lambda m: f"\\x{ord(m.group()):02x}", text)


@dataclass
class _BundleStreamHooks:
    """Bundle-mode (M4-2) extras threaded through the shared stream walk.

    ``global_event_ids`` and ``uploaded_sha256s`` are SHARED across all streams of one
    bundle (workspace-global ``event_id`` uniqueness; ``file.uploaded`` blob
    references for the blob pass). ``month_stats`` is per-stream: month filename ->
    recomputed ``{sha256, bytes, event_count, first_seq, last_seq}``, compared later
    against ``manifest.streams[id].files`` (the truncation/reorder/append detector).
    """

    global_event_ids: dict[str, str]
    uploaded_sha256s: set[str]
    month_stats: dict[str, dict[str, Any]] = field(default_factory=dict)


def _walk_stream(
    root: Path,
    stream_dir: Path,
    stream_id: str,
    name: str | None,
    manifest_wsid: str | None,
    findings: list[Finding],
    notes: list[str],
    bundle: _BundleStreamHooks | None = None,
) -> StreamSummary:
    """Own read-only walk of one stream (Ruling 1): every month file, every line.

    Sequence/id bookkeeping (``expected``/``seen_seqs``/``seen_ids``) is carried ACROSS
    month files — ``*.ndjson`` sorted lexically is chronological, so contiguity spans
    month boundaries (matching ``append``'s scan semantics). Never mutates disk.

    ``bundle`` (M4-2) enables the bundle-only extras: per-month-file digest/count
    recomputation, month-file naming, ``body.stream_id`` binding, workspace-global
    ``event_id`` uniqueness, and ``file.uploaded`` blob-reference collection.
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
        month = path.name.removesuffix(".ndjson")

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

        # Bundle mode: recompute this month file's manifest entry from the bytes on
        # disk (digest/size over the RAW bytes — a torn tail must show up as a
        # mismatch, not be silently healed; counts over the terminated lines).
        stats: dict[str, Any] | None = None
        if bundle is not None:
            stats = bundle.month_stats[path.name] = {
                "sha256": hashlib.sha256(raw_bytes).hexdigest(),
                "bytes": len(raw_bytes),
                "event_count": sum(1 for chunk in terminated.split(b"\n") if chunk),
                "first_seq": None,
                "last_seq": None,
            }

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
            if stats is not None:
                if stats["first_seq"] is None:
                    stats["first_seq"] = seq
                stats["last_seq"] = seq

            # HASH CHECK — RAW body -> hash_event; verify_hash(envelope) is FORBIDDEN here.
            # verify_hash re-dumps body.model_dump(), and Pydantic lax coercion would
            # silently repair a nonconforming body ("type_version": "1" -> 1), masking the
            # exact byte divergence this check exists to catch. Always hash the raw dict and
            # compare to the raw stored event_hash string (never launder either through a model).
            #
            # SECURITY (S1, revises plan Ruling 2): the hash check runs UNCONDITIONALLY at
            # M0 — there is no payload_redacted exemption. Redaction does not exist at M0
            # (send hardcodes False), so the self-asserted in-band flag has NO authority;
            # honoring it would let one attacker-writable bit waive the exact tamper class
            # verify exists to catch. A truthy flag is itself a FAILURE (redacted_line).
            # M1 note: the §2.1 exemption returns only for authenticated, audited server
            # redactions, validated against their audit record — never the bare flag.
            server_meta = obj.get("server")
            redacted = isinstance(server_meta, dict) and bool(server_meta.get("payload_redacted"))
            if redacted:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "redacted_line",
                        stream_id,
                        seq,
                        eid,
                        rel,
                        "payload_redacted set, but M0 has no redaction authority — "
                        "hash check NOT waived",
                    )
                )
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
                            f"recomputed {computed} != stored {_clip(str(stored_hash))}",
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

            # ---- Bundle-only per-line checks (M4-2) ----
            if bundle is not None:
                # An event's month file is part of the sealed layout: the file name
                # must equal server_received_at[:7]. A non-string received_at is
                # already an envelope-shape failure in Pass C, so only check strings.
                received = (
                    server_meta.get("server_received_at") if isinstance(server_meta, dict) else None
                )
                if isinstance(received, str) and received[:7] != month:
                    findings.append(
                        Finding(
                            Severity.FAILURE,
                            "month_mismatch",
                            stream_id,
                            seq,
                            eid,
                            rel,
                            f"server_received_at {_clip(received)!r} does not belong "
                            f"in month file {path.name}",
                        )
                    )
                body_obj = obj.get("body")
                body_sid = body_obj.get("stream_id") if isinstance(body_obj, dict) else None
                if body_sid != stream_id:
                    findings.append(
                        Finding(
                            Severity.FAILURE,
                            "stream_id_mismatch",
                            stream_id,
                            seq,
                            eid,
                            rel,
                            f"body.stream_id {body_sid!r} != stream dir {stream_id!r}",
                        )
                    )
                # Collect blob references for the blob pass: every file.uploaded
                # payload sha256 must exist under blobs/ (or be declared missing).
                if isinstance(body_obj, dict) and body_obj.get("type") == "file.uploaded":
                    payload_obj = body_obj.get("payload")
                    payload_sha = (
                        payload_obj.get("sha256") if isinstance(payload_obj, dict) else None
                    )
                    if isinstance(payload_sha, str):
                        bundle.uploaded_sha256s.add(payload_sha)

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
            # Workspace-global uniqueness (M4-2): the same event_id in TWO different
            # streams of one bundle. The per-stream duplicate above already covers
            # reuse within a stream, so only the cross-stream case fires here.
            if bundle is not None:
                prior_stream = bundle.global_event_ids.setdefault(eid, stream_id)
                if prior_stream != stream_id:
                    findings.append(
                        Finding(
                            Severity.FAILURE,
                            "duplicate_event_id_global",
                            stream_id,
                            seq,
                            eid,
                            rel,
                            f"event_id {eid} also appears in stream {prior_stream}",
                        )
                    )

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

    A mid-walk ``OSError`` on a month file aborts the run with exit 2 (environmental, not
    a finding): a partially-read stream cannot honestly be reported gapless. Revisit at M4
    scale if long-running verifies want per-stream isolation.

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
        # Not an initialized workspace: a usage error, not a finding (exit 2). Must stay
        # FIRST and separate from the malformed-manifest tuple below.
        raise UsageError(str(exc)) from exc
    except (CorruptLogError, KeyError, TypeError, ValueError, AttributeError) as exc:
        # Malformed manifest: one failure, then best-effort mode. The tuple covers every
        # shape Workspace.open can actually raise on a valid-JSON-but-wrong manifest
        # (missing workspace_id -> KeyError, non-dict "streams" -> AttributeError, non-dict
        # stream entry -> TypeError) plus ValueError for malformed scalars. A bare
        # `except Exception` is deliberately rejected: it would relabel genuine verify
        # bugs as manifest_invalid findings and hide crashes CI must see.
        findings.append(
            Finding(
                Severity.FAILURE,
                "manifest_invalid",
                None,
                None,
                None,
                "workspace.json",
                f"malformed manifest: {exc!r}",
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

    # M4 SEAM (filled by ENG-156): the blob pass lives in _verify_blobs and runs from
    # verify_bundle — a live M0/M1 workspace still has no blobs/ tree, so the
    # live-workspace walk keeps nothing to do here.

    _fill_stream_counts(summaries, findings)

    return VerifyReport(
        root=root,
        workspace_id=workspace_id,
        findings=findings,
        streams=summaries,
        notes=notes,
    )


def _fill_stream_counts(summaries: list[StreamSummary], findings: list[Finding]) -> None:
    """Fill per-stream failure/warning counts once ALL findings are collected."""
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


# --------------------------------------------------------------------------- bundle mode


def verify_path(root: Path | str, *, verbose: bool = False) -> VerifyReport:
    """Mode dispatch (M4-2): ``manifest.json`` => §9 export bundle, else live workspace.

    A directory carrying BOTH marker files is verified as a bundle (the sealed
    manifest is the stronger contract). A directory with neither raises
    :class:`UsageError` from :func:`verify_workspace` (exit 2), unchanged.
    """
    root = Path(root)
    if (root / BUNDLE_MANIFEST_NAME).is_file():
        return verify_bundle(root, verbose=verbose)
    return verify_workspace(root, verbose=verbose)


def verify_bundle(root: Path | str, *, verbose: bool = False) -> VerifyReport:
    """Walk a §9 export bundle read-only and return a :class:`VerifyReport` (M4-2).

    Three passes, ALL collected (Ruling 8 — never stop at the first finding):

    A. **Event log** — the same per-line raw-hash/sequence/schema walk as a live
       workspace, plus the bundle-only per-line checks: month-file naming
       (``server_received_at[:7]`` == file name), ``body.stream_id`` == directory,
       ``body.workspace_id`` == the manifest workspace, workspace-global
       ``event_id`` uniqueness, and ``file.uploaded`` blob-reference collection.
       ``payload_redacted`` remains an unconditional FAILURE (ENG-60 ruling).
    B. **Blobs** (the ``# M4 SEAM`` pass) — every ``blobs/<ab>/<hex>`` re-hashed
       against its path digest; every referenced blob (``files.json`` content +
       thumbnail digests, ``file.uploaded`` payload digests, ``blobs.index``) must
       exist — absent is a FAILURE unless declared in ``manifest.missing_blobs``
       (then a WARNING); an unreferenced blob is a WARNING; sizes are cross-checked
       against ``blobs.index[hex].bytes`` and ``files.json`` ``size_bytes``.
    C. **Manifest** — ``bundle_digest`` recomputed over the JCS canonicalization of
       the manifest sans that key (the exact way export sealed it); every month
       file's sha256/bytes/event_count/first_seq/last_seq recomputed and compared —
       THE truncation/reorder/append detector, since the §9 bundle deliberately has
       no prev-hash chain; ``head_seq``/``event_count``/``event_count_total``;
       sidecar digests; stream dirs <-> manifest entries one-to-one.

    A malformed ``manifest.json`` yields ``manifest_invalid`` finding(s) plus a
    best-effort walk (per-line checks still run; manifest-dependent cross-checks
    are suppressed — unknown expectations would be noise). Exit-code contract
    unchanged: any FAILURE => 1, warnings-only => 0, unreadable path =>
    :class:`UsageError` (2).
    """
    root = Path(root)
    findings: list[Finding] = []
    notes: list[str] = []

    manifest_path = root / BUNDLE_MANIFEST_NAME
    try:
        manifest_bytes = manifest_path.read_bytes()
    except OSError as exc:
        raise UsageError(f"cannot read {manifest_path}: {exc}") from exc

    manifest: dict[str, Any] | None = None
    try:
        parsed = json.loads(manifest_bytes)
    except (json.JSONDecodeError, ValueError):
        parsed = None
    if isinstance(parsed, dict):
        manifest = parsed
        # A COPY is popped/canonicalized — verify never mutates its own evidence.
        _check_bundle_digest(dict(parsed), findings)
    else:
        findings.append(
            Finding(
                Severity.FAILURE,
                "manifest_invalid",
                None,
                None,
                None,
                BUNDLE_MANIFEST_NAME,
                "manifest.json is not a JSON object",
            )
        )

    # Defensive extraction: each malformed section is ONE manifest_invalid finding,
    # and the checks depending on it are skipped (best-effort, mirroring the live
    # workspace's malformed-manifest behavior).
    manifest_wsid: str | None = None
    manifest_streams: dict[str, Any] = {}
    blob_index: dict[str, Any] = {}
    sidecar_digests: dict[str, Any] | None = None
    missing_blobs: set[str] = set()
    #: ENG-152 workspace icon digest (``manifest.workspace.icon_sha256``) — a
    #: referenced blob exactly like a user avatar, so the blob pass requires its
    #: bytes on disk and does not flag them unreferenced.
    manifest_icon_sha: str | None = None
    if manifest is not None:

        def _invalid(detail: str) -> None:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "manifest_invalid",
                    None,
                    None,
                    None,
                    BUNDLE_MANIFEST_NAME,
                    detail,
                )
            )

        ws_raw = manifest.get("workspace")
        wsid = ws_raw.get("workspace_id") if isinstance(ws_raw, dict) else None
        if isinstance(wsid, str):
            manifest_wsid = wsid
        else:
            _invalid("workspace.workspace_id missing or not a string")
        icon_raw = ws_raw.get("icon_sha256") if isinstance(ws_raw, dict) else None
        if isinstance(icon_raw, str):
            manifest_icon_sha = icon_raw
        elif icon_raw is not None:
            _invalid("workspace.icon_sha256 is not a string or null")
        streams_raw = manifest.get("streams")
        if isinstance(streams_raw, dict):
            manifest_streams = streams_raw
        else:
            _invalid("streams missing or not an object")
        blobs_raw = manifest.get("blobs")
        index_raw = blobs_raw.get("index") if isinstance(blobs_raw, dict) else None
        if isinstance(index_raw, dict):
            blob_index = index_raw
        else:
            _invalid("blobs.index missing or not an object")
        sidecars_raw = manifest.get("sidecars")
        if isinstance(sidecars_raw, dict):
            sidecar_digests = sidecars_raw
        else:
            _invalid("sidecars missing or not an object")
        mb_raw = manifest.get("missing_blobs")
        if isinstance(mb_raw, list) and all(isinstance(sha, str) for sha in mb_raw):
            missing_blobs = set(mb_raw)
        else:
            _invalid("missing_blobs missing or not an array of strings")

    # ---- Pass A: the shared stream walk, with the bundle hooks attached ---------
    global_event_ids: dict[str, str] = {}
    uploaded_sha256s: set[str] = set()
    month_stats_by_stream: dict[str, dict[str, dict[str, Any]]] = {}
    streams_dir = root / STREAMS_DIR
    summaries: list[StreamSummary] = []
    try:
        dir_entries = sorted(streams_dir.iterdir()) if streams_dir.is_dir() else []
    except OSError as exc:
        raise UsageError(f"cannot read {streams_dir}: {exc}") from exc

    for entry in dir_entries:
        if not entry.is_dir():
            if verbose and entry.suffix == ".ndjson":
                notes.append(f"ignoring {entry.name}: a .ndjson directly under {STREAMS_DIR}/")
            continue
        sid = entry.name
        entry_meta = manifest_streams.get(sid)
        name_raw = entry_meta.get("name") if isinstance(entry_meta, dict) else None
        hooks = _BundleStreamHooks(
            global_event_ids=global_event_ids, uploaded_sha256s=uploaded_sha256s
        )
        try:
            summaries.append(
                _walk_stream(
                    root,
                    entry,
                    sid,
                    name_raw if isinstance(name_raw, str) else None,
                    manifest_wsid,
                    findings,
                    notes,
                    bundle=hooks,
                )
            )
        except OSError as exc:
            raise UsageError(f"cannot read stream dir {entry}: {exc}") from exc
        month_stats_by_stream[sid] = hooks.month_stats

    # ---- Pass C: manifest cross-checks (skipped sections already flagged above) --
    summaries_by_sid = {s.stream_id: s for s in summaries}
    if manifest is not None:
        _cross_check_bundle_streams(
            manifest_streams, summaries_by_sid, month_stats_by_stream, findings
        )
        recomputed_total = sum(s.events for s in summaries)
        total = manifest.get("event_count_total")
        if total != recomputed_total:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "count_mismatch",
                    None,
                    None,
                    None,
                    BUNDLE_MANIFEST_NAME,
                    f"event_count_total: manifest {total!r} != recomputed {recomputed_total}",
                )
            )
    user_entries, file_entries = _check_sidecars(root, sidecar_digests, findings)

    # ---- Pass B: blobs (the # M4 SEAM pass) --------------------------------------
    _verify_blobs(
        root,
        user_entries,
        file_entries,
        uploaded_sha256s,
        blob_index,
        missing_blobs,
        manifest_icon_sha,
        findings,
    )

    _fill_stream_counts(summaries, findings)

    return VerifyReport(
        root=root,
        workspace_id=manifest_wsid,
        findings=findings,
        streams=summaries,
        notes=notes,
    )


def _check_bundle_digest(manifest: dict[str, Any], findings: list[Finding]) -> None:
    """Recompute ``bundle_digest`` exactly the way export sealed it (M4-1).

    ``sha256:`` over the RFC 8785 (JCS) canonicalization of the manifest dict
    WITHOUT the ``bundle_digest`` key — the same canonicalization discipline as
    ``event_hash`` (D1). ``manifest`` is the caller's throwaway copy (popped here).
    """
    stored = manifest.pop("bundle_digest", None)
    if not isinstance(stored, str):
        findings.append(
            Finding(
                Severity.FAILURE,
                "manifest_digest_mismatch",
                None,
                None,
                None,
                BUNDLE_MANIFEST_NAME,
                "bundle_digest missing or not a string",
            )
        )
        return
    try:
        recomputed = f"sha256:{hashlib.sha256(canonicalize(manifest)).hexdigest()}"
    except JCSError as exc:
        findings.append(
            Finding(
                Severity.FAILURE,
                "manifest_digest_mismatch",
                None,
                None,
                None,
                BUNDLE_MANIFEST_NAME,
                f"manifest not canonicalizable: {_clip(str(exc))}",
            )
        )
        return
    if recomputed != stored:
        findings.append(
            Finding(
                Severity.FAILURE,
                "manifest_digest_mismatch",
                None,
                None,
                None,
                BUNDLE_MANIFEST_NAME,
                f"recomputed {recomputed} != stored {_clip(stored)}",
            )
        )


def _cross_check_bundle_streams(
    manifest_streams: dict[str, Any],
    summaries_by_sid: dict[str, StreamSummary],
    month_stats_by_stream: dict[str, dict[str, dict[str, Any]]],
    findings: list[Finding],
) -> None:
    """Manifest <-> on-disk stream cross-checks (bundle Pass C).

    Every manifest stream must have a ``streams/<id>/`` dir (export always creates
    one, even for an empty stream) and every dir a manifest entry — a bundle is a
    sealed artifact, so BOTH directions are failures (unlike the live workspace's
    ``empty_registered_stream`` warning). Each month file's recomputed
    sha256/bytes (``file_digest_mismatch``) and event_count/first_seq/last_seq
    (``count_mismatch``) must equal the manifest entry: with no prev-hash chain in
    the §9 format, this is the check that catches truncation, reordering, and
    appends that keep every per-event hash valid.
    """
    for sid, entry in sorted(manifest_streams.items()):
        if not isinstance(entry, dict):
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "manifest_invalid",
                    sid,
                    None,
                    None,
                    BUNDLE_MANIFEST_NAME,
                    f"streams[{sid!r}] is not an object",
                )
            )
            continue
        summary = summaries_by_sid.get(sid)
        if summary is None:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "stream_dir_missing",
                    sid,
                    None,
                    None,
                    f"{STREAMS_DIR}/{sid}",
                    "manifest stream has no streams/ subdir on disk",
                )
            )
            continue
        stats_by_month = month_stats_by_stream.get(sid, {})
        files_map_raw = entry.get("files")
        files_map: dict[str, Any]
        if isinstance(files_map_raw, dict):
            files_map = files_map_raw
        else:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "manifest_invalid",
                    sid,
                    None,
                    None,
                    BUNDLE_MANIFEST_NAME,
                    f"streams[{sid!r}].files missing or not an object",
                )
            )
            files_map = {}
        for month_name, meta in sorted(files_map.items()):
            rel = f"{STREAMS_DIR}/{sid}/{month_name}"
            stats = stats_by_month.get(month_name)
            if stats is None:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "month_file_missing",
                        sid,
                        None,
                        None,
                        rel,
                        "listed in the manifest but absent on disk",
                    )
                )
                continue
            if not isinstance(meta, dict):
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "manifest_invalid",
                        sid,
                        None,
                        None,
                        BUNDLE_MANIFEST_NAME,
                        f"streams[{sid!r}].files[{month_name!r}] is not an object",
                    )
                )
                continue
            if stats["sha256"] != meta.get("sha256"):
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "file_digest_mismatch",
                        sid,
                        None,
                        None,
                        rel,
                        f"recomputed sha256 {stats['sha256']} != manifest "
                        f"{_clip(str(meta.get('sha256')))}",
                    )
                )
            if stats["bytes"] != meta.get("bytes"):
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "file_digest_mismatch",
                        sid,
                        None,
                        None,
                        rel,
                        f"{stats['bytes']} bytes on disk != manifest {meta.get('bytes')!r}",
                    )
                )
            for field_name in ("event_count", "first_seq", "last_seq"):
                if stats[field_name] != meta.get(field_name):
                    findings.append(
                        Finding(
                            Severity.FAILURE,
                            "count_mismatch",
                            sid,
                            None,
                            None,
                            rel,
                            f"{field_name}: recomputed {stats[field_name]!r} != manifest "
                            f"{meta.get(field_name)!r}",
                        )
                    )
        for month_name in sorted(stats_by_month):
            if month_name not in files_map:
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "month_file_unlisted",
                        sid,
                        None,
                        None,
                        f"{STREAMS_DIR}/{sid}/{month_name}",
                        "month file on disk but not in the manifest",
                    )
                )
        last_on_disk = summary.last_seq if summary.last_seq is not None else 0
        if entry.get("head_seq") != last_on_disk:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "count_mismatch",
                    sid,
                    None,
                    None,
                    f"{STREAMS_DIR}/{sid}",
                    f"head_seq: manifest {entry.get('head_seq')!r} != last on-disk "
                    f"seq {last_on_disk}",
                )
            )
        if entry.get("event_count") != summary.events:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "count_mismatch",
                    sid,
                    None,
                    None,
                    f"{STREAMS_DIR}/{sid}",
                    f"stream event_count: manifest {entry.get('event_count')!r} != "
                    f"{summary.events} on disk",
                )
            )
    for sid, summary in sorted(summaries_by_sid.items()):
        if sid not in manifest_streams:
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


def _check_sidecars(
    root: Path, digests: dict[str, Any] | None, findings: list[Finding]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Verify both sidecars against their manifest digests; return their rows.

    Returns ``(users.json rows, files.json rows)``. ``digests`` is ``None`` in
    best-effort mode (malformed manifest): the digest comparison is suppressed,
    but both sidecars are still parsed so the blob pass keeps its reference set
    (files.json content/thumbnails + users.json avatars, ENG-152).
    """
    user_entries: list[dict[str, Any]] = []
    file_entries: list[dict[str, Any]] = []
    for name in _SIDECAR_NAMES:
        path = root / name
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "sidecar_missing",
                    None,
                    None,
                    None,
                    name,
                    "required bundle sidecar is absent",
                )
            )
            continue
        except OSError as exc:
            raise UsageError(f"cannot read {path}: {exc}") from exc
        if digests is not None:
            expected = digests.get(name)
            if not isinstance(expected, str):
                findings.append(
                    Finding(
                        Severity.FAILURE,
                        "manifest_invalid",
                        None,
                        None,
                        None,
                        BUNDLE_MANIFEST_NAME,
                        f"sidecars[{name!r}] missing or not a string",
                    )
                )
            else:
                actual = hashlib.sha256(data).hexdigest()
                if actual != expected:
                    findings.append(
                        Finding(
                            Severity.FAILURE,
                            "sidecar_digest_mismatch",
                            None,
                            None,
                            None,
                            name,
                            f"recomputed sha256 {actual} != manifest {_clip(expected)}",
                        )
                    )
        try:
            parsed = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if not isinstance(parsed, list) or not all(isinstance(e, dict) for e in parsed):
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "sidecar_invalid",
                    None,
                    None,
                    None,
                    name,
                    "not a JSON array of objects",
                )
            )
        elif name == "files.json":
            file_entries = parsed
        elif name == "users.json":
            user_entries = parsed
    return user_entries, file_entries


def _stream_sha256(path: Path) -> str:
    """Bare-hex sha256 of a file, chunk-streamed (blobs can be tens of MB)."""
    hasher = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(1 << 20):
            hasher.update(chunk)
    return hasher.hexdigest()


def _verify_blobs(
    root: Path,
    user_entries: list[dict[str, Any]],
    file_entries: list[dict[str, Any]],
    uploaded_sha256s: set[str],
    blob_index: dict[str, Any],
    missing_blobs: set[str],
    icon_sha256: str | None,
    findings: list[Finding],
) -> None:
    """The M4 blob pass (fills this module's long-reserved ``# M4 SEAM``).

    * every file under ``blobs/**`` re-hashed against its path digest
      (``blob_hash_mismatch``);
    * every referenced digest — ``files.json`` ``sha256`` + ``thumbnail_sha256``,
      ``users.json`` ``avatar_sha256`` (ENG-152 profile pictures), the
      ``manifest.workspace.icon_sha256`` (ENG-152 workspace icon), every
      ``file.uploaded`` payload ``sha256``, and ``manifest.blobs.index`` —
      must exist on disk: ``blob_missing`` FAILURE, downgraded to a WARNING when
      the digest is declared in ``manifest.missing_blobs``;
    * a blob referenced by nothing is a ``blob_unreferenced`` WARNING;
    * sizes cross-checked against ``blobs.index[hex].bytes`` and ``files.json``
      ``size_bytes`` (``blob_size_mismatch``).
    """
    blobs_dir = root / _BLOBS_DIR
    on_disk: dict[str, Path] = {}
    try:
        blob_paths = (
            sorted(p for p in blobs_dir.rglob("*") if p.is_file()) if blobs_dir.is_dir() else []
        )
    except OSError as exc:
        raise UsageError(f"cannot read {blobs_dir}: {exc}") from exc
    for path in blob_paths:
        rel = str(path.relative_to(root))
        name = path.name
        if (
            not _BLOB_HEX_RE.fullmatch(name)
            or path.parent.name != name[:2]
            or path.parent.parent != blobs_dir
        ):
            findings.append(
                Finding(
                    Severity.WARNING,
                    "blob_unrecognized",
                    None,
                    None,
                    None,
                    rel,
                    "not a blobs/<ab>/<sha256hex> content-addressed path",
                )
            )
            continue
        on_disk[name] = path
        actual = _stream_sha256(path)
        if actual != name:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "blob_hash_mismatch",
                    None,
                    None,
                    None,
                    rel,
                    f"content hashes to {actual}, path claims {name}",
                )
            )

    # References by CONTENT USE (files.json rows + users.json avatars +
    # file.uploaded payloads); the manifest index additionally REQUIRES presence
    # but is not itself a "use", so an index-only blob still warns as unreferenced.
    referenced: dict[str, str] = {}
    for entry in file_entries:
        fid = entry.get("file_id")
        sha = entry.get("sha256")
        if isinstance(sha, str):
            referenced.setdefault(sha, f"files.json entry {fid!r}")
        thumb = entry.get("thumbnail_sha256")
        if isinstance(thumb, str):
            referenced.setdefault(thumb, f"files.json thumbnail of {fid!r}")
    for entry in user_entries:
        avatar = entry.get("avatar_sha256")
        if isinstance(avatar, str):
            referenced.setdefault(avatar, f"users.json avatar of {entry.get('user_id')!r}")
    if isinstance(icon_sha256, str):
        referenced.setdefault(icon_sha256, "manifest.workspace.icon_sha256")
    for sha in sorted(uploaded_sha256s):
        referenced.setdefault(sha, "a file.uploaded event payload")
    required = dict(referenced)
    for sha in blob_index:
        if isinstance(sha, str):
            required.setdefault(sha, "manifest blobs.index")

    for sha, referrer in sorted(required.items()):
        if sha in on_disk:
            continue
        rel = f"{_BLOBS_DIR}/{sha[:2]}/{sha}"
        if sha in missing_blobs:
            findings.append(
                Finding(
                    Severity.WARNING,
                    "blob_missing",
                    None,
                    None,
                    None,
                    rel,
                    f"referenced by {referrer}; declared in manifest.missing_blobs",
                )
            )
        else:
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "blob_missing",
                    None,
                    None,
                    None,
                    rel,
                    f"referenced by {referrer} but absent from {_BLOBS_DIR}/",
                )
            )
    for sha in sorted(on_disk):
        if sha not in referenced:
            findings.append(
                Finding(
                    Severity.WARNING,
                    "blob_unreferenced",
                    None,
                    None,
                    None,
                    str(on_disk[sha].relative_to(root)),
                    "present but referenced by no files.json row or file.uploaded event",
                )
            )
    for sha, meta in sorted(blob_index.items(), key=lambda kv: str(kv[0])):
        blob_path = on_disk.get(sha) if isinstance(sha, str) else None
        if blob_path is None or not isinstance(meta, dict):
            continue
        actual_bytes = blob_path.stat().st_size
        if actual_bytes != meta.get("bytes"):
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "blob_size_mismatch",
                    None,
                    None,
                    None,
                    str(blob_path.relative_to(root)),
                    f"{actual_bytes} bytes on disk != manifest blobs.index {meta.get('bytes')!r}",
                )
            )
    for entry in file_entries:
        sha = entry.get("sha256")
        blob_path = on_disk.get(sha) if isinstance(sha, str) else None
        if blob_path is None:
            continue
        actual_bytes = blob_path.stat().st_size
        if actual_bytes != entry.get("size_bytes"):
            findings.append(
                Finding(
                    Severity.FAILURE,
                    "blob_size_mismatch",
                    None,
                    None,
                    None,
                    "files.json",
                    f"file {entry.get('file_id')!r}: size_bytes "
                    f"{entry.get('size_bytes')!r} != blob {actual_bytes} bytes",
                )
            )


def _finding_sort_key(f: Finding) -> tuple[int, str, int]:
    """Failures before warnings, then by stream, then by sequence (Ruling 8 ordering)."""
    sev_rank = 0 if f.severity is Severity.FAILURE else 1
    return (sev_rank, f.stream_id or "", f.sequence if f.sequence is not None else -1)


def format_human(
    report: VerifyReport, *, cap: int = MAX_HUMAN_FINDINGS, verbose: bool = False
) -> str:
    """Render the human-readable report: per-stream summary, capped findings, totals.

    Every untrusted interpolation (stream ids, manifest names, file paths, details,
    verbose notes) passes through :func:`_sanitize_for_terminal` — this formatter is
    the trust boundary between attacker-influenceable disk content and the operator's
    terminal. Trusted fields (severity, class, numeric counts) are emitted as-is.
    """
    lines: list[str] = []
    for summary in sorted(report.streams, key=lambda s: s.stream_id):
        label = f"stream {_sanitize_for_terminal(summary.stream_id)}"
        if summary.name:
            label += f" ({_sanitize_for_terminal(summary.name)})"
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
        sid = _sanitize_for_terminal(finding.stream_id or "-")
        lines.append(
            f"  [{finding.severity.value}] {finding.cls} {sid} seq={seq} "
            f"{_sanitize_for_terminal(finding.file)}: {_sanitize_for_terminal(finding.detail)}"
        )
    if len(ordered) > cap:
        lines.append(f"  … +{len(ordered) - cap} more findings (use --json for the full list)")

    if verbose:
        lines.extend(f"note: {_sanitize_for_terminal(note)}" for note in report.notes)

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
