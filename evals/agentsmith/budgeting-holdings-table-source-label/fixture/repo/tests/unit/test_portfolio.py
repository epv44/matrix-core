from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from finance.exceptions import NotFoundError
from finance.models.dataclasses import Institution, Transaction
from finance.services.goals import (
    add_goal_allocation,
    create_goal,
    delete_goal,
    delete_goal_allocation,
    goal_summary,
    list_goals,
    update_goal,
)
from finance.services.investments import (
    refresh_sp500_prices,
    refresh_sp500_prices_if_stale,
)
from finance.services.portfolio import (
    PortfolioFilters,
    add_cash_earmark,
    build_dashboard,
    reconcile_portfolio_flows,
    reset_account_allocations,
    reset_security_allocations,
    set_account_allocations,
    set_account_preferences,
    set_flow_classification,
    set_security_allocations,
    set_security_classification,
)
from finance.storage.connection import get_connection
from finance.storage.repository import upsert_institution, upsert_transaction
from finance.storage.schema import run_migrations


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "portfolio.db"))
    run_migrations(connection)
    upsert_institution(connection, Institution(name="test"))
    yield connection
    connection.close()


def _account(
    conn,
    account_id,
    name,
    account_type="investment",
    subtype="brokerage",
    *,
    is_401k=False,
):
    conn.execute(
        """INSERT INTO financial_accounts
        (account_id, institution_id, name, type, subtype, is_401k, raw_payload)
        VALUES (?, 1, ?, ?, ?, ?, '{}')""",
        (account_id, name, account_type, subtype, int(is_401k)),
    )


def _security(conn, security_id, ticker, name=None, security_type="equity"):
    conn.execute(
        """INSERT INTO investment_securities (security_id, ticker, name, type)
        VALUES (?, ?, ?, ?)""",
        (security_id, ticker, name or ticker, security_type),
    )


def _holding(conn, account_id, security_id, value, cost_basis=None):
    conn.execute(
        """INSERT INTO investment_holdings
        (account_id, security_id, quantity, price, value, cost_basis, raw_payload)
        VALUES (?, ?, 1, ?, ?, ?, '{}')""",
        (account_id, security_id, value, value, cost_basis),
    )


def _holding_snapshot(conn, day, account_id, security_id, value, cost_basis=None):
    conn.execute(
        """INSERT INTO investment_holding_snapshots
        (snapshot_date, account_id, security_id, quantity, price, value, cost_basis, raw_payload)
        VALUES (?, ?, ?, 1, ?, ?, ?, '{}')""",
        (day, account_id, security_id, value, value, cost_basis),
    )


def _cash_snapshot(conn, day, account_id, value):
    conn.execute(
        """INSERT INTO cash_account_snapshots
        (snapshot_date, account_id, balance, asset_subtype, raw_payload)
        VALUES (?, ?, ?, 'savings', '{}')""",
        (day, account_id, value),
    )


def _depository_transaction(conn, txn_id, account_id, day, amount, pfc="TRANSFER_IN"):
    upsert_transaction(
        conn,
        Transaction(
            plaid_transaction_id=txn_id,
            account_id=account_id,
            institution_id=1,
            date=datetime.fromisoformat(day).replace(tzinfo=timezone.utc),
            amount=Decimal(str(amount)),
            merchant="Transfer",
            raw_description="Transfer",
            pfc_primary="TRANSFER_IN",
            pfc_detailed=pfc,
        ),
    )


def _investment_transaction(conn, txn_id, account_id, day, amount, kind, subtype):
    conn.execute(
        """INSERT INTO investment_transactions
        (plaid_transaction_id, account_id, date, type, subtype, amount, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, '{}')""",
        (txn_id, account_id, day, kind, subtype, amount),
    )
    conn.commit()


def test_unknown_security_is_other_until_user_override(conn):
    _account(conn, "brokerage", "Brokerage")
    _security(conn, "mystery", "MYST")
    _holding(conn, "brokerage", "mystery", 100)
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))
    assert dashboard["allocation"] == [
        {"asset_class": "OTHER", "value": 100.0, "percentage": 100.0}
    ]

    set_security_classification(conn, "mystery", "INTERNATIONAL_EQUITY")
    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))
    assert dashboard["allocation"][0]["asset_class"] == "INTERNATIONAL_EQUITY"


@pytest.mark.parametrize(
    ("subtype", "name", "category", "view"),
    (
        ("529", "College", "EDUCATION", "EDUCATION"),
        ("hsa", "Health account", "HEALTH_SAVINGS", "HEALTH_SAVINGS"),
        ("stock plan", "Equity Awards", "EQUITY_COMPENSATION", "TAXABLE"),
        ("ira", "Traditional IRA", "RETIREMENT", "RETIREMENT"),
        ("brokerage", "Brokerage", "BROKERAGE", "TAXABLE"),
    ),
)
def test_account_subtypes_map_to_categories(conn, subtype, name, category, view):
    _account(conn, "target", name, subtype=subtype)
    _cash_snapshot(conn, "2026-08-20", "target", 100)
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))
    account = next(
        row for row in dashboard["filters"]["accounts"] if row["id"] == "target"
    )

    assert account["account_category"] == category
    assert account["category_source"] == "AUTOMATIC"
    assert (
        build_dashboard(conn, PortfolioFilters(range="ALL", view=view))["summary"][
            "current_portfolio_value"
        ]
        == 100
    )


def test_529_balance_is_separate_from_transaction_contributions(conn):
    _account(conn, "college", "Schwab 529 Plan", subtype="529")
    _cash_snapshot(conn, "2026-08-20", "college", 11393.4)
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["contribution_summary"]["education_balance"] == 11393.4
    assert dashboard["contribution_summary"]["education_contributions"] == 0
    assert dashboard["contribution_summary"]["category_balances"] == {
        "EDUCATION": 11393.4
    }
    assert (
        build_dashboard(conn, PortfolioFilters(range="ALL", view="TAXABLE"))["summary"][
            "current_portfolio_value"
        ]
        == 0
    )


def test_manual_account_category_and_balance_allocation_override(conn):
    _account(conn, "mystery", "Provider-specific account", subtype="custom")
    _cash_snapshot(conn, "2026-08-20", "mystery", 100)
    conn.commit()

    automatic = build_dashboard(conn, PortfolioFilters(range="ALL"))
    assert automatic["holdings"][0]["asset_class"] == "OTHER"
    assert "UNCLASSIFIED_ACCOUNT_CATEGORY" in {
        warning["code"] for warning in automatic["data_quality"]["warnings"]
    }

    set_account_preferences(
        conn,
        "mystery",
        account_category="EDUCATION",
        tax_status=None,
        liquidity="ILLIQUID",
    )
    set_account_allocations(
        conn,
        "mystery",
        [
            {"asset_class": "US_EQUITY", "percent": 70},
            {"asset_class": "BONDS", "percent": 30},
        ],
    )
    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["holdings"][0]["account_category"] == "EDUCATION"
    assert dashboard["holdings"][0]["classification_source"] == "USER"
    assert dashboard["allocation"] == [
        {"asset_class": "US_EQUITY", "value": 70.0, "percentage": 70.0},
        {"asset_class": "BONDS", "value": 30.0, "percentage": 30.0},
    ]

    assert reset_account_allocations(conn, "mystery") is True
    assert (
        build_dashboard(conn, PortfolioFilters(range="ALL"))["holdings"][0][
            "asset_class"
        ]
        == "OTHER"
    )


def test_security_holdings_take_precedence_over_account_allocation(conn):
    _account(conn, "brokerage", "Brokerage")
    _security(conn, "vti", "VTI")
    _holding(conn, "brokerage", "vti", 100)
    set_account_allocations(
        conn, "brokerage", [{"asset_class": "BONDS", "percent": 100}]
    )
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["holdings"][0]["security_id"] == "vti"
    assert dashboard["holdings"][0]["asset_class"] == "US_EQUITY"


def test_mixed_security_allocation_is_global_and_splits_current_value(conn):
    _account(conn, "taxable", "Taxable")
    _account(conn, "retirement", "Retirement", subtype="ira")
    _security(
        conn,
        "target-2060",
        "VANGUARD.TARGET.2060",
        "Vanguard Target Retirement 2060",
        "mutual fund",
    )
    _holding(conn, "taxable", "target-2060", 600)
    _holding(conn, "retirement", "target-2060", 400)
    conn.commit()

    set_security_allocations(
        conn,
        "target-2060",
        [
            {"asset_class": "US_EQUITY", "percent": 54},
            {"asset_class": "INTERNATIONAL_EQUITY", "percent": 36},
            {"asset_class": "BONDS", "percent": 10},
        ],
    )

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["allocation"] == [
        {"asset_class": "US_EQUITY", "value": 540.0, "percentage": 54.0},
        {
            "asset_class": "INTERNATIONAL_EQUITY",
            "value": 360.0,
            "percentage": 36.0,
        },
        {"asset_class": "BONDS", "value": 100.0, "percentage": 10.0},
    ]
    assert all(row["classification_source"] == "USER" for row in dashboard["holdings"])
    assert all(row["instrument_type"] == "mutual fund" for row in dashboard["holdings"])
    assert dashboard["holdings"][0]["asset_allocation"] == [
        {"asset_class": "BONDS", "percent": 10.0},
        {"asset_class": "INTERNATIONAL_EQUITY", "percent": 36.0},
        {"asset_class": "US_EQUITY", "percent": 54.0},
    ]

    set_security_allocations(
        conn,
        "target-2060",
        [
            {"asset_class": "US_EQUITY", "percent": 90},
            {"asset_class": "CASH", "percent": 10},
        ],
    )
    without_direct_cash = build_dashboard(
        conn, PortfolioFilters(range="ALL", cash_policy="EXCLUDE_ALL")
    )
    assert without_direct_cash["summary"]["current_portfolio_value"] == 1000
    assert without_direct_cash["allocation"] == [
        {"asset_class": "US_EQUITY", "value": 900.0, "percentage": 90.0},
        {"asset_class": "CASH", "value": 100.0, "percentage": 10.0},
    ]

    assert reset_security_allocations(conn, "target-2060") is True
    reset_dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))
    assert reset_dashboard["allocation"] == [
        {"asset_class": "OTHER", "value": 1000.0, "percentage": 100.0}
    ]


@pytest.mark.parametrize(
    ("allocations", "message"),
    (
        ([{"asset_class": "US_EQUITY", "percent": 90}], "total 100"),
        (
            [
                {"asset_class": "US_EQUITY", "percent": 50},
                {"asset_class": "US_EQUITY", "percent": 50},
            ],
            "unique",
        ),
        ([{"asset_class": "CRYPTO", "percent": 100}], "Unsupported"),
    ),
)
def test_security_allocation_validation(conn, allocations, message):
    _security(conn, "amd", "AMD")
    conn.commit()

    with pytest.raises(ValueError, match=message):
        set_security_allocations(conn, "amd", allocations)


def test_529_balance_is_visible_as_other_not_cash(conn):
    _account(conn, "529", "College", subtype="529")
    _cash_snapshot(conn, "2026-08-11", "529", 11371.04)
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["summary"]["current_portfolio_value"] == 11371.04
    assert dashboard["allocation"][0]["asset_class"] == "OTHER"
    assert dashboard["holdings"][0]["value_source"] == "cash_snapshot"


def test_holdings_precede_same_account_cash_snapshot(conn):
    _account(conn, "brokerage", "Brokerage")
    _security(conn, "vti", "VTI")
    _holding(conn, "brokerage", "vti", 100, 80)
    _cash_snapshot(conn, "2026-08-11", "brokerage", 999)
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["summary"]["current_portfolio_value"] == 100
    assert dashboard["holdings"][0]["value_source"] == "holdings"


def test_401k_and_cash_filters_recalculate_denominator(conn):
    _account(conn, "taxable", "Taxable")
    _account(conn, "retirement", "401k", subtype="401k", is_401k=True)
    _account(conn, "cash", "Savings", "depository", "savings")
    _security(conn, "vti", "VTI")
    _security(conn, "bnd", "BND")
    _holding(conn, "taxable", "vti", 100)
    _holding(conn, "retirement", "bnd", 100)
    _cash_snapshot(conn, "2026-08-11", "cash", 100)
    conn.commit()

    dashboard = build_dashboard(
        conn,
        PortfolioFilters(range="ALL", include_401k=False, cash_policy="EXCLUDE_ALL"),
    )

    assert dashboard["summary"]["current_portfolio_value"] == 100
    assert dashboard["allocation"] == [
        {"asset_class": "US_EQUITY", "value": 100.0, "percentage": 100.0}
    ]


def test_earmarked_cash_can_be_excluded(conn):
    _account(conn, "cash", "Savings", "depository", "savings")
    _cash_snapshot(conn, "2026-08-11", "cash", 1000)
    add_cash_earmark(conn, "cash", "House", 300)

    dashboard = build_dashboard(
        conn,
        PortfolioFilters(range="ALL", cash_policy="EXCLUDE_EARMARKED"),
    )

    assert dashboard["summary"]["current_portfolio_value"] == 700


def test_internal_transfer_is_paired_and_not_a_contribution(conn):
    _account(conn, "checking", "Checking", "depository", "checking")
    _account(conn, "brokerage", "Brokerage")
    _depository_transaction(conn, "out", "checking", "2026-08-10", 1000)
    _investment_transaction(
        conn, "in", "brokerage", "2026-08-11", -1000, "transfer", "deposit"
    )

    events = reconcile_portfolio_flows(conn)
    types = {event["source_id"]: event["flow_type"] for event in events}

    assert types == {"out": "INTERNAL_TRANSFER", "in": "INTERNAL_TRANSFER"}


def test_transfer_chain_changes_destinations_without_creating_savings(conn):
    _account(conn, "checking", "Checking", "depository", "checking")
    _account(conn, "hysa", "HYSA", "depository", "savings")
    _account(conn, "brokerage", "Brokerage")
    _depository_transaction(conn, "checking-out", "checking", "2026-08-01", 1000)
    _depository_transaction(conn, "hysa-in", "hysa", "2026-08-01", -1000)
    _depository_transaction(conn, "hysa-out", "hysa", "2026-08-02", 700)
    _investment_transaction(
        conn, "brokerage-in", "brokerage", "2026-08-02", -700, "transfer", "deposit"
    )

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    summary = dashboard["contribution_summary"]
    assert summary["saved_this_year"] == 0
    assert summary["invested_this_year"] == 700
    assert summary["cash_savings"] == -700
    assert sum(dashboard["contribution_activity"][0]["destinations"].values()) == 0


def test_user_flow_override_survives_reconciliation(conn):
    _account(conn, "brokerage", "Brokerage")
    _investment_transaction(
        conn, "deposit", "brokerage", "2026-08-11", -100, "transfer", "deposit"
    )
    reconcile_portfolio_flows(conn)
    set_flow_classification(conn, "INVESTMENT", "deposit", "IGNORE")

    events = reconcile_portfolio_flows(conn)

    assert events[0]["flow_type"] == "IGNORE"
    assert events[0]["source"] == "USER"


def test_twr_removes_contribution_and_aligns_benchmark(conn):
    _account(conn, "brokerage", "Brokerage")
    _security(conn, "vti", "VTI")
    _holding(conn, "brokerage", "vti", 160, 120)
    _holding_snapshot(conn, "2026-08-07", "brokerage", "vti", 100, 80)
    _holding_snapshot(conn, "2026-08-10", "brokerage", "vti", 160, 120)
    _investment_transaction(
        conn, "deposit", "brokerage", "2026-08-10", -50, "transfer", "contribution"
    )
    conn.execute(
        """INSERT INTO benchmark_prices (benchmark, price_date, adjusted_close)
        VALUES ('SP500_TOTAL_RETURN_PROXY', '2026-08-07', 100),
               ('SP500_TOTAL_RETURN_PROXY', '2026-08-10', 105)"""
    )
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["performance"]["available"] is True
    assert dashboard["performance"]["twr"] == pytest.approx(0.10)
    assert dashboard["performance"]["benchmark_return"] == pytest.approx(0.05)
    assert dashboard["growth_decomposition"]["market_appreciation"] == 10
    assert dashboard["growth_decomposition"]["reconciliation_difference"] == 0


def test_missing_cost_basis_remains_nullable(conn):
    _account(conn, "brokerage", "Brokerage")
    _security(conn, "vti", "VTI")
    _holding(conn, "brokerage", "vti", 100, None)
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["summary"]["cost_basis"] is None
    assert dashboard["holdings"][0]["unrealized_gain"] is None
    assert "MISSING_COST_BASIS" in {
        warning["code"] for warning in dashboard["data_quality"]["warnings"]
    }


def test_modified_dietz_is_used_for_between_snapshot_contribution(conn):
    _account(conn, "brokerage", "Brokerage")
    _security(conn, "vti", "VTI")
    _holding(conn, "brokerage", "vti", 160, 100)
    _holding_snapshot(conn, "2026-01-01", "brokerage", "vti", 100, 100)
    _holding_snapshot(conn, "2026-01-11", "brokerage", "vti", 160, 150)
    _investment_transaction(
        conn, "mid-period", "brokerage", "2026-01-06", -50, "transfer", "deposit"
    )

    performance = build_dashboard(conn, PortfolioFilters(range="ALL"))["performance"]

    assert performance["method"] == "MODIFIED_DIETZ"
    assert performance["is_estimate"] is True
    assert performance["twr"] is None
    assert performance["portfolio_return"] == pytest.approx(0.08)


def test_snapshot_coverage_starts_when_new_zero_holding_account_is_complete(conn):
    _account(conn, "brokerage", "Brokerage")
    _account(conn, "new-529", "New 529", subtype="529")
    _security(conn, "vti", "VTI")
    _holding(conn, "brokerage", "vti", 120)
    for day, value in (("2026-01-01", 100), ("2026-01-02", 110), ("2026-01-03", 120)):
        _holding_snapshot(conn, day, "brokerage", "vti", value)
        conn.execute(
            """INSERT INTO portfolio_snapshot_accounts
                   (snapshot_date, account_id, balance, holdings_count, is_complete)
               VALUES (?, 'brokerage', ?, 1, 1)""",
            (day, value),
        )
    for day in ("2026-01-02", "2026-01-03"):
        _cash_snapshot(conn, day, "new-529", 0)
        conn.execute(
            """INSERT INTO portfolio_snapshot_accounts
                   (snapshot_date, account_id, balance, holdings_count, is_complete)
               VALUES (?, 'new-529', 0, 0, 1)""",
            (day,),
        )
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["performance"]["available"] is True
    assert dashboard["performance"]["coverage_start"] == "2026-01-02"
    assert [row["date"] for row in dashboard["snapshots"]] == [
        "2026-01-02",
        "2026-01-03",
    ]


def test_closed_account_history_remains_without_blocking_later_snapshots(conn):
    _account(conn, "active", "Active")
    _account(conn, "closed", "Closed")
    _security(conn, "vti", "VTI")
    _security(conn, "bnd", "BND")
    _holding(conn, "active", "vti", 120)
    _holding_snapshot(conn, "2026-01-01", "active", "vti", 100)
    _holding_snapshot(conn, "2026-01-01", "closed", "bnd", 50)
    _holding_snapshot(conn, "2026-01-02", "active", "vti", 110)
    _holding_snapshot(conn, "2026-01-03", "active", "vti", 120)
    conn.execute(
        """UPDATE financial_accounts
           SET is_active = 0, inactive_since = '2026-01-02'
           WHERE account_id = 'closed'"""
    )
    for day, account_id, balance, count in (
        ("2026-01-01", "active", 100, 1),
        ("2026-01-01", "closed", 50, 1),
        ("2026-01-02", "active", 110, 1),
        ("2026-01-02", "closed", 0, 0),
        ("2026-01-03", "active", 120, 1),
    ):
        conn.execute(
            """INSERT INTO portfolio_snapshot_accounts
                   (snapshot_date, account_id, balance, holdings_count, is_complete)
               VALUES (?, ?, ?, ?, 1)""",
            (day, account_id, balance, count),
        )
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["summary"]["current_portfolio_value"] == 120
    assert all(row["complete"] for row in dashboard["snapshots"])
    assert [row["date"] for row in dashboard["snapshots"]] == [
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
    ]


def test_goal_allocations_are_partial_and_fund_proportionally_after_decline(conn):
    _account(conn, "cash", "Savings", "depository", "savings")
    _cash_snapshot(conn, "2026-01-01", "cash", 100)
    house = create_goal(conn, "House", "HOUSE_DOWN_PAYMENT", 80)
    emergency = create_goal(conn, "Emergency", "EMERGENCY_FUND", 40)
    add_goal_allocation(conn, house, "ACCOUNT", "cash", 60)
    add_goal_allocation(conn, emergency, "ACCOUNT", "cash", 40)
    with pytest.raises(ValueError, match="cannot exceed"):
        add_goal_allocation(conn, house, "ACCOUNT", "cash", 1)
    _cash_snapshot(conn, "2026-01-02", "cash", 50)
    conn.commit()

    goals = {goal["id"]: goal for goal in list_goals(conn)}
    assert goals[house]["funded_amount"] == pytest.approx(30)
    assert goals[emergency]["funded_amount"] == pytest.approx(20)
    assert goals[house]["underfunded_amount"] == pytest.approx(30)
    dashboard = build_dashboard(
        conn, PortfolioFilters(range="ALL", include_goal_reserved=False)
    )
    assert dashboard["summary"]["current_portfolio_value"] == 0


def test_goals_scope_to_household_and_owner(conn):
    _account(conn, "cash", "Savings", "depository", "savings")
    _cash_snapshot(conn, "2026-01-01", "cash", 200)
    house = create_goal(conn, "House", "HOUSE_DOWN_PAYMENT", 80)
    mine = create_goal(
        conn, "My ring", "OTHER", 50, scope="PERSONAL", owner_user_id="user-a"
    )
    theirs = create_goal(
        conn, "Their trip", "OTHER", 50, scope="PERSONAL", owner_user_id="user-b"
    )

    household = {goal["id"] for goal in list_goals(conn, "HOUSEHOLD")}
    assert {house} <= household
    assert mine not in household
    assert theirs not in household

    mine_ids = {goal["id"] for goal in list_goals(conn, "PERSONAL", "user-a")}
    assert house not in mine_ids
    assert mine in mine_ids
    assert theirs not in mine_ids


def test_personal_goal_is_private_to_its_owner(conn):
    _account(conn, "cash", "Savings", "depository", "savings")
    _cash_snapshot(conn, "2026-01-01", "cash", 200)
    mine = create_goal(
        conn, "My goal", "OTHER", 50, scope="PERSONAL", owner_user_id="user-a"
    )
    with pytest.raises(NotFoundError):
        delete_goal(conn, mine, user_id="user-b")
    with pytest.raises(NotFoundError):
        update_goal(conn, mine, name="Hacked", goal_type="OTHER", user_id="user-b")
    with pytest.raises(NotFoundError):
        add_goal_allocation(conn, mine, "ACCOUNT", "cash", 10, user_id="user-b")

    add_goal_allocation(conn, mine, "ACCOUNT", "cash", 10, user_id="user-a")
    allocation_id = list_goals(conn, "PERSONAL", "user-a")[0]["allocations"][0]["id"]
    with pytest.raises(NotFoundError):
        delete_goal_allocation(conn, allocation_id, user_id="user-b")
    assert delete_goal_allocation(conn, allocation_id, user_id="user-a")


def test_household_goals_are_shared_across_members(conn):
    _account(conn, "cash", "Savings", "depository", "savings")
    _cash_snapshot(conn, "2026-01-01", "cash", 100)
    house = create_goal(conn, "House", "HOUSE_DOWN_PAYMENT", 80)
    add_goal_allocation(conn, house, "ACCOUNT", "cash", 60, user_id="user-a")
    update_goal(
        conn,
        house,
        name="New house",
        goal_type="HOUSE_DOWN_PAYMENT",
        user_id="user-b",
    )
    assert list_goals(conn, "HOUSEHOLD")[0]["name"] == "New house"
    assert delete_goal(conn, house, user_id="user-b")


def test_goal_summary_aggregates_all_scopes(conn):
    _account(conn, "cash", "Savings", "depository", "savings")
    _cash_snapshot(conn, "2026-01-01", "cash", 200)
    create_goal(conn, "Kitchen", "EMERGENCY_FUND", 100)
    create_goal(
        conn, "Boat", "EMERGENCY_FUND", 100, scope="PERSONAL", owner_user_id="user-a"
    )
    create_goal(
        conn, "Car", "EMERGENCY_FUND", 100, scope="PERSONAL", owner_user_id="user-b"
    )

    assert len(goal_summary(conn)["goals"]) == 3
    assert len(goal_summary(conn, "HOUSEHOLD")["goals"]) == 1
    assert len(goal_summary(conn, "PERSONAL", "user-a")["goals"]) == 1
    assert len(goal_summary(conn, "PERSONAL", "user-b")["goals"]) == 1


def test_linked_rsu_vest_is_income_and_contribution_not_market_return(conn):
    _account(conn, "brokerage", "Brokerage")
    _security(conn, "meta", "META")
    _holding(conn, "brokerage", "meta", 170, 170)
    _holding_snapshot(conn, "2026-01-01", "brokerage", "meta", 100, 100)
    _holding_snapshot(conn, "2026-01-02", "brokerage", "meta", 170, 170)
    conn.execute(
        """INSERT INTO equity_compensation_events
               (event_type, event_date, account_id, security_id, shares,
                fair_market_value, gross_income, withholding, net_shares, source)
           VALUES ('RSU_VEST', '2026-01-02', 'brokerage', 'meta', 1,
                   100, 100, 30, 0.7, 'manual')"""
    )
    conn.commit()

    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))

    assert dashboard["growth_decomposition"]["contributions"] == 70
    assert dashboard["growth_decomposition"]["market_appreciation"] == 0
    assert dashboard["performance"]["portfolio_return"] == 0
    assert dashboard["wealth_bridge"]["earned_income"] == 100
    assert dashboard["wealth_bridge"]["spending"] == 30
    assert dashboard["wealth_bridge"]["other_external_flows"] == 0


def test_yfinance_benchmark_refresh_is_cached_idempotently(conn, monkeypatch):
    symbols = []

    class History:
        @staticmethod
        def iterrows():
            return iter(
                [
                    (datetime(2026, 8, 7, tzinfo=timezone.utc), {"Adj Close": 100.0}),
                    (datetime(2026, 8, 10, tzinfo=timezone.utc), {"Adj Close": 105.0}),
                ]
            )

    ticker = SimpleNamespace(history=lambda **_kwargs: History())

    def ticker_for(symbol):
        symbols.append(symbol)
        return ticker

    monkeypatch.setattr(
        "finance.services.investments.yf",
        SimpleNamespace(Ticker=ticker_for),
    )

    assert refresh_sp500_prices(conn, "2026-08-01", "2026-08-12") == 2
    assert refresh_sp500_prices(conn, "2026-08-01", "2026-08-12") == 2
    assert (
        conn.execute("SELECT COUNT(*) AS count FROM benchmark_prices").fetchone()[
            "count"
        ]
        == 2
    )
    assert symbols == ["SPY", "SPY"]
    row = conn.execute(
        "SELECT benchmark, source FROM benchmark_prices LIMIT 1"
    ).fetchone()
    assert dict(row) == {
        "benchmark": "SP500_TOTAL_RETURN_PROXY",
        "source": "yfinance:SPY",
    }


def test_benchmark_refresh_is_throttled_and_forceable(conn, monkeypatch):
    refreshes = []

    def refresh(_conn):
        refreshes.append(True)
        return 3

    monkeypatch.setattr("finance.services.investments.refresh_sp500_prices", refresh)

    assert refresh_sp500_prices_if_stale(conn) == (3, True)
    assert refresh_sp500_prices_if_stale(conn) == (0, False)
    assert refresh_sp500_prices_if_stale(conn, force=True) == (3, True)
    assert refreshes == [True, True]


def test_benchmark_refresh_downloads_only_missing_dates(conn, monkeypatch):
    requested = {}

    class EmptyHistory:
        @staticmethod
        def iterrows():
            return iter([])

    conn.execute(
        """
        INSERT INTO benchmark_prices (
            benchmark,
            price_date,
            adjusted_close,
            source
        )
        VALUES (?, ?, ?, ?)
        """,
        ("SP500_TOTAL_RETURN_PROXY", "2026-08-10", 100.0, "test"),
    )
    conn.commit()
    monkeypatch.setattr(
        "finance.services.investments.yf",
        SimpleNamespace(
            Ticker=lambda _symbol: SimpleNamespace(
                history=lambda **kwargs: requested.update(kwargs) or EmptyHistory()
            )
        ),
    )

    refresh_sp500_prices(conn, end_date="2026-08-15")

    assert requested["start"] == "2026-08-11"
