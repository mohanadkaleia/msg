"""Thin conftest shim — all harness logic lives in :mod:`harness` (typed).

pytest only discovers fixtures/hooks attached to a ``conftest`` module, but
mypy cannot check a second module named ``conftest`` (``cli/tests/conftest.py``
already claims the name), so the real logic sits in ``harness.py`` — a unique
module name under the strict gate — and is re-exported here.
"""

from harness import (  # noqa: F401
    client,
    database_url,
    db_connection,
    db_session,
    migrated_db,
    postgres_container,
    pytest_collection_modifyitems,
    settings,
)
