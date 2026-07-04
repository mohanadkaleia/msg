"""``msgctl init`` — workspace materialization and clobber-refusal (Ruling 5)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from msgctl.cli import main
from msgd.core import ids


def test_init_creates_manifest_and_streams_tree(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0

    manifest_path = root / "workspace.json"
    assert manifest_path.is_file()
    assert (root / "streams").is_dir()

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["format_version"] == 1
    assert ids.is_valid_typed_id(manifest["workspace_id"], ids.IdKind.WORKSPACE)
    assert manifest["streams"] == {}
    assert ids.is_valid_typed_id(manifest["local_author"]["user_id"], ids.IdKind.USER)
    assert ids.is_valid_typed_id(manifest["local_author"]["device_id"], ids.IdKind.DEVICE)
    assert manifest["name"] == "ws"


def test_init_honors_name_flag(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root), "--name", "Acme"]) == 0
    manifest = json.loads((root / "workspace.json").read_text(encoding="utf-8"))
    assert manifest["name"] == "Acme"


def test_reinit_refuses_to_clobber(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    original = (root / "workspace.json").read_text(encoding="utf-8")

    assert main(["init", str(root)]) == 1
    # The original manifest (and its workspace_id) is left untouched.
    assert (root / "workspace.json").read_text(encoding="utf-8") == original


def test_init_stdout_is_manifest_json(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    out = capsys.readouterr().out
    printed = json.loads(out)
    assert printed["workspace_id"].startswith("w_")
