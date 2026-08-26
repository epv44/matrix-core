from datetime import datetime, timezone
from decimal import Decimal

import pytest

from finance.categorization.pfc_map import classify_txn
from finance.categorization.processor import process_monthly_data
from finance.models.dataclasses import Transaction
from finance.services.categorization import (
    resolve_category_for_transaction,
    resolve_transaction_type,
)
from finance.storage.connection import get_connection
from finance.storage.schema import run_migrations


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "test.db"))
    run_migrations(connection)
    yield connection
    connection.close()


def txn(tid, year, month, day, merchant, amount, category, pfc=None):
    return Transaction(
        plaid_transaction_id=tid,
        account_id="a1",
        date=datetime(year, month, day, tzinfo=timezone.utc),
        amount=Decimal(str(amount)),
        merchant=merchant,
        category=category,
        pfc_primary=pfc,
        raw_description=merchant,
    )


class TestProcessor:
    def test_expenses_grouped_by_category(self):
        txns = {
            (2026, 6): [
                txn("t1", 2026, 6, 1, "UBER", 30, "Transportation"),
                txn("t2", 2026, 6, 2, "KFC", 25, "Restaurants"),
                txn("t3", 2026, 6, 3, "SAFEWAY", 120, "Groceries"),
            ],
        }
        result = process_monthly_data(txns)
        month = result[(2026, 6)]
        assert len(month["expenses"]["Transportation"]) == 1
        assert month["expenses"]["Transportation"][0][0] == "UBER"
        assert month["expenses"]["Transportation"][0][1] == 30
        assert month["expenses"]["Restaurants"][0][0] == "KFC"
        assert month["expenses"]["Restaurants"][0][1] == 25
        assert month["expenses"]["Groceries"][0][0] == "SAFEWAY"
        assert month["expenses"]["Groceries"][0][1] == 120

    def test_income_excluded_from_expenses(self, conn):
        txns = {
            (2026, 6): [
                txn("t1", 2026, 6, 1, "GUSTO PAY", 5850, None),
                txn("t2", 2026, 6, 2, "UBER", 30, "Transportation"),
            ],
        }
        result = process_monthly_data(
            txns, type_resolver=lambda t: resolve_transaction_type(conn, t)
        )
        month = result[(2026, 6)]
        expense_count = sum(len(v) for v in month["expenses"].values())
        assert expense_count == 1
        assert len(month["income"]) == 1
        assert month["income"][0]["merchant"] == "GUSTO PAY"
        assert month["income"][0]["txn_id"] == "t1"

    def test_transfers_excluded_from_both(self, conn):
        txns = {
            (2026, 6): [
                txn("t1", 2026, 6, 1, "UBER", 30, "Transportation"),
                txn("t2", 2026, 6, 2, "CREDIT CARD 3333 PAYMENT *//", 25, None),
                txn("t3", 2026, 6, 3, "CD DEPOSIT .INITIAL.", 1000, None),
            ],
        }
        result = process_monthly_data(
            txns, type_resolver=lambda t: resolve_transaction_type(conn, t)
        )
        month = result[(2026, 6)]
        expense_count = sum(len(v) for v in month["expenses"].values())
        assert expense_count == 1
        assert len(month["income"]) == 0
        assert len(month["transfers"]) == 2

    def test_summary_totals(self, conn):
        txns = {
            (2026, 6): [
                txn("t1", 2026, 6, 1, "UBER", 30, "Transportation"),
                txn("t2", 2026, 6, 2, "KFC", 25, "Restaurants"),
                txn("t3", 2026, 6, 3, "GUSTO PAY", 5000, None),
            ],
        }
        result = process_monthly_data(
            txns, type_resolver=lambda t: resolve_transaction_type(conn, t)
        )
        summary = result[(2026, 6)]["summary"]
        assert summary["total_spent"] == 55.0
        assert summary["total_made"] == 5000.0
        assert summary["net"] == 4945.0

    def test_unknown_category_goes_to_misc(self):
        txns = {
            (2026, 6): [
                txn("t1", 2026, 6, 1, "SOME STORE", 50, "UnknownCategory"),
            ],
        }
        result = process_monthly_data(txns)
        month = result[(2026, 6)]
        assert len(month["expenses"]["MISC."]) == 1
        assert month["expenses"]["MISC."][0][0] == "SOME STORE"

    def test_merchant_override_to_sheet_category(self, conn):
        txns = {
            (2026, 6): [
                txn("t1", 2026, 6, 1, "CHEWY INC", 71.78, "MISC."),
                txn("t2", 2026, 6, 2, "Zelle: Veronica (Tia) Daycare", 560, "MISC."),
            ],
        }
        result = process_monthly_data(
            txns,
            category_resolver=lambda t: (
                resolve_category_for_transaction(conn, t) or "MISC."
            ),
        )
        month = result[(2026, 6)]
        assert month["expenses"]["Cat Related"][0][0] == "CHEWY INC"
        assert month["expenses"]["Baby"][0][0] == "Zelle: Veronica (Tia) Daycare"
        assert len(month["expenses"]["MISC."]) == 0

    def test_multiple_months_separated(self):
        txns = {
            (2026, 4): [
                txn("t1", 2026, 4, 1, "APRIL EXPENSE", 100, "Transportation"),
            ],
            (2026, 5): [
                txn("t2", 2026, 5, 1, "MAY EXPENSE", 200, "Restaurants"),
            ],
        }
        result = process_monthly_data(txns)
        assert len(result) == 2
        assert result[(2026, 4)]["summary"]["total_spent"] == 100.0
        assert result[(2026, 5)]["summary"]["total_spent"] == 200.0

    def test_no_duplicate_uber_in_april(self, monthly):
        """Integration-style: uses fixture, verifies April has exactly 1 Uber."""
        april = monthly.get((2026, 4), [])
        ubers_in_april = [t for t in april if t.merchant == "Uber"]
        assert len(ubers_in_april) == 1, (
            f"April has {len(ubers_in_april)} Ubers: {[t.amount for t in ubers_in_april]}"
        )
        assert ubers_in_april[0].amount == Decimal("6.33")

    def test_april_has_two_expenses(self, monthly):
        april_txns = monthly.get((2026, 4), [])
        expenses = [t for t in april_txns if classify_txn(t) == "expense"]
        assert len(expenses) == 2
        merchants = sorted(t.merchant for t in expenses)
        assert merchants == ["Uber", "United Airlines"]

    def test_no_uber_duplicate_in_any_month(self, monthly):
        """Verifies no month has more unique Uber transaction IDs than expected."""
        for (year, month), txns in monthly.items():
            ubers = [t for t in txns if t.merchant == "Uber"]
            unique_ids = {t.plaid_transaction_id for t in ubers}
            if ubers:
                assert len(unique_ids) == len(ubers), (
                    f"{year}-{month:02d}: {len(ubers)} Ubers but {len(unique_ids)} unique IDs - dupes exist"
                )
