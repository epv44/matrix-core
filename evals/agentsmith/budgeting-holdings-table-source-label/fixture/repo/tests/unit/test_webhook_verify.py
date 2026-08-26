import base64
import hashlib
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from finance.security.webhook_verify import (
    WebhookBodyHashError,
    WebhookVerificationError,
    verify_webhook,
)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _make_key_pair():

    private_key = ec.generate_private_key(ec.SECP256R1())
    nums = private_key.public_key().public_numbers()
    jwk = {
        "alg": "ES256",
        "crv": "P-256",
        "kty": "EC",
        "use": "sig",
        "kid": "test-kid-1",
        "x": _b64url(nums.x.to_bytes(32, "big")),
        "y": _b64url(nums.y.to_bytes(32, "big")),
    }
    return private_key, jwk


def _sign(jwk, payload: dict, private_key, kid="test-kid-1"):

    pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return jwt.encode(payload, pem, algorithm="ES256", headers={"kid": kid})


class _FakeClient:
    def __init__(self, jwk):
        self._jwk = jwk

    def webhook_verification_key_get(self, request):
        if request.key_id != self._jwk["kid"]:
            raise LookupError("unknown kid")
        return {"key": self._jwk}


def _payload(body: bytes, iat: int | str | None = None):
    return {
        "iat": iat if iat is not None else int(time.time()),
        "request_body_sha256": hashlib.sha256(body).hexdigest(),
    }


def test_verify_accepts_valid_webhook():
    private_key, jwk = _make_key_pair()
    body = b'{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE"}'
    token = _sign(jwk, _payload(body), private_key)
    claims = verify_webhook(_FakeClient(jwk), body, token)
    assert claims is not None
    assert claims["request_body_sha256"] == hashlib.sha256(body).hexdigest()


def test_verify_rejects_missing_header():
    _, jwk = _make_key_pair()
    body = b"{}"
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, None)
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, "")


def test_verify_rejects_expired_iat():
    private_key, jwk = _make_key_pair()
    body = b"{}"
    token = _sign(jwk, _payload(body, iat=int(time.time()) - 400), private_key)
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, token)


def test_verify_rejects_wrong_algorithm():
    _, jwk = _make_key_pair()
    body = b"{}"
    token = jwt.encode(
        _payload(body),
        "shared-secret-that-is-long-enough-for-hs256",
        algorithm="HS256",
        headers={"kid": "test-kid-1"},
    )
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, token)


def test_verify_rejects_body_hash_mismatch():
    private_key, jwk = _make_key_pair()
    body = b'{"a":1}'
    token = _sign(jwk, _payload(b'{"a":2}'), private_key)
    with pytest.raises(WebhookBodyHashError):
        verify_webhook(_FakeClient(jwk), body, token)


def test_verify_rejects_unknown_kid():
    private_key, jwk = _make_key_pair()
    body = b"{}"
    token = _sign(jwk, _payload(body), private_key, kid="other-kid")
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, token)


def test_verify_rejects_malformed_token():
    _, jwk = _make_key_pair()
    body = b"{}"
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, "not-a-jwt")


@pytest.mark.parametrize("iat", [str(int(time.time())), int(time.time()) + 60])
def test_verify_rejects_invalid_iat(iat):
    private_key, jwk = _make_key_pair()
    jwk["kid"] = "iat-kid"
    body = b"{}"
    token = _sign(jwk, _payload(body, iat=iat), private_key, kid="iat-kid")
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, token)


def test_verify_rejects_invalid_jwk_metadata():
    private_key, jwk = _make_key_pair()
    jwk.update({"kid": "bad-key", "use": "enc"})
    body = b"{}"
    token = _sign(jwk, _payload(body), private_key, kid="bad-key")
    with pytest.raises(WebhookVerificationError):
        verify_webhook(_FakeClient(jwk), body, token)
