import json
import sqlite3
from typing import cast

import pytest
from fastapi import HTTPException
from plaid.exceptions import ApiException
from starlette.requests import Request

from finance.api.routers.institutions import (
    unlink_connection as unlink_connection_route,
)
from finance.exceptions import ConfigError, PlaidError
from finance.models.dataclasses import Institution
from finance.plaid_client.items import remove_item
from finance.services.institutions import unlink_connection
from finance.storage.connection import get_connection
from finance.storage.repositories.institutions import delete_connection_data
from finance.storage.repository import get_institution_by_uuid, upsert_institution
from finance.storage.schema import run_migrations


class RemoveClient:
    def __init__(self, error: Exception | None = None):
        self.error = error
        self.called = False

    def item_remove(self, _request):
        self.called = True
        if self.error:
            raise self.error


def _api_error(code: str) -> ApiException:
    error = ApiException(status=400, reason="Bad Request")
    error.body = json.dumps({"error_code": code})
    return error


def test_remove_item_accepts_an_item_that_is_already_missing():
    client = RemoveClient(_api_error("ITEM_NOT_FOUND"))

    assert remove_item(client, "access-token") == "already_missing"
    assert client.called is True


def test_remove_item_rejects_other_plaid_errors():
    client = RemoveClient(_api_error("ITEM_LOGIN_REQUIRED"))

    with pytest.raises(PlaidError):
        remove_item(client, "access-token")


def test_unlink_service_revokes_before_local_cleanup(monkeypatch, tmp_path):
    conn = get_connection(str(tmp_path / "service.db"))
    run_migrations(conn)
    upsert_institution(
        conn,
        Institution(
            name="fidelity",
            plaid_item_id="item",
            connection_uuid="connection",
        ),
    )
    events: list[str] = []
    deleted_labels: list[str] = []

    def record_remote(_client, _token):
        events.append("remote")
        return "already_missing"

    def record_local(_conn, _institution_id, _item_id):
        events.append("local")
        return {"accounts": 0, "transactions": 0, "investment_transactions": 0}

    monkeypatch.setattr(
        "finance.services.institutions.get_token_for_connection",
        lambda _config, _institution: "access-token",
    )
    monkeypatch.setattr(
        "finance.services.institutions.remove_item",
        record_remote,
    )
    monkeypatch.setattr(
        "finance.services.institutions.delete_connection_data",
        record_local,
    )
    monkeypatch.setattr(
        "finance.services.institutions.delete_keychain_token",
        deleted_labels.append,
    )

    response = unlink_connection(
        conn, object(), {"plaid_environment": "production"}, "connection"
    )

    assert response["remote_status"] == "already_missing"
    assert response["keychain_deleted"] is True
    assert events == ["remote", "local"]
    assert "plaid_access_token_production_connection_connection" in deleted_labels
    conn.close()


def test_unlink_service_keeps_local_data_when_plaid_fails(monkeypatch, tmp_path):
    conn = get_connection(str(tmp_path / "service-failure.db"))
    run_migrations(conn)
    upsert_institution(
        conn,
        Institution(name="fidelity", connection_uuid="connection"),
    )
    monkeypatch.setattr(
        "finance.services.institutions.get_token_for_connection",
        lambda _config, _institution: "access-token",
    )
    monkeypatch.setattr(
        "finance.services.institutions.remove_item",
        lambda _client, _token: (_ for _ in ()).throw(PlaidError("upstream failed")),
    )

    with pytest.raises(PlaidError):
        unlink_connection(
            conn, object(), {"plaid_environment": "production"}, "connection"
        )

    assert get_institution_by_uuid(conn, "connection") is not None
    conn.close()


def test_unlink_service_requires_a_token(monkeypatch, tmp_path):
    conn = get_connection(str(tmp_path / "service-token.db"))
    run_migrations(conn)
    upsert_institution(
        conn,
        Institution(name="fidelity", connection_uuid="connection"),
    )
    monkeypatch.setattr(
        "finance.services.institutions.get_token_for_connection",
        lambda _config, _institution: (_ for _ in ()).throw(ConfigError("missing")),
    )

    with pytest.raises(ConfigError, match="cannot be revoked"):
        unlink_connection(
            conn, object(), {"plaid_environment": "production"}, "connection"
        )
    conn.close()


def _request(role: str) -> Request:
    request = Request({"type": "http", "method": "DELETE", "path": "/"})
    request.state.user = {"id": "user", "role": role}
    return request


def test_unlink_route_requires_an_admin(monkeypatch):
    monkeypatch.setattr(
        "finance.api.routers.institutions.unlink_connection_service",
        lambda *_args: pytest.fail("service should not run"),
    )

    with pytest.raises(HTTPException) as exc_info:
        unlink_connection_route(
            "connection",
            _request("MEMBER"),
            "production",
            (cast(sqlite3.Connection, object()), {"plaid_environment": "production"}),
        )

    assert exc_info.value.status_code == 403


def test_delete_connection_data_removes_owned_rows_and_preserves_shared_rows(
    tmp_path,
):
    conn = get_connection(str(tmp_path / "unlink.db"))
    run_migrations(conn)
    removed_id = upsert_institution(
        conn,
        Institution(
            name="steph fidelity",
            plaid_item_id="removed-item",
            connection_uuid="removed-connection",
            connection_type="INVESTMENT",
        ),
    )
    remaining_id = upsert_institution(
        conn,
        Institution(
            name="eric fidelity",
            plaid_item_id="remaining-item",
            connection_uuid="remaining-connection",
            connection_type="INVESTMENT",
        ),
    )
    conn.executemany(
        """
        INSERT INTO household_accounts (id, display_name)
        VALUES (?, ?)
        """,
        (("shared-household", "Shared"), ("removed-household", "Removed")),
    )
    conn.execute(
        """
        INSERT INTO account_owners (household_account_id, user_id)
        VALUES ('shared-household', 'user-one')
        """
    )
    conn.executemany(
        """
        INSERT INTO financial_accounts
        (
            account_id, institution_id, name, type, raw_payload,
            household_account_id, original_household_account_id,
            is_authoritative
        )
        VALUES (?, ?, ?, 'investment', '{}', ?, ?, ?)
        """,
        (
            (
                "removed-shared",
                removed_id,
                "Removed Shared",
                "shared-household",
                "removed-original-shared",
                1,
            ),
            (
                "removed-only",
                removed_id,
                "Removed Only",
                "removed-household",
                "removed-household",
                1,
            ),
            (
                "remaining-shared",
                remaining_id,
                "Remaining Shared",
                "shared-household",
                "remaining-original-shared",
                0,
            ),
        ),
    )
    conn.executemany(
        """
        INSERT INTO investment_securities (security_id, name)
        VALUES (?, ?)
        """,
        (("shared-security", "Shared"), ("removed-security", "Removed")),
    )
    conn.executemany(
        """
        INSERT INTO security_asset_allocations (
            security_id,
            asset_class,
            allocation_percent,
            source
        )
        VALUES (?, 'US_EQUITY', 100, 'SYSTEM')
        """,
        (("shared-security",), ("removed-security",)),
    )
    conn.executemany(
        """
        INSERT INTO investment_holdings
        (account_id, security_id, quantity, value)
        VALUES (?, ?, 1, 10)
        """,
        (
            ("removed-shared", "shared-security"),
            ("removed-only", "removed-security"),
            ("remaining-shared", "shared-security"),
        ),
    )
    conn.execute(
        """
        INSERT INTO investment_transactions
        (plaid_transaction_id, account_id, security_id, date, raw_payload)
        VALUES ('investment-removed', 'removed-only', 'removed-security', '2026-01-01', '{}')
        """
    )
    conn.execute(
        """
        INSERT INTO account_asset_allocations (
            account_id,
            asset_class,
            allocation_percent,
            source
        )
        VALUES ('removed-only', 'BONDS', 100, 'USER')
        """
    )
    conn.execute(
        """
        INSERT INTO transaction_audit_events
        (investment_transaction_id, event_type, raw_payload)
        VALUES ('investment-removed', 'CREATED', '{}')
        """
    )
    conn.execute(
        """
        INSERT INTO transactions
        (plaid_transaction_id, account_id, institution_id, date, amount)
        VALUES ('transaction-removed', 'removed-only', ?, '2026-01-01', 10)
        """,
        (removed_id,),
    )
    conn.execute(
        """
        INSERT INTO category_changes (transaction_id, reason)
        VALUES ('transaction-removed', 'MANUAL')
        """
    )
    conn.execute(
        """
        INSERT INTO cash_earmarks (account_id, name, amount)
        VALUES ('removed-only', 'Old goal', 10)
        """
    )
    earmark_id = conn.execute(
        "SELECT id FROM cash_earmarks WHERE account_id = 'removed-only'"
    ).fetchone()[0]
    conn.execute(
        """
        INSERT INTO financial_goals
        (name, goal_type, target_amount, source_earmark_id)
        VALUES ('Old goal', 'CASH_RESERVE', 10, ?)
        """,
        (earmark_id,),
    )
    conn.execute(
        """
        INSERT INTO webhook_jobs
        (delivery_id, env, item_id, webhook_type, webhook_code)
        VALUES ('delivery', 'production', 'removed-item', 'ITEM', 'ERROR')
        """
    )
    conn.commit()

    counts = delete_connection_data(conn, removed_id, "removed-item")

    assert counts == {
        "accounts": 2,
        "transactions": 1,
        "investment_transactions": 1,
    }
    assert get_institution_by_uuid(conn, "removed-connection") is None
    assert get_institution_by_uuid(conn, "remaining-connection") is not None
    remaining = conn.execute(
        """
        SELECT is_authoritative
        FROM financial_accounts
        WHERE account_id = 'remaining-shared'
        """
    ).fetchone()
    assert remaining["is_authoritative"] == 1
    assert conn.execute(
        "SELECT 1 FROM household_accounts WHERE id = 'shared-household'"
    ).fetchone()
    assert (
        conn.execute(
            "SELECT 1 FROM household_accounts WHERE id = 'removed-household'"
        ).fetchone()
        is None
    )
    assert conn.execute(
        "SELECT 1 FROM investment_securities WHERE security_id = 'shared-security'"
    ).fetchone()
    assert (
        conn.execute(
            "SELECT 1 FROM investment_securities WHERE security_id = 'removed-security'"
        ).fetchone()
        is None
    )
    for table in (
        "transactions",
        "category_changes",
        "investment_transactions",
        "transaction_audit_events",
        "cash_earmarks",
        "financial_goals",
        "webhook_jobs",
        "account_asset_allocations",
    ):
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    conn.close()
