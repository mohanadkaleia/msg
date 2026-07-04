"""``msgctl verify`` — every acceptance criterion as an explicit test (ENG-60 §6).

Fixtures are built with REAL ``msgctl`` sends (subprocess), then corrupted by direct
file manipulation. Behavior is asserted both via the in-process ``verify_workspace``
report (fine-grained) and via ``cli.main`` (end-to-end exit codes / stdout).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from conftest import run_cli
from msgctl import verify
from msgctl.cli import main
from verify_helpers import (
    init_ws,
    make_envelope_line,
    month_file,
    read_raw_lines,
    rehash,
    send,
    stream_dirs,
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
