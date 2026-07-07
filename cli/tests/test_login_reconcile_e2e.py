"""ENG-109 robustness: a failing reconciling pull must NOT brick first-run login.

`cmd_login` persists auth + identity + credentials + the remote binding BEFORE
the best-effort reconciling pull. So a transient network blip during that pull
leaves a fully usable login (not a written credential with no binding, which on
`--setup` is unrecoverable: retry 409s `already_initialized`, plain re-login has
no device_id). This injects a first-pull failure and proves: login STILL
succeeds, the binding + credentials are durable, and a later explicit `pull`
reconciles the server's `general` with NO duplicate.

Own module (not appended to the happy-path e2e) so the module-scoped
``live_server`` starts from an EMPTY server — a second ``--setup`` on a server
that already has an owner would 409 ``already_initialized``.

Marked ``integration`` (needs Docker); ``-m "not integration"`` skips it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from _e2e_server import _run
from _e2e_server import live_server as live_server  # shared fixture re-export
from msgctl import remote
from msgctl.client import MsgClient
from msgctl.credentials import read_credentials, require_remote
from msgctl.sync import PullResult
from msgctl.sync import pull as real_pull
from msgctl.workspace import Workspace

pytestmark = pytest.mark.integration

OWNER_PASSWORD = "correct-horse-battery-staple"


def test_login_survives_failing_reconciling_pull(
    live_server: tuple[str, Path],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_url, _server_log = live_server
    ws = tmp_path / "acme"
    out: list[str] = []

    # Inject a transport blip: the FIRST pull (login's reconcile) raises; every
    # later pull (the explicit `msgctl pull` below) delegates to the real one.
    calls = {"n": 0}

    def flaky_pull(workspace: Workspace, client: MsgClient) -> PullResult:
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("injected network blip during reconciling pull")
        return real_pull(workspace, client)

    monkeypatch.setattr(remote, "pull", flaky_pull)

    # --- Setup: the reconciling pull fails, but login must still succeed --------
    login_out = json.loads(
        _run(
            capsys,
            out,
            "login",
            str(ws),
            "--setup",
            "--server-url",
            base_url,
            "--email",
            "owner@example.com",
            "--password",
            OWNER_PASSWORD,
            "--workspace-name",
            "Acme",
            "--display-name",
            "Owner",
        )
    )
    assert calls["n"] == 1, "the reconciling pull should have been attempted once"
    assert login_out["logged_in"] is True

    # No partial state: credentials AND the remote binding are both durable.
    ws_open = Workspace.open(ws)
    creds = read_credentials(ws_open)
    assert creds["token"]
    binding: dict[str, Any] = require_remote(ws_open)
    assert binding["server_url"] == base_url
    assert binding["device_id"]  # a plain re-login would need this — it's present
    assert binding["meta_stream_id"]

    # The deferred pull means the workspace has NOT yet learned `general`.
    assert "general" not in ws_open.name_index

    # --- Recovery: an explicit pull reconciles `general` (real pull runs now) ---
    _run(capsys, out, "pull", str(ws))
    assert calls["n"] == 2
    ws_open = Workspace.open(ws)
    assert "general" in ws_open.name_index
    general_id = ws_open.name_index["general"]

    # --- send --stream general REUSES the server's general — no duplicate -------
    sent = json.loads(_run(capsys, out, "send", str(ws), "--stream", "general", "--text", "hi"))
    assert sent["stream_id"] == general_id
    _run(capsys, out, "push", str(ws))

    with MsgClient(base_url, token=str(creds["token"])) as client:
        sync = client.get_sync()
    channels = [s for s in sync["streams"] if s.get("kind") == "channel"]
    assert len(channels) == 1, f"expected exactly one channel after recovery, got {channels}"
    assert channels[0]["name"] == "general"
    assert channels[0]["stream_id"] == general_id
    assert channels[0]["head_seq"] == 1  # the single message landed
