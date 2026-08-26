import pytest
from fastapi import HTTPException

from finance.api.routers.dashboard import (
    SecurityAllocationItem,
    SecurityClassificationUpdate,
    delete_investment_account_allocations,
    delete_investment_classification,
    update_investment_account_allocations,
    update_investment_classification,
)
from finance.storage.connection import get_connection
from finance.storage.repositories.portfolio import (
    list_account_asset_allocations,
    list_security_asset_allocations,
)
from finance.storage.schema import run_migrations


@pytest.fixture
def conn(tmp_path):
    connection = get_connection(str(tmp_path / "investment-api.db"))
    run_migrations(connection)
    connection.execute(
        """
        INSERT INTO institutions (name, plaid_item_id)
        VALUES ('test', 'item-test')
        """
    )
    connection.execute(
        """
        INSERT INTO investment_securities (security_id, ticker, name, type)
        VALUES ('target-2060', 'VANGUARD.TARGET.2060', 'Target 2060', 'mutual fund')
        """
    )
    connection.execute(
        """
        INSERT INTO financial_accounts
        (account_id, institution_id, name, type, subtype, raw_payload)
        VALUES ('balance-only', 1, 'Schwab 529 Plan', 'investment', '529', '{}')
        """
    )
    connection.commit()
    yield connection
    connection.close()


def test_classification_endpoint_replaces_and_resets_mixed_allocation(conn):
    response = update_investment_classification(
        "target-2060",
        SecurityClassificationUpdate(
            allocations=[
                SecurityAllocationItem(asset_class="US_EQUITY", percent=54),
                SecurityAllocationItem(asset_class="INTERNATIONAL_EQUITY", percent=36),
                SecurityAllocationItem(asset_class="BONDS", percent=10),
            ]
        ),
        "sandbox",
        (conn, {}),
    )

    assert response == {"ok": True, "security_id": "target-2060"}
    assert list_security_asset_allocations(conn, "target-2060") == [
        {"asset_class": "BONDS", "allocation_percent": 10, "source": "USER"},
        {
            "asset_class": "INTERNATIONAL_EQUITY",
            "allocation_percent": 36,
            "source": "USER",
        },
        {"asset_class": "US_EQUITY", "allocation_percent": 54, "source": "USER"},
    ]

    assert delete_investment_classification("target-2060", "sandbox", (conn, {})) == {
        "ok": True,
        "security_id": "target-2060",
    }
    assert list_security_asset_allocations(conn, "target-2060") == []


def test_classification_endpoint_keeps_legacy_single_class_contract(conn):
    update_investment_classification(
        "target-2060",
        SecurityClassificationUpdate(asset_class="US_EQUITY"),
        "sandbox",
        (conn, {}),
    )

    assert list_security_asset_allocations(conn, "target-2060") == [
        {
            "asset_class": "US_EQUITY",
            "allocation_percent": 100,
            "source": "USER",
        }
    ]


def test_classification_endpoint_rejects_ambiguous_or_invalid_updates(conn):
    with pytest.raises(HTTPException) as ambiguous:
        update_investment_classification(
            "target-2060",
            SecurityClassificationUpdate(
                asset_class="US_EQUITY",
                allocations=[
                    SecurityAllocationItem(asset_class="US_EQUITY", percent=100)
                ],
            ),
            "sandbox",
            (conn, {}),
        )
    assert ambiguous.value.status_code == 400

    with pytest.raises(HTTPException) as invalid_total:
        update_investment_classification(
            "target-2060",
            SecurityClassificationUpdate(
                allocations=[
                    SecurityAllocationItem(asset_class="US_EQUITY", percent=90)
                ]
            ),
            "sandbox",
            (conn, {}),
        )
    assert invalid_total.value.status_code == 400


def test_account_allocation_endpoint_replaces_and_resets_balance_allocation(conn):
    response = update_investment_account_allocations(
        "balance-only",
        SecurityClassificationUpdate(
            allocations=[
                SecurityAllocationItem(asset_class="US_EQUITY", percent=80),
                SecurityAllocationItem(asset_class="BONDS", percent=20),
            ]
        ),
        "sandbox",
        (conn, {}),
    )

    assert response == {"ok": True, "account_id": "balance-only"}
    assert list_account_asset_allocations(conn, "balance-only") == [
        {"asset_class": "BONDS", "allocation_percent": 20, "source": "USER"},
        {"asset_class": "US_EQUITY", "allocation_percent": 80, "source": "USER"},
    ]
    assert delete_investment_account_allocations(
        "balance-only", "sandbox", (conn, {})
    ) == {"ok": True, "account_id": "balance-only"}
    assert list_account_asset_allocations(conn, "balance-only") == []
