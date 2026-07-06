"""Tests for the CLI member (``msgctl``)."""

import os
import subprocess
import sys
from types import ModuleType

import pytest
from msgctl import __version__
from msgctl.cli import main


def test_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["--version"])
    assert excinfo.value.code == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == f"msgctl {__version__}"


def test_core_importable_from_cli() -> None:
    import msgctl
    import msgd.core

    assert isinstance(msgctl, ModuleType)
    assert isinstance(msgd.core, ModuleType)


def test_rebuild_projections_bad_url_is_sanitized() -> None:
    """A malformed ``MSG_DATABASE_URL`` fails cleanly without leaking the DSN.

    Security round 1: SQLAlchemy's URL-parse error embeds the full DSN (password
    included). ``cmd_rebuild_projections`` funnels every DB failure into a
    ``MsgctlError`` that names only the exception class, so ``main`` prints a
    one-line ``msgctl: …`` message — not a credential-bearing raw traceback.

    Driven as a real subprocess so the assertion covers the true stderr the
    operator / CI logs would see (``main`` → ``SystemExit`` → no Python traceback).
    """
    secret = "s3cr3tPASSWORD"
    env = {**os.environ, "MSG_DATABASE_URL": f"postgresql+asyncpg://user:{secret}@host:notaport/db"}
    proc = subprocess.run(
        [sys.executable, "-m", "msgctl.cli", "rebuild-projections"],
        capture_output=True,
        text=True,
        env=env,
    )
    assert proc.returncode == 1  # MsgctlError → operational-error exit
    assert secret not in proc.stderr  # DSN credentials never echoed
    assert secret not in proc.stdout
    assert "Traceback" not in proc.stderr  # no raw traceback escaped
    assert "rebuild-projections failed" in proc.stderr
