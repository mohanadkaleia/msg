"""Boot a real ``msgd`` server for the ENG-83 Playwright golden path, then block.

The Playwright `global-setup` spawns this (``uv run python
web/tests/e2e/serverctl.py``); it starts an ephemeral Postgres testcontainer,
runs the Alembic migrations, launches a subprocess ``uvicorn`` on the true ASGI
app (``msgd.api.app:create_app --factory``) at a FIXED port (so the Vite preview
proxy can target it), waits until healthy, writes a readiness file, and blocks
until it receives SIGTERM/SIGINT — on which the Postgres container + uvicorn are
torn down.

This is the same real-server mechanism the M1 exit gate uses
(``cli/tests/_e2e_server.py``): one Postgres container + one subprocess uvicorn
on the real app. Kept in web/ so the golden-path harness is self-contained.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import FrameType

import httpx
from msgd.db.migrate import run_migrations
from testcontainers.postgres import PostgresContainer  # type: ignore[import-untyped]

HERE = Path(__file__).resolve().parent
READY_FILE = HERE / ".server-ready"
PORT = int(os.environ.get("MSGD_E2E_PORT", "8099"))
BASE_URL = f"http://127.0.0.1:{PORT}"

# Golden-path bootstrap identity (the browser logs in as this owner).
OWNER_EMAIL = "owner@example.com"
OWNER_PASSWORD = "correct-horse-battery-staple"


def _bootstrap() -> None:
    """Create the owner + a public ``general`` channel via ``msgctl`` (§2.2).

    The server's ``POST /v1/setup`` creates only ``workspace-meta``; a channel is
    born from a ``channel.created`` event, which ``msgctl send --stream general``
    auto-emits. So the browser has a real channel to open, this seeds the owner,
    ``general``, and one message — then the golden-path spec just logs in.
    """
    from msgctl.cli import main as msgctl_main

    ws = HERE / ".bootstrap-ws"
    if ws.exists():
        shutil.rmtree(ws)

    def run(*args: str) -> None:
        rc = msgctl_main(list(args))
        if rc != 0:
            raise RuntimeError(f"msgctl {' '.join(args)} exited {rc}")

    run(
        "login", str(ws), "--setup",
        "--server-url", BASE_URL,
        "--email", OWNER_EMAIL,
        "--password", OWNER_PASSWORD,
        "--workspace-name", "Acme",
        "--display-name", "Owner",
    )  # fmt: skip
    run("send", str(ws), "--stream", "general", "--text", "welcome to general")
    run("push", str(ws))


def _wait_healthy(timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    last = "no response"
    while time.time() < deadline:
        try:
            resp = httpx.get(f"{BASE_URL}/healthz", timeout=2.0)
            if resp.status_code == 200:
                return
            last = f"HTTP {resp.status_code}"
        except httpx.HTTPError as exc:
            last = type(exc).__name__
        time.sleep(0.3)
    raise RuntimeError(f"server did not become healthy at {BASE_URL}: {last}")


def main() -> int:
    READY_FILE.unlink(missing_ok=True)
    with PostgresContainer("postgres:17") as container:
        raw_url = container.get_connection_url()
        asyncpg_url = raw_url.replace("postgresql+psycopg2", "postgresql+asyncpg")
        run_migrations(asyncpg_url)

        data_dir = HERE / ".server-data"
        data_dir.mkdir(exist_ok=True)
        # Serve the built SPA from the server itself — the PRODUCTION topology
        # (same origin for HTML + API + WS), so no proxy is involved and the
        # Sec-WebSocket-Protocol bearer handshake reaches the server intact.
        web_dist = HERE.parent.parent / "dist"
        env = {
            **os.environ,
            "MSG_DATABASE_URL": asyncpg_url,
            "MSG_DATA_DIR": str(data_dir),
            "MSG_SECRET_KEY": "e2e-golden-path-secret",
            "MSG_SERVE_SPA": "true",
            "MSG_WEB_DIST_DIR": str(web_dist),
            "MSG_LOG_LEVEL": "INFO",
            "MSG_DOCS_ENABLED": "false",
            # Weak argon2 so browser logins in the smoke stay fast.
            "MSG_ARGON2_TIME_COST": "1",
            "MSG_ARGON2_MEMORY_COST_KIB": "8",
            "MSG_ARGON2_PARALLELISM": "1",
        }
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
                str(PORT),
                # Force the wsproto WS implementation: uvicorn's default
                # ``websockets`` backend (v16) does not surface the
                # ``Sec-WebSocket-Protocol`` subprotocols in the ASGI scope, so the
                # server's bearer-token WS auth (scope["subprotocols"]) sees nothing
                # and closes 4401/403. wsproto populates the scope correctly.
                "--ws",
                "wsproto",
                "--log-level",
                "info",
            ],
            env=env,
        )

        stop = False

        def _handle(_signum: int, _frame: FrameType | None) -> None:
            nonlocal stop
            stop = True

        signal.signal(signal.SIGTERM, _handle)
        signal.signal(signal.SIGINT, _handle)

        try:
            _wait_healthy()
            _bootstrap()
            READY_FILE.write_text(BASE_URL, encoding="utf-8")
            print(f"READY {BASE_URL}", flush=True)
            while not stop and proc.poll() is None:
                time.sleep(0.25)
        finally:
            READY_FILE.unlink(missing_ok=True)
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
