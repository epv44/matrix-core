from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient

from finance.api.routers import auth
from finance.security.auth import PUBLIC_PATHS
from finance.storage.identity import (
    create_household_admin,
    identity_connection,
    initialize_identity_database,
)


def test_household_mode_marks_session_cookie_secure(monkeypatch):
    monkeypatch.setattr(auth, "load_config", lambda: {"session_cookie_secure": True})
    response = Response()

    auth._set_session_cookie(response, "session-token")

    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie
    assert "SameSite=lax" in cookie
    assert "Secure" in cookie


def test_local_development_cookie_can_use_http(monkeypatch):
    monkeypatch.setattr(auth, "load_config", lambda: {"session_cookie_secure": False})
    response = Response()

    auth._set_session_cookie(response, "session-token")

    assert "Secure" not in response.headers["set-cookie"]


def test_invitation_api_creates_and_signs_in_member(monkeypatch, tmp_path):
    identity_path = str(tmp_path / "identity.db")
    initialize_identity_database(identity_path)
    conn = identity_connection(identity_path)
    admin = create_household_admin(
        conn, "Home", "admin", "admin@example.com", "a-secure-password"
    )
    conn.close()
    monkeypatch.setattr(
        auth,
        "load_config",
        lambda: {
            "identity_db_path": identity_path,
            "session_cookie_secure": True,
        },
    )
    admin_request = _request(admin)

    created = auth.create_invitation(
        auth.InvitationRequest(email="member@example.com"), admin_request
    )
    test_app = FastAPI()
    test_app.include_router(auth.router)
    client = TestClient(test_app)
    inspected_response = client.post(
        "/api/auth/invitations/inspect", json={"token": created["token"]}
    )
    accepted_response = client.post(
        "/api/auth/invitations/accept",
        json={
            "token": created["token"],
            "username": "member",
            "password": "member-chosen-password",
        },
    )

    assert inspected_response.status_code == 200
    assert inspected_response.json()["invitation"]["household_name"] == "Home"
    assert accepted_response.status_code == 200
    assert accepted_response.json()["user"]["email"] == "member@example.com"
    assert accepted_response.json()["user"]["role"] == "MEMBER"
    assert "Secure" in accepted_response.headers["set-cookie"]
    assert "/api/auth/invitations/inspect" in PUBLIC_PATHS
    assert "/api/auth/invitations/accept" in PUBLIC_PATHS


def _request(user: dict | None = None) -> Request:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/",
            "headers": [],
            "client": ("127.0.0.1", 1234),
        }
    )
    if user is not None:
        request.state.user = user
    return request
