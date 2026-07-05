"""Security AC: raw tokens and passwords never reach the logs (ENG-64 D2)."""

from __future__ import annotations

import io
import logging

from authutil import (
    OWNER,
    accept_invite,
    create_invite,
    do_login,
    do_setup,
    join_token,
)
from httpx import AsyncClient
from msgd.logging import RedactSecretsFilter


async def test_secrets_never_logged(client: AsyncClient) -> None:
    """Drive setup + login + accept-invite while capturing every log line.

    The raw session tokens, the raw invite token, and the passwords must appear
    in no record — message or ``extra``.
    """
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setLevel(logging.DEBUG)
    handler.addFilter(RedactSecretsFilter())  # the same filter the app installs
    root = logging.getLogger()
    previous_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        setup_body = await do_setup(client)
        setup_token = setup_body["token"]

        login = await do_login(client, email=OWNER["email"], password=OWNER["password"])
        login_token = login.json()["token"]

        invite = await create_invite(client, setup_token, role="member")
        raw_invite = join_token(invite.json()["url"])
        accepted = await accept_invite(client, raw_invite, email="new@example.com")
        accept_token = accepted.json()["token"]
    finally:
        root.removeHandler(handler)
        root.setLevel(previous_level)

    output = buffer.getvalue()
    for secret in (setup_token, login_token, accept_token, raw_invite):
        assert secret not in output, "a raw token leaked into the logs"
    assert OWNER["password"] not in output
    assert "another-valid-password" not in output  # accept-invite default password


def test_redact_filter_scrubs_sensitive_extra() -> None:
    """The redaction filter replaces denylisted ``extra`` keys before formatting."""
    record = logging.LogRecord(
        name="test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="auth event",
        args=None,
        exc_info=None,
    )
    record.token = "raw-bearer-secret"
    record.password = "hunter2-hunter2"
    assert RedactSecretsFilter().filter(record) is True
    assert record.token == "[REDACTED]"  # type: ignore[attr-defined]
    assert record.password == "[REDACTED]"  # type: ignore[attr-defined]
