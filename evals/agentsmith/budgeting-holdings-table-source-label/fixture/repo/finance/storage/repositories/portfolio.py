"""Persistence projections for portfolio reporting and preferences."""

import sqlite3


def _dicts(rows) -> list[dict]:
    return [dict(row) for row in rows]


def list_account_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                a.account_id,
                a.name,
                a.type,
                a.subtype,
                a.tax_status,
                a.is_401k,
                a.is_active,
                a.inactive_since,
                a.raw_payload,
                p.tax_status AS preferred_tax_status,
                p.account_category AS preferred_account_category,
                p.liquidity,
                p.include_by_default,
                p.is_401k AS preferred_is_401k
            FROM financial_accounts AS a
            LEFT JOIN account_preferences AS p ON a.account_id = p.account_id
            """
        ).fetchall()
    )


def list_current_holding_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                h.account_id,
                h.security_id,
                h.quantity,
                h.price,
                h.value,
                h.cost_basis,
                s.ticker,
                s.name AS security_name,
                s.type AS security_type,
                s.subtype AS security_subtype
            FROM investment_holdings AS h
            LEFT JOIN investment_securities AS s
                ON h.security_id = s.security_id
            """
        ).fetchall()
    )


def list_latest_cash_balance_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                s.account_id,
                s.balance
            FROM cash_account_snapshots AS s
            WHERE s.snapshot_date = (
                SELECT MAX(s2.snapshot_date)
                FROM cash_account_snapshots AS s2
                WHERE s2.account_id = s.account_id
            )
            """
        ).fetchall()
    )


def list_security_asset_allocations(conn, security_id) -> list[dict]:
    return _dicts(
        conn.execute(
            """
        SELECT
            asset_class,
            allocation_percent,
            source
        FROM security_asset_allocations
        WHERE security_id = ?
        ORDER BY asset_class
        """,
            (security_id,),
        ).fetchall()
    )


def list_account_asset_allocations(conn, account_id) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                asset_class,
                allocation_percent,
                source
            FROM account_asset_allocations
            WHERE account_id = ?
            ORDER BY asset_class
            """,
            (account_id,),
        ).fetchall()
    )


def get_latest_snapshot_date(conn) -> str | None:
    row = conn.execute(
        """
        SELECT MAX(snapshot_date) AS value
        FROM (
            SELECT snapshot_date FROM investment_holding_snapshots
            UNION ALL
            SELECT snapshot_date FROM cash_account_snapshots
        ) AS snapshot_dates
        """
    ).fetchone()
    return str(row["value"]) if row and row["value"] else None


def list_flow_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                source_type,
                source_id,
                flow_date,
                account_id,
                amount,
                currency,
                transfer_hint,
                flow_type,
                matched_source_type,
                matched_source_id,
                source,
                updated_at
            FROM portfolio_flow_classifications
            """
        )
    )


def list_depository_flow_source_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                t.plaid_transaction_id,
                t.account_id,
                t.date,
                t.amount,
                t.currency,
                t.merchant,
                t.raw_description,
                t.type_override,
                t.pfc_primary,
                t.pfc_detailed
            FROM transactions AS t
            INNER JOIN financial_accounts AS a ON t.account_id = a.account_id
            WHERE t.removed = 0 AND t.pending = 0
            """
        ).fetchall()
    )


def list_investment_flow_source_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                plaid_transaction_id,
                account_id,
                date,
                amount,
                type,
                subtype,
                raw_payload
            FROM investment_transactions
            WHERE amount IS NOT NULL
            """
        ).fetchall()
    )


def upsert_system_flow(conn, event) -> None:
    conn.execute(
        """
        INSERT INTO portfolio_flow_classifications
        (
            source_type, source_id, flow_date, account_id, amount, currency,
            transfer_hint, flow_type,
            matched_source_type, matched_source_id, source
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYSTEM')
        ON CONFLICT (source_type, source_id) DO UPDATE SET
            flow_date = excluded.flow_date, account_id = excluded.account_id,
            amount = excluded.amount, currency = excluded.currency,
            transfer_hint = excluded.transfer_hint, flow_type = excluded.flow_type,
            matched_source_type = excluded.matched_source_type,
            matched_source_id = excluded.matched_source_id, source = 'SYSTEM',
            updated_at = CURRENT_TIMESTAMP
        WHERE portfolio_flow_classifications.source != 'USER'
        """,
        (
            event["source_type"],
            event["source_id"],
            event["date"].isoformat(),
            event["account_id"],
            event["amount"],
            event["currency"],
            int(event["transfer_hint"]),
            event["flow_type"],
            event["matched_source_type"],
            event["matched_source_id"],
        ),
    )


def list_holding_snapshot_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                h.snapshot_date,
                h.account_id,
                h.security_id,
                h.value,
                h.cost_basis,
                h.is_complete,
                s.ticker,
                s.name AS security_name,
                s.type AS security_type,
                s.subtype AS security_subtype
            FROM investment_holding_snapshots AS h
            LEFT JOIN investment_securities AS s
                ON h.security_id = s.security_id
            ORDER BY h.snapshot_date
            """
        ).fetchall()
    )


def list_snapshot_coverage_rows(conn, end_date: str) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                snapshot_date,
                account_id,
                is_complete
            FROM portfolio_snapshot_accounts
            WHERE snapshot_date <= ?
            ORDER BY snapshot_date, account_id
            """,
            (end_date,),
        ).fetchall()
    )


def list_cash_snapshot_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                snapshot_date,
                account_id,
                balance AS value,
                is_complete
            FROM cash_account_snapshots
            ORDER BY snapshot_date
            """
        ).fetchall()
    )


def list_equity_compensation_rows(conn, start_date, end_date) -> list[dict]:
    start_value = start_date.isoformat() if start_date else None
    return _dicts(
        conn.execute(
            """
            SELECT
                event_type,
                event_date,
                account_id,
                security_id,
                shares,
                fair_market_value,
                gross_income,
                withholding,
                net_shares
            FROM equity_compensation_events
            WHERE event_date <= ? AND (? IS NULL OR event_date >= ?)
            ORDER BY event_date, id
            """,
            (end_date.isoformat(), start_value, start_value),
        ).fetchall()
    )


def list_account_sync_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                a.account_id,
                i.last_successful_sync
            FROM institutions AS i
            INNER JOIN financial_accounts AS a ON i.id = a.institution_id
            WHERE i.last_successful_sync IS NOT NULL
            """
        ).fetchall()
    )


def list_cash_earmarks(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                id,
                account_id,
                name,
                amount
            FROM cash_earmarks
            ORDER BY id
            """
        )
    )


def account_exists(conn, account_id) -> bool:
    return bool(
        conn.execute(
            """
            SELECT 1 FROM financial_accounts
            WHERE account_id = ?
            """,
            (account_id,),
        ).fetchone()
    )


def upsert_account_preferences(
    conn,
    account_id,
    tax_status,
    liquidity,
    include_by_default,
    is_401k,
    account_category,
) -> None:
    conn.execute(
        """
        INSERT INTO account_preferences
        (
            account_id, tax_status, liquidity, include_by_default, is_401k,
            account_category
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (account_id) DO UPDATE SET
            tax_status = excluded.tax_status,
            liquidity = excluded.liquidity,
            include_by_default = excluded.include_by_default,
            is_401k = excluded.is_401k,
            account_category = excluded.account_category,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            account_id,
            tax_status,
            liquidity,
            include_by_default,
            is_401k,
            account_category,
        ),
    )
    conn.commit()


def create_cash_earmark_records(conn, account_id, name, amount) -> int:
    cursor = conn.execute(
        """
        INSERT INTO cash_earmarks (account_id, name, amount) VALUES (?, ?, ?)
        """,
        (account_id, name, amount),
    )
    goal_cursor = conn.execute(
        """
        INSERT INTO financial_goals
        (name, goal_type, target_amount, source_earmark_id)
        VALUES (?, 'CASH_RESERVE', ?, ?)
        """,
        (name, amount, cursor.lastrowid),
    )
    conn.execute(
        """
        INSERT INTO goal_allocations
        (goal_id, source_type, account_id, assigned_amount)
        VALUES (?, 'ACCOUNT', ?, ?)
        """,
        (goal_cursor.lastrowid, account_id, amount),
    )
    conn.commit()
    return int(cursor.lastrowid)


def delete_cash_earmark_records(conn, earmark_id) -> bool:
    goal = conn.execute(
        """
        SELECT id FROM financial_goals
        WHERE source_earmark_id = ?
        """,
        (earmark_id,),
    ).fetchone()
    if goal:
        conn.execute(
            """
                     DELETE FROM goal_allocations
                     WHERE goal_id = ?
                     """,
            (goal["id"],),
        )
        conn.execute(
            """
                     DELETE FROM financial_goals
                     WHERE id = ?
                     """,
            (goal["id"],),
        )
    cursor = conn.execute(
        """
                          DELETE FROM cash_earmarks
                          WHERE id = ?
                          """,
        (earmark_id,),
    )
    conn.commit()
    return cursor.rowcount > 0


def list_security_rows(conn) -> list[dict]:
    return _dicts(
        conn.execute(
            """
            SELECT
                s.security_id,
                s.ticker,
                s.name,
                s.type,
                s.subtype
            FROM investment_securities AS s
            ORDER BY COALESCE(s.ticker, s.name)
            """
        ).fetchall()
    )


def security_exists(conn, security_id) -> bool:
    return bool(
        conn.execute(
            """
            SELECT 1 FROM investment_securities
            WHERE security_id = ?
            """,
            (security_id,),
        ).fetchone()
    )


def replace_security_asset_allocations(conn, security_id, allocations) -> None:
    try:
        conn.execute(
            """
            DELETE FROM security_asset_allocations
            WHERE security_id = ?
            """,
            (security_id,),
        )
        conn.executemany(
            """
            INSERT INTO security_asset_allocations (
                security_id,
                asset_class,
                allocation_percent,
                source
            )
            VALUES (?, ?, ?, 'USER')
            """,
            ((security_id, row["asset_class"], row["percent"]) for row in allocations),
        )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise


def delete_security_asset_allocations(conn, security_id) -> bool:
    cursor = conn.execute(
        """
        DELETE FROM security_asset_allocations
        WHERE security_id = ?
        """,
        (security_id,),
    )
    conn.commit()
    return cursor.rowcount > 0


def replace_account_asset_allocations(conn, account_id, allocations) -> None:
    try:
        conn.execute(
            """
            DELETE FROM account_asset_allocations
            WHERE account_id = ?
            """,
            (account_id,),
        )
        conn.executemany(
            """
            INSERT INTO account_asset_allocations (
                account_id,
                asset_class,
                allocation_percent,
                source
            )
            VALUES (?, ?, ?, 'USER')
            """,
            ((account_id, row["asset_class"], row["percent"]) for row in allocations),
        )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise


def delete_account_asset_allocations(conn, account_id) -> bool:
    cursor = conn.execute(
        """
        DELETE FROM account_asset_allocations
        WHERE account_id = ?
        """,
        (account_id,),
    )
    conn.commit()
    return cursor.rowcount > 0


def get_flow_row(conn, source_type, source_id) -> dict | None:
    row = conn.execute(
        """
        SELECT
            source_type,
            source_id,
            flow_date,
            account_id,
            amount,
            currency,
            transfer_hint,
            flow_type,
            matched_source_type,
            matched_source_id,
            source,
            updated_at
        FROM portfolio_flow_classifications
        WHERE source_type = ? AND source_id = ?
        """,
        (source_type, source_id),
    ).fetchone()
    return dict(row) if row else None


def update_flow_classification(conn, source_type, source_id, flow_type) -> None:
    conn.execute(
        """
        UPDATE portfolio_flow_classifications
        SET
            flow_type = ?, source = 'USER',
            matched_source_type = NULL, matched_source_id = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE source_type = ? AND source_id = ?
        """,
        (flow_type, source_type, source_id),
    )
    conn.commit()


def list_benchmark_prices(conn) -> list[tuple[str, float]]:
    rows = conn.execute(
        """
        SELECT
            price_date,
            adjusted_close
        FROM benchmark_prices
        WHERE benchmark = 'SP500_TOTAL_RETURN_PROXY'
        ORDER BY price_date
        """
    )
    return [(row["price_date"], float(row["adjusted_close"])) for row in rows]
