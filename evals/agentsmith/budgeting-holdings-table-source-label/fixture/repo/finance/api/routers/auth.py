"""Local household authentication boundary."""

import sqlite3
import threading
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from finance.config.settings import (
    VALID_ENVIRONMENTS,
    load_config,
    resolve_environment,
)
from finance.exceptions import ConfigError
from finance.security.auth import SESSION_COOKIE, request_user
from finance.storage.connection import get_connection
from finance.storage.identity import (
    accept_household_invitation,
    authenticate,
    create_household_admin,
    create_household_invitation,
    create_session,
    delete_session,
    get_household_invitation,
    identity_connection,
    initialize_identity_database,
    list_household_invitations,
    list_members,
    reset_password,
    revoke_household_invitation,
    setup_required,
)
from finance.storage.repositories.households import adopt_existing_household_data

router = APIRouter(prefix="/api/auth", tags=["auth"])
_LOGIN_WINDOW_SECONDS = 60
_LOGIN_MAX_ATTEMPTS = 5
_login_attempts: dict[str, list[float]] = {}
_login_lock = threading.Lock()


class SetupRequest(BaseModel):
    household_name: str
    username: str
    email: str
    password: str


class LoginRequest(BaseModel):
    email: str
    password: str


class InvitationRequest(BaseModel):
    email: str


class InvitationTokenRequest(BaseModel):
    token: str


class AcceptInvitationRequest(BaseModel):
    token: str
    username: str
    password: str


class PasswordRequest(BaseModel):
    password: str


def _identity_conn():
    config = load_config()
    initialize_identity_database(config["identity_db_path"])
    return identity_connection(config["identity_db_path"])


@router.get("/status")
def auth_status():
    conn = _identity_conn()
    try:
        return {"setup_required": setup_required(conn)}
    finally:
        conn.close()


@router.post("/setup")
def setup(payload: SetupRequest, response: Response):
    conn = _identity_conn()
    try:
        user = create_household_admin(
            conn,
            payload.household_name,
            payload.username,
            payload.email,
            payload.password,
        )
        _adopt_existing_data(user["household_id"], user["id"])
        token, csrf_token = create_session(conn, user["id"])
    except (ValueError, sqlite3.IntegrityError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()
    _set_session_cookie(response, token)
    return {"user": user, "csrf_token": csrf_token}


@router.post("/login")
def login(payload: LoginRequest, response: Response, request: Request):
    attempt_key = request.client.host if request.client else "localhost"
    _check_login_rate(attempt_key)
    conn = _identity_conn()
    try:
        user = authenticate(conn, payload.email, payload.password)
        if user is None:
            _record_login_failure(attempt_key)
            raise HTTPException(status_code=401, detail="Invalid email or password")
        _clear_login_failures(attempt_key)
        token, csrf_token = create_session(conn, user["id"])
    finally:
        conn.close()
    _set_session_cookie(response, token)
    return {"user": user, "csrf_token": csrf_token}


@router.post("/logout")
def logout(request: Request, response: Response):
    conn = _identity_conn()
    try:
        delete_session(conn, request.cookies.get(SESSION_COOKIE))
    finally:
        conn.close()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    user = request_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    public_user = {key: value for key, value in user.items() if key != "csrf_token"}
    return {"user": public_user, "csrf_token": user["csrf_token"]}


@router.get("/members")
def members(request: Request):
    user = request_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    conn = _identity_conn()
    try:
        return {"members": list_members(conn, user["household_id"])}
    finally:
        conn.close()


@router.get("/invitations")
def invitations(request: Request):
    user = _require_admin(request)
    conn = _identity_conn()
    try:
        return {"invitations": list_household_invitations(conn, user["household_id"])}
    finally:
        conn.close()


@router.post("/invitations")
def create_invitation(payload: InvitationRequest, request: Request):
    user = _require_admin(request)
    conn = _identity_conn()
    try:
        invitation, token = create_household_invitation(
            conn,
            user["household_id"],
            user["id"],
            payload.email,
        )
    except (ValueError, sqlite3.IntegrityError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()
    return {"invitation": invitation, "token": token}


@router.delete("/invitations/{invitation_id}")
def revoke_invitation(invitation_id: str, request: Request):
    user = _require_admin(request)
    conn = _identity_conn()
    try:
        revoke_household_invitation(conn, user["household_id"], invitation_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    finally:
        conn.close()
    return {"ok": True}


@router.post("/invitations/inspect")
def inspect_invitation(payload: InvitationTokenRequest, request: Request):
    attempt_key = request.client.host if request.client else "localhost"
    _check_login_rate(attempt_key)
    conn = _identity_conn()
    try:
        invitation = get_household_invitation(conn, payload.token)
    except ValueError as exc:
        _record_login_failure(attempt_key)
        raise HTTPException(
            status_code=400, detail="Invitation is invalid or expired"
        ) from exc
    finally:
        conn.close()
    _clear_login_failures(attempt_key)
    return {"invitation": invitation}


@router.post("/invitations/accept")
def accept_invitation(
    payload: AcceptInvitationRequest, response: Response, request: Request
):
    attempt_key = request.client.host if request.client else "localhost"
    _check_login_rate(attempt_key)
    conn = _identity_conn()
    try:
        user = accept_household_invitation(
            conn, payload.token, payload.username, payload.password
        )
        token, csrf_token = create_session(conn, user["id"])
    except (ValueError, sqlite3.IntegrityError) as exc:
        _record_login_failure(attempt_key)
        detail = (
            str(exc)
            if isinstance(exc, ValueError)
            and str(exc) != "Invitation is invalid or expired"
            else "Invitation is invalid or expired"
        )
        raise HTTPException(status_code=400, detail=detail) from exc
    finally:
        conn.close()
    _clear_login_failures(attempt_key)
    _set_session_cookie(response, token)
    return {"user": user, "csrf_token": csrf_token}


@router.put("/members/{user_id}/password")
def admin_reset_password(user_id: str, payload: PasswordRequest, request: Request):
    _require_admin(request)
    conn = _identity_conn()
    try:
        reset_password(conn, user_id, payload.password, force_change=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()
    return {"ok": True}


@router.put("/password")
def change_password(payload: PasswordRequest, request: Request):
    user = request_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    conn = _identity_conn()
    try:
        reset_password(conn, user["id"], payload.password, force_change=False)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()
    return {"ok": True, "login_required": True}


def _require_admin(request: Request) -> dict:
    user = request_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if user.get("role") != "ADMIN":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return user


def _set_session_cookie(response: Response, token: str) -> None:
    secure = bool(load_config().get("session_cookie_secure", False))
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=secure,
        samesite="lax",
        max_age=30 * 24 * 60 * 60,
        path="/",
    )


def _check_login_rate(key: str) -> None:
    now = time.monotonic()
    with _login_lock:
        recent = [
            attempt
            for attempt in _login_attempts.get(key, [])
            if now - attempt < _LOGIN_WINDOW_SECONDS
        ]
        _login_attempts[key] = recent
        if len(recent) >= _LOGIN_MAX_ATTEMPTS:
            raise HTTPException(status_code=429, detail="Too many login attempts")


def _record_login_failure(key: str) -> None:
    with _login_lock:
        _login_attempts.setdefault(key, []).append(time.monotonic())


def _clear_login_failures(key: str) -> None:
    with _login_lock:
        _login_attempts.pop(key, None)


def _adopt_existing_data(household_id: str, user_id: str) -> None:
    config = load_config()
    for environment in VALID_ENVIRONMENTS:
        try:
            resolved = resolve_environment(config, environment)
        except ConfigError:
            continue
        conn = get_connection(resolved["db_path"], check_same_thread=False)
        try:
            adopt_existing_household_data(conn, household_id, user_id)
        finally:
            conn.close()
