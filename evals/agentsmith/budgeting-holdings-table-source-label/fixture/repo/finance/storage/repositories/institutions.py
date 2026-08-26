"""Institution persistence projections not covered by the legacy facade."""

from finance.models.dataclasses import Institution
from finance.storage.repository import get_institution_by_name


def list_transaction_accounts(conn, limit: int = 100) -> list[dict]:
    rows = conn.execute(
        """
        SELECT DISTINCT
            transactions.account_id,
            institutions.name AS institution
        FROM transactions
        LEFT JOIN institutions
            ON transactions.institution_id = institutions.id
        WHERE
            transactions.removed = 0
            AND transactions.account_id <> ''
        ORDER BY transactions.account_id
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def find_institution(conn, name: str) -> Institution | None:
    return get_institution_by_name(conn, name)


def count_active_transactions(conn) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM transactions
        WHERE removed = 0
        """
    ).fetchone()
    return int(row["n"])


def delete_connection_data(conn, institution_id: int, item_id: str | None) -> dict:
    """Delete one connection and all exclusively owned local records atomically."""

    counts: dict[str, int] = {}
    try:
        conn.execute("BEGIN")
        _create_unlink_scope(conn, institution_id)
        counts = _unlink_counts(conn)
        _delete_connection_dependents(conn, institution_id, item_id)
        _repair_shared_identities(conn)
        _delete_orphan_identities(conn)
        _delete_orphan_securities(conn)
        conn.execute(
            """
            DELETE FROM institutions
            WHERE id = ?
            """,
            (institution_id,),
        )
        _drop_unlink_scope(conn)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return counts


def _create_unlink_scope(conn, institution_id: int) -> None:
    conn.execute("CREATE TEMP TABLE unlink_accounts (account_id TEXT PRIMARY KEY)")
    conn.execute(
        """
        INSERT INTO unlink_accounts (account_id)
        SELECT account_id
        FROM financial_accounts
        WHERE institution_id = ?
        """,
        (institution_id,),
    )
    conn.execute(
        "CREATE TEMP TABLE unlink_transactions (transaction_id TEXT PRIMARY KEY)"
    )
    conn.execute(
        """
        INSERT INTO unlink_transactions (transaction_id)
        SELECT transactions.plaid_transaction_id
        FROM transactions
        WHERE transactions.institution_id = ?
        """,
        (institution_id,),
    )
    conn.execute(
        """
        CREATE TEMP TABLE unlink_investment_transactions (
            transaction_id TEXT PRIMARY KEY
        )
        """
    )
    conn.execute(
        """
        INSERT INTO unlink_investment_transactions (transaction_id)
        SELECT investment_transactions.plaid_transaction_id
        FROM investment_transactions
        WHERE investment_transactions.account_id IN (
            SELECT unlink_accounts.account_id FROM unlink_accounts
        )
        """
    )
    conn.execute("CREATE TEMP TABLE unlink_earmarks (earmark_id INTEGER PRIMARY KEY)")
    conn.execute(
        """
        INSERT INTO unlink_earmarks (earmark_id)
        SELECT cash_earmarks.id
        FROM cash_earmarks
        WHERE cash_earmarks.account_id IN (
            SELECT unlink_accounts.account_id FROM unlink_accounts
        )
        """
    )
    conn.execute("CREATE TEMP TABLE unlink_goals (goal_id INTEGER PRIMARY KEY)")
    conn.execute(
        """
        INSERT INTO unlink_goals (goal_id)
        SELECT financial_goals.id
        FROM financial_goals
        WHERE financial_goals.source_earmark_id IN (
            SELECT unlink_earmarks.earmark_id FROM unlink_earmarks
        )
        """
    )
    conn.execute(
        "CREATE TEMP TABLE unlink_households (household_account_id TEXT PRIMARY KEY)"
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO unlink_households (household_account_id)
        SELECT household_account_id
        FROM financial_accounts
        WHERE
            institution_id = ?
            AND household_account_id IS NOT NULL
        """,
        (institution_id,),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO unlink_households (household_account_id)
        SELECT original_household_account_id
        FROM financial_accounts
        WHERE
            institution_id = ?
            AND original_household_account_id IS NOT NULL
        """,
        (institution_id,),
    )
    conn.execute("CREATE TEMP TABLE unlink_securities (security_id TEXT PRIMARY KEY)")
    conn.execute(
        """
        INSERT OR IGNORE INTO unlink_securities (security_id)
        SELECT investment_holdings.security_id
        FROM investment_holdings
        WHERE
            investment_holdings.account_id IN (
                SELECT unlink_accounts.account_id FROM unlink_accounts
            )
            AND investment_holdings.security_id IS NOT NULL
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO unlink_securities (security_id)
        SELECT investment_holding_snapshots.security_id
        FROM investment_holding_snapshots
        WHERE
            investment_holding_snapshots.account_id IN (
                SELECT unlink_accounts.account_id FROM unlink_accounts
            )
            AND investment_holding_snapshots.security_id IS NOT NULL
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO unlink_securities (security_id)
        SELECT investment_transactions.security_id
        FROM investment_transactions
        WHERE
            investment_transactions.account_id IN (
                SELECT unlink_accounts.account_id FROM unlink_accounts
            )
            AND investment_transactions.security_id IS NOT NULL
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO unlink_securities (security_id)
        SELECT equity_compensation_events.security_id
        FROM equity_compensation_events
        WHERE
            equity_compensation_events.account_id IN (
                SELECT unlink_accounts.account_id FROM unlink_accounts
            )
            AND equity_compensation_events.security_id IS NOT NULL
        """
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO unlink_securities (security_id)
        SELECT goal_allocations.security_id
        FROM goal_allocations
        WHERE
            goal_allocations.account_id IN (
                SELECT unlink_accounts.account_id FROM unlink_accounts
            )
            AND goal_allocations.security_id IS NOT NULL
        """
    )


def _unlink_counts(conn) -> dict[str, int]:
    return {
        "accounts": conn.execute("SELECT COUNT(*) FROM unlink_accounts").fetchone()[0],
        "transactions": conn.execute(
            "SELECT COUNT(*) FROM unlink_transactions"
        ).fetchone()[0],
        "investment_transactions": conn.execute(
            "SELECT COUNT(*) FROM unlink_investment_transactions"
        ).fetchone()[0],
    }


def _delete_connection_dependents(
    conn, institution_id: int, item_id: str | None
) -> None:
    conn.execute(
        """
        DELETE FROM category_changes
        WHERE transaction_id IN (SELECT transaction_id FROM unlink_transactions)
        """
    )
    conn.execute(
        """
        DELETE FROM transaction_audit_events
        WHERE investment_transaction_id IN (
            SELECT transaction_id FROM unlink_investment_transactions
        )
        """
    )
    conn.execute(
        """
        DELETE FROM equity_compensation_events
        WHERE
            account_id IN (SELECT account_id FROM unlink_accounts)
            OR investment_transaction_id IN (
                SELECT transaction_id FROM unlink_investment_transactions
            )
        """
    )
    conn.execute(
        """
        DELETE FROM goal_allocations
        WHERE
            account_id IN (SELECT account_id FROM unlink_accounts)
            OR goal_id IN (SELECT goal_id FROM unlink_goals)
        """
    )
    conn.execute(
        """
        DELETE FROM financial_goals
        WHERE id IN (SELECT goal_id FROM unlink_goals)
        """
    )
    conn.execute(
        """
        DELETE FROM investment_holdings
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM investment_holding_snapshots
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM cash_account_snapshots
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM portfolio_snapshot_accounts
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM account_preferences
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM account_asset_allocations
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM cash_earmarks
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM portfolio_flow_classifications
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM investment_transactions
        WHERE account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM account_merge_suggestions
        WHERE
            account_id IN (SELECT account_id FROM unlink_accounts)
            OR candidate_account_id IN (SELECT account_id FROM unlink_accounts)
        """
    )
    conn.execute(
        """
        DELETE FROM transactions
        WHERE institution_id = ?
        """,
        (institution_id,),
    )
    conn.execute(
        """
        DELETE FROM connection_sync_history
        WHERE institution_id = ?
        """,
        (institution_id,),
    )
    conn.execute(
        """
        DELETE FROM sync_history
        WHERE institution_id = ?
        """,
        (institution_id,),
    )
    conn.execute(
        """
        DELETE FROM relink_sessions
        WHERE institution_id = ?
        """,
        (institution_id,),
    )
    if item_id:
        conn.execute(
            """
            DELETE FROM webhook_jobs
            WHERE item_id = ?
            """,
            (item_id,),
        )
    conn.execute(
        """
        DELETE FROM financial_accounts
        WHERE institution_id = ?
        """,
        (institution_id,),
    )


def _repair_shared_identities(conn) -> None:
    conn.execute(
        """
        UPDATE financial_accounts AS account
        SET is_authoritative = 1, updated_at = CURRENT_TIMESTAMP
        WHERE
            account.household_account_id IN (
                SELECT household_account_id FROM unlink_households
            )
            AND account.account_id = (
                SELECT MIN(candidate.account_id)
                FROM financial_accounts AS candidate
                WHERE candidate.household_account_id = account.household_account_id
            )
            AND NOT EXISTS (
                SELECT 1
                FROM financial_accounts AS authoritative
                WHERE
                    authoritative.household_account_id = account.household_account_id
                    AND authoritative.is_authoritative = 1
            )
        """
    )


def _delete_orphan_identities(conn) -> None:
    conn.execute(
        """
        DELETE FROM account_owners
        WHERE
            household_account_id IN (
                SELECT household_account_id FROM unlink_households
            )
            AND NOT EXISTS (
                SELECT 1
                FROM financial_accounts
                WHERE
                    financial_accounts.household_account_id
                    = account_owners.household_account_id
            )
        """
    )
    conn.execute(
        """
        DELETE FROM household_accounts
        WHERE
            id IN (SELECT household_account_id FROM unlink_households)
            AND NOT EXISTS (
                SELECT 1
                FROM financial_accounts
                WHERE financial_accounts.household_account_id = household_accounts.id
            )
        """
    )


def _delete_orphan_securities(conn) -> None:
    conn.execute(
        """
        DELETE FROM security_asset_allocations
        WHERE security_id IN (
            SELECT investment_securities.security_id
            FROM investment_securities
            WHERE
                investment_securities.security_id IN (
                    SELECT unlink_securities.security_id FROM unlink_securities
                )
                AND NOT EXISTS (
                    SELECT 1 FROM investment_holdings
                    WHERE investment_holdings.security_id = investment_securities.security_id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM investment_holding_snapshots
                    WHERE investment_holding_snapshots.security_id = investment_securities.security_id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM investment_transactions
                    WHERE investment_transactions.security_id = investment_securities.security_id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM equity_compensation_events
                    WHERE equity_compensation_events.security_id = investment_securities.security_id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM goal_allocations
                    WHERE goal_allocations.security_id = investment_securities.security_id
                )
        )
        """
    )
    conn.execute(
        """
        DELETE FROM investment_securities
        WHERE
            investment_securities.security_id IN (
                SELECT unlink_securities.security_id FROM unlink_securities
            )
            AND NOT EXISTS (
                SELECT 1 FROM investment_holdings
                WHERE investment_holdings.security_id = investment_securities.security_id
            )
            AND NOT EXISTS (
                SELECT 1 FROM investment_holding_snapshots
                WHERE investment_holding_snapshots.security_id = investment_securities.security_id
            )
            AND NOT EXISTS (
                SELECT 1 FROM investment_transactions
                WHERE investment_transactions.security_id = investment_securities.security_id
            )
            AND NOT EXISTS (
                SELECT 1 FROM equity_compensation_events
                WHERE equity_compensation_events.security_id = investment_securities.security_id
            )
            AND NOT EXISTS (
                SELECT 1 FROM goal_allocations
                WHERE goal_allocations.security_id = investment_securities.security_id
            )
        """
    )


def _drop_unlink_scope(conn) -> None:
    conn.execute("DROP TABLE unlink_accounts")
    conn.execute("DROP TABLE unlink_transactions")
    conn.execute("DROP TABLE unlink_investment_transactions")
    conn.execute("DROP TABLE unlink_earmarks")
    conn.execute("DROP TABLE unlink_goals")
    conn.execute("DROP TABLE unlink_households")
    conn.execute("DROP TABLE unlink_securities")
