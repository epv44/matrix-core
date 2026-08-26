import pytest

from finance.categorization.pfc_map import (
    SEED_TYPE_KEYWORDS,
    classify_txn,
    map_pfc,
    mappings_from_constants,
)
from finance.config.settings import load_config, resolve_environment, token_label
from finance.models.dataclasses import TypeRule
from finance.plaid_client.auth import get_client, setup_sandbox_institution
from finance.plaid_client.sync import sync_dry_run
from finance.security.token_store import get_token as get_keychain_token
from finance.services.categorization import resolve_transaction_type


@pytest.mark.integration
class TestSandboxSync:
    """Calls real Plaid sandbox. Requires PLAID_CLIENT_ID and PLAID_SANDBOX_SECRET."""

    @pytest.fixture(scope="class")
    @classmethod
    def months(cls):

        config = resolve_environment(load_config(), "sandbox")
        client = get_client(config)
        token = get_keychain_token(
            token_label("sandbox", "usaa_test")
        ) or get_keychain_token("plaid_access_token_usaa_test")
        if token is None:
            token, _ = setup_sandbox_institution(client, "usaa_test", config)
        return sync_dry_run(client, token)

    def test_has_transactions(self, months):
        total = sum(len(v) for v in months.values())
        assert total > 0, "No transactions returned from sandbox"

    def test_multiple_months(self, months):
        assert len(months) > 1, f"All transactions in one month: {list(months.keys())}"

    def test_dates_match_grouping(self, months):
        for (year, month), txns in months.items():
            for t in txns:
                assert t.date.year == year
                assert t.date.month == month

    def test_pfc_mapped_to_category(self, months):
        mappings = mappings_from_constants()
        mapped = 0
        for txns in months.values():
            for t in txns:
                if t.pfc_primary and map_pfc(
                    None, t.pfc_primary, t.pfc_detailed, mappings=mappings
                ):
                    mapped += 1
        assert mapped > 0, "No transactions had PFC mapped to a category"

    def test_uber_is_expense(self, months):
        ubers = [t for txns in months.values() for t in txns if t.merchant == "Uber"]
        assert len(ubers) > 0, "No Uber transactions found"
        for t in ubers:
            assert classify_txn(t) == "expense"

    def test_gusto_is_income(self, months):
        type_rules = [
            TypeRule(pattern=p, transaction_type=t, priority=pr)
            for p, t, pr in SEED_TYPE_KEYWORDS
        ]
        gustos = [
            t
            for txns in months.values()
            for t in txns
            if t.merchant and "GUSTO" in t.merchant.upper()
        ]
        assert len(gustos) > 0, "No Gusto transactions found"
        for t in gustos:
            assert resolve_transaction_type(None, t, type_rules=type_rules) == "income"

    def test_credit_card_is_transfer(self, months):
        ccs = [
            t
            for txns in months.values()
            for t in txns
            if t.merchant and "CREDIT CARD" in t.merchant.upper()
        ]
        assert len(ccs) > 0, "No credit card payments found"
        for t in ccs:
            assert classify_txn(t) == "transfer"
