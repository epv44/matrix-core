import json
from decimal import Decimal

import pytest

from finance.categorization.pfc_map import SEED_TYPE_KEYWORDS, mappings_from_constants
from finance.models.dataclasses import TypeRule
from finance.plaid_client.sync import _map_plaid_transaction
from finance.services.categorization import resolve_transaction_type


def load_raw():
    with open("tests/fixtures/sandbox_response.json") as f:
        return json.load(f)


@pytest.fixture
def raw_data():
    return load_raw()


@pytest.fixture
def mappings():
    return mappings_from_constants()


@pytest.fixture
def parsed(raw_data, mappings):
    items = raw_data.get("added", raw_data.get("transactions", []))
    return [
        _map_plaid_transaction(t, mappings=mappings, category_rules=[]) for t in items
    ]


class TestDates:
    def test_all_dates_are_2026(self, parsed):
        for t in parsed:
            assert t.date.year == 2026, f"{t.plaid_transaction_id}: year={t.date.year}"

    def test_dates_range_apr_to_jul(self, parsed):
        months = {t.date.month for t in parsed}
        for m in months:
            assert 4 <= m <= 7, f"Unexpected month: {m}"

    def test_no_utcnow_fallback(self, parsed):
        for t in parsed:
            assert t.date.year == 2026

    def test_some_have_different_months(self, parsed):
        months = {t.date.month for t in parsed}
        assert len(months) > 1, f"All transactions in one month: {months}"


class TestAmounts:
    def test_amount_is_decimal(self, parsed):
        for t in parsed:
            assert isinstance(t.amount, Decimal), (
                f"{t.plaid_transaction_id}: type={type(t.amount)}"
            )

    def test_amounts_match_json(self, parsed, raw_data):
        items = raw_data.get("added", raw_data.get("transactions", []))
        for t, raw in zip(parsed, items):
            expected = Decimal(str(raw["amount"]))
            assert t.amount == expected, (
                f"{t.plaid_transaction_id}: {t.amount} != {expected}"
            )


class TestMerchants:
    def test_merchant_name_populated(self, parsed):
        for t in parsed:
            if t.merchant is None and t.raw_description:
                continue
            assert t.merchant is not None or t.raw_description is not None

    def test_merchant_falls_back_to_name(self, parsed, raw_data):
        items = raw_data.get("added", raw_data.get("transactions", []))
        for t, raw in zip(parsed, items):
            expected = raw.get("merchant_name") or raw.get("name")
            assert t.merchant == expected, (
                f"{t.plaid_transaction_id}: {t.merchant} != {expected}"
            )


class TestPaymentProcessor:
    def test_payment_processor_mapped(self, mappings):
        raw = {
            "transaction_id": "x1",
            "account_id": "a1",
            "amount": 88.88,
            "date": "2026-07-24",
            "payment_meta": {"payment_processor": "PayPal"},
        }
        t = _map_plaid_transaction(raw, mappings=mappings, category_rules=[])
        assert t.payment_processor == "PayPal"

    def test_payment_processor_none_when_absent(self, mappings):
        raw = {
            "transaction_id": "x2",
            "account_id": "a2",
            "amount": 5.0,
            "date": "2026-07-24",
        }
        t = _map_plaid_transaction(raw, mappings=mappings, category_rules=[])
        assert t.payment_processor is None


class TestCategoryMapping:
    def test_sync_no_longer_derives_category(self, parsed):
        for t in parsed:
            assert t.category is None, (
                f"{t.plaid_transaction_id}: sync stored a derived category"
            )

    def test_legacy_no_longer_derives_category(self, parsed, raw_data):
        items = raw_data.get("added", raw_data.get("transactions", []))
        for t, raw in zip(parsed, items):
            pfc = raw.get("personal_finance_category")
            if not pfc:
                legacy = raw.get("category", [])
                if legacy and legacy[0] in ("Food and Drink", "Travel"):
                    assert t.category is None, (
                        f"{t.plaid_transaction_id}: legacy={legacy} stored"
                    )


class TestClassification:
    @pytest.fixture
    def type_rules(self):

        return [
            TypeRule(pattern=p, transaction_type=t, priority=pr)
            for p, t, pr in SEED_TYPE_KEYWORDS
        ]

    def _resolve(self, t, type_rules):

        return resolve_transaction_type(None, t, type_rules=type_rules)

    @pytest.mark.parametrize(
        "name_substring",
        [
            "CREDIT CARD",
            "AUTOMATIC PAYMENT",
        ],
    )
    def test_transfer_patterns(self, parsed, name_substring, type_rules):
        matches = [
            t for t in parsed if t.merchant and name_substring in t.merchant.upper()
        ]
        for t in matches:
            assert self._resolve(t, type_rules) == "transfer", (
                f"{t.plaid_transaction_id}: {t.merchant} -> {self._resolve(t, type_rules)}"
            )

    def test_gusto_is_income(self, parsed, type_rules):
        gustos = [t for t in parsed if t.merchant and "GUSTO" in t.merchant.upper()]
        assert len(gustos) > 0, "No Gusto transactions found"
        for t in gustos:
            assert self._resolve(t, type_rules) == "income", (
                f"{t.plaid_transaction_id}: Gusto -> {self._resolve(t, type_rules)}"
            )

    def test_interest_is_income(self, parsed, type_rules):
        ints = [
            t
            for t in parsed
            if t.raw_description and "INTRST" in t.raw_description.upper()
        ]
        for t in ints:
            assert self._resolve(t, type_rules) == "income", (
                f"{t.plaid_transaction_id}: interest -> {self._resolve(t, type_rules)}"
            )

    def test_cd_deposit_is_transfer(self, parsed, type_rules):
        cds = [
            t
            for t in parsed
            if t.raw_description and "CD DEPOSIT" in t.raw_description.upper()
        ]
        for t in cds:
            assert self._resolve(t, type_rules) == "transfer", (
                f"{t.plaid_transaction_id}: CD -> {self._resolve(t, type_rules)}"
            )
