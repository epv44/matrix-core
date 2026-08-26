from finance.models.dataclasses import Institution
from finance.storage.connection import get_connection
from finance.storage.repositories.households import (
    list_household_accounts,
    list_household_connections,
    merge_provider_accounts,
    set_account_owners,
    split_provider_account,
)
from finance.storage.repository import upsert_cash_accounts, upsert_institution
from finance.storage.schema import run_migrations


def test_joint_account_merge_counts_one_source_and_preserves_owners(tmp_path):
    conn = get_connection(str(tmp_path / "household.db"))
    run_migrations(conn)
    first = upsert_institution(
        conn, Institution(name="Fidelity — One", owner_user_id="user-one")
    )
    second = upsert_institution(
        conn, Institution(name="Fidelity — Two", owner_user_id="user-two")
    )
    shared = {
        "name": "Joint Brokerage",
        "type": "investment",
        "subtype": "brokerage",
        "mask": "1234",
        "balances": {"current": 100},
    }
    upsert_cash_accounts(
        conn, first, [{**shared, "account_id": "provider-one"}], "2026-08-12"
    )
    upsert_cash_accounts(
        conn, second, [{**shared, "account_id": "provider-two"}], "2026-08-12"
    )

    merge_provider_accounts(conn, "provider-one", "provider-two")
    account = next(
        item
        for item in list_household_accounts(conn)
        if "provider-one" in item["provider_account_ids"]
    )
    set_account_owners(conn, account["id"], ["user-one", "user-two"])
    account = next(
        item for item in list_household_accounts(conn) if item["id"] == account["id"]
    )
    assert sorted(account["owner_user_ids"]) == ["user-one", "user-two"]
    assert account["authoritative_account_id"] == "provider-one"

    split_provider_account(conn, "provider-two")
    rows = conn.execute(
        "SELECT account_id, is_authoritative FROM financial_accounts ORDER BY account_id"
    ).fetchall()
    assert [dict(row) for row in rows] == [
        {"account_id": "provider-one", "is_authoritative": 1},
        {"account_id": "provider-two", "is_authoritative": 1},
    ]
    conn.close()


def test_persistent_account_id_automatically_selects_one_authoritative_source(
    tmp_path,
):
    conn = get_connection(str(tmp_path / "persistent-account.db"))
    run_migrations(conn)
    first = upsert_institution(conn, Institution(name="Fidelity — One"))
    second = upsert_institution(conn, Institution(name="Fidelity — Two"))
    shared = {
        "persistent_account_id": "stable-provider-account",
        "name": "Joint Brokerage",
        "type": "investment",
        "subtype": "brokerage",
        "mask": "1234",
        "balances": {"current": 100},
    }

    upsert_cash_accounts(
        conn, first, [{**shared, "account_id": "provider-one"}], "2026-08-12"
    )
    upsert_cash_accounts(
        conn, second, [{**shared, "account_id": "provider-two"}], "2026-08-12"
    )

    rows = conn.execute(
        """
        SELECT account_id, household_account_id, is_authoritative
        FROM financial_accounts
        ORDER BY account_id
        """
    ).fetchall()
    assert rows[0]["household_account_id"] == rows[1]["household_account_id"]
    assert [row["is_authoritative"] for row in rows] == [1, 0]
    conn.close()


def test_household_connections_group_named_accounts_and_keep_empty_connections(
    tmp_path,
):
    conn = get_connection(str(tmp_path / "connection-groups.db"))
    run_migrations(conn)
    bilt_id = upsert_institution(
        conn,
        Institution(
            name="bilt",
            institution_name="Bilt",
            connection_uuid="connection-bilt",
            connection_type="DEPOSITORY",
            status="COMPLETE",
        ),
    )
    upsert_institution(
        conn,
        Institution(
            name="steph fidelity",
            institution_name="Fidelity",
            connection_uuid="connection-fidelity",
            connection_type="INVESTMENT",
            status="COMPLETE",
        ),
    )
    upsert_cash_accounts(
        conn,
        bilt_id,
        [
            {
                "account_id": "provider-account",
                "name": "Bilt Palladium Card",
                "type": "credit",
                "subtype": "credit card",
                "balances": {"current": 25},
            }
        ],
        "2026-08-14",
    )

    groups = list_household_connections(conn)
    bilt_account = next(
        account
        for account in list_household_accounts(conn)
        if account["display_name"] == "Bilt Palladium Card"
    )

    assert groups == [
        {
            "connection_id": "connection-bilt",
            "name": "bilt",
            "institution_name": "Bilt",
            "connection_type": "DEPOSITORY",
            "status": "COMPLETE",
            "household_account_ids": [bilt_account["id"]],
        },
        {
            "connection_id": "connection-fidelity",
            "name": "steph fidelity",
            "institution_name": "Fidelity",
            "connection_type": "INVESTMENT",
            "status": "COMPLETE",
            "household_account_ids": [],
        },
    ]
    conn.close()
