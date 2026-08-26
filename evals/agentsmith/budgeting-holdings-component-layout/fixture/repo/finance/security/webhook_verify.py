import base64
import hashlib
import hmac
import logging
import time

import jwt
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePublicNumbers
from plaid.model.webhook_verification_key_get_request import (
    WebhookVerificationKeyGetRequest,
)

from finance.config.settings import load_config, resolve_environment
from finance.exceptions import ConfigError
from finance.plaid_client.auth import get_client

logger = logging.getLogger(__name__)

MAX_AGE_SECONDS = 300
_KEY_CACHE: dict[tuple[str, str], dict] = {}


class WebhookVerificationError(ValueError):
    pass


class WebhookBodyHashError(WebhookVerificationError):
    pass


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def get_verification_key(client, kid: str, environment: str = "production") -> dict:
    cache_key = (environment, kid)
    cached = _cached_key(cache_key)
    if cached is not None:
        return cached

    resp = client.webhook_verification_key_get(
        WebhookVerificationKeyGetRequest(key_id=kid)
    )
    key = resp["key"]
    if not _valid_verification_key(key, kid):
        raise WebhookVerificationError("Invalid or expired Plaid verification key")
    _KEY_CACHE[cache_key] = key
    return key


def _cached_key(cache_key: tuple[str, str]) -> dict | None:
    cached = _KEY_CACHE.get(cache_key)
    if cached is None:
        return None
    expired_at = cached.get("expired_at")
    if expired_at is None or expired_at > int(time.time()):
        return cached
    _KEY_CACHE.pop(cache_key, None)
    return None


def _valid_verification_key(key: dict, kid: str) -> bool:
    expected = {"kid": kid, "alg": "ES256", "kty": "EC", "crv": "P-256", "use": "sig"}
    expired_at = key.get("expired_at")
    return all(key.get(name) == value for name, value in expected.items()) and (
        expired_at is None or expired_at > int(time.time())
    )


def _public_key_from_jwk(jwk: dict):

    if jwk.get("crv") != "P-256":
        raise WebhookVerificationError("Plaid webhook key must use P-256")
    curve = ec.SECP256R1()
    numbers = EllipticCurvePublicNumbers(
        int.from_bytes(_b64url_decode(jwk["x"]), "big"),
        int.from_bytes(_b64url_decode(jwk["y"]), "big"),
        curve,
    )
    return numbers.public_key(default_backend())


def get_webhook_client(environment: str):

    if environment not in ("production", "sandbox"):
        raise ConfigError("Webhook environment must be production or sandbox")
    return get_client(resolve_environment(load_config(), environment))


def verify_webhook(
    client, raw_body: bytes, header: str | None, environment: str = "production"
) -> dict:
    if not header:
        raise WebhookVerificationError("Missing Plaid-Verification header")

    claims = _verified_claims(client, header, environment)
    _validate_claim_time(claims)
    _validate_body_hash(claims, raw_body)
    return claims


def _verified_claims(client, header: str, environment: str) -> dict:
    try:
        kid = _verification_key_id(header)
        return _decode_with_refresh(client, header, environment, kid)
    except WebhookVerificationError:
        raise
    except Exception as exc:
        logger.warning("Webhook JWT verification failed: %s", exc)
        raise WebhookVerificationError("Invalid webhook signature") from exc


def _verification_key_id(header: str) -> str:
    jwt_header = jwt.get_unverified_header(header)
    if jwt_header.get("alg") != "ES256":
        raise WebhookVerificationError("Webhook algorithm must be ES256")
    kid = jwt_header.get("kid")
    if not kid:
        raise WebhookVerificationError("Webhook JWT is missing kid")
    return kid


def _decode_with_refresh(client, header: str, environment: str, kid: str) -> dict:
    jwk = get_verification_key(client, kid, environment)
    try:
        return _decode_claims(header, jwk)
    except jwt.InvalidSignatureError:
        _KEY_CACHE.pop((environment, kid), None)
        return _decode_claims(header, get_verification_key(client, kid, environment))


def _decode_claims(header: str, jwk: dict) -> dict:
    return jwt.decode(
        header,
        _public_key_from_jwk(jwk),
        algorithms=["ES256"],
        options={"verify_iat": False},
    )


def _validate_claim_time(claims: dict) -> None:
    iat = claims.get("iat")
    now = int(time.time())
    if not isinstance(iat, int) or isinstance(iat, bool):
        raise WebhookVerificationError("Webhook iat must be an integer")
    if now - iat > MAX_AGE_SECONDS or iat > now:
        raise WebhookVerificationError("Webhook iat is outside the 5-minute window")


def _validate_body_hash(claims: dict, raw_body: bytes) -> None:
    claimed_hash = claims.get("request_body_sha256")
    if not isinstance(claimed_hash, str) or not claimed_hash:
        raise WebhookVerificationError("Webhook JWT is missing request_body_sha256")
    actual_hash = hashlib.sha256(raw_body).hexdigest()
    if not hmac.compare_digest(actual_hash, claimed_hash):
        raise WebhookBodyHashError("Webhook body hash mismatch")
