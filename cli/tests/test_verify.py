"""``msgctl verify`` — every acceptance criterion as an explicit test (ENG-60 §6).

Fixtures are built with REAL ``msgctl`` sends (subprocess), then corrupted by direct
file manipulation. Behavior is asserted both via the in-process ``verify_workspace``
report (fine-grained) and via ``cli.main`` (end-to-end exit codes / stdout).
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from conftest import run_cli
from msgctl import verify
from msgctl.cli import main
from msgd.core import ids
from verify_helpers import (
    BundleInfo,
    build_clean_bundle,
    event_line,
    init_ws,
    make_envelope_line,
    make_stored_event,
    month_file,
    read_raw_lines,
    rehash,
    reseal_manifest,
    send,
    stream_dirs,
    write_bundle,
    write_lines,
)


def _classes(report: verify.VerifyReport) -> list[str]:
    return [f.cls for f in report.findings]


# --------------------------------------------------------------------------- green path


def test_verify_green(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "hello")
    send(root, "general", "world")
    send(root, "general", "again")
    send(root, "random", "hi")

    report = verify.verify_workspace(root, verbose=True)
    assert report.findings == []
    assert report.ok is True
    assert report.exit_code == 0
    assert report.total_events == 4
    assert len(report.streams) == 2
    assert main(["verify", str(root)]) == 0


def test_verify_empty_workspace_is_green(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    report = verify.verify_workspace(root)
    assert report.findings == []
    assert report.exit_code == 0
    assert main(["verify", str(root)]) == 0


def test_verify_spans_two_month_files(tmp_path: Path) -> None:
    """Contiguity must carry across month files (cross-file bookkeeping)."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "july-1")
    send(root, "general", "july-2")
    sdir = stream_dirs(root)[0]
    lines = read_raw_lines(month_file(sdir))
    # Move the second (seq 2) event into an August file, verbatim (a legit later month).
    (sdir / "2026-07.ndjson").write_text(lines[0] + "\n", encoding="utf-8")
    (sdir / "2026-08.ndjson").write_text(lines[1] + "\n", encoding="utf-8")

    report = verify.verify_workspace(root)
    assert report.findings == []
    assert report.exit_code == 0
    assert report.streams[0].first_seq == 1
    assert report.streams[0].last_seq == 2


# --------------------------------------------------------------------------- hash class


def test_verify_flipped_body_byte(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    env = send(root, "general", "hello")
    sdir = stream_dirs(root)[0]
    path = month_file(sdir)
    path.write_text(path.read_text().replace("hello", "hZllo", 1), encoding="utf-8")

    report = verify.verify_workspace(root)
    assert _classes(report) == ["hash_mismatch"]
    finding = report.findings[0]
    assert finding.sequence == 1
    assert finding.event_id == env["body"]["event_id"]
    assert finding.stream_id == sdir.name
    assert report.exit_code == 1


def test_verify_edited_payload_without_rehash(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "original text")
    path = month_file(stream_dirs(root)[0])
    obj = json.loads(read_raw_lines(path)[0])
    obj["body"]["payload"]["text"] = "tampered text"  # keep the OLD event_hash
    write_lines(path, [json.dumps(obj, separators=(",", ":"))])

    report = verify.verify_workspace(root)
    assert _classes(report) == ["hash_mismatch"]
    assert report.exit_code == 1


def test_verify_coercion_tamper_is_caught(tmp_path: Path) -> None:
    """Crux regression (Ruling 2): edit body.type_version 1 -> "1" WITHOUT re-hashing.

    The raw JCS of the string "1" differs from int 1, so the honest re-hash must FAIL.
    This fails loudly the moment anyone swaps in ``verify_hash`` (which would coerce
    "1" -> 1 via ``model_dump`` and mask the tamper).
    """
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "hello")
    path = month_file(stream_dirs(root)[0])
    line = read_raw_lines(path)[0]
    obj = json.loads(line)
    assert obj["body"]["type_version"] == 1
    obj["body"]["type_version"] = "1"  # string, no re-hash
    write_lines(path, [json.dumps(obj, separators=(",", ":"))])

    report = verify.verify_workspace(root)
    classes = _classes(report)
    assert "hash_mismatch" in classes
    assert report.exit_code == 1
    assert main(["verify", str(root)]) == 1


def test_verify_redacted_flag_tampered_body(tmp_path: Path) -> None:
    """Security round 1 (S1): payload_redacted must NOT waive the hash check at M0.

    The PoC bypass: edit the payload, set the self-asserted flag, keep the stale hash.
    Both signals must fire — the flag itself (redacted_line) and the tamper it tried to
    hide (hash_mismatch)."""
    root = tmp_path / "ws"
    init_ws(root)
    env = send(root, "general", "original")
    path = month_file(stream_dirs(root)[0])
    obj = json.loads(read_raw_lines(path)[0])
    obj["body"]["payload"]["text"] = "tampered"  # stale event_hash kept
    obj["server"]["payload_redacted"] = True
    write_lines(path, [json.dumps(obj, separators=(",", ":"))])

    report = verify.verify_workspace(root)
    classes = _classes(report)
    assert "redacted_line" in classes
    assert "hash_mismatch" in classes
    for finding in report.findings:
        assert finding.sequence == 1
        assert finding.event_id == env["body"]["event_id"]
        assert finding.severity is verify.Severity.FAILURE
    assert report.exit_code == 1


def test_verify_redacted_flag_alone_is_failure(tmp_path: Path) -> None:
    """S1 signal independence: the flag on an untouched body (hash still faithful) is
    exactly one redacted_line failure and NO hash_mismatch — exit 1 either way."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "untouched")
    path = month_file(stream_dirs(root)[0])
    obj = json.loads(read_raw_lines(path)[0])
    obj["server"]["payload_redacted"] = True  # body unmodified => hash still valid
    write_lines(path, [json.dumps(obj, separators=(",", ":"))])

    report = verify.verify_workspace(root)
    assert _classes(report) == ["redacted_line"]
    assert report.exit_code == 1


# ----------------------------------------------------------------------- sequence class


@pytest.mark.parametrize(
    ("delete_index", "expected_missing"),
    [
        (1, "missing 2..2"),  # deleted middle line
        (0, "missing 1..1"),  # deleted FIRST line — the chopped-head case (gap at start)
    ],
)
def test_verify_deleted_line_is_gap(
    tmp_path: Path, delete_index: int, expected_missing: str
) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "one")
    send(root, "general", "two")
    send(root, "general", "three")
    send(root, "general", "four")
    path = month_file(stream_dirs(root)[0])
    lines = read_raw_lines(path)
    del lines[delete_index]
    write_lines(path, lines)

    report = verify.verify_workspace(root)
    # Exactly one gap — a single gap must resync, not cascade one finding per later line.
    gaps = [f for f in report.findings if f.cls == "gap"]
    assert len(gaps) == 1
    assert expected_missing in gaps[0].detail
    assert _classes(report) == ["gap"]
    assert report.exit_code == 1


def test_verify_out_of_order(tmp_path: Path) -> None:
    """Ruled semantics: a late-arriving sequence is reported as BOTH the hole it left
    (``gap``) and the out-of-place line (``out_of_order``) — two true statements about
    the disk, not double-counting."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "one")
    b = send(root, "general", "two")
    send(root, "general", "three")
    path = month_file(stream_dirs(root)[0])
    lines = read_raw_lines(path)
    # The same three UNMODIFIED real lines, reordered on disk: 1, 3, 2. Lines untouched
    # => hashes stay faithful, so the only findings are sequence findings.
    write_lines(path, [lines[0], lines[2], lines[1]])

    report = verify.verify_workspace(root)
    assert sorted(_classes(report)) == ["gap", "out_of_order"]
    gap = next(f for f in report.findings if f.cls == "gap")
    assert "missing 2..2" in gap.detail
    ooo = next(f for f in report.findings if f.cls == "out_of_order")
    assert ooo.sequence == 2
    assert ooo.event_id == b["body"]["event_id"]
    assert report.exit_code == 1


def test_verify_duplicated_line_is_duplicate(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "one")
    send(root, "general", "two")
    path = month_file(stream_dirs(root)[0])
    lines = read_raw_lines(path)
    write_lines(path, [lines[0], lines[1], lines[1]])  # byte-identical dup of seq 2

    report = verify.verify_workspace(root)
    classes = _classes(report)
    assert "duplicate" in classes
    # Same bytes => same event_id at the same seq => NOT a duplicate_event_id.
    assert "duplicate_event_id" not in classes
    assert report.exit_code == 1


def test_verify_duplicate_event_id_distinct_seq(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    a = send(root, "general", "one")
    send(root, "general", "two")
    path = month_file(stream_dirs(root)[0])
    lines = read_raw_lines(path)
    obj = json.loads(lines[1])
    obj["body"]["event_id"] = a["body"]["event_id"]  # reuse seq-1's id at seq 2
    obj["event_hash"] = rehash(obj)  # keep the hash faithful so it is only an id dup
    write_lines(path, [lines[0], json.dumps(obj, separators=(",", ":"))])

    report = verify.verify_workspace(root)
    assert "duplicate_event_id" in _classes(report)
    assert report.exit_code == 1


# -------------------------------------------------------------------------- torn / parse


def test_verify_torn_trailing_is_warning(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "one")
    send(root, "general", "two")
    path = month_file(stream_dirs(root)[0])
    before = path.read_bytes()
    with open(path, "ab") as fh:  # append a partial (unterminated) chunk
        fh.write(b'{"body":{"partial"')

    report = verify.verify_workspace(root)
    assert _classes(report) == ["torn_line"]
    assert report.findings[0].severity is verify.Severity.WARNING
    assert report.ok is True
    assert report.exit_code == 0
    # verify is read-only: it must NOT have truncated the torn bytes.
    assert path.read_bytes() == before + b'{"body":{"partial"'
    assert main(["verify", str(root)]) == 0


def test_verify_unparseable_terminated_line(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "one")
    path = month_file(stream_dirs(root)[0])
    before = path.read_bytes()
    lines = read_raw_lines(path)
    # One bad-JSON terminated line + one valid-JSON-but-not-an-envelope line.
    write_lines(path, [lines[0], "{not json", json.dumps({"foo": "bar"})])
    after_write = path.read_bytes()

    report = verify.verify_workspace(root)
    assert _classes(report).count("unparseable") == 2
    assert report.exit_code == 1
    assert before != after_write  # sanity: we did change the file
    assert path.read_bytes() == after_write  # verify itself did not touch it


# ----------------------------------------------------------------------------- schema/D9


def test_verify_unknown_type_not_a_finding(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    sdir = stream_dirs(root)[0]
    path = month_file(sdir)
    ws = json.loads((root / "workspace.json").read_text())
    # Append a well-formed unknown-type envelope with the CORRECT next seq (2) and a
    # faithful raw hash: proves hash + sequence still ran (a wrong seq would be a gap).
    unknown = make_envelope_line(
        workspace_id=ws["workspace_id"],
        stream_id=sdir.name,
        server_sequence=2,
        type="reaction.created",
        payload={"emoji": "thumbsup"},
    )
    write_lines(path, read_raw_lines(path) + [unknown])

    report = verify.verify_workspace(root, verbose=True)
    assert report.findings == []
    assert report.exit_code == 0
    assert any("reaction.created" in note for note in report.notes)


def test_verify_unknown_type_wrong_seq_is_gap(tmp_path: Path) -> None:
    """Proves the sequence pass runs on unknown types (a bad seq -> gap)."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    sdir = stream_dirs(root)[0]
    path = month_file(sdir)
    ws = json.loads((root / "workspace.json").read_text())
    unknown = make_envelope_line(
        workspace_id=ws["workspace_id"],
        stream_id=sdir.name,
        server_sequence=5,  # should be 2
        type="reaction.created",
        payload={"emoji": "x"},
    )
    write_lines(path, read_raw_lines(path) + [unknown])

    report = verify.verify_workspace(root)
    assert "gap" in _classes(report)


def test_verify_unknown_type_tampered_hash_is_caught(tmp_path: Path) -> None:
    """Unknown types must never become a hashing blind spot: Pass A hashes every line
    BEFORE the D9 skip in Pass C, so a tampered unknown-type line still fails."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    sdir = stream_dirs(root)[0]
    path = month_file(sdir)
    ws = json.loads((root / "workspace.json").read_text())
    tampered = make_envelope_line(
        workspace_id=ws["workspace_id"],
        stream_id=sdir.name,
        server_sequence=2,  # correct next seq — only the hash is wrong
        type="widget.exploded",
        payload={"boom": True},
        event_hash="sha256:" + "0" * 64,  # syntactically valid, wrong digest
    )
    write_lines(path, read_raw_lines(path) + [tampered])

    report = verify.verify_workspace(root)
    assert _classes(report) == ["hash_mismatch"]
    finding = report.findings[0]
    assert finding.stream_id == sdir.name
    assert finding.sequence == 2
    assert finding.event_id == json.loads(tampered)["body"]["event_id"]
    # The D9 skip still applied: payload validation stayed off, only the hash fired.
    assert "schema_invalid" not in _classes(report)
    assert "unparseable" not in _classes(report)
    assert report.exit_code == 1


def test_verify_schema_invalid_known_type(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    sdir = stream_dirs(root)[0]
    path = month_file(sdir)
    ws = json.loads((root / "workspace.json").read_text())
    # Known type, faithful hash over a bad payload (invalid message_id) => schema_invalid,
    # NOT hash_mismatch (the hash is honest to the bad body).
    bad = make_envelope_line(
        workspace_id=ws["workspace_id"],
        stream_id=sdir.name,
        server_sequence=2,
        type="message.created",
        type_version=1,
        payload={"message_id": "not-an-m-id", "text": "hi", "format": "markdown"},
    )
    write_lines(path, read_raw_lines(path) + [bad])

    report = verify.verify_workspace(root)
    classes = _classes(report)
    assert classes == ["schema_invalid"]
    assert report.exit_code == 1


# --------------------------------------------------------------------------- registry


def test_verify_unregistered_stream_dir(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    real = send(root, "general", "real")
    ws = json.loads((root / "workspace.json").read_text())
    from msgd.core import ids

    fake_sid = ids.new_stream_id()
    fake_dir = root / "streams" / fake_sid
    fake_dir.mkdir()
    line = make_envelope_line(
        workspace_id=ws["workspace_id"],
        stream_id=fake_sid,
        server_sequence=1,
        payload=real["body"]["payload"],
    )
    (fake_dir / "2026-07.ndjson").write_text(line + "\n", encoding="utf-8")

    report = verify.verify_workspace(root)
    assert "unregistered_stream_dir" in _classes(report)
    assert report.exit_code == 1


def test_verify_empty_registered_stream(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    manifest_path = root / "workspace.json"
    manifest = json.loads(manifest_path.read_text())
    from msgd.core import ids

    empty_sid = ids.new_stream_id()
    manifest["streams"][empty_sid] = {
        "name": "empty-channel",
        "kind": "channel",
        "created_at": "2026-07-04T00:00:00.000Z",
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    report = verify.verify_workspace(root)
    warnings = [f for f in report.findings if f.cls == "empty_registered_stream"]
    assert len(warnings) == 1
    assert warnings[0].severity is verify.Severity.WARNING
    assert report.ok is True
    assert report.exit_code == 0


def test_verify_workspace_id_mismatch(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    path = month_file(stream_dirs(root)[0])
    from msgd.core import ids

    obj = json.loads(read_raw_lines(path)[0])
    obj["body"]["workspace_id"] = ids.new_workspace_id()  # different valid w_ id
    obj["event_hash"] = rehash(obj)  # fix the hash so it is ONLY a wsid mismatch
    write_lines(path, [json.dumps(obj, separators=(",", ":"))])

    report = verify.verify_workspace(root)
    assert _classes(report) == ["workspace_id_mismatch"]
    assert report.exit_code == 1


def test_verify_manifest_invalid_best_effort(tmp_path: Path) -> None:
    """A corrupt manifest -> one manifest_invalid failure + best-effort walk (Ruling 6)."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    (root / "workspace.json").write_text("{ not valid json", encoding="utf-8")

    report = verify.verify_workspace(root)
    classes = _classes(report)
    assert "manifest_invalid" in classes
    # Best-effort: registry/workspace_id checks suppressed, but per-line checks still ran.
    assert "unregistered_stream_dir" not in classes
    assert "workspace_id_mismatch" not in classes
    assert report.exit_code == 1


def _drop_workspace_id(manifest: dict[str, Any]) -> dict[str, Any]:
    del manifest["workspace_id"]  # KeyError path inside Workspace.open
    return manifest


def _streams_as_list(manifest: dict[str, Any]) -> dict[str, Any]:
    manifest["streams"] = []  # AttributeError path (.items() on a list)
    return manifest


@pytest.mark.parametrize("mangle", [_drop_workspace_id, _streams_as_list])
def test_verify_manifest_malformed_shapes_best_effort(
    tmp_path: Path, mangle: Callable[[dict[str, Any]], dict[str, Any]]
) -> None:
    """Valid-JSON-but-wrong manifests must yield manifest_invalid + best-effort walk,
    never an uncaught traceback (review round 1, finding 1)."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "real")
    manifest_path = root / "workspace.json"
    manifest = mangle(json.loads(manifest_path.read_text()))
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # Subprocess: prove no traceback escapes (an uncaught KeyError would sail past
    # main's `except MsgctlError`).
    proc = run_cli("verify", str(root), "--json")
    assert proc.returncode == 1
    assert "Traceback" not in proc.stderr
    payload = json.loads(proc.stdout)  # well-formed JSON object
    assert payload["ok"] is False

    report = verify.verify_workspace(root)
    classes = _classes(report)
    assert classes.count("manifest_invalid") == 1
    # The stream walk still ran: the one real event was visited and its hash is clean.
    assert report.total_events == 1
    assert "hash_mismatch" not in classes
    # Best-effort mode suppresses the registry/workspace_id cross-checks (no noise).
    assert "unregistered_stream_dir" not in classes
    assert "workspace_id_mismatch" not in classes
    assert report.exit_code == 1


# -------------------------------------------------------------------------- json / exit


def test_verify_json_shape(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "hello")
    path = month_file(stream_dirs(root)[0])
    path.write_text(path.read_text().replace("hello", "hZllo", 1), encoding="utf-8")

    rc = main(["verify", str(root), "--json"])
    out = capsys.readouterr().out
    payload = json.loads(out)  # stdout is exactly one JSON object, nothing else
    assert rc == 1
    assert payload["ok"] is False
    assert set(payload) == {"root", "workspace_id", "ok", "summary", "streams", "findings"}
    assert set(payload["summary"]) == {
        "streams",
        "events",
        "failures",
        "warnings",
        "findings_total",
    }
    assert payload["findings"][0]["class"] == "hash_mismatch"
    # file paths are relative to the workspace root (CI-diffable).
    assert payload["findings"][0]["file"].startswith("streams/")
    assert not payload["findings"][0]["file"].startswith("/")


def test_verify_json_matches_human_exit(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "hello")
    path = month_file(stream_dirs(root)[0])
    path.write_text(path.read_text().replace("hello", "hZllo", 1), encoding="utf-8")
    rc_human = main(["verify", str(root)])
    capsys.readouterr()
    rc_json = main(["verify", str(root), "--json"])
    capsys.readouterr()
    assert rc_human == rc_json == 1


def test_verify_exit_codes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # clean -> 0
    clean = tmp_path / "clean"
    init_ws(clean)
    send(clean, "general", "ok")
    assert main(["verify", str(clean)]) == 0
    capsys.readouterr()

    # warning-only (torn line) -> 0
    warn = tmp_path / "warn"
    init_ws(warn)
    send(warn, "general", "ok")
    with open(month_file(stream_dirs(warn)[0]), "ab") as fh:
        fh.write(b"{partial")
    assert main(["verify", str(warn)]) == 0
    capsys.readouterr()

    # failure -> 1
    bad = tmp_path / "bad"
    init_ws(bad)
    send(bad, "general", "ok")
    p = month_file(stream_dirs(bad)[0])
    p.write_text(p.read_text().replace("ok", "zz", 1), encoding="utf-8")
    assert main(["verify", str(bad)]) == 1
    capsys.readouterr()

    # not-a-workspace dir -> 2
    plain = tmp_path / "plain"
    plain.mkdir()
    assert main(["verify", str(plain)]) == 2
    capsys.readouterr()

    # missing dir -> 2
    assert main(["verify", str(tmp_path / "does-not-exist")]) == 2
    capsys.readouterr()


# -------------------------------------------------------------------- report safety (S2)

_HOSTILE_HASH = "sha256:\x1b[2K\rclean: 0 failures\x1b[0m"


def _hostile_workspace(root: Path) -> None:
    """Real send, then a spoofing event_hash + an ANSI-laced manifest stream name."""
    init_ws(root)
    send(root, "general", "hello")
    path = month_file(stream_dirs(root)[0])
    obj = json.loads(read_raw_lines(path)[0])
    obj["event_hash"] = _HOSTILE_HASH  # terminal-rewrite payload in an untrusted field
    write_lines(path, [json.dumps(obj, separators=(",", ":"))])
    manifest_path = root / "workspace.json"
    manifest = json.loads(manifest_path.read_text())
    for entry in manifest["streams"].values():
        entry["name"] = "gen\x1b[31meral"  # ANSI in the manifest stream name
    manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")


def test_verify_human_output_has_no_control_chars(tmp_path: Path) -> None:
    """S2: the human report is TTY-safe — control chars are escaped visibly, never raw
    and never silently stripped; the spoof does not displace the genuine finding."""
    root = tmp_path / "ws"
    _hostile_workspace(root)

    proc = run_cli("verify", str(root))
    assert proc.returncode == 1
    out = proc.stdout
    # No raw ESC / CR anywhere on the operator's terminal...
    assert "\x1b" not in out
    assert "\r" not in out
    # ...but the escaped form IS present: escape-not-strip (the bytes are evidence).
    assert "\\x1b" in out
    # The genuine hash_mismatch finding is intact and the totals report the failure.
    assert "hash_mismatch" in out
    assert "1 failure(s)" in out


def test_verify_json_keeps_raw_bytes(tmp_path: Path) -> None:
    """S2 counterpart: --json is NOT sanitized — machine consumers get byte-fidelity
    (json.dumps escapes control chars safely on the wire; json.loads round-trips them)."""
    root = tmp_path / "ws"
    _hostile_workspace(root)

    proc = run_cli("verify", str(root), "--json")
    assert proc.returncode == 1  # same exit code as the human run
    payload = json.loads(proc.stdout)  # parses cleanly despite hostile content
    assert payload["ok"] is False
    detail = next(f for f in payload["findings"] if f["class"] == "hash_mismatch")["detail"]
    # The raw ESC bytes round-trip through the JSON path un-sanitized (no \\xNN text).
    assert "\x1b[2K" in detail
    assert "\\x1b" not in detail


# ----------------------------------------------------------------- collect all / capping


def test_verify_collects_all_findings(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "one")
    send(root, "general", "two")
    send(root, "general", "three")
    path = month_file(stream_dirs(root)[0])
    lines = read_raw_lines(path)
    # Inject three distinct failures: flip seq-1's body, delete seq 2 (gap), corrupt seq-3 JSON.
    obj0 = json.loads(lines[0])
    obj0["body"]["payload"]["text"] = "tampered"  # keep old hash -> hash_mismatch
    corrupt0 = json.dumps(obj0, separators=(",", ":"))
    # seq 1 (hash_mismatch) + seq 3 valid (gap: seq 2 dropped) + a bad-JSON line (unparseable).
    write_lines(path, [corrupt0, lines[2], "{not json"])

    report = verify.verify_workspace(root)
    classes = set(_classes(report))
    assert "hash_mismatch" in classes
    assert "gap" in classes
    assert "unparseable" in classes  # verify did not stop at the first failure
    assert report.exit_code == 1


def test_verify_human_cap(tmp_path: Path) -> None:
    """> MAX_HUMAN_FINDINGS findings: human output capped, summary counts complete."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "seed")
    path = month_file(stream_dirs(root)[0])
    seed = read_raw_lines(path)[0]
    ws = json.loads((root / "workspace.json").read_text())
    sid = stream_dirs(root)[0].name
    # 150 lines, each a hash_mismatch (wrong stored hash), correct contiguous seqs.
    lines = [seed]
    for seq in range(2, 152):
        line = make_envelope_line(
            workspace_id=ws["workspace_id"],
            stream_id=sid,
            server_sequence=seq,
            payload={"message_id": _m_id(), "text": f"m{seq}", "format": "markdown"},
            event_hash="sha256:" + "0" * 64,  # deliberately wrong
        )
        lines.append(line)
    write_lines(path, lines)

    report = verify.verify_workspace(root)
    assert report.failures == 150
    human = verify.format_human(report, cap=verify.MAX_HUMAN_FINDINGS)
    shown = [ln for ln in human.splitlines() if ln.startswith("  [failure]")]
    assert len(shown) == verify.MAX_HUMAN_FINDINGS
    assert "more findings" in human
    # summary line remains complete/uncapped.
    assert "150 failure(s)" in human
    # --json is uncapped.
    payload = json.loads(verify.format_json(report))
    assert len(payload["findings"]) == 150


def _m_id() -> str:
    from msgd.core import ids

    return ids.new_message_id()


# =============================================================== bundle mode (M4-2)
#
# The §9 tamper matrix (ENG-156): a clean fixture bundle per test, ONE precise
# corruption each, and an assertion on the SPECIFIC finding class — every check is
# proven non-vacuous (remove the check and its test fails). The §9 bundle has NO
# prev-hash chain, deliberately; test_bundle_swap_and_renumber_* below is the proof
# that the sealed manifest closes exactly that gap.


def _bundle(tmp_path: Path) -> tuple[Path, BundleInfo]:
    root = tmp_path / "bundle"
    return root, build_clean_bundle(root)


def _month_path(root: Path, stream_id: str, month: str) -> Path:
    return root / "streams" / stream_id / f"{month}.ndjson"


def _blob_path(root: Path, sha: str) -> Path:
    return root / "blobs" / sha[:2] / sha


def _dump_line(obj: dict[str, Any]) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _rewrite_manifest(root: Path, manifest: dict[str, Any]) -> None:
    """Write an edited manifest verbatim (digest left however the test wants it)."""
    (root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


# ------------------------------------------------------------------ green + dispatch


def test_bundle_green(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    report = verify.verify_path(root, verbose=True)
    assert report.findings == []
    assert report.ok is True
    assert report.exit_code == 0
    assert report.workspace_id == info.workspace_id
    assert report.total_events == 7
    assert len(report.streams) == 2
    assert {s.name for s in report.streams} == {"general", "random"}
    assert main(["verify", str(root)]) == 0


def test_bundle_mode_detection_manifest_wins(tmp_path: Path) -> None:
    """manifest.json => bundle mode even if a (bogus) workspace.json sits alongside."""
    root, _ = _bundle(tmp_path)
    (root / "workspace.json").write_text("{ not even json", encoding="utf-8")
    report = verify.verify_path(root)
    assert report.findings == []  # bundle mode never opened workspace.json
    assert report.exit_code == 0


def test_bundle_mode_detection_workspace_unchanged(tmp_path: Path) -> None:
    """No manifest.json => the pre-M4 live-workspace walk, byte-for-byte."""
    root = tmp_path / "ws"
    init_ws(root)
    send(root, "general", "hello")
    report = verify.verify_path(root)
    assert report.findings == []
    assert report.exit_code == 0
    # And a non-workspace dir still exits 2 through the CLI (usage, not a finding).
    plain = tmp_path / "plain"
    plain.mkdir()
    assert main(["verify", str(plain)]) == 2


def test_bundle_json_shape(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    _blob_path(root, info.content_sha).unlink()
    proc = run_cli("verify", str(root), "--json")
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["ok"] is False
    assert payload["workspace_id"] == info.workspace_id
    assert any(f["class"] == "blob_missing" for f in payload["findings"])


# ------------------------------------------------------- tamper matrix: event log (A)


def test_bundle_flipped_body_byte(tmp_path: Path) -> None:
    """Tamper 1: one flipped byte inside a body => hash_mismatch (and the month-file
    digest diverges too — two independent detectors on the same tamper)."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-06")
    data = path.read_text(encoding="utf-8")
    assert '"text":"two"' in data
    path.write_text(data.replace('"text":"two"', '"text":"twZ"', 1), encoding="utf-8")

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "hash_mismatch" in classes
    assert "file_digest_mismatch" in classes
    assert report.exit_code == 1


def test_bundle_edited_event_hash(tmp_path: Path) -> None:
    """Tamper 2: a rewritten stored event_hash => hash_mismatch."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-06")
    lines = read_raw_lines(path)
    obj = json.loads(lines[0])
    obj["event_hash"] = "sha256:" + "0" * 64
    write_lines(path, [_dump_line(obj), *lines[1:]])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "hash_mismatch" in classes
    assert report.exit_code == 1


def test_bundle_truncated_month_file(tmp_path: Path) -> None:
    """Tamper 3: a deleted trailing NDJSON line => the manifest counts/digest AND the
    cross-month sequence gap both fire."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-06")
    lines = read_raw_lines(path)
    write_lines(path, lines[:-1])  # drop seq 3; 2026-07 continues at seq 4

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "gap" in classes
    assert "file_digest_mismatch" in classes
    assert "count_mismatch" in classes  # event_count/last_seq vs manifest
    assert report.exit_code == 1


def test_bundle_reordered_lines(tmp_path: Path) -> None:
    """Tamper 4: two lines swapped verbatim => sequence findings + digest mismatch."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-06")
    lines = read_raw_lines(path)
    write_lines(path, [lines[1], lines[0], lines[2]])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "file_digest_mismatch" in classes
    assert "gap" in classes and "out_of_order" in classes
    assert report.exit_code == 1


def test_bundle_swap_and_renumber_caught_by_manifest(tmp_path: Path) -> None:
    """Tamper 5 — THE no-prev-hash-chain proof. Swap two events AND renumber their
    server_sequence: every per-event check passes (event_hash covers body only, and
    the on-disk sequence is gapless 1..n again), so an event-log-only verifier is
    blind to it. The sealed manifest's month-file digest is what catches it."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-06")
    lines = read_raw_lines(path)
    first, second = json.loads(lines[0]), json.loads(lines[1])
    first["server"]["server_sequence"] = 2
    second["server"]["server_sequence"] = 1
    write_lines(path, [_dump_line(second), _dump_line(first), lines[2]])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    # The event-log pass is fully green on this tamper...
    assert "hash_mismatch" not in classes
    assert "gap" not in classes
    assert "out_of_order" not in classes
    assert "duplicate" not in classes
    # ...and the manifest digest is the ONLY thing standing. Exactly one finding.
    assert classes == ["file_digest_mismatch"]
    assert report.exit_code == 1


def test_bundle_appended_event_caught(tmp_path: Path) -> None:
    """Tamper 10b: a perfectly valid event appended after export (correct hash, next
    seq) => file digest + counts diverge from the sealed manifest."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-07")
    forged = make_stored_event(
        workspace_id=info.workspace_id,
        stream_id=info.stream_a,
        server_sequence=6,
        server_received_at="2026-07-03T09:00:00.000Z",
        payload={"message_id": _m_id(), "text": "forged", "format": "markdown"},
    )
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(event_line(forged))

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "hash_mismatch" not in classes
    assert "gap" not in classes
    assert "file_digest_mismatch" in classes
    assert "count_mismatch" in classes  # event_count/last_seq/head_seq/total
    assert report.exit_code == 1


def test_bundle_month_mismatch(tmp_path: Path) -> None:
    """server_received_at is NOT hashed (server metadata), so moving an event across
    months needs its own check: the month-file name is part of the sealed layout."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-06")
    lines = read_raw_lines(path)
    obj = json.loads(lines[0])
    obj["server"]["server_received_at"] = "2026-08-01T00:00:00.000Z"
    write_lines(path, [_dump_line(obj), *lines[1:]])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "hash_mismatch" not in classes  # metadata edit: the body hash stays green
    assert "month_mismatch" in classes
    assert "file_digest_mismatch" in classes
    assert report.exit_code == 1


def test_bundle_stream_id_mismatch(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_a, "2026-06")
    lines = read_raw_lines(path)
    obj = json.loads(lines[0])
    obj["body"]["stream_id"] = ids.new_stream_id()
    obj["event_hash"] = rehash(obj)  # faithful hash: ONLY the binding is wrong
    write_lines(path, [_dump_line(obj), *lines[1:]])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "hash_mismatch" not in classes
    assert "stream_id_mismatch" in classes
    assert report.exit_code == 1


def test_bundle_workspace_id_mismatch(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_b, "2026-07")
    lines = read_raw_lines(path)
    obj = json.loads(lines[0])
    obj["body"]["workspace_id"] = ids.new_workspace_id()
    obj["event_hash"] = rehash(obj)
    write_lines(path, [_dump_line(obj), *lines[1:]])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "workspace_id_mismatch" in classes
    assert report.exit_code == 1


def test_bundle_redacted_flag_is_failure(tmp_path: Path) -> None:
    """The ENG-60 ruling carries into bundles: payload_redacted has no authority."""
    root, info = _bundle(tmp_path)
    path = _month_path(root, info.stream_b, "2026-07")
    lines = read_raw_lines(path)
    obj = json.loads(lines[0])
    obj["server"]["payload_redacted"] = True  # body untouched: hash stays valid
    write_lines(path, [_dump_line(obj), *lines[1:]])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "redacted_line" in classes
    assert "hash_mismatch" not in classes
    assert report.exit_code == 1


def test_bundle_duplicate_event_id_across_streams(tmp_path: Path) -> None:
    """Tamper 11: the SAME event_id in two different streams — sealed into an
    otherwise fully consistent bundle, so global uniqueness is the only detector."""
    workspace_id = ids.new_workspace_id()
    stream_a, stream_b = sorted([ids.new_stream_id(), ids.new_stream_id()])
    dup_eid = ids.new_event_id()

    def _msg_event(sid: str, eid: str) -> dict[str, Any]:
        return make_stored_event(
            workspace_id=workspace_id,
            stream_id=sid,
            server_sequence=1,
            event_id=eid,
            payload={"message_id": _m_id(), "text": "hi", "format": "markdown"},
        )

    root = tmp_path / "bundle"
    write_bundle(
        root,
        workspace_id=workspace_id,
        streams={
            stream_a: {"name": "a", "events": [_msg_event(stream_a, dup_eid)]},
            stream_b: {"name": "b", "events": [_msg_event(stream_b, dup_eid)]},
        },
    )

    report = verify.verify_bundle(root)
    assert _classes(report) == ["duplicate_event_id_global"]
    finding = report.findings[0]
    assert finding.stream_id == stream_b  # flagged on the second stream walked
    assert finding.event_id == dup_eid
    assert stream_a in finding.detail
    assert report.exit_code == 1


# ----------------------------------------------------------- tamper matrix: blobs (B)


def test_bundle_missing_blob(tmp_path: Path) -> None:
    """Tamper 6: a referenced blob deleted from blobs/ => blob_missing FAILURE."""
    root, info = _bundle(tmp_path)
    _blob_path(root, info.content_sha).unlink()

    report = verify.verify_bundle(root)
    assert _classes(report) == ["blob_missing"]
    assert report.findings[0].severity is verify.Severity.FAILURE
    assert info.content_sha in report.findings[0].file
    assert report.exit_code == 1


def test_bundle_corrupted_blob(tmp_path: Path) -> None:
    """Tamper 7: flipped blob byte (size preserved) => blob_hash_mismatch only."""
    root, info = _bundle(tmp_path)
    path = _blob_path(root, info.thumb_sha)
    data = bytearray(path.read_bytes())
    data[0] ^= 0xFF
    path.write_bytes(bytes(data))

    report = verify.verify_bundle(root)
    assert _classes(report) == ["blob_hash_mismatch"]
    assert report.exit_code == 1


def test_bundle_truncated_blob_size_checks(tmp_path: Path) -> None:
    """A shortened blob trips the content hash AND both size cross-checks
    (manifest blobs.index bytes + files.json size_bytes)."""
    root, info = _bundle(tmp_path)
    _blob_path(root, info.content_sha).write_bytes(info.content[:-4])

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "blob_hash_mismatch" in classes
    assert classes.count("blob_size_mismatch") == 2
    assert report.exit_code == 1


def test_bundle_declared_missing_blob_is_warning(tmp_path: Path) -> None:
    """Tamper 12: an absence DECLARED in manifest.missing_blobs (the
    --allow-missing-blobs export path) is a WARNING, not a FAILURE — exit 0."""
    workspace_id = ids.new_workspace_id()
    stream_id = ids.new_stream_id()
    absent_sha = hashlib.sha256(b"never made it into the export").hexdigest()
    file_id = ids.new_file_id()
    root = tmp_path / "bundle"
    write_bundle(
        root,
        workspace_id=workspace_id,
        streams={
            stream_id: {
                "name": "general",
                "events": [
                    make_stored_event(
                        workspace_id=workspace_id,
                        stream_id=stream_id,
                        server_sequence=1,
                        payload={"message_id": _m_id(), "text": "hi", "format": "markdown"},
                    )
                ],
            }
        },
        files=[
            {
                "file_id": file_id,
                "sha256": absent_sha,
                "name": "gone.bin",
                "mime_type": "application/octet-stream",
                "size_bytes": 30,
                "uploaded_by": ids.new_user_id(),
                "stream_id": stream_id,
                "created_at": "2026-07-01T00:00:00.000Z",
                "thumbnail_sha256": None,
            }
        ],
        missing_blobs=[absent_sha],
    )

    report = verify.verify_bundle(root)
    assert _classes(report) == ["blob_missing"]
    assert report.findings[0].severity is verify.Severity.WARNING
    assert "missing_blobs" in report.findings[0].detail
    assert report.ok is True
    assert report.exit_code == 0
    assert main(["verify", str(root)]) == 0


def test_bundle_unreferenced_blob_is_warning(tmp_path: Path) -> None:
    root, _ = _bundle(tmp_path)
    stray = b"who left this here"
    sha = hashlib.sha256(stray).hexdigest()
    path = _blob_path(root, sha)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(stray)

    report = verify.verify_bundle(root)
    assert _classes(report) == ["blob_unreferenced"]
    assert report.findings[0].severity is verify.Severity.WARNING
    assert report.exit_code == 0


def test_bundle_uploaded_event_blob_reference_enforced(tmp_path: Path) -> None:
    """A file.uploaded payload sha256 is a first-class blob reference: with the
    files.json row gone, the EVENT alone must still make the deleted blob a failure."""
    root, info = _bundle(tmp_path)
    # Rewrite files.json to an empty list; reseal its digest so ONLY the event refs remain.
    (root / "files.json").write_text("[]\n", encoding="utf-8")
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest["sidecars"]["files.json"] = hashlib.sha256(b"[]\n").hexdigest()
    _rewrite_manifest(root, manifest)
    reseal_manifest(root)
    _blob_path(root, info.content_sha).unlink()

    report = verify.verify_bundle(root)
    classes = _classes(report)
    blob_missing = [f for f in report.findings if f.cls == "blob_missing"]
    assert len(blob_missing) == 1
    assert "file.uploaded" in blob_missing[0].detail
    # The thumbnail is now referenced by nothing (files.json emptied) => warning.
    assert "blob_unreferenced" in classes
    assert report.exit_code == 1


# -------------------------------------------------------- tamper matrix: manifest (C)


def test_bundle_manifest_digest_mismatch(tmp_path: Path) -> None:
    """Tamper 10a: ANY manifest edit without resealing => manifest_digest_mismatch —
    even on a field no other check re-derives (tool)."""
    root, _ = _bundle(tmp_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest["tool"] = "attacker/1.0"
    _rewrite_manifest(root, manifest)

    report = verify.verify_bundle(root)
    assert _classes(report) == ["manifest_digest_mismatch"]
    assert report.exit_code == 1


def test_bundle_manifest_count_edit_resealed(tmp_path: Path) -> None:
    """Tamper 9: month-file counts edited AND the digest resealed — the recomputed
    per-file counts must catch it on their own (independent of bundle_digest)."""
    root, info = _bundle(tmp_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    entry = manifest["streams"][info.stream_a]["files"]["2026-06.ndjson"]
    entry["event_count"] = 99
    entry["first_seq"] = 7
    _rewrite_manifest(root, manifest)
    reseal_manifest(root)

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "manifest_digest_mismatch" not in classes  # the reseal held
    assert classes == ["count_mismatch", "count_mismatch"]
    assert report.exit_code == 1


def test_bundle_manifest_head_seq_edit_resealed(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest["streams"][info.stream_b]["head_seq"] = 9
    _rewrite_manifest(root, manifest)
    reseal_manifest(root)

    report = verify.verify_bundle(root)
    assert _classes(report) == ["count_mismatch"]
    assert "head_seq" in report.findings[0].detail
    assert report.exit_code == 1


def test_bundle_manifest_blob_bytes_edit_resealed(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    manifest["blobs"]["index"][info.content_sha]["bytes"] = 1
    _rewrite_manifest(root, manifest)
    reseal_manifest(root)

    report = verify.verify_bundle(root)
    assert _classes(report) == ["blob_size_mismatch"]
    assert report.exit_code == 1


def test_bundle_removed_stream_dir(tmp_path: Path) -> None:
    """Tamper 8: a whole streams/<id>/ subtree deleted => stream_dir_missing (plus
    the workspace-wide event_count_total divergence)."""
    root, info = _bundle(tmp_path)
    shutil.rmtree(root / "streams" / info.stream_b)

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "stream_dir_missing" in classes
    assert "count_mismatch" in classes  # event_count_total: 5 on disk != 7 sealed
    assert report.exit_code == 1


def test_bundle_extra_stream_dir(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    sid = ids.new_stream_id()
    extra = root / "streams" / sid
    extra.mkdir()
    forged = make_stored_event(
        workspace_id=info.workspace_id,
        stream_id=sid,
        server_sequence=1,
        payload={"message_id": _m_id(), "text": "planted", "format": "markdown"},
    )
    (extra / "2026-07.ndjson").write_text(event_line(forged), encoding="utf-8")

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "unregistered_stream_dir" in classes
    assert "count_mismatch" in classes  # event_count_total: 8 on disk != 7 sealed
    assert report.exit_code == 1


def test_bundle_month_file_missing_and_unlisted(tmp_path: Path) -> None:
    root, info = _bundle(tmp_path)
    _month_path(root, info.stream_a, "2026-06").unlink()
    forged = make_stored_event(
        workspace_id=info.workspace_id,
        stream_id=info.stream_b,
        server_sequence=3,
        server_received_at="2026-08-01T00:00:00.000Z",
        payload={"message_id": _m_id(), "text": "later", "format": "markdown"},
    )
    _month_path(root, info.stream_b, "2026-08").write_text(event_line(forged), encoding="utf-8")

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "month_file_missing" in classes  # 2026-06.ndjson sealed but gone
    assert "month_file_unlisted" in classes  # 2026-08.ndjson on disk, never sealed
    assert report.exit_code == 1


def test_bundle_sidecar_digest_mismatch(tmp_path: Path) -> None:
    root, _ = _bundle(tmp_path)
    with open(root / "users.json", "a", encoding="utf-8") as fh:
        fh.write(" ")  # still valid JSON, different bytes

    report = verify.verify_bundle(root)
    assert _classes(report) == ["sidecar_digest_mismatch"]
    assert report.findings[0].file == "users.json"
    assert report.exit_code == 1


def test_bundle_sidecar_missing(tmp_path: Path) -> None:
    root, _ = _bundle(tmp_path)
    (root / "files.json").unlink()

    report = verify.verify_bundle(root)
    classes = _classes(report)
    assert "sidecar_missing" in classes
    # With files.json gone its thumbnail reference vanished too => warning, and the
    # walk kept going (collect everything, Ruling 8).
    assert "blob_unreferenced" in classes
    assert report.exit_code == 1


def test_bundle_manifest_invalid_best_effort(tmp_path: Path) -> None:
    """A syntactically broken manifest.json => one manifest_invalid failure, and the
    per-line hash/sequence walk still runs (best-effort, mirroring workspace mode)."""
    root, _ = _bundle(tmp_path)
    (root / "manifest.json").write_text("{ not json", encoding="utf-8")

    report = verify.verify_bundle(root)
    assert _classes(report) == ["manifest_invalid"]
    assert report.total_events == 7  # the stream walk still visited every event
    assert report.exit_code == 1

    proc = run_cli("verify", str(root), "--json")  # and no traceback via the CLI
    assert proc.returncode == 1
    assert "Traceback" not in proc.stderr


def test_bundle_collects_all_findings(tmp_path: Path) -> None:
    """Ruling 8 holds in bundle mode: multiple independent tampers, one report."""
    root, info = _bundle(tmp_path)
    # Tamper 1: flip a body byte in stream A.
    path_a = _month_path(root, info.stream_a, "2026-06")
    path_a.write_text(
        path_a.read_text(encoding="utf-8").replace('"text":"one"', '"text":"onZ"', 1),
        encoding="utf-8",
    )
    # Tamper 2: delete the content blob.
    _blob_path(root, info.content_sha).unlink()
    # Tamper 3: truncate stream B.
    path_b = _month_path(root, info.stream_b, "2026-07")
    write_lines(path_b, read_raw_lines(path_b)[:-1])

    report = verify.verify_bundle(root)
    classes = set(_classes(report))
    assert {"hash_mismatch", "blob_missing", "file_digest_mismatch", "count_mismatch"} <= classes
    assert report.exit_code == 1
