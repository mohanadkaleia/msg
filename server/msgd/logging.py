"""Structured JSON logging (TDD §4.3 observability).

A dependency-free ``logging.dictConfig`` setup that emits one JSON object per
line and routes uvicorn's ``access`` and ``error`` loggers through the same
formatter so app and server logs share a shape. ``configure_logging`` is called
by both :func:`msgd.api.app.create_app` and :mod:`msgd.db.migrate`; the
container entrypoint passes ``--log-config`` / ``log_config=None`` to uvicorn so
this config wins over uvicorn's defaults.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
from logging.config import dictConfig
from typing import Any

_RESERVED = frozenset(
    logging.makeLogRecord({}).__dict__.keys() | {"message", "asctime", "taskName"}
)

# Structured `extra=` keys that must never reach a log line. Raw session tokens
# and passwords are only ever placed in response models (ENG-64 D2); this filter
# is belt-and-suspenders — if any of these keys is ever attached to a record via
# `extra=`, it is dropped before formatting. A dedicated test greps captured log
# output for the raw token to enforce the "never logged" rule.
_REDACTED_KEYS = frozenset(
    {"token", "password", "authorization", "secret", "session_token", "raw_token"}
)

# Belt-and-braces message-string scrub (ENG-68 security round 1): a ``token=<value>``
# in a RENDERED log message (e.g. a URL printed by uvicorn or any future debug line)
# is rewritten so no code path can log a raw session token, even though ENG-68 moved
# the WS token off the URL onto ``Sec-WebSocket-Protocol``. Matches ``token=`` up to
# the next whitespace / quote / ``&`` — enough for a query string or a bare pair.
_QS_TOKEN_RE = re.compile(r"(?i)(token=)[^\s\"'&]+")


class RedactSecretsFilter(logging.Filter):
    """Redact sensitive ``extra=`` keys AND any ``token=…`` in the rendered message.

    The keys are dropped before formatting; the message-string scrub is the
    defense-in-depth backstop for a secret that reaches the message text itself
    (uvicorn's request-line log, a stray URL debug) rather than an ``extra=`` field.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        for key in _REDACTED_KEYS:
            if key in record.__dict__:
                record.__dict__[key] = "[REDACTED]"
        # Scrub the fully-rendered message (``getMessage`` applies ``%``-args), then
        # pin it as ``msg`` with empty ``args`` so the redaction survives formatting.
        message = record.getMessage()
        scrubbed = _QS_TOKEN_RE.sub(r"\1[REDACTED]", message)
        if scrubbed != message:
            record.msg = scrubbed
            record.args = ()
        return True


class JsonFormatter(logging.Formatter):
    """Render a log record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": dt.datetime.fromtimestamp(record.created, tz=dt.UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        # Merge any structured `extra=` fields the caller attached.
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON formatter on root + uvicorn loggers at ``level``."""
    dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {"json": {"()": "msgd.logging.JsonFormatter"}},
            "filters": {"redact": {"()": "msgd.logging.RedactSecretsFilter"}},
            "handlers": {
                "default": {
                    "class": "logging.StreamHandler",
                    "formatter": "json",
                    "filters": ["redact"],
                    "stream": "ext://sys.stdout",
                }
            },
            "root": {"handlers": ["default"], "level": level},
            "loggers": {
                # Route uvicorn through our handler; don't let it double-log.
                "uvicorn": {"handlers": ["default"], "level": level, "propagate": False},
                "uvicorn.error": {
                    "handlers": ["default"],
                    "level": level,
                    "propagate": False,
                },
                "uvicorn.access": {
                    "handlers": ["default"],
                    "level": level,
                    "propagate": False,
                },
            },
        }
    )
