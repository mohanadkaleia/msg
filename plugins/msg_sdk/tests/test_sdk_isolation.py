"""Structural guarantees: public-API-only + dependency-light base install.

The SDK is a black-box HTTP/WS consumer of the public plugin API
(``docs/plugins.md``) — these make that a gate, not a convention (mirroring
``plugins/github_notifier``):

* a static AST sweep: no package module imports ``msgd`` / ``msgctl`` / ``server``
  / ``cli`` or an HTTP framework/client (``fastapi`` / ``sqlalchemy`` / ``httpx`` /
  ``pydantic``);
* a fresh-interpreter import: loading the package pulls no msg modules — and no
  ``websockets`` — into ``sys.modules`` (``websockets`` is behind the optional
  ``ws`` extra and imported lazily, so the base install stays stdlib-only).
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent / "msg_sdk"

FORBIDDEN_IMPORTS = frozenset(
    {"msgd", "msgctl", "server", "cli", "fastapi", "sqlalchemy", "httpx", "pydantic"}
)


def _imported_top_level_names(tree: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_package_source_imports_nothing_from_msg() -> None:
    sources = sorted(PACKAGE_DIR.rglob("*.py"))
    assert sources, f"no sources found under {PACKAGE_DIR}"
    for source in sources:
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        forbidden = FORBIDDEN_IMPORTS & _imported_top_level_names(tree)
        assert not forbidden, f"{source} imports forbidden module(s): {sorted(forbidden)}"


def test_base_import_is_dependency_light() -> None:
    """A fresh interpreter importing the SDK loads no msg modules and no websockets."""
    probe = (
        "import sys\n"
        "import msg_sdk\n"
        "from msg_sdk import MsgClient, hash_event, canonicalize, ids\n"
        f"forbidden = {sorted(FORBIDDEN_IMPORTS | {'websockets'})!r}\n"
        "loaded = {name.split('.')[0] for name in sys.modules}\n"
        "hit = sorted(set(forbidden) & loaded)\n"
        "assert not hit, f'unexpected modules loaded on base import: {hit}'\n"
    )
    subprocess.run([sys.executable, "-c", probe], check=True, timeout=60)
