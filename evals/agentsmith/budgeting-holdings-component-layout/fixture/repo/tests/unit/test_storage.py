from datetime import datetime, timezone
from decimal import Decimal

import pytest

from finance.models.dataclasses import Institution, Transaction
from finance.storage.connection import get_connection
from finance.storage.repository import (
    count_category_changes,
    count_filtered_transactions,
    count_sync_history,
    create_category,
    delete_category,
    ensure_category,
    filtered_transactions,
    get_all_institutions,
    get_available_months,
    get_category_cap,
    get_category_caps,
    get_category_changes,
    get_category_id_by_name,
    get_category_names,
    get_category_rules,
    get_income_transactions,
    get_institution_id_by_name,
    get_monthly_budget,
    get_setting,
    get_sync_history,
    get_transaction_by_id,
    get_transactions_by_date_range,
    get_type_rules,
    record_category_change,
    record_sync_history,
    replace_institution_transactions,
    set_category_cap,
    set_manual_category,
    set_monthly_budget,
    set_setting,
    set_transaction_ignored,
    set_transaction_type_override,
    update_institution_cursor,
    upsert_category_rule,
    upsert_institution,
    upsert_transaction,
    upsert_type_rule,
)
from finance.storage.schema import SCHEMA_VERSION, get_schema_version, run_migrations


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "test.db"))
    run_migrations(connection)
    yield connection
    connection.close()


def _txn(
    tid,
    merchant,
    amount,
    day,
    *,
    month=7,
    institution_id=None,
    manual_category_id=None,
    type_override=None,
):
    return Transaction(
        plaid_transaction_id=tid,
        account_id="a1",
        institution_id=institution_id,
        date=datetime(2026, month, day, tzinfo=timezone.utc),
        amount=Decimal(str(amount)),
        merchant=merchant,
        raw_description=merchant,
        manual_category_id=manual_category_id,
        type_override=type_override,
    )


def test_schema_initializes_to_latest_version(conn):
    assert get_schema_version(conn) == SCHEMA_VERSION


def test_upsert_institution_returns_id(conn):
    assert upsert_institution(conn, Institution(name="usaa")) > 0


def test_get_all_institutions_sorted(conn):
    upsert_institution(conn, Institution(name="usaa"))
    upsert_institution(conn, Institution(name="chase"))
    names = sorted(i.name for i in get_all_institutions(conn))
    assert names == ["chase", "usaa"]


def test_update_institution_cursor(conn):
    inst_id = upsert_institution(conn, Institution(name="usaa"))
    update_institution_cursor(conn, inst_id, "cursor-1")
    inst = get_all_institutions(conn)[0]
    assert inst.cursor == "cursor-1"
    assert inst.last_successful_sync is not None


def test_upsert_transaction_and_fetch(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.merchant == "UBER"
    assert txn.amount == Decimal(30)


def test_upsert_transaction_updates_existing(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    upsert_transaction(conn, _txn("t1", "LYFT", 40, 1))
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.merchant == "LYFT"
    assert txn.amount == Decimal(40)


def test_replace_institution_transactions_removes_related_audit(conn):
    inst_id = upsert_institution(conn, Institution(name="usaa"))
    upsert_transaction(conn, _txn("old-1", "OLD", 10, 1, institution_id=inst_id))
    conn.execute(
        "INSERT INTO category_changes (transaction_id, reason) VALUES ('old-1', 'MANUAL')"
    )
    conn.commit()
    assert replace_institution_transactions(conn, "usaa") == 1
    assert get_transaction_by_id(conn, "old-1") is None
    assert (
        conn.execute(
            "SELECT COUNT(*) AS n FROM category_changes WHERE transaction_id='old-1'"
        ).fetchone()["n"]
        == 0
    )


def test_upsert_preserves_manual_category_and_type_override(conn):
    rest_id = ensure_category(conn, "Restaurants")
    upsert_transaction(
        conn,
        _txn("t1", "UBER", 30, 1, manual_category_id=rest_id, type_override="EXPENSE"),
    )
    upsert_transaction(conn, _txn("t1", "UBER", 31, 1))
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.manual_category_id == rest_id
    assert txn.type_override == "EXPENSE"


def test_missing_transaction_returns_none(conn):
    assert get_transaction_by_id(conn, "nope") is None


def test_date_range_query(conn):
    upsert_transaction(conn, _txn("t1", "A", 10, 1))
    upsert_transaction(conn, _txn("t2", "B", 20, 20))
    rows = get_transactions_by_date_range(conn, "2026-07-01", "2026-07-10")
    assert [t.plaid_transaction_id for t in rows] == ["t1"]


def test_available_months_desc(conn):
    upsert_transaction(conn, _txn("t1", "A", 10, 1, month=4))
    upsert_transaction(conn, _txn("t2", "B", 20, 1, month=5))
    assert get_available_months(conn) == [(2026, 5), (2026, 4)]


def test_filtered_transactions_by_institution(conn):
    usaa = upsert_institution(conn, Institution(name="usaa"))
    chase = upsert_institution(conn, Institution(name="chase"))
    upsert_transaction(conn, _txn("t1", "A", 10, 1, institution_id=usaa))
    upsert_transaction(conn, _txn("t2", "B", 20, 2, institution_id=chase))
    rows = filtered_transactions(conn, {"institution_id": usaa})
    assert [t.plaid_transaction_id for t in rows] == ["t1"]
    assert rows[0].institution == "usaa"


def test_filtered_transactions_respects_limit_and_order(conn):
    upsert_transaction(conn, _txn("a", "A", 10, 1))
    upsert_transaction(conn, _txn("b", "B", 20, 2))
    rows = filtered_transactions(conn, {"order": "amount DESC", "limit": 1})
    assert [t.plaid_transaction_id for t in rows] == ["b"]
    assert count_filtered_transactions(conn, {}) == 2


def test_filtered_transactions_invalid_order_falls_back(conn):
    upsert_transaction(conn, _txn("a", "A", 10, 1))
    upsert_transaction(conn, _txn("b", "B", 20, 2))
    rows = filtered_transactions(conn, {"order": "amount; DROP TABLE transactions"})
    assert [t.plaid_transaction_id for t in rows] == ["b", "a"]


def test_income_transactions_returns_non_removed(conn):
    upsert_transaction(conn, _txn("t1", "GUSTO", 100, 1))
    upsert_transaction(conn, _txn("t2", "UBER", 30, 2))
    rows = get_income_transactions(conn)
    assert [t.plaid_transaction_id for t in rows] == ["t2", "t1"]


def test_categories_crud(conn):
    create_category(conn, "Restaurants")
    assert "Restaurants" in get_category_names(conn)
    delete_category(conn, "Restaurants")
    assert "Restaurants" not in get_category_names(conn)


def test_category_rules_upsert(conn):
    cid = ensure_category(conn, "Transportation")
    upsert_category_rule(conn, "UBER", cid)
    rules = get_category_rules(conn)
    uber_rules = [r for r in rules if r.pattern == "UBER"]
    assert len(uber_rules) == 1
    assert uber_rules[0].category == "Transportation"
    assert uber_rules[0].match_type == "BOTH"


def test_type_rules_upsert(conn):
    upsert_type_rule(conn, "DEPOSIT@", "INCOME")
    rules = get_type_rules(conn)
    deposit_rules = [r for r in rules if r.pattern == "DEPOSIT@"]
    assert len(deposit_rules) == 1
    assert deposit_rules[0].transaction_type == "INCOME"


def test_type_override_set_and_clear(conn):
    upsert_transaction(conn, _txn("t1", "CD DEPOSIT", 100, 1))
    updated = set_transaction_type_override(conn, "t1", "INCOME")
    assert updated is not None
    assert updated.type_override == "INCOME"
    cleared = set_transaction_type_override(conn, "t1", None)
    assert cleared is not None
    assert cleared.type_override is None


def test_set_manual_category_writes_audit(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    rest_id = ensure_category(conn, "Restaurants")
    trans_id = ensure_category(conn, "Transportation")
    set_manual_category(conn, "t1", rest_id)
    record_category_change(conn, "t1", None, rest_id, reason="MANUAL")
    set_manual_category(conn, "t1", trans_id)
    record_category_change(conn, "t1", rest_id, trans_id, reason="MANUAL")
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.manual_category_id == trans_id
    changes = get_category_changes(conn, txn_id="t1")
    assert len(changes) == 2
    assert changes[0].old_category == "Restaurants"
    assert changes[0].new_category == "Transportation"
    assert changes[0].reason == "MANUAL"


def test_category_changes_pagination(conn):

    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    rest_id = ensure_category(conn, "Restaurants")
    groc_id = ensure_category(conn, "Groceries")
    for _ in range(5):
        record_category_change(conn, "t1", rest_id, groc_id, reason="MANUAL")
    assert count_category_changes(conn) == 5
    assert count_category_changes(conn, txn_id="t1") == 5
    assert count_category_changes(conn, txn_id="nope") == 0
    first = get_category_changes(conn, limit=2, offset=0)
    second = get_category_changes(conn, limit=2, offset=2)
    assert len(first) == 2
    assert len(second) == 2
    first_id = first[0].id
    first_next_id = first[1].id
    second_id = second[0].id
    assert first_id is not None and first_next_id is not None and second_id is not None
    assert first_id > first_next_id
    assert second_id < first_id
    assert len(get_category_changes(conn, limit=2, offset=4)) == 1
    assert get_category_changes(conn, txn_id="nope") == []


def test_set_transaction_ignored(conn):
    upsert_transaction(conn, _txn("t1", "UBER", 30, 1))
    upsert_transaction(conn, _txn("t2", "LYFT", 40, 2))
    set_transaction_ignored(conn, "t1", True)
    txn = get_transaction_by_id(conn, "t1")
    assert txn is not None
    assert txn.is_ignored is True
    assert [t.plaid_transaction_id for t in filtered_transactions(conn, {})] == ["t2"]
    assert count_filtered_transactions(conn, {}) == 1
    assert [
        t.plaid_transaction_id
        for t in get_transactions_by_date_range(conn, "2026-07-01", "2026-07-31")
    ] == ["t2"]
    assert {
        t.plaid_transaction_id
        for t in get_transactions_by_date_range(
            conn, "2026-07-01", "2026-07-31", include_ignored=True
        )
    } == {"t1", "t2"}


def test_connection_reuses_existing_database(tmp_path):
    db_path = str(tmp_path / "test.db")
    conn = get_connection(db_path)
    run_migrations(conn)
    conn.close()
    conn2 = get_connection(db_path)
    assert get_schema_version(conn2) == SCHEMA_VERSION
    conn2.close()


def test_v24_repairs_v23_account_identity_column(tmp_path):
    conn = get_connection(str(tmp_path / "v23-drift.db"))
    run_migrations(conn)
    institution_id = upsert_institution(conn, Institution(name="fidelity"))
    conn.execute(
        """
        INSERT INTO financial_accounts
        (account_id, institution_id, name, type, raw_payload, household_account_id)
        VALUES ('provider-account', ?, 'Brokerage', 'investment', '{}', 'acct_provider-account')
        """,
        (institution_id,),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO household_accounts (id, display_name)
        VALUES ('acct_provider-account', 'Brokerage')
        """
    )
    conn.execute(
        "ALTER TABLE financial_accounts DROP COLUMN original_household_account_id"
    )
    conn.execute("UPDATE schema_version SET version = 23")
    conn.commit()

    run_migrations(conn)

    columns = {row[1] for row in conn.execute("PRAGMA table_info (financial_accounts)")}
    account = conn.execute(
        """
        SELECT household_account_id, original_household_account_id
        FROM financial_accounts
        WHERE account_id = 'provider-account'
        """
    ).fetchone()
    assert get_schema_version(conn) == SCHEMA_VERSION
    assert "original_household_account_id" in columns
    assert account["household_account_id"] == "acct_provider-account"
    assert account["original_household_account_id"] == "acct_provider-account"
    conn.close()


def test_v24_preserves_existing_original_household_identity(tmp_path):
    conn = get_connection(str(tmp_path / "v23-complete.db"))
    run_migrations(conn)
    institution_id = upsert_institution(conn, Institution(name="fidelity"))
    conn.execute(
        """
        INSERT INTO financial_accounts
        (
            account_id, institution_id, name, type, raw_payload,
            household_account_id, original_household_account_id
        )
        VALUES (
            'provider-account', ?, 'Brokerage', 'investment', '{}',
            'merged-household', 'original-household'
        )
        """,
        (institution_id,),
    )
    conn.execute("UPDATE schema_version SET version = 23")
    conn.commit()

    run_migrations(conn)

    original = conn.execute(
        """
        SELECT original_household_account_id
        FROM financial_accounts
        WHERE account_id = 'provider-account'
        """
    ).fetchone()[0]
    assert original == "original-household"
    conn.close()


def test_v25_migrates_single_security_classification_to_full_allocation(tmp_path):
    conn = get_connection(str(tmp_path / "v24-classification.db"))
    run_migrations(conn)
    conn.execute("DROP TABLE security_asset_allocations")
    conn.execute(
        """
        CREATE TABLE security_classifications (
            security_id TEXT PRIMARY KEY,
            asset_class TEXT NOT NULL,
            source TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        INSERT INTO security_classifications (security_id, asset_class, source)
        VALUES ('amd', 'US_EQUITY', 'USER')
        """
    )
    conn.execute("UPDATE schema_version SET version = 24")
    conn.commit()

    run_migrations(conn)

    row = conn.execute(
        """
        SELECT asset_class, allocation_percent, source
        FROM security_asset_allocations
        WHERE security_id = 'amd'
        """
    ).fetchone()
    assert dict(row) == {
        "asset_class": "US_EQUITY",
        "allocation_percent": 100,
        "source": "USER",
    }
    assert (
        conn.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'security_classifications'
            """
        ).fetchone()
        is None
    )
    assert get_schema_version(conn) == SCHEMA_VERSION == 27
    conn.close()


def test_v26_adds_goal_scope_columns(tmp_path):
    conn = get_connection(str(tmp_path / "v25-goals.db"))
    run_migrations(conn)
    conn.execute(
        "INSERT INTO financial_goals (name, goal_type, target_amount) "
        "VALUES ('Old goal', 'EMERGENCY_FUND', 100)"
    )
    conn.execute("DROP INDEX idx_financial_goals_scope_owner")
    conn.execute("ALTER TABLE financial_goals DROP COLUMN scope")
    conn.execute("ALTER TABLE financial_goals DROP COLUMN owner_user_id")
    conn.execute("UPDATE schema_version SET version = 25")
    conn.commit()

    run_migrations(conn)

    columns = {row[1] for row in conn.execute("PRAGMA table_info (financial_goals)")}
    assert "scope" in columns
    assert "owner_user_id" in columns
    goal = conn.execute(
        """
        SELECT scope, owner_user_id
        FROM financial_goals
        WHERE name = 'Old goal'
        """
    ).fetchone()
    assert goal["scope"] == "HOUSEHOLD"
    assert goal["owner_user_id"] is None
    assert get_schema_version(conn) == SCHEMA_VERSION == 27


def test_v27_adds_account_categories_and_balance_allocations(tmp_path):
    conn = get_connection(str(tmp_path / "v26-account-categories.db"))
    run_migrations(conn)
    conn.execute("DROP TABLE account_asset_allocations")
    conn.execute("ALTER TABLE account_preferences DROP COLUMN account_category")
    conn.execute(
        """
        INSERT INTO institutions (name, plaid_item_id)
        VALUES ('migration-test', 'migration-item')
        """
    )
    conn.execute(
        """
        INSERT INTO financial_accounts
        (account_id, institution_id, name, type, subtype, raw_payload)
        VALUES ('legacy-retirement', 1, 'Legacy retirement', 'investment', 'ira', '{}')
        """
    )
    conn.execute(
        """
        INSERT INTO account_preferences
        (account_id, tax_status, include_by_default)
        VALUES ('legacy-retirement', 'RETIREMENT', 1)
        """
    )
    conn.execute("UPDATE schema_version SET version = 26")
    conn.commit()

    run_migrations(conn)

    preference_columns = {
        row[1] for row in conn.execute("PRAGMA table_info (account_preferences)")
    }
    assert "account_category" in preference_columns
    migrated_preference = conn.execute(
        """
        SELECT account_category
        FROM account_preferences
        WHERE account_id = 'legacy-retirement'
        """
    ).fetchone()
    assert migrated_preference["account_category"] == "RETIREMENT"
    assert (
        conn.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'account_asset_allocations'
            """
        ).fetchone()
        is not None
    )
    assert get_schema_version(conn) == SCHEMA_VERSION == 27
    conn.close()


def test_record_sync_history_returns_id(conn):
    inst_id = upsert_institution(conn, Institution(name="usaa"))
    sync_id = record_sync_history(
        conn, "production", inst_id, None, False, "ok", added=3
    )
    assert sync_id > 0


def test_sync_history_scoped_by_env(conn):
    usaa_id = upsert_institution(conn, Institution(name="usaa"))
    chase_id = upsert_institution(conn, Institution(name="chase"))
    record_sync_history(conn, "production", usaa_id, None, False, "ok", added=3)
    record_sync_history(
        conn, "sandbox", chase_id, "2026-01-01", True, "error", error="boom"
    )
    production_rows = get_sync_history(conn, "production")
    assert len(production_rows) == 1
    sandbox_rows = get_sync_history(conn, "sandbox")
    assert sandbox_rows[0]["institution"] == "chase"
    assert sandbox_rows[0]["error"] == "boom"
    assert sandbox_rows[0]["replace"] == 1


def test_sync_history_supports_pagination(conn):
    institution_id = upsert_institution(conn, Institution(name="usaa"))
    for added in range(45):
        record_sync_history(
            conn, "production", institution_id, None, False, "ok", added=added
        )
    record_sync_history(conn, "sandbox", institution_id, None, False, "ok", added=100)

    first_page = get_sync_history(conn, "production", limit=20, offset=0)
    second_page = get_sync_history(conn, "production", limit=20, offset=20)
    third_page = get_sync_history(conn, "production", limit=20, offset=40)

    assert count_sync_history(conn, "production") == 45
    assert count_sync_history(conn, "sandbox") == 1
    assert [row["added"] for row in first_page] == list(range(44, 24, -1))
    assert [row["added"] for row in second_page] == list(range(24, 4, -1))
    assert [row["added"] for row in third_page] == list(range(4, -1, -1))


def test_institution_id_by_name(conn):
    inst_id = upsert_institution(conn, Institution(name="usaa"))
    assert get_institution_id_by_name(conn, "usaa") == inst_id
    assert get_institution_id_by_name(conn, "nope") is None


def test_settings_table_exists(conn):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
    ).fetchone()
    assert row is not None


def test_settings_crud(conn):

    assert get_setting(conn, "monthly_budget") is None
    assert get_monthly_budget(conn) is None
    set_setting(conn, "monthly_budget", "14648.00")
    assert get_setting(conn, "monthly_budget") == "14648.00"
    assert get_monthly_budget(conn) == Decimal("14648.00")
    set_setting(conn, "monthly_budget", "15000.00")
    assert get_setting(conn, "monthly_budget") == "15000.00"
    set_monthly_budget(conn, Decimal(100))
    assert get_monthly_budget(conn) == Decimal(100)


def test_category_caps_crud(conn):

    cid = ensure_category(conn, "Groceries")
    assert get_category_cap(conn, cid) is None
    assert get_category_caps(conn) == {}
    set_category_cap(conn, cid, Decimal("1200.00"))
    assert get_category_cap(conn, cid) == Decimal("1200.00")
    assert get_category_caps(conn) == {cid: Decimal("1200.00")}
    set_category_cap(conn, cid, Decimal("1300.00"))
    assert get_category_cap(conn, cid) == Decimal("1300.00")
    set_category_cap(conn, cid, None)
    assert get_category_cap(conn, cid) is None
    assert get_category_caps(conn) == {}


def test_delete_category_removes_cap(conn):

    cid = create_category(conn, "Pepe")
    set_category_cap(conn, cid, Decimal(400))
    assert get_category_cap(conn, cid) == Decimal(400)
    delete_category(conn, "Pepe")
    assert get_category_id_by_name(conn, "Pepe") is None
    assert get_category_cap(conn, cid) is None
