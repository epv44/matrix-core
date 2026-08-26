import logging
import re

from finance.exceptions import PlaidError

logger = logging.getLogger(__name__)

SENSITIVE_PATTERNS = [
    re.compile(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b"),
    re.compile(r"\b\d{4}[ -]?\d{4}[ -]?\d{4}\b"),
    re.compile(r"\b\d{9}\b"),
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    re.compile(
        r"\b(?:access[_-]?token|public[_-]?token|client[_-]?secret|"
        r"plaid[_-]?secret|authorization|bearer)\b\s*[\"']?\s*[:=]?\s*"
        r"[\"']?\s*(?:Bearer\s+)?[A-Za-z0-9._~+/=-]+",
        re.IGNORECASE,
    ),
]


def redact(text: str) -> str:
    for pattern in SENSITIVE_PATTERNS:
        text = pattern.sub("<REDACTED>", text)
    return text


def sanitized_error(exc: Exception) -> str:
    msg = str(exc)
    return redact(msg)


class SanitizedPlaidError(PlaidError):
    def __init__(self, original: Exception, message: str):
        sanitized = redact(message)
        super().__init__(sanitized)


def wrap_plaid_call(func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        safe = sanitized_error(exc)
        logger.error("Plaid API error (redacted): %s", safe)
        raise SanitizedPlaidError(exc, safe) from None
