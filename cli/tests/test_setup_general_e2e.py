"""ENG-109: `login --setup` seeds ONE `general`, and `send --stream general` reuses it.

The reconciliation proof: `msgctl login` pulls right after binding, so the local
name index learns the server's setup-created public `general`. A subsequent
`send --stream general` therefore resolves that name to the EXISTING stream id
and enqueues only a `message.created` — it never mints a second `channel.created`.
So exactly one `general` channel ever exists server-side, and the message lands
in it.

Its own module (not appended to ``test_remote_e2e``) so the module-scoped
``live_server`` starts from an EMPTY server — a second ``--setup`` on a server
that already has an owner would 409 ``already_initialized``.

Marked ``integration`` (needs Docker); ``-m "not integration"`` skips it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from _e2e_server import _run
from _e2e_server import live_server as live_server  # shared fixture re-export
from msgctl.client import MsgClient
from msgctl.credentials import read_credentials
from msgctl.workspace import Workspace

pytestmark = pytest.mark.integration

OWNER_PASSWORD = "correct-horse-battery-staple"


def test_setup_seeds_single_general_send_reuses_it(
    live_server: tuple[str, Path], tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    base_url, _server_log = live_server
    ws = tmp_path / "acme"
    out: list[str] = []

    # Setup: the server auto-creates the public `general`; login pulls it locally.
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

    # The local workspace learned `general` from the login-time pull: exactly the
    # meta stream + the setup-created general, and general resolves by NAME.
    ws_open = Workspace.open(ws)
    assert "general" in ws_open.name_index
    general_id = ws_open.name_index["general"]

    # send --stream general must REUSE the setup-created id (no new channel.created).
    sent = json.loads(_run(capsys, out, "send", str(ws), "--stream", "general", "--text", "hi"))
    assert sent["stream_id"] == general_id, "send minted a NEW general instead of reusing setup's"
    _run(capsys, out, "push", str(ws))

    # Server-side truth: exactly ONE channel, named `general`, with the message.
    creds = read_credentials(ws_open)
    with MsgClient(base_url, token=str(creds["token"])) as client:
        sync = client.get_sync()
    channels = [s for s in sync["streams"] if s.get("kind") == "channel"]
    assert len(channels) == 1, f"expected exactly one channel, got {channels}"
    general = channels[0]
    assert general["name"] == "general"
    assert general["visibility"] == "public"
    assert general["stream_id"] == general_id
    assert general["member"] is True
    assert general["head_seq"] == 1  # the single message we sent
