from datetime import datetime, timezone
from decimal import Decimal

import pytest

from finance.categorization.pfc_map import classify_txn, map_legacy_category, map_pfc
from finance.models.dataclasses import Transaction
from finance.services.categorization import resolve_transaction_type
from finance.storage.connection import get_connection
from finance.storage.repository import get_category_rules
from finance.storage.schema import run_migrations


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "test.db"))
    run_migrations(connection)
    yield connection
    connection.close()


@pytest.mark.parametrize(
    "primary,detailed,expected",
    [
        ("FOOD_AND_DRINK", "FAST_FOOD", "Restaurants"),
        ("FOOD_AND_DRINK", "GROCERIES", "Groceries"),
        ("FOOD_AND_DRINK", "RESTAURANTS", "Restaurants"),
        ("TRANSPORTATION", "RIDE_SHARE", "Transportation"),
        ("TRANSPORTATION", "GAS", "Transportation"),
        ("TRAVEL", "AIRLINES", "Travel"),
        ("TRAVEL", "HOTELS", "Travel"),
        ("RENT_AND_UTILITIES", None, "Living Expenses"),
        ("GENERAL_MERCHANDISE", None, "MISC."),
        ("PETS", "PET_FOOD", "Cat Related"),
    ],
)
def test_map_pfc_known(conn, primary, detailed, expected):
    assert map_pfc(conn, primary, detailed) == expected


@pytest.mark.parametrize(
    "primary,detailed",
    [
        ("PERSONAL_CARE", None),
        ("LOAN_PAYMENTS", None),
        ("TRANSFER_IN", None),
        ("TRANSFER_OUT", None),
        (None, None),
    ],
)
def test_map_pfc_unknown(conn, primary, detailed):
    assert map_pfc(conn, primary, detailed) is None


@pytest.mark.parametrize(
    "merchant,amount,pfc,expected",
    [
        ("Uber", "6.33", "TRANSPORTATION", "expense"),
        ("United Airlines", "500", "TRAVEL", "expense"),
        ("KFC", "500", "FOOD_AND_DRINK", "expense"),
        ("SparkFun", "89.4", "GENERAL_MERCHANDISE", "expense"),
        ("Starbucks", "5.50", "FOOD_AND_DRINK", "expense"),
        ("Touchstone Climbing", "78.5", "PERSONAL_CARE", "expense"),
    ],
)
def test_classify_expense(merchant, amount, pfc, expected):
    txn = Transaction(
        merchant=merchant,
        amount=Decimal(amount),
        pfc_primary=pfc,
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    assert classify_txn(txn) == expected


@pytest.mark.parametrize(
    "desc,pfc,amount,expected",
    [
        ("INTRST PYMNT", "TRANSFER_IN", "-4.22", "income"),
        ("GUSTO PAY 123456", "TRANSFER_OUT", "5850.0", "income"),
        ("DIRECT DEP", None, "2000.0", "income"),
        ("PAYROLL", None, "3000.0", "income"),
    ],
)
def test_classify_income(conn, desc, pfc, amount, expected):
    txn = Transaction(
        raw_description=desc,
        amount=Decimal(amount),
        pfc_primary=pfc,
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    rules = get_category_rules(conn)
    assert resolve_transaction_type(conn, txn, category_rules=rules) == expected


@pytest.mark.parametrize(
    "desc,pfc,amount,expected",
    [
        ("CREDIT CARD 3333 PAYMENT *//", "LOAN_PAYMENTS", "25.0", "transfer"),
        ("AUTOMATIC PAYMENT - THANK", "LOAN_PAYMENTS", "2078.5", "transfer"),
        ("CD DEPOSIT .INITIAL.", "TRANSFER_OUT", "1000.0", "transfer"),
        ("BILT CARD PMT ***********", "RENT_AND_UTILITIES", "3721.28", "transfer"),
    ],
)
def test_classify_transfer(conn, desc, pfc, amount, expected):
    txn = Transaction(
        raw_description=desc,
        amount=Decimal(amount),
        pfc_primary=pfc,
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    rules = get_category_rules(conn)
    assert resolve_transaction_type(conn, txn, category_rules=rules) == expected


@pytest.mark.parametrize(
    "merchant,amount,pfc,processor,expected",
    [
        ("1POINT3ACRE", "88.88", "TRANSFER_OUT", "PayPal", "expense"),
        ("Venmo", "90.0", "TRANSFER_OUT", "Braintree", "expense"),
        (
            "BILT CARD HOUSING ***********",
            "2000.0",
            "RENT_AND_UTILITIES",
            None,
            "expense",
        ),
    ],
)
def test_classify_payment_app_expense(merchant, amount, pfc, processor, expected):
    txn = Transaction(
        merchant=merchant,
        amount=Decimal(amount),
        pfc_primary=pfc,
        payment_processor=processor,
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    assert classify_txn(txn) == expected


@pytest.mark.parametrize(
    "merchant,amount,pfc,processor,expected",
    [
        (
            "A.T. CROSS A.T. 402-935- CREDIT",
            "-28.25",
            "TRANSFER_IN",
            "PayPal",
            "income",
        ),
        ("Venmo", "-90.0", "TRANSFER_IN", "Braintree", "income"),
    ],
)
def test_classify_payment_app_income(merchant, amount, pfc, processor, expected):
    txn = Transaction(
        merchant=merchant,
        amount=Decimal(amount),
        pfc_primary=pfc,
        payment_processor=processor,
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    assert classify_txn(txn) == expected


def test_classify_daycare_override_expense(conn):
    txn = Transaction(
        merchant="Zelle: Veronica (Tia) Daycare",
        amount=Decimal(560),
        pfc_primary="TRANSFER_OUT",
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    rules = get_category_rules(conn)
    assert resolve_transaction_type(conn, txn, category_rules=rules) == "expense"


@pytest.mark.parametrize(
    "desc,pfc,amount,expected",
    [
        ("DEPOSIT@MOBILE", "TRANSFER_IN", "-516.0", "income"),
        ("DEPOSIT@USAA", None, "-100.0", "income"),
    ],
)
def test_classify_mobile_deposit_income(conn, desc, pfc, amount, expected):
    txn = Transaction(
        raw_description=desc,
        amount=Decimal(amount),
        pfc_primary=pfc,
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    rules = get_category_rules(conn)
    assert resolve_transaction_type(conn, txn, category_rules=rules) == expected


def test_classify_honors_type_override(conn):
    txn = Transaction(
        merchant="CREDIT CARD",
        amount=Decimal("25.0"),
        type_override="income",
        date=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    assert resolve_transaction_type(conn, txn) == "income"


@pytest.mark.parametrize(
    "category,expected",
    [
        (["Food and Drink", "Restaurants"], "Restaurants"),
        (["Travel", "Taxi"], "Travel"),
        (["Travel", "Airlines"], "Travel"),
        (["Shops", "Sporting Goods"], "MISC."),
        (["Recreation", "Gyms"], "MISC."),
        (["Payment", "Credit Card"], None),
        (["Transfer", "Debit"], None),
        (["Transfer", "Credit"], None),
        (["Transfer", "Deposit"], None),
        (None, None),
        ([], None),
    ],
)
def test_map_legacy_category(conn, category, expected):
    assert map_legacy_category(conn, category) == expected
