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
import re

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

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
REDACTED = "[REDACTED]"
SENSITIVE_LOG_PATTERNS = (
    re.compile(r"(?i)\b(Authorization|Proxy-Authorization|X-API-Key)\s*:\s*[^\r\n]+"),
    re.compile(r"(?i)\b(Bearer)\s+[^\s,;]+"),
    re.compile(r"(?i)\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+"),
    re.compile(r"(?i)\b(postgres(?:ql)?(?:\+[^:]+)?://)([^\s/@:]+):([^\s/@]+)@"),
    re.compile(r"(?i)([?&](?:token|ticket|access_token|refresh_token|id_token|code|api_key|password)=)[^&\s]+"),
    re.compile(
        r"(?i)\b(password|passwd|secret|client_secret|api_key|access_token|"
        r"refresh_token|id_token|jwt_secret_key|token_encryption_key|database_url)\s*([:=])\s*"
        r"(?:['\"])?[^\s,;}&]+"
    ),
)


def redact_sensitive_text(value: object) -> str:
    """Remove credential-shaped values from text before it reaches a log sink."""
    text = str(value)
    text = SENSITIVE_LOG_PATTERNS[0].sub(r"\1: " + REDACTED, text)
    text = SENSITIVE_LOG_PATTERNS[1].sub(r"\1 " + REDACTED, text)
    text = SENSITIVE_LOG_PATTERNS[2].sub(r"\1: " + REDACTED, text)
    text = SENSITIVE_LOG_PATTERNS[3].sub(r"\1" + REDACTED + ":" + REDACTED + "@", text)
    text = SENSITIVE_LOG_PATTERNS[4].sub(r"\1" + REDACTED, text)
    return SENSITIVE_LOG_PATTERNS[5].sub(r"\1\2" + REDACTED, text)


class SensitiveDataFormatter(logging.Formatter):
    """Redact the complete formatted record, including exception tracebacks."""

    def format(self, record: logging.LogRecord) -> str:
        return redact_sensitive_text(super().format(record))


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
        format=LOG_FORMAT,
        force=True,
    )

    for name in NOISY_THIRD_PARTY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    root = logging.getLogger()
    for handler in root.handlers:
        handler.setFormatter(SensitiveDataFormatter(LOG_FORMAT))
    if not any(isinstance(f, NoisyIcalFilter) for f in root.filters):
        root.addFilter(NoisyIcalFilter())

    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, QuietAccessFilter) for f in access.filters):
        access.addFilter(QuietAccessFilter())

    return level
