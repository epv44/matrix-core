from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

import pytest

from finance.api.routers.categories import parse_cap_amount
from finance.models.dataclasses import Institution, Transaction
from finance.services.categorization import (
    assign_category,
    get_all_categories,
    monthly_spreadsheet_data,
    resolve_category_for_transaction,
    resolve_transaction_type,
    yearly_summary,
)
from finance.services.reports import get_income_breakdown
from finance.storage.connection import get_connection
from finance.storage.repository import (
    create_category,
    delete_category_rule,
    ensure_category,
    get_category_id_by_name,
    get_category_rules,
    get_transaction_by_id,
    set_category_cap,
    set_monthly_budget,
    upsert_category_rule,
    upsert_institution,
    upsert_transaction,
)
from finance.storage.schema import SCHEMA_VERSION, get_schema_version, run_migrations


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "test.db"))
    run_migrations(connection)
    yield connection
    connection.close()


def _txn(tid, merchant, amount, day, *, pfc=None, processor=None):
    return Transaction(
        plaid_transaction_id=tid,
        account_id="a1",
        date=datetime(2026, 7, day, tzinfo=timezone.utc),
        amount=Decimal(str(amount)),
        merchant=merchant,
        raw_description=merchant,
        pfc_primary=pfc,
        payment_processor=processor,
    )


def _rule(conn, pattern, category):
    upsert_category_rule(conn, pattern, ensure_category(conn, category))


def test_get_all_categories_has_defaults_and_overrides(conn):
    create_category(conn, "Custom")
    categories = get_all_categories(conn)
    assert "Custom" in categories
    assert "Cat Related" in categories
    assert "Baby" in categories


def test_resolve_category_uses_rule(conn):
    _rule(conn, "UBER", "Transportation")
    txn = _txn("t1", "UBER", 30, 1)
    assert resolve_category_for_transaction(conn, txn) == "Transportation"


def test_resolve_category_uses_seeded_merchant_override(conn):
    txn = _txn("t1", "CHEWY INC", 71.78, 1)
    assert resolve_category_for_transaction(conn, txn) == "Cat Related"


def test_manual_override_wins_over_rule(conn):
    _rule(conn, "UBER", "Transportation")
    rest_id = ensure_category(conn, "Restaurants")
    txn = _txn("t1", "UBER", 30, 1)
    txn.manual_category_id = rest_id
    assert resolve_category_for_transaction(conn, txn) == "Restaurants"


def test_resolve_category_uses_manual_override(conn):
    rest_id = ensure_category(conn, "Restaurants")
    txn = _txn("t1", "RANDOM", 30, 1)
    txn.manual_category_id = rest_id
    assert resolve_category_for_transaction(conn, txn) == "Restaurants"


def test_resolve_category_uses_pfc(conn):
    txn = _txn("t1", "UNITED", 500, 1, pfc="TRAVEL")
    assert resolve_category_for_transaction(conn, txn) == "Travel"


def test_resolve_category_returns_none_when_no_match(conn):
    txn = _txn("t1", "MYSTERY", 30, 1)
    assert resolve_category_for_transaction(conn, txn) is None


def test_assign_category_updates_and_remembers_rule(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    updated = assign_category(conn, "t1", "Transportation", remember=True)
    assert updated is not None
    assert updated.manual_category_id is not None
    assert resolve_category_for_transaction(conn, updated) == "Transportation"
    rules = get_category_rules(conn)
    assert any(r.pattern == "UBER" for r in rules)
    changes = conn.execute(
        "SELECT reason FROM category_changes WHERE transaction_id='t1'"
    ).fetchall()
    assert len(changes) == 1
    assert changes[0]["reason"] == "MANUAL"


def test_assign_category_remember_rule_governs_similar_on_read(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    upsert_transaction(conn, _txn("t2", "UBER", 40, 2))
    assign_category(conn, "t1", "Transportation", remember=True)
    transaction = get_transaction_by_id(conn, "t2")
    assert transaction is not None
    assert resolve_category_for_transaction(conn, transaction) == "Transportation"
    assert transaction.manual_category_id is None


def test_assign_category_blank_name_returns_none(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    assert assign_category(conn, "t1", "   ") is None


def test_category_resolves_on_read_without_stored_value(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    _rule(conn, "UBER", "Transportation")
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.manual_category_id is None
    assert resolve_category_for_transaction(conn, txn) == "Transportation"


def test_dashboard_sheet_matches_rule_resolution(conn):
    upsert_transaction(conn, _txn("t1", "Empire Jiu Jitsu", 100, 1))
    _rule(conn, "Empire Jiu Jitsu", "Self")
    data = monthly_spreadsheet_data(conn, 2026, 7)
    detail = data["detailed"]["Self"][0]
    assert detail["category_internal"] == "Self"
    assert data["transactions"][0]["category"] == "Self"


def test_rule_match_type_merchant_only(conn):
    upsert_category_rule(
        conn, "AMAZON", ensure_category(conn, "MISC."), match_type="MERCHANT"
    )
    txn_desc = _txn("t1", "SOMETHING", 10, 1)
    txn_desc.raw_description = "AMAZON MKTPL*ABC"
    assert resolve_category_for_transaction(conn, txn_desc) is None
    txn_merchant = _txn("t2", "Amazon", 10, 2)
    assert resolve_category_for_transaction(conn, txn_merchant) == "MISC."


def test_rule_soft_delete_disables(conn):
    _rule(conn, "UBER", "Transportation")
    txn = _txn("t1", "UBER", 30, 1)
    assert resolve_category_for_transaction(conn, txn) == "Transportation"
    rules = get_category_rules(conn)
    rule = next(r for r in rules if r.pattern == "UBER")
    assert rule.id is not None
    delete_category_rule(conn, rule.id)
    assert resolve_category_for_transaction(conn, txn) is None
    remaining = [r for r in get_category_rules(conn) if r.pattern == "UBER"]
    assert remaining and not remaining[0].enabled


def test_resolve_and_type_cases(conn):
    cases = [
        (
            _txn("t1", "CHIPOTLE", 18.5, 1, pfc="FOOD_AND_DRINK", processor="PayPal"),
            "Restaurants",
            "expense",
        ),
        (
            _txn("t2", "RENTAL", 1500, 2, pfc="RENT_AND_UTILITIES"),
            "Living Expenses",
            "expense",
        ),
        (
            _txn("t3", "1POINT3ACRE", 88.88, 3, pfc="TRANSFER_OUT", processor="PayPal"),
            "MISC.",
            "expense",
        ),
        (_txn("t4", "DEPOSIT@MOBILE", 516, 4, pfc="TRANSFER_IN"), None, "income"),
        (_txn("t5", "GUSTO PAY", 3000, 5), None, "income"),
        (_txn("t6", "CREDIT CARD 3333", 25, 6, pfc="LOAN_PAYMENTS"), None, "transfer"),
    ]
    for t, cat, ttype in cases:
        resolved_cat = resolve_category_for_transaction(conn, t)
        if cat is not None:
            assert resolved_cat == cat, (
                f"{t.merchant}: category {resolved_cat} != {cat}"
            )
        assert resolve_transaction_type(conn, t) == ttype, (
            f"{t.merchant}: type mismatch"
        )


def test_get_income_breakdown_groups(conn):
    upsert_transaction(conn, _txn("t1", "GUSTO", 100, 1))
    upsert_transaction(conn, _txn("t2", "GUSTO", 50, 2))
    result = get_income_breakdown(conn)
    assert result["total"] == 150.0
    assert result["breakdown"][0]["source"] == "GUSTO"
    assert result["breakdown"][0]["count"] == 2


def test_find_matching_rule_prefers_longest_on_priority_tie(conn):
    _rule(conn, "Amazon", "Home Goods")
    _rule(conn, "AMAZON PRIME VIDEO", "MISC.")
    assert (
        resolve_category_for_transaction(conn, _txn("t1", "Amazon Prime Video", 15, 1))
        == "MISC."
    )
    assert (
        resolve_category_for_transaction(conn, _txn("t2", "Amazon", 15, 2))
        == "Home Goods"
    )


def test_find_matching_rule_priority_dominates_length(conn):
    _rule(conn, "FOOD", "MISC.")
    _rule(conn, "FOOD MART", "Groceries")
    assert (
        resolve_category_for_transaction(conn, _txn("t1", "FOOD MART", 15, 1))
        == "Groceries"
    )
    upsert_category_rule(
        conn, "FOOD", ensure_category(conn, "Restaurants"), priority=200
    )
    assert (
        resolve_category_for_transaction(conn, _txn("t2", "FOOD MART", 15, 2))
        == "Restaurants"
    )


def test_amazon_specific_overrides_resolve_misc(conn):
    _rule(conn, "Amazon", "Home Goods")
    assert (
        resolve_category_for_transaction(conn, _txn("t1", "Amazon Prime", 12, 1))
        == "MISC."
    )
    assert (
        resolve_category_for_transaction(conn, _txn("t2", "Amazon Prime Video", 15, 2))
        == "MISC."
    )
    assert (
        resolve_category_for_transaction(conn, _txn("t3", "Amazon Kindle", 9, 3))
        == "MISC."
    )
    assert (
        resolve_category_for_transaction(conn, _txn("t4", "Amazon Web Services", 40, 4))
        == "MISC."
    )
    assert (
        resolve_category_for_transaction(conn, _txn("t5", "Amazon", 20, 5))
        == "Home Goods"
    )


def test_seeded_specific_overrides_present(conn):
    rules = {
        r.pattern: (r.category, r.priority, r.match_type, r.source)
        for r in get_category_rules(conn)
    }
    assert rules.get("AMAZON PRIME") == ("MISC.", 100, "BOTH", "seed")
    assert rules.get("AMAZON PRIME VIDEO") == ("MISC.", 100, "BOTH", "seed")
    assert rules.get("AMAZON KINDLE") == ("MISC.", 100, "BOTH", "seed")
    assert rules.get("AMAZON WEB SERVICES") == ("MISC.", 100, "BOTH", "seed")


def test_v14_schema_uses_ids_and_derives_on_read(conn):

    inst_id = upsert_institution(conn, Institution(name="usaa"))
    _rule(conn, "Amazon", "Home Goods")
    t = _txn("t1", "Amazon", 10, 1)
    t.institution_id = inst_id
    upsert_transaction(conn, t)
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.institution_id == inst_id
    assert txn.institution == "usaa"
    assert txn.manual_category_id is None
    assert resolve_category_for_transaction(conn, txn) == "Home Goods"


def test_assign_category_without_remember_no_rule(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    assign_category(conn, "t1", "Transportation")
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.manual_category_id is not None
    assert not [r for r in get_category_rules(conn) if r.pattern == "UBER"]
    assert resolve_category_for_transaction(conn, txn) == "Transportation"


def test_rule_replaces_same_pattern(conn):
    _rule(conn, "West Portal Produce Market", "Restaurants")
    _rule(conn, "West Portal Produce Market", "Groceries")
    rules = [
        r for r in get_category_rules(conn) if r.pattern == "West Portal Produce Market"
    ]
    assert len(rules) == 1
    assert rules[0].category == "Groceries"


def test_v15_migration_dedups_duplicate_pattern_rules(conn):
    conn.execute("ALTER TABLE category_rules RENAME TO category_rules_old")
    conn.executescript("""
        CREATE TABLE category_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL,
            match_type TEXT NOT NULL DEFAULT 'BOTH',
            category_id INTEGER NOT NULL,
            priority INTEGER DEFAULT 100,
            source TEXT NOT NULL DEFAULT 'user',
            enabled INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    rest_id = ensure_category(conn, "Restaurants")
    groc_id = ensure_category(conn, "Groceries")
    conn.execute(
        "INSERT INTO category_rules (pattern, match_type, category_id, priority) VALUES ('West Portal Produce Market','BOTH',?,100)",
        (rest_id,),
    )
    conn.execute(
        "INSERT INTO category_rules (pattern, match_type, category_id, priority) VALUES ('West Portal Produce Market','BOTH',?,100)",
        (groc_id,),
    )
    conn.execute("DROP TABLE category_rules_old")
    conn.execute("UPDATE schema_version SET version = 14")
    conn.commit()
    run_migrations(conn)
    assert get_schema_version(conn) == SCHEMA_VERSION
    rules = [
        r for r in get_category_rules(conn) if r.pattern == "West Portal Produce Market"
    ]
    assert len(rules) == 1
    assert rules[0].category == "Groceries"


def test_yearly_summary_rollup(conn):

    def ytxn(tid, day, month, merchant, amount, pfc):
        return Transaction(
            plaid_transaction_id=tid,
            account_id="a1",
            date=datetime(2026, month, day, tzinfo=timezone.utc),
            amount=Decimal(str(amount)),
            merchant=merchant,
            raw_description=merchant,
            pfc_primary=pfc,
        )

    upsert_transaction(conn, ytxn("t1", 1, 7, "REST", 30, "FOOD_AND_DRINK"))
    upsert_transaction(conn, ytxn("t2", 2, 8, "REST", 70, "FOOD_AND_DRINK"))
    upsert_transaction(conn, ytxn("t3", 3, 7, "GAS", 20, "TRANSPORTATION"))
    set_monthly_budget(conn, Decimal(100))

    restaurants_id = get_category_id_by_name(conn, "Restaurants")
    transportation_id = get_category_id_by_name(conn, "Transportation")
    assert restaurants_id is not None
    assert transportation_id is not None
    set_category_cap(conn, restaurants_id, Decimal(500))
    set_category_cap(conn, transportation_id, Decimal(200))
    data = yearly_summary(conn, 2026)
    assert data["year"] == 2026
    cats = {c["name"]: c for c in data["categories"]}
    assert cats["Restaurants"]["monthly"][6] == 30.0
    assert cats["Restaurants"]["monthly"][7] == 70.0
    assert cats["Restaurants"]["total"] == 100.0
    assert cats["Restaurants"]["average"] == round(100 / 12, 2)
    assert cats["Transportation"]["monthly"][6] == 20.0
    assert data["annual"]["expense"][6] == 50.0
    assert data["annual"]["expense"][7] == 70.0
    assert data["annual"]["expense_total"] == 120.0
    assert data["annual"]["budget"] == [100.0] * 12
    assert data["annual"]["net"][6] == 50.0
    assert data["annual"]["net"][7] == 30.0
    assert cats["Restaurants"]["percentage"] == round(100 / 120 * 100, 2)
    assert cats["Restaurants"]["cap"] == 500.0
    assert cats["Transportation"]["cap"] == 200.0
    assert cats["Groceries"]["cap"] is None
    assert data["annual"]["income"] == [0.0] * 12
    assert data["annual"]["income_total"] == 0.0
    assert data["annual"]["net_income"][6] == -50.0
    assert data["annual"]["net_income"][7] == -70.0
    assert data["annual"]["net_income_total"] == -120.0
    assert data["annual"]["net_income_average"] == round(-120 / 12, 2)


def test_parse_cap_amount_sanitizes_and_validates():

    assert parse_cap_amount(None) is None
    assert parse_cap_amount("") is None
    assert parse_cap_amount("  ") is None
    assert parse_cap_amount("3200") == Decimal(3200)
    assert parse_cap_amount("3,200") == Decimal(3200)
    assert parse_cap_amount("$3,200") == Decimal(3200)
    assert parse_cap_amount("$3,200.50") == Decimal("3200.50")
    assert parse_cap_amount(" 3 200 ") == Decimal(3200)
    with pytest.raises(InvalidOperation):
        parse_cap_amount("abc")
    with pytest.raises(InvalidOperation):
        parse_cap_amount("3,20,0x")
