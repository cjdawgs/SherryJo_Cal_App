"""
Central logging configuration.

Before this module existed the application had no ``basicConfig`` at all, so the
root logger sat at WARNING and every ``logger.info()`` in the codebase was
silently discarded — while ~170 bare ``print()`` calls wrote to stdout
unconditionally. That inversion is what filled the hosting log quota.

Everything now goes through the standard library, so a single ``LOG_LEVEL``
environment variable controls volume without a code change.
"""

import logging
import os

# Requests whose 2xx access-log lines carry no information: health probes,
# telemetry beacons and static assets. 4xx/5xx are always kept.
QUIET_ACCESS_PATHS = ("/health", "/tv/diag", "/static/")

DEFAULT_PRODUCTION_LEVEL = "WARNING"
DEFAULT_DEVELOPMENT_LEVEL = "INFO"

NOISY_THIRD_PARTY_LOGGERS = (
    "caldav",
    "vobject",
    "icalendar",
    "recurring_ical_events",
    "urllib3.connectionpool",
)

BLOCKED_THIRD_PARTY_SNIPPETS = (
    "Ical data was modified to avoid compatibility issues",
    "Your calendar server breaks the icalendar standard",
    "error count:",
)


class NoisyIcalFilter(logging.Filter):
    """Drop iCalendar library chatter that is normal for real-world feeds."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage() if record else ""

        if any(snippet in message for snippet in BLOCKED_THIRD_PARTY_SNIPPETS):
            return False

        return not message.startswith(("--- ", "+++ ", "@@ "))


class QuietAccessFilter(logging.Filter):
    """
    Drop successful access-log lines for high-frequency, zero-signal routes.

    A TV kiosk beacons diagnostics and polls events around the clock; each of
    those produced an access line describing a request nobody will ever read.
    Failures still get through, which is the only reason to read this log.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) < 5:
            return True

        path = str(args[2])
        try:
            status = int(args[4])
        except (TypeError, ValueError):
            return True

        if status >= 400:
            return True

        return not path.startswith(QUIET_ACCESS_PATHS)


def resolve_log_level() -> str:
    """Explicit LOG_LEVEL wins; otherwise quiet in production, chatty locally."""
    configured = (os.getenv("LOG_LEVEL") or "").strip().upper()
    if configured in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        return configured

    from app.config import is_production_environment

    return DEFAULT_PRODUCTION_LEVEL if is_production_environment() else DEFAULT_DEVELOPMENT_LEVEL


def configure_logging() -> str:
    """Install handlers, levels and filters. Safe to call more than once."""
    level = resolve_log_level()

    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        force=True,
    )

    for name in NOISY_THIRD_PARTY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    root = logging.getLogger()
    if not any(isinstance(f, NoisyIcalFilter) for f in root.filters):
        root.addFilter(NoisyIcalFilter())

    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, QuietAccessFilter) for f in access.filters):
        access.addFilter(QuietAccessFilter())

    return level
