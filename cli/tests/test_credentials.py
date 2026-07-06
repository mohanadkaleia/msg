"""Unit tests for the ``.msgctl/`` sidecar (ENG-70 §2): perms, hygiene, gitignore."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest
from msgctl import credentials
from msgctl.errors import UsageError
from msgctl.workspace import Workspace, init_workspace

_TOKEN = "sk_super_secret_bearer_token_value"


def _ws(tmp_path: Path) -> Workspace:
    init_workspace(tmp_path / "ws")
    return Workspace.open(tmp_path / "ws")


def test_credentials_file_is_0600(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    credentials.write_credentials(ws, token=_TOKEN, expires_at="2026-08-01T00:00:00Z")
    path = credentials.msgctl_dir(ws) / credentials.CREDENTIALS_NAME
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600, f"credentials perms must be 0600, got {oct(mode)}"


def test_credentials_roundtrip(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    credentials.write_credentials(ws, token=_TOKEN, expires_at="2026-08-01T00:00:00Z")
    creds = credentials.read_credentials(ws)
    assert creds["token"] == _TOKEN
    assert creds["expires_at"] == "2026-08-01T00:00:00Z"


def test_token_never_in_remote_binding(tmp_path: Path) -> None:
    """The non-secret remote.json must never carry the raw token."""
    ws = _ws(tmp_path)
    credentials.write_remote_binding(
        ws,
        {
            "server_url": "http://localhost:8000",
            "workspace_id": "w_x",
            "user_id": "u_x",
            "device_id": "d_x",
            "role": "owner",
            "meta_stream_id": "s_meta",
        },
    )
    text = (credentials.msgctl_dir(ws) / credentials.REMOTE_NAME).read_text()
    assert _TOKEN not in text
    binding = credentials.read_remote_binding(ws)
    assert "token" not in binding


def test_is_remote_and_require_remote(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert credentials.is_remote(ws) is False
    with pytest.raises(UsageError):
        credentials.require_remote(ws)
    credentials.write_remote_binding(ws, {"server_url": "http://x", "device_id": "d_x"})
    assert credentials.is_remote(ws) is True
    assert credentials.require_remote(ws)["server_url"] == "http://x"


def test_gitignore_upsert_idempotent(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    credentials.ensure_gitignore(ws)
    credentials.ensure_gitignore(ws)  # second call must not duplicate
    content = (ws.root / ".gitignore").read_text()
    assert content.count(".msgctl/") == 1
    assert content.count("projections.sqlite3*") == 1


def test_gitignore_preserves_existing_lines(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (ws.root / ".gitignore").write_text("*.log\n")
    credentials.ensure_gitignore(ws)
    lines = {ln.strip() for ln in (ws.root / ".gitignore").read_text().splitlines()}
    assert "*.log" in lines
    assert ".msgctl/" in lines


def test_cursors_roundtrip(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert credentials.read_cursors(ws) == {}
    credentials.write_cursors(ws, {"s_a": 3, "s_b": 10})
    assert credentials.read_cursors(ws) == {"s_a": 3, "s_b": 10}


def test_msgctl_dir_is_outside_streams(tmp_path: Path) -> None:
    """The sidecar dir must be a root sibling of streams/, invisible to verify."""
    ws = _ws(tmp_path)
    credentials.write_credentials(ws, token=_TOKEN, expires_at="2026-08-01T00:00:00Z")
    d = credentials.msgctl_dir(ws)
    assert d.parent == ws.root
    assert d.name == ".msgctl"
    assert not str(d).startswith(str(ws.streams_dir))
    # A fresh (unbound) sidecar is never a JSON that leaks under streams/.
    assert list(ws.streams_dir.glob("**/*.json")) == []


def test_credentials_dir_created_with_restrictive_mode(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    credentials.write_credentials(ws, token=_TOKEN, expires_at="2026-08-01T00:00:00Z")
    d = credentials.msgctl_dir(ws)
    assert stat.S_IMODE(d.stat().st_mode) == 0o700


def test_write_cursors_is_valid_json(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    credentials.write_cursors(ws, {"s_a": 1})
    raw = (credentials.msgctl_dir(ws) / credentials.CURSORS_NAME).read_text()
    assert json.loads(raw) == {"s_a": 1}
