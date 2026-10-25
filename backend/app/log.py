"""Console logging: quiet by default - one ready notice, then only warnings and real errors.

* ``yofilter`` logger: INFO is reserved for essential notices; diagnostics are DEBUG.
  ``YOFILTER_LOG_LEVEL=DEBUG`` brings back model/session details.
* Uvicorn: successful requests (status < 400) and the startup/shutdown boilerplate are dropped.
  Failed requests, the "running on <url>" line and every error still show.
"""

from __future__ import annotations

import logging
import os

_BOILERPLATE = (
    "Started server process",
    "Waiting for application startup",
    "Application startup complete",
    "Waiting for application shutdown",
    "Application shutdown complete",
    "Finished server process",
)


class _DropSuccessfulRequests(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            return int(record.args[-1]) >= 400      # uvicorn access args: (client, method, path, http, status)
        except (TypeError, ValueError, IndexError, KeyError):
            return True


class _DropBoilerplate(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return not str(record.msg).startswith(_BOILERPLATE)


def configure_logging() -> logging.Logger:
    logger = logging.getLogger("yofilter")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        logger.propagate = False
        for name, log_filter in (("uvicorn.access", _DropSuccessfulRequests()), ("uvicorn.error", _DropBoilerplate())):
            logging.getLogger(name).addFilter(log_filter)
    level = getattr(logging, os.environ.get("YOFILTER_LOG_LEVEL", "INFO").strip().upper(), logging.INFO)
    logger.setLevel(level if isinstance(level, int) else logging.INFO)
    return logger
