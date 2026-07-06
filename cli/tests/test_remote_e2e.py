"""M1 exit-criterion E2E (ENG-70 §9): two ``msgctl`` clients converge over the real server.

Test-server mechanism: an **ephemeral Postgres testcontainer** + a **subprocess
``uvicorn``** running the real ASGI app (``msgd.api.app:create_app --factory``).
The CLI's synchronous ``httpx.Client`` drives the live server over real HTTP —
exercising the true bearer auth, sequencing, idempotency, and problem+json paths
(an in-process ASGI transport cannot serve a sync client). Server stdout+stderr
is captured to a file so the "raw token never logged" invariant is checked
against real server logs.

Marked ``integration`` (needs Docker); ``-m "not integration"`` skips it.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from msgctl import credentials
from msgctl.cli import main
from msgctl.projection import PROJECTION_DB_NAME, dump_messages, open_db, project
from msgctl.rebuild import rebuild_projection
from msgctl.workspace import Workspace
from msgd.db.migrate import run_migrations
from testcontainers.postgres import PostgresContainer  # type: ignore[import-untyped]

pytestmark = pytest.mark.integration

OWNER_PASSWORD = "correct-horse-battery-staple"
MEMBER_PASSWORD = "another-valid-password-42"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_healthy(base_url: str, *, timeout: float = 40.0) -> None:
    deadline = time.time() + timeout
    last: str = "no response"
    while time.time() < deadline:
        try:
            resp = httpx.get(f"{base_url}/healthz", timeout=2.0)
            if resp.status_code == 200:
                return
            last = f"HTTP {resp.status_code}"
        except httpx.HTTPError as exc:
            last = type(exc).__name__
        time.sleep(0.3)
    raise RuntimeError(f"server did not become healthy at {base_url}: {last}")


@pytest.fixture(scope="module")
def live_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[str, Path]]:
    """Start Postgres + a subprocess uvicorn; yield (base_url, server_log_path)."""
    with PostgresContainer("postgres:17") as container:
        raw_url: str = container.get_connection_url()
        asyncpg_url = raw_url.replace("postgresql+psycopg2", "postgresql+asyncpg")
        run_migrations(asyncpg_url)

        port = _free_port()
        base_url = f"http://127.0.0.1:{port}"
        data_dir = tmp_path_factory.mktemp("msgd-data")
        log_path = tmp_path_factory.mktemp("msgd-logs") / "server.log"

        env = {
            **os.environ,
            "MSG_DATABASE_URL": asyncpg_url,
            "MSG_DATA_DIR": str(data_dir),
            "MSG_SECRET_KEY": "e2e-test-secret",
            # Uppercase level name — logging.dictConfig rejects lowercase (the app
            # factory calls configure_logging with this value).
            "MSG_LOG_LEVEL": "INFO",
            "MSG_DOCS_ENABLED": "false",
            # Weak argon2 so a handful of logins stay fast (matches the harness).
            "MSG_ARGON2_TIME_COST": "1",
            "MSG_ARGON2_MEMORY_COST_KIB": "8",
            "MSG_ARGON2_PARALLELISM": "1",
        }
        with open(log_path, "wb") as log_file:
            proc = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "msgd.api.app:create_app",
                    "--factory",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--log-level",
                    "info",
                ],
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
            )
            try:
                _wait_healthy(base_url)
                yield base_url, log_path
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)


def _run(capsys: pytest.CaptureFixture[str], sink: list[str], *args: str) -> str:
    """Invoke the CLI in-process; accumulate stdout+stderr into ``sink``; return stdout."""
    code = main(list(args))
    captured = capsys.readouterr()
    sink.append(captured.out)
    sink.append(captured.err)
    assert code == 0, f"`msgctl {' '.join(args)}` exited {code}: {captured.err}"
    return captured.out.strip()


def _log_lines(stream_dir: Path) -> list[str]:
    lines: list[str] = []
    for path in sorted(stream_dir.glob("*.ndjson")):
        lines.extend(ln for ln in path.read_text(encoding="utf-8").split("\n") if ln)
    return lines


def _project_dump(root: Path) -> str:
    conn = open_db(root / PROJECTION_DB_NAME)
    try:
        project(Workspace.open(root), conn)
        return dump_messages(conn)
    finally:
        conn.close()


def test_two_clients_converge(
    live_server: tuple[str, Path], tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    base_url, server_log = live_server
    ws_a = tmp_path / "alice"
    ws_b = tmp_path / "bob"
    out: list[str] = []

    # --- Workspace A: setup owner, author, push -----------------------------
    _run(
        capsys,
        out,
        "login",
        str(ws_a),
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
    a_send1 = json.loads(
        _run(capsys, out, "send", str(ws_a), "--stream", "general", "--text", "a1")
    )
    _run(capsys, out, "send", str(ws_a), "--stream", "general", "--text", "a2")
    _run(capsys, out, "push", str(ws_a))

    # --- A mints an invite for B --------------------------------------------
    invite_out = json.loads(_run(capsys, out, "invite", str(ws_a), "--role", "member"))
    token = invite_out["url"].rsplit("/join/", 1)[1]

    # --- Workspace B: join, pull, author into the pulled channel, push ------
    _run(
        capsys,
        out,
        "login",
        str(ws_b),
        "--invite-token",
        token,
        "--server-url",
        base_url,
        "--email",
        "bob@example.com",
        "--password",
        MEMBER_PASSWORD,
        "--display-name",
        "Bob",
    )
    _run(capsys, out, "pull", str(ws_b))  # B resolves A's `general` from sync
    _run(capsys, out, "send", str(ws_b), "--stream", "general", "--text", "b1")
    _run(capsys, out, "push", str(ws_b))

    # --- everyone pulls the final truth -------------------------------------
    _run(capsys, out, "pull", str(ws_a))
    _run(capsys, out, "pull", str(ws_b))

    # === Assertion 1: byte-identical stream logs A vs B =====================
    a_streams = {p.name for p in (ws_a / "streams").iterdir() if p.is_dir()}
    b_streams = {p.name for p in (ws_b / "streams").iterdir() if p.is_dir()}
    assert a_streams == b_streams, "both clients must have the same stream ids"
    assert len(a_streams) == 2, f"expected meta + general, got {a_streams}"
    for sid in a_streams:
        a_lines = _log_lines(ws_a / "streams" / sid)
        b_lines = _log_lines(ws_b / "streams" / sid)
        assert a_lines == b_lines, f"stream {sid} logs diverge between A and B"

    # === Assertion 2: byte-identical project dumps ==========================
    dump_a = _project_dump(ws_a)
    dump_b = _project_dump(ws_b)
    assert dump_a == dump_b
    # All three messages (a1, a2, b1) are present.
    assert dump_a.count("message_id") == 3 or len(dump_a.strip().split("\n")) == 3

    # === Assertion 3: verify is green on both ===============================
    assert main(["verify", str(ws_a)]) == 0
    capsys.readouterr()
    assert main(["verify", str(ws_b)]) == 0
    capsys.readouterr()

    # === Assertion 4: idempotency — re-seed an already-accepted item ========
    from msgctl import outbox
    from msgd.core.hashing import hash_event
    from msgd.core.payloads import build_message_created_body

    ws_a_open = Workspace.open(ws_a)
    replay_body = build_message_created_body(
        workspace_id=ws_a_open.workspace_id,
        stream_id=a_send1["stream_id"],
        author_user_id=ws_a_open.local_author.user_id,
        author_device_id=ws_a_open.local_author.device_id,
        client_created_at="2026-07-04T00:00:00.000Z",
        text="a1-replay",
        event_id=a_send1["event_id"],  # SAME event_id → server must dedupe
    ).model_dump(mode="json")
    outbox.enqueue(ws_a_open, replay_body, hash_event(replay_body))
    _run(capsys, out, "push", str(ws_a))
    _run(capsys, out, "pull", str(ws_a))

    general_lines_after = _log_lines(ws_a / "streams" / a_send1["stream_id"])
    assert len(general_lines_after) == 3, "idempotent replay must not duplicate the event"
    assert main(["verify", str(ws_a)]) == 0
    capsys.readouterr()

    # === Assertion 5: rebuild ≡ incremental on the pulled workspace =========
    rebuild_projection(Workspace.open(ws_a))
    conn = open_db(ws_a / PROJECTION_DB_NAME)
    try:
        rebuilt_dump = dump_messages(conn)
    finally:
        conn.close()
    assert rebuilt_dump == _project_dump(ws_a)

    # === Assertion 6: credential hygiene ====================================
    import stat

    creds_path = credentials.msgctl_dir(ws_a_open) / credentials.CREDENTIALS_NAME
    assert stat.S_IMODE(creds_path.stat().st_mode) == 0o600
    raw_token = json.loads(creds_path.read_text())["token"]
    assert raw_token  # sanity: a token was stored
    combined_cli_output = "".join(out)
    assert raw_token not in combined_cli_output, "raw token leaked to CLI stdout/stderr"
    server_log_text = server_log.read_text(encoding="utf-8", errors="replace")
    assert raw_token not in server_log_text, "raw token leaked into server logs"
