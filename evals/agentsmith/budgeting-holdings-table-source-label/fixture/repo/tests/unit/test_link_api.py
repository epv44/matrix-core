import logging
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from finance.api.routers.institutions import (
    LinkExchange,
    SyncRequest,
    _store_exchanged_connection,
    create_link_token,
    relink_connection,
    relink_institution,
    sync_all,
    sync_history,
)
from finance.models.dataclasses import Institution
from finance.services import sync_policy
from finance.storage.connection import get_connection
from finance.storage.repository import (
    get_all_institutions,
    get_relink_session,
    record_sync_history,
    upsert_institution,
)
from finance.storage.schema import run_migrations


class FakePlaidClient:
    def __init__(self):
        self.request = None
        self.removed = False

    def link_token_create(self, request):
        self.request = request
        return {"link_token": "link-token"}

    def item_remove(self, request):
        self.removed = True


def _db(tmp_path, webhook_url=None):
    conn = get_connection(str(tmp_path / "api.db"))
    run_migrations(conn)
    return conn, {
        "plaid_environment": "production",
        "webhook_url": webhook_url,
    }


def test_link_token_caps_history_without_webhook(monkeypatch, tmp_path):
    client = FakePlaidClient()
    db = _db(tmp_path)
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )
    response = create_link_token(
        "production",
        db,
        "usaa",
        "2026-01-01",
        request=Request({"type": "http", "method": "POST", "path": "/api/link/token"}),
    )
    assert response["link_token"] == "link-token"
    assert client.request is not None
    assert client.request.transactions.days_requested == 30
    db[0].close()


def test_link_token_uses_signed_in_members_plaid_identifier(monkeypatch, tmp_path):
    client = FakePlaidClient()
    db = _db(tmp_path)
    request = Request({"type": "http", "method": "POST", "path": "/api/link/token"})
    request.state.user = {
        "id": "wife-user",
        "plaid_client_user_id": "wife-plaid-user",
    }
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )

    create_link_token("production", db, "fidelity", None, "INVESTMENT", request=request)

    assert client.request is not None
    assert client.request.user.client_user_id == "wife-plaid-user"
    db[0].close()


def test_link_token_includes_configured_redirect_uri(monkeypatch, tmp_path):
    client = FakePlaidClient()
    db = _db(tmp_path)
    db[1]["plaid_redirect_uri"] = "https://example.local:3443/oauth/callback"
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )
    request = Request({"type": "http", "method": "POST", "path": "/api/link/token"})

    create_link_token("production", db, "usaa", None, request=request)

    assert client.request is not None
    assert client.request.redirect_uri == "https://example.local:3443/oauth/callback"
    db[0].close()


def test_sync_all_returns_fresh_within_ttl(monkeypatch, tmp_path):
    sync_policy.reset()
    db = _db(tmp_path)
    institution_id = upsert_institution(db[0], Institution(name="usaa"))
    timestamp = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    db[0].execute(
        "UPDATE institutions SET last_successful_sync = ? WHERE id = ?",
        (timestamp, institution_id),
    )
    db[0].commit()
    monkeypatch.setattr(
        "finance.api.routers.institutions.svc_sync_all",
        lambda *args, **kwargs: pytest.fail("fresh sync must not call Plaid"),
    )

    response = sync_all("production", db, SyncRequest())

    assert response["status"] == "fresh"
    assert response["results"] == {}
    db[0].close()


def test_sync_all_runs_when_stale_and_reports_completed(monkeypatch, tmp_path):
    sync_policy.reset()
    db = _db(tmp_path)
    institution_id = upsert_institution(db[0], Institution(name="usaa"))
    timestamp = (datetime.now(timezone.utc) - timedelta(days=2)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    db[0].execute(
        "UPDATE institutions SET last_successful_sync = ? WHERE id = ?",
        (timestamp, institution_id),
    )
    db[0].commit()
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: object()
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.svc_sync_all",
        lambda *args, **kwargs: {
            "usaa": {"ok": True, "added": 1, "modified": 0, "removed": 0}
        },
    )

    response = sync_all("production", db, SyncRequest())

    assert response["status"] == "completed"
    assert response["results"]["usaa"]["ok"] is True
    db[0].close()


def test_exchange_assigns_new_connection_to_signed_in_member(monkeypatch, tmp_path):
    db = _db(tmp_path)
    monkeypatch.setattr(
        "finance.api.routers.institutions.set_keychain_token",
        lambda _label, _token: None,
    )
    payload = LinkExchange(
        public_token="public-token",
        institution="fidelity",
        institution_name="Fidelity",
        connection_type="INVESTMENT",
    )
    user = {
        "id": "wife-user",
        "username": "wife",
        "household_id": "household-one",
    }

    name, connection_id, _pending, _removed = _store_exchanged_connection(
        db[0], object(), payload, "production", user, "access-token", "item-one"
    )

    stored = get_all_institutions(db[0])[0]
    assert name == "Fidelity"
    assert connection_id == stored.connection_uuid
    assert stored.owner_user_id == "wife-user"
    assert stored.household_id == "household-one"
    db[0].close()


def test_sync_history_returns_page_metadata(tmp_path):
    db = _db(tmp_path)
    institution_id = upsert_institution(db[0], Institution(name="usaa"))
    for added in range(25):
        record_sync_history(
            db[0], "production", institution_id, None, False, "ok", added=added
        )

    response = sync_history("production", db, limit=20, offset=20)

    assert response["total"] == 25
    assert response["limit"] == 20
    assert response["offset"] == 20
    assert [row["added"] for row in response["history"]] == [4, 3, 2, 1, 0]
    db[0].close()


def test_relink_start_preserves_old_item_and_selected_history(monkeypatch, tmp_path):
    client = FakePlaidClient()
    db = _db(tmp_path, "https://example.ngrok-free.app/webhook")
    upsert_institution(db[0], Institution(name="usaa", plaid_item_id="old-item"))
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_keychain_token", lambda label: "old-token"
    )
    response = relink_institution("usaa", "production", db, "2026-01-01")
    assert response["relink_id"]
    assert client.removed is False
    assert client.request is not None
    assert client.request.webhook == "https://example.ngrok-free.app/webhook"
    session = get_relink_session(db[0], response["relink_id"])
    assert session is not None
    assert session["history_date"] == "2026-01-01"
    assert session["days_requested"] > 30
    db[0].close()


def test_relink_connection_resolves_stable_connection_id(monkeypatch, tmp_path):
    client = FakePlaidClient()
    db = _db(tmp_path, "https://example.ngrok-free.app/webhook")
    upsert_institution(db[0], Institution(name="usaa", plaid_item_id="old-item"))
    connection_id = get_all_institutions(db[0])[0].connection_uuid
    assert connection_id is not None
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_keychain_token", lambda label: "old-token"
    )

    response = relink_connection(connection_id, "production", db, "2026-01-01")

    assert response["relink_id"]
    assert client.request is not None
    db[0].close()


def test_relink_start_rejects_long_history_without_webhook(monkeypatch, tmp_path):
    client = FakePlaidClient()
    db = _db(tmp_path)
    upsert_institution(db[0], Institution(name="usaa", plaid_item_id="old-item"))
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_keychain_token", lambda label: "old-token"
    )

    with pytest.raises(HTTPException) as exc_info:
        relink_institution("usaa", "production", db, "2026-01-01")

    assert exc_info.value.status_code == 400
    assert "require a configured webhook" in exc_info.value.detail
    assert client.request is None
    db[0].close()


def test_relink_start_logs_selected_history_without_secrets(
    monkeypatch, tmp_path, caplog
):
    client = FakePlaidClient()
    db = _db(tmp_path, "https://example.ngrok-free.app/webhook")
    upsert_institution(db[0], Institution(name="usaa", plaid_item_id="old-item"))
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_keychain_token",
        lambda label: "secret-token",
    )

    with caplog.at_level(logging.INFO):
        response = relink_institution("usaa", "production", db, "2026-01-01")

    assert response["relink_id"] in caplog.text
    assert "history_date=2026-01-01" in caplog.text
    assert "secret-token" not in caplog.text
    db[0].close()


def test_investment_backfill_syncs_existing_item_without_relinking(
    monkeypatch, tmp_path
):
    client = FakePlaidClient()
    db = _db(tmp_path)
    upsert_institution(
        db[0],
        Institution(
            name="schwab", plaid_item_id="investment-item", connection_type="INVESTMENT"
        ),
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_client", lambda config: client
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_keychain_token",
        lambda label: "existing-token",
    )
    monkeypatch.setattr(
        "finance.api.routers.institutions.get_token_for_institution",
        lambda config, name: "existing-token",
    )
    captured = {}

    def fake_sync(*args, **kwargs):
        captured.update(kwargs)
        return {"status": "COMPLETE", "added": 2, "modified": 0, "removed": 0}

    monkeypatch.setattr("finance.api.routers.institutions.sync_investments", fake_sync)
    response = relink_institution("schwab", "production", db, "2026-01-01")

    assert response["direct"] is True
    assert response["initial_sync"]["added"] == 2
    assert captured["since"] == date(2026, 1, 1)
    assert client.removed is False
    assert client.request is None
    db[0].close()
