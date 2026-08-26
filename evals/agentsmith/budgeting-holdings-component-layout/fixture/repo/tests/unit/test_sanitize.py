import logging

import pytest

from finance.exceptions import PlaidError
from finance.security.sanitize import (
    SanitizedPlaidError,
    redact,
    sanitized_error,
    wrap_plaid_call,
)


def test_redact_full_card_number():
    assert redact("PAN 4111 1111 1111 1111") == "PAN <REDACTED>"


def test_redact_social_security_number():
    assert redact("ssn 123-45-6789") == "ssn <REDACTED>"


def test_redact_access_token():
    assert redact("access_token=abc123") == "<REDACTED>"


@pytest.mark.parametrize(
    "text",
    [
        "Authorization: Bearer bearer-secret",
        'public_token: "public-secret"',
        "client_secret=client-secret",
        "PLAID_SECRET=plaid-secret",
    ],
)
def test_redact_credential_variants(text):
    assert "secret" not in redact(text).lower()


def test_sanitized_error_redacts():
    assert sanitized_error(ValueError("card 4111111111111111")) == "card <REDACTED>"


def test_wrap_plaid_call_returns_value():
    assert wrap_plaid_call(lambda: 42) == 42


def test_wrap_plaid_call_raises_sanitized():
    def boom():
        raise ValueError("secret access_token: xyz-123")

    with pytest.raises(PlaidError) as excinfo:
        wrap_plaid_call(boom)
    assert "secret <REDACTED>" in str(excinfo.value)


def test_wrap_plaid_call_does_not_log_raw_exception_or_traceback(caplog):
    secret = "PLAID_SECRET_123"

    def boom():
        raise ValueError(f"request failed access_token={secret}")

    with (
        caplog.at_level(logging.ERROR, logger="finance.security.sanitize"),
        pytest.raises(PlaidError),
    ):
        wrap_plaid_call(boom)

    assert secret not in caplog.text
    assert "<REDACTED>" in caplog.text


def test_sanitized_plaid_error_subclasses_plaid_error():
    error = SanitizedPlaidError(ValueError("raw"), "safe message")
    assert isinstance(error, PlaidError)
    assert str(error) == "safe message"
