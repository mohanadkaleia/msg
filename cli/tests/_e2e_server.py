"""Shared real-server E2E mechanism for the ``msgctl`` integration suite.

Extracted from ENG-70's ``test_remote_e2e.py`` (ENG-73) so both that feature
test and the M1 exit gate (``test_m1_exit_gate.py``) drive **one** mechanism: an
ephemeral **Postgres testcontainer** + a **subprocess ``uvicorn``** running the
true ASGI app (``msgd.api.app:create_app --factory``). One container, one
server-process shape, one place to maintain.

The CLI's synchronous ``httpx.Client`` drives the live server over real HTTP,
exercising the true bearer auth, sequencing, idempotency, and problem+json paths
(an in-process ASGI transport cannot serve a sync client). Server stdout+stderr
is captured to a file so the "raw token never logged" invariant is checked
against real server logs.

The :func:`live_server` fixture is **module-scoped**, so each importing test
module reuses a single Postgres container + uvicorn process across its tests.
Import it into a test module with ``from _e2e_server import live_server as
live_server`` (the redundant alias marks the intentional fixture re-export).
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from msgctl.cli import main
from msgctl.projection import PROJECTION_DB_NAME, dump_messages, open_db, project
from msgctl.workspace import Workspace
from msgd.db.migrate import run_migrations
from testcontainers.postgres import PostgresContainer  # type: ignore[import-untyped]


@dataclass(frozen=True)
class ServerHandle:
    """Everything a test may need about the running E2E server.

    ``live_server`` keeps yielding the historical ``(base_url, log_path)`` pair;
    tests that also need the server's DB DSN / data dir (ENG-155's `msgctl
    export` reads them directly) build their own fixture on
    :func:`start_live_server` and take the full handle.
    """

    base_url: str
    log_path: Path
    database_url: str
    data_dir: Path


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


@contextmanager
def start_live_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ServerHandle]:
    """Start Postgres + a subprocess uvicorn; yield the full :class:`ServerHandle`."""
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
                yield ServerHandle(
                    base_url=base_url,
                    log_path=log_path,
                    database_url=asyncpg_url,
                    data_dir=data_dir,
                )
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)


@pytest.fixture(scope="module")
def live_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[str, Path]]:
    """Start Postgres + a subprocess uvicorn; yield (base_url, server_log_path)."""
    with start_live_server(tmp_path_factory) as handle:
        yield handle.base_url, handle.log_path


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
