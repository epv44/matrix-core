from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from plaid.exceptions import ApiException

from finance.exceptions import PlaidSyncError
from finance.models.dataclasses import Institution as InstModel
from finance.models.dataclasses import Transaction
from finance.plaid_client.sync import sync_institution
from finance.services.plaid_sync import sync_all
from finance.storage.connection import get_connection
from finance.storage.repository import (
    ensure_category,
    get_institution_by_name,
    get_sync_history,
    get_transaction_by_id,
    upsert_institution,
    upsert_transaction,
)
from finance.storage.schema import run_migrations

RESPONSE = {
    "item_id": "item1",
    "added": [
        {
            "transaction_id": "t1",
            "account_id": "a1",
            "amount": "12.34",
            "date": "2026-07-01",
            "name": "STARBUCKS",
        }
    ],
    "modified": [],
    "removed": [],
    "next_cursor": "c2",
    "has_more": False,
}


class _FakeApiClient:
    def sanitize_for_serialization(self, response):
        return response


class _FakeClient:
    def __init__(self, response=RESPONSE):
        self.api_client = _FakeApiClient()
        self._response = response

    def transactions_sync(self, request):
        return self._response


class _FailingClient:
    def __init__(self):
        self.api_client = _FakeApiClient()

    def transactions_sync(self, request):
        raise ApiException(status=400, reason="bad request")


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "test.db"))
    run_migrations(connection)
    yield connection
    connection.close()


def _txn(tid, institution_id=None):
    return Transaction(
        plaid_transaction_id=tid,
        account_id="a1",
        institution_id=institution_id,
        date=datetime(2026, 6, 1, tzinfo=timezone.utc),
        amount=Decimal("5.00"),
        merchant="OLD",
    )


def test_sync_institution_records_history_and_returns_stats(conn):
    stats = sync_institution(
        _FakeClient(), conn, "usaa", "token", {"plaid_environment": "sandbox"}
    )
    assert stats == {"added": 1, "modified": 0, "removed": 0}
    rows = get_sync_history(conn, "sandbox")
    assert len(rows) == 1
    assert rows[0]["status"] == "ok"
    assert rows[0]["added"] == 1
    assert rows[0]["replace"] == 0


def test_sync_institution_replace_deletes_existing_transactions(conn):

    usaa_id = upsert_institution(conn, InstModel(name="usaa"))
    upsert_transaction(conn, _txn("old1", institution_id=usaa_id))
    stats = sync_institution(
        _FakeClient(),
        conn,
        "usaa",
        "token",
        {"plaid_environment": "sandbox"},
        replace=True,
    )
    assert stats == {"added": 1, "modified": 0, "removed": 0}
    assert get_transaction_by_id(conn, "old1") is None
    assert get_transaction_by_id(conn, "t1") is not None
    rows = get_sync_history(conn, "sandbox")
    assert rows[0]["replace"] == 1


def test_sync_institution_error_records_failed_history(conn):
    with pytest.raises(PlaidSyncError):
        sync_institution(
            _FailingClient(), conn, "usaa", "token", {"plaid_environment": "sandbox"}
        )
    rows = get_sync_history(conn, "sandbox")
    assert rows[0]["status"] == "error"
    assert rows[0]["error"] is not None


def test_sync_all_records_history_for_each_institution(conn, monkeypatch):
    monkeypatch.setattr(
        "finance.services.plaid_sync.get_token_for_institution",
        lambda config, name: "token",
    )

    upsert_institution(conn, InstModel(name="usaa"))
    upsert_institution(conn, InstModel(name="chase"))
    results = sync_all(conn, _FakeClient(), {"plaid_environment": "sandbox"})
    assert results["usaa"]["ok"] is True
    assert results["usaa"]["added"] == 1
    assert len(get_sync_history(conn, "sandbox")) == 2


def test_sync_institution_backfill_resets_cursor_and_preserves_existing(conn):
    upsert_transaction(conn, _txn("old1"))
    stats = sync_institution(
        _FakeClient(),
        conn,
        "usaa",
        "token",
        {"plaid_environment": "sandbox"},
        backfill=True,
    )
    assert stats == {"added": 1, "modified": 0, "removed": 0}
    assert get_transaction_by_id(conn, "old1") is not None
    assert get_transaction_by_id(conn, "t1") is not None
    institution = get_institution_by_name(conn, "usaa")
    assert institution is not None
    assert institution.cursor == "c2"
    rows = get_sync_history(conn, "sandbox")
    assert rows[0]["backfill"] == 1
    assert rows[0]["replace"] == 0


def test_sync_institution_backfill_filters_older_than_since(conn):
    response = {
        "item_id": "item1",
        "added": [
            {
                "transaction_id": "old",
                "account_id": "a1",
                "amount": "1.00",
                "date": "2026-05-01",
                "name": "OLD",
            },
            {
                "transaction_id": "new",
                "account_id": "a1",
                "amount": "2.00",
                "date": "2026-07-01",
                "name": "NEW",
            },
        ],
        "modified": [],
        "removed": [],
        "next_cursor": "c3",
        "has_more": False,
    }
    stats = sync_institution(
        _FakeClient(response),
        conn,
        "usaa",
        "token",
        {"plaid_environment": "sandbox"},
        since=date(2026, 6, 1),
        backfill=True,
    )
    assert stats == {"added": 1, "modified": 0, "removed": 0}
    assert get_transaction_by_id(conn, "old") is None
    assert get_transaction_by_id(conn, "new") is not None


def test_sync_institution_counts_pre_existing_as_modified(conn):

    usaa_id = upsert_institution(conn, InstModel(name="usaa"))
    upsert_transaction(conn, _txn("t1", institution_id=usaa_id))
    stats = sync_institution(
        _FakeClient(),
        conn,
        "usaa",
        "token",
        {"plaid_environment": "sandbox"},
        backfill=True,
    )
    assert stats == {"added": 0, "modified": 1, "removed": 0}
    assert get_transaction_by_id(conn, "t1") is not None


def test_backfill_paginates_all_pages_even_when_page_has_old_txns(conn):
    page1 = {
        "item_id": "item1",
        "added": [
            {
                "transaction_id": "old1",
                "account_id": "a1",
                "amount": "1.00",
                "date": "2026-03-01",
                "name": "OLD",
            },
            {
                "transaction_id": "mid1",
                "account_id": "a1",
                "amount": "2.00",
                "date": "2026-07-01",
                "name": "MID",
            },
        ],
        "modified": [],
        "removed": [],
        "next_cursor": "c2",
        "has_more": True,
    }
    page2 = {
        "item_id": "item1",
        "added": [
            {
                "transaction_id": "new1",
                "account_id": "a1",
                "amount": "3.00",
                "date": "2026-08-01",
                "name": "NEW",
            },
        ],
        "modified": [],
        "removed": [],
        "next_cursor": "c3",
        "has_more": False,
    }
    pages = iter([page1, page2])

    class _PagedClient:
        def __init__(self):
            self.api_client = _FakeApiClient()

        def transactions_sync(self, request):
            return next(pages)

    stats = sync_institution(
        _PagedClient(),
        conn,
        "usaa",
        "token",
        {"plaid_environment": "sandbox"},
        since=date(2026, 6, 1),
        backfill=True,
    )
    assert stats == {"added": 2, "modified": 0, "removed": 0}
    assert get_transaction_by_id(conn, "old1") is None
    assert get_transaction_by_id(conn, "mid1") is not None
    assert get_transaction_by_id(conn, "new1") is not None
    institution = get_institution_by_name(conn, "usaa")
    assert institution is not None
    assert institution.cursor == "c3"


def test_sync_institution_resync_preserves_manual_category(conn):

    txn = _txn("t1")
    txn.manual_category_id = ensure_category(conn, "Self")
    upsert_transaction(conn, txn)
    sync_institution(
        _FakeClient(),
        conn,
        "usaa",
        "token",
        {"plaid_environment": "sandbox"},
        backfill=True,
    )
    updated = get_transaction_by_id(conn, "t1")
    assert updated is not None
    assert updated.manual_category_id is not None


def test_backfill_requires_since(conn):

    with pytest.raises(ValueError, match="start date"):
        sync_all(conn, _FakeClient(), {"plaid_environment": "sandbox"}, backfill=True)


def test_backfill_rejects_future_since(conn):

    with pytest.raises(ValueError, match="future"):
        sync_all(
            conn,
            _FakeClient(),
            {"plaid_environment": "sandbox"},
            since=date(2999, 1, 1),
            backfill=True,
        )


def test_backfill_rejects_older_than_24_months(conn):

    with pytest.raises(ValueError, match="730"):
        sync_all(
            conn,
            _FakeClient(),
            {"plaid_environment": "sandbox"},
            since=date(2020, 1, 1),
            backfill=True,
        )


def test_backfill_and_replace_mutually_exclusive(conn):

    with pytest.raises(ValueError, match="mutually exclusive"):
        sync_all(
            conn,
            _FakeClient(),
            {"plaid_environment": "sandbox"},
            since=date(2026, 1, 1),
            backfill=True,
            replace=True,
        )
