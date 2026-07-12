"""Make the canonical live-server harness importable from the SDK e2e.

The SDK's live end-to-end test drives a REAL msgd (subprocess uvicorn + a
Postgres testcontainer) over real HTTP/WebSocket — an in-process ASGI transport
cannot serve the SDK's ``urllib`` / ``websockets`` clients. Rather than fork a
second boot mechanism, we reuse ``cli/tests/_e2e_server.py`` (the one the CLI
integration + exit-gate suites already use). It lives outside this package's
tests dir, so add it to ``sys.path`` here.
"""

from __future__ import annotations

import sys
from pathlib import Path

_CLI_TESTS = Path(__file__).resolve().parents[3] / "cli" / "tests"
if str(_CLI_TESTS) not in sys.path:
    sys.path.insert(0, str(_CLI_TESTS))
