from datetime import datetime, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from finance.api.routers.transactions import (
    IgnoreRequest,
    ReclassifyRequest,
    ignore_transaction,
    reclassify_transaction,
)
from finance.models.dataclasses import Transaction
from finance.storage.connection import get_connection
from finance.storage.repository import get_transaction_by_id, upsert_transaction
from finance.storage.schema import run_migrations


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "test.db"))
    run_migrations(connection)
    yield connection
    connection.close()


def test_ignore_transaction_endpoint_persists_flag(conn):
    upsert_transaction(
        conn,
        Transaction(
            plaid_transaction_id="t1",
            account_id="a1",
            date=datetime(2026, 7, 1, tzinfo=timezone.utc),
            amount=Decimal(30),
        ),
    )

    result = ignore_transaction(
        "t1", IgnoreRequest(ignored=True), "sandbox", (conn, {})
    )

    assert result == {"ok": True, "ignored": True}
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.is_ignored is True


def test_ignore_transaction_endpoint_returns_404(conn):
    with pytest.raises(HTTPException) as exc:
        ignore_transaction(
            "missing", IgnoreRequest(ignored=True), "sandbox", (conn, {})
        )

    assert exc.value.status_code == 404


def test_reclassify_type_only_does_not_require_or_change_category(conn):
    upsert_transaction(
        conn,
        Transaction(
            plaid_transaction_id="t1",
            account_id="a1",
            date=datetime(2026, 7, 1, tzinfo=timezone.utc),
            amount=Decimal(100),
            merchant="Brokerage contribution",
        ),
    )

    result = reclassify_transaction(
        "t1", ReclassifyRequest(new_type="transfer"), "sandbox", (conn, {})
    )

    assert result["resolved_type"] == "transfer"
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.type_override == "TRANSFER"
    assert txn.manual_category_id is None


def test_reclassify_requires_at_least_one_change(conn):
    with pytest.raises(HTTPException) as exc:
        reclassify_transaction("missing", ReclassifyRequest(), "sandbox", (conn, {}))
    assert exc.value.status_code == 400
