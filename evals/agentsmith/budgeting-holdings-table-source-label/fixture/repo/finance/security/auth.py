"""Cookie-session authentication helpers for the local web boundary."""

import hmac

from fastapi import Request

from finance.config.settings import load_config
from finance.storage.identity import identity_connection, resolve_session

SESSION_COOKIE = "budget_session"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
PUBLIC_PATHS = {
    "/health",
    "/openapi.json",
    "/docs",
    "/docs/oauth2-redirect",
    "/api/auth/status",
    "/api/auth/setup",
    "/api/auth/login",
    "/api/auth/invitations/inspect",
    "/api/auth/invitations/accept",
    "/api/webhook/transactions",
}


def request_user(request: Request) -> dict | None:
    user = getattr(request.state, "user", None)
    return user if isinstance(user, dict) else None


def authenticate_request(request: Request) -> dict | None:
    config = load_config()
    conn = identity_connection(config["identity_db_path"])
    try:
        return resolve_session(conn, request.cookies.get(SESSION_COOKIE))
    finally:
        conn.close()


def csrf_matches(request: Request, user: dict) -> bool:
    supplied = request.headers.get("x-csrf-token", "")
    expected = str(user.get("csrf_token") or "")
    return bool(supplied and expected and hmac.compare_digest(supplied, expected))
