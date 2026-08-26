import json
from datetime import date

import pytest

from finance.api.routers.institutions import list_institutions
from finance.models.dataclasses import Institution
from finance.plaid_client import investments
from finance.services.portfolio import get_investment_dashboard
from finance.storage.connection import get_connection
from finance.storage.repository import (
    get_last_connection_sync,
    get_target_allocation,
    set_target_allocation,
    upsert_cash_accounts,
    upsert_institution,
    upsert_investment_data,
)
from finance.storage.schema import run_migrations


class _ApiClient:
    @staticmethod
    def sanitize_for_serialization(value):
        return value


class _Client:
    api_client = _ApiClient()

    def __init__(self, transaction_pages):
        self.transaction_pages = iter(transaction_pages)

    def investments_holdings_get(self, _request):
        return {"accounts": [], "securities": [], "holdings": []}

    def investments_transactions_get(self, _request):
        return next(self.transaction_pages)


def _db(tmp_path):
    conn = get_connection(str(tmp_path / "investments.db"))
    run_migrations(conn)
    upsert_institution(
        conn,
        Institution(
            name="schwab",
            plaid_item_id="item-1",
            connection_type="INVESTMENT",
        ),
    )
    return conn


def test_investment_transactions_always_receive_default_30_day_window(
    monkeypatch, tmp_path
):
    requests = []

    def request(_module, **kwargs):
        requests.append(kwargs)
        return kwargs

    monkeypatch.setattr(investments, "_today", lambda: date(2026, 8, 11))
    monkeypatch.setattr(investments, "_request", request)
    monkeypatch.setattr(investments, "wrap_plaid_call", lambda call: call())

    conn = _db(tmp_path)
    investments.sync_investments(
        _Client([{"investment_transactions": [], "total_investment_transactions": 0}]),
        conn,
        "schwab",
        "token",
    )

    transaction_request = requests[-1]
    assert transaction_request["start_date"] == date(2026, 7, 12)
    assert transaction_request["end_date"] == date(2026, 8, 11)
    assert transaction_request["options"]["count"] == 500
    assert transaction_request["options"]["offset"] == 0
    assert "count" not in transaction_request
    assert "offset" not in transaction_request

    institution = conn.execute(
        "SELECT id FROM institutions WHERE name = 'schwab'"
    ).fetchone()
    assert institution is not None
    assert get_last_connection_sync(conn, institution["id"], "INVESTMENT") is not None
    listed = list_institutions("production", (conn, {}))
    schwab = next(item for item in listed["institutions"] if item["name"] == "schwab")
    assert schwab["connection_type"] == "INVESTMENT"
    assert schwab["last_successful_sync"] is not None
    assert schwab["last_investment_sync"] == schwab["last_successful_sync"]


def test_investment_transaction_pagination_reuses_requested_date_window(
    monkeypatch, tmp_path
):
    requests = []

    def request(_module, **kwargs):
        requests.append(kwargs)
        return kwargs

    monkeypatch.setattr(investments, "_request", request)
    monkeypatch.setattr(investments, "wrap_plaid_call", lambda call: call())
    investments.sync_investments(
        _Client(
            [
                {
                    "investment_transactions": [
                        {
                            "investment_transaction_id": "1",
                            "account_id": "account-1",
                            "date": "2026-01-02",
                        }
                    ],
                    "total_investment_transactions": 2,
                },
                {
                    "investment_transactions": [
                        {
                            "investment_transaction_id": "2",
                            "account_id": "account-1",
                            "date": "2026-01-03",
                        }
                    ],
                    "total_investment_transactions": 2,
                },
            ]
        ),
        _db(tmp_path),
        "schwab",
        "token",
        since=date(2026, 1, 1),
    )

    transaction_requests = [request for request in requests if "start_date" in request]
    assert transaction_requests[0]["start_date"] == date(2026, 1, 1)
    assert transaction_requests[0]["end_date"] == transaction_requests[1]["end_date"]
    assert transaction_requests[1]["start_date"] == date(2026, 1, 1)
    assert transaction_requests[1]["options"]["offset"] == 1
    assert transaction_requests[0]["options"]["count"] == 500


def test_investment_pagination_stops_on_empty_page(monkeypatch, tmp_path):
    requests = []

    def request(_module, **kwargs):
        requests.append(kwargs)
        return kwargs

    monkeypatch.setattr(investments, "_request", request)
    monkeypatch.setattr(investments, "wrap_plaid_call", lambda call: call())
    investments.sync_investments(
        _Client(
            [
                {
                    "investment_transactions": [
                        {
                            "investment_transaction_id": "1",
                            "account_id": "account-1",
                            "date": "2026-01-02",
                        }
                    ],
                    "total_investment_transactions": 2,
                },
                {"investment_transactions": [], "total_investment_transactions": 2},
            ]
        ),
        _db(tmp_path),
        "schwab",
        "token",
        since=date(2026, 1, 1),
    )

    assert len(requests) == 5


def test_dashboard_uses_account_balance_when_no_holdings_exist(tmp_path):
    conn = _db(tmp_path)
    conn.execute(
        """INSERT INTO financial_accounts
        (account_id, institution_id, name, type, subtype, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?)""",
        (
            "account-529",
            1,
            "Schwab 529 Plan",
            "investment",
            "529",
            json.dumps({"balances": {"current": 11371.04}}),
        ),
    )
    conn.commit()

    dashboard = get_investment_dashboard(conn)

    assert dashboard["total_value"] == 11371.04
    assert dashboard["cost_basis"] == 0
    assert dashboard["market_appreciation"] == 0
    assert dashboard["accounts"] == [
        {
            "id": "account-529",
            "label": "Schwab 529 Plan",
            "value": 11371.04,
            "percentage": 100.0,
            "value_source": "account_balance",
        }
    ]


def test_dashboard_prefers_holdings_over_account_balance(tmp_path):
    conn = _db(tmp_path)
    conn.execute(
        """INSERT INTO financial_accounts
        (account_id, institution_id, name, type, subtype, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?)""",
        (
            "account-holdings",
            1,
            "Brokerage",
            "investment",
            "brokerage",
            json.dumps({"balances": {"current": 999.0}}),
        ),
    )
    conn.execute(
        "INSERT INTO investment_securities (security_id, ticker, name) VALUES (?, ?, ?)",
        ("security-1", "TEST", "Test Security"),
    )
    conn.execute(
        """INSERT INTO investment_holdings
        (account_id, security_id, quantity, value, cost_basis, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?)""",
        ("account-holdings", "security-1", 10, 100.0, 80.0, "{}"),
    )
    conn.commit()

    dashboard = get_investment_dashboard(conn)

    assert dashboard["total_value"] == 100.0
    assert dashboard["market_appreciation"] == 20.0
    assert dashboard["accounts"][0]["value_source"] == "holdings"


def test_target_allocation_is_validated_and_used_by_dashboard(tmp_path):
    conn = _db(tmp_path)
    assert get_target_allocation(conn)["US_EQUITY"] == 60.0
    set_target_allocation(conn, 70, 20, 10)
    assert get_target_allocation(conn) == {
        "US_EQUITY": 70.0,
        "INTERNATIONAL_EQUITY": 20.0,
        "BONDS": 10.0,
        "CASH": 0.0,
        "OTHER": 0.0,
    }
    with pytest.raises(ValueError):
        set_target_allocation(conn, 70, 20, 20)


def test_cash_snapshot_is_idempotent_and_included_as_cash(tmp_path):
    conn = _db(tmp_path)
    accounts = [
        {
            "account_id": "checking-1",
            "name": "Checking",
            "type": "depository",
            "subtype": "checking",
            "balances": {"current": 5000.0},
        }
    ]
    assert upsert_cash_accounts(conn, 1, accounts, "2026-08-11") == 1
    assert upsert_cash_accounts(conn, 1, accounts, "2026-08-11") == 1
    dashboard = get_investment_dashboard(conn)
    assert dashboard["total_value"] == 5000.0
    assert dashboard["asset_allocation"][0]["asset_class"] == "CASH"


def _investment_payload(*security_ids):
    return {
        "accounts": [
            {
                "account_id": "brokerage-1",
                "name": "Brokerage",
                "type": "investment",
                "subtype": "brokerage",
                "balances": {"current": 100.0},
            }
        ],
        "securities": [
            {"security_id": security_id, "ticker_symbol": security_id.upper()}
            for security_id in security_ids
        ],
        "holdings": [
            {
                "account_id": "brokerage-1",
                "security_id": security_id,
                "quantity": 1,
                "institution_price": 50,
                "institution_value": 50,
            }
            for security_id in security_ids
        ],
        "transactions": [],
    }


def test_investment_sync_replaces_stale_holdings_and_records_zero_holdings(tmp_path):
    conn = _db(tmp_path)
    upsert_investment_data(
        conn, 1, "item-1", _investment_payload("one", "two"), "2026-08-10"
    )

    stats = upsert_investment_data(
        conn, 1, "item-1", _investment_payload("one"), "2026-08-11"
    )
    assert stats["removed"] == 1
    assert [
        row["security_id"]
        for row in conn.execute("SELECT security_id FROM investment_holdings")
    ] == ["one"]

    empty = _investment_payload()
    stats = upsert_investment_data(conn, 1, "item-1", empty, "2026-08-12")
    assert stats["removed"] == 1
    assert (
        conn.execute("SELECT COUNT(*) AS count FROM investment_holdings").fetchone()[
            "count"
        ]
        == 0
    )
    status = conn.execute(
        """SELECT holdings_count, is_complete FROM portfolio_snapshot_accounts
           WHERE snapshot_date = '2026-08-12' AND account_id = 'brokerage-1'"""
    ).fetchone()
    assert dict(status) == {"holdings_count": 0, "is_complete": 1}


def test_investment_sync_is_same_day_idempotent_and_rolls_back_invalid_payload(
    tmp_path,
):
    conn = _db(tmp_path)
    payload = _investment_payload("one")
    upsert_investment_data(conn, 1, "item-1", payload, "2026-08-11")
    upsert_investment_data(conn, 1, "item-1", payload, "2026-08-11")
    assert (
        conn.execute(
            "SELECT COUNT(*) AS count FROM investment_holding_snapshots"
        ).fetchone()["count"]
        == 1
    )

    invalid = _investment_payload("two")
    invalid["accounts"][0]["account_id"] = "new-account"
    with pytest.raises(ValueError, match="unknown account"):
        upsert_investment_data(conn, 1, "item-1", invalid, "2026-08-12")
    assert [
        row["security_id"]
        for row in conn.execute("SELECT security_id FROM investment_holdings")
    ] == ["one"]
    assert (
        conn.execute(
            "SELECT 1 FROM financial_accounts WHERE account_id = 'new-account'"
        ).fetchone()
        is None
    )


def test_investment_sync_consolidates_duplicate_account_security_holdings(tmp_path):
    conn = _db(tmp_path)
    payload = _investment_payload("one")
    exact = dict(payload["holdings"][0])
    distinct = {
        **exact,
        "quantity": 2,
        "institution_value": 100,
        "cost_basis": 80,
        "tax_lots": [{"institution_lot_id": "lot-2", "quantity": 2}],
    }
    payload["holdings"] = [
        {
            **exact,
            "cost_basis": 40,
            "tax_lots": [{"institution_lot_id": "lot-1", "quantity": 1}],
        },
        {
            **exact,
            "cost_basis": 40,
            "tax_lots": [{"institution_lot_id": "lot-1", "quantity": 1}],
        },
        distinct,
    ]

    stats = upsert_investment_data(conn, 1, "item-1", payload, "2026-08-12")

    assert stats["source_holdings"] == 3
    assert stats["holdings"] == 1
    assert stats["consolidated_holdings"] == 2
    row = conn.execute(
        """SELECT quantity, value, cost_basis, tax_lots, raw_payload
           FROM investment_holdings WHERE account_id = 'brokerage-1'"""
    ).fetchone()
    assert float(row["quantity"]) == 3
    assert float(row["value"]) == 150
    assert float(row["cost_basis"]) == 120
    assert "lot-1" in row["tax_lots"] and "lot-2" in row["tax_lots"]
    assert "source_holdings" in row["raw_payload"]


def test_authoritative_sync_closes_disappeared_account(tmp_path):
    conn = _db(tmp_path)
    upsert_investment_data(conn, 1, "item-1", _investment_payload("one"), "2026-08-11")

    stats = upsert_investment_data(
        conn,
        1,
        "item-1",
        {"accounts": [], "securities": [], "holdings": [], "transactions": []},
        "2026-08-12",
    )

    assert stats["removed"] == 1
    account = conn.execute(
        """SELECT is_active, inactive_since FROM financial_accounts
           WHERE account_id = 'brokerage-1'"""
    ).fetchone()
    assert dict(account) == {"is_active": 0, "inactive_since": "2026-08-12"}
    status = conn.execute(
        """SELECT source, balance, holdings_count, is_complete
           FROM portfolio_snapshot_accounts
           WHERE account_id = 'brokerage-1' AND snapshot_date = '2026-08-12'"""
    ).fetchone()
    assert dict(status) == {
        "source": "PLAID_CLOSED",
        "balance": 0,
        "holdings_count": 0,
        "is_complete": 1,
    }
    assert get_investment_dashboard(conn)["total_value"] == 0
