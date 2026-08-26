from datetime import datetime, timezone
from decimal import Decimal

from finance.models.dataclasses import Transaction
from finance.services.exports import export_single_month_to_bytes
from finance.storage.connection import get_connection
from finance.storage.repository import upsert_transaction
from finance.storage.schema import run_migrations


def _txn(tid, merchant, amount, day, category):
    return Transaction(
        plaid_transaction_id=tid,
        account_id="a1",
        date=datetime(2026, 7, day, tzinfo=timezone.utc),
        amount=Decimal(str(amount)),
        merchant=merchant,
        raw_description=merchant,
        category=category,
    )


def test_export_single_month_returns_xlsx_bytes(tmp_path):
    db_path = str(tmp_path / "test.db")
    conn = get_connection(db_path)
    run_migrations(conn)
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1, "Transportation"))
    data = export_single_month_to_bytes(conn, 2026, 7)
    conn.close()
    assert data[:2] == b"PK"
    assert len(data) > 1000


def test_export_months_multiple_transactions(tmp_path):
    db_path = str(tmp_path / "test.db")
    conn = get_connection(db_path)
    run_migrations(conn)
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1, "Transportation"))
    upsert_transaction(conn, _txn("t2", "KFC", 25, 2, "Restaurants"))
    data = export_single_month_to_bytes(conn, 2026, 7)
    conn.close()
    assert data[:2] == b"PK"
