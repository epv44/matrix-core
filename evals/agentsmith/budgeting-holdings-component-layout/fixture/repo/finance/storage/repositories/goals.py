"""Persistence operations for financial goals and asset reservations."""


def list_goal_rows(conn, scope=None, owner_user_id=None) -> list[dict]:
    if scope is None:
        rows = conn.execute(
            """
            SELECT
                id,
                name,
                goal_type,
                target_amount,
                target_date,
                status,
                scope,
                owner_user_id,
                created_at,
                updated_at
            FROM financial_goals
            ORDER BY status, id
            """
        ).fetchall()
    elif owner_user_id is None:
        rows = conn.execute(
            """
            SELECT
                id,
                name,
                goal_type,
                target_amount,
                target_date,
                status,
                scope,
                owner_user_id,
                created_at,
                updated_at
            FROM financial_goals
            WHERE scope = ?
            ORDER BY status, id
            """,
            (scope,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT
                id,
                name,
                goal_type,
                target_amount,
                target_date,
                status,
                scope,
                owner_user_id,
                created_at,
                updated_at
            FROM financial_goals
            WHERE scope = ? AND owner_user_id = ?
            ORDER BY status, id
            """,
            (scope, owner_user_id),
        ).fetchall()
    return [dict(row) for row in rows]


def get_goal(conn, goal_id) -> dict | None:
    row = conn.execute(
        """
        SELECT
            id,
            name,
            goal_type,
            target_amount,
            target_date,
            status,
            scope,
            owner_user_id,
            created_at,
            updated_at
        FROM financial_goals
        WHERE id = ?
        """,
        (goal_id,),
    ).fetchone()
    return dict(row) if row else None


def create_goal_row(
    conn,
    name,
    goal_type,
    target_amount,
    target_date,
    scope,
    owner_user_id,
) -> int:
    cursor = conn.execute(
        """
        INSERT INTO financial_goals
        (name, goal_type, target_amount, target_date, scope, owner_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (name, goal_type, target_amount, target_date, scope, owner_user_id),
    )
    conn.commit()
    return int(cursor.lastrowid)


def update_goal_row(
    conn, goal_id, name, goal_type, target_amount, target_date, status
) -> bool:
    cursor = conn.execute(
        """
        UPDATE financial_goals
        SET
            name = ?, goal_type = ?, target_amount = ?, target_date = ?,
            status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (name, goal_type, target_amount, target_date, status, goal_id),
    )
    conn.commit()
    return cursor.rowcount > 0


def delete_goal_records(conn, goal_id) -> bool:
    goal = conn.execute(
        """
        SELECT source_earmark_id FROM financial_goals
        WHERE id = ?
        """,
        (goal_id,),
    ).fetchone()
    conn.execute(
        """
                 DELETE FROM goal_allocations
                 WHERE goal_id = ?
                 """,
        (goal_id,),
    )
    cursor = conn.execute(
        """
                          DELETE FROM financial_goals
                          WHERE id = ?
                          """,
        (goal_id,),
    )
    if goal and goal["source_earmark_id"] is not None:
        conn.execute(
            """
            DELETE FROM cash_earmarks
            WHERE id = ?
            """,
            (goal["source_earmark_id"],),
        )
    conn.commit()
    return cursor.rowcount > 0


def active_goal_exists(conn, goal_id) -> bool:
    return bool(
        conn.execute(
            """
            SELECT 1 FROM financial_goals
            WHERE id = ? AND status = 'ACTIVE'
            """,
            (goal_id,),
        ).fetchone()
    )


def create_allocation_row(
    conn, goal_id, source_type, account_id, security_id, assigned_amount
) -> int:
    cursor = conn.execute(
        """
        INSERT INTO goal_allocations
        (goal_id, source_type, account_id, security_id, assigned_amount)
        VALUES (?, ?, ?, ?, ?)
        """,
        (goal_id, source_type, account_id, security_id, assigned_amount),
    )
    conn.commit()
    return int(cursor.lastrowid)


def delete_allocation_row(conn, allocation_id) -> bool:
    cursor = conn.execute(
        """
                          DELETE FROM goal_allocations
                          WHERE id = ?
                          """,
        (allocation_id,),
    )
    conn.commit()
    return cursor.rowcount > 0


def get_allocation_goal_id(conn, allocation_id) -> int | None:
    row = conn.execute(
        """
        SELECT goal_id FROM goal_allocations
        WHERE id = ?
        """,
        (allocation_id,),
    ).fetchone()
    return int(row["goal_id"]) if row else None


def list_reserved_source_rows(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            a.source_type,
            a.account_id,
            a.security_id,
            SUM(a.assigned_amount) AS assigned_amount
        FROM goal_allocations AS a
        INNER JOIN financial_goals AS g ON a.goal_id = g.id
        WHERE g.status = 'ACTIVE'
        GROUP BY a.source_type, a.account_id, a.security_id
        """
    )
    return [dict(row) for row in rows]


def list_allocation_rows(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            a.id,
            a.goal_id,
            a.source_type,
            a.account_id,
            a.security_id,
            a.assigned_amount,
            fa.name AS account_name,
            COALESCE(s.ticker, s.name) AS security_name
        FROM goal_allocations AS a
        LEFT JOIN financial_accounts AS fa ON a.account_id = fa.account_id
        LEFT JOIN investment_securities AS s ON a.security_id = s.security_id
        ORDER BY a.id
        """
    )
    return [dict(row) for row in rows]


def get_account_type(conn, account_id) -> str | None:
    row = conn.execute(
        """
        SELECT type FROM financial_accounts
        WHERE account_id = ?
        """,
        (account_id,),
    ).fetchone()
    return str(row["type"]) if row else None


def holding_exists(conn, account_id, security_id=None) -> bool:
    if security_id is None:
        row = conn.execute(
            """
            SELECT 1 FROM investment_holdings
            WHERE account_id = ?
            ORDER BY security_id
            LIMIT 1
            """,
            (account_id,),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT 1 FROM investment_holdings
            WHERE account_id = ? AND security_id = ?
            """,
            (account_id, security_id),
        ).fetchone()
    return bool(row)


def get_holding_value(conn, account_id, security_id) -> float:
    row = conn.execute(
        """
        SELECT value FROM investment_holdings
        WHERE account_id = ? AND security_id = ?
        """,
        (account_id, security_id),
    ).fetchone()
    return float(row["value"] or 0) if row else 0.0


def get_account_value_source(conn, account_id) -> dict | None:
    row = conn.execute(
        """
        SELECT
            raw_payload,
            is_active
        FROM financial_accounts
        WHERE account_id = ?
        """,
        (account_id,),
    ).fetchone()
    return dict(row) if row else None


def get_latest_cash_balance(conn, account_id) -> float | None:
    row = conn.execute(
        """
        SELECT balance FROM cash_account_snapshots
        WHERE account_id = ?
        ORDER BY snapshot_date DESC
        LIMIT 1
        """,
        (account_id,),
    ).fetchone()
    return float(row["balance"]) if row and row["balance"] is not None else None


def get_assigned_amount(conn, source_type, account_id, security_id) -> float:
    row = conn.execute(
        """
        SELECT SUM(a.assigned_amount) AS assigned_amount
        FROM goal_allocations AS a
        INNER JOIN financial_goals AS g ON a.goal_id = g.id
        WHERE
            g.status = 'ACTIVE' AND a.source_type = ? AND a.account_id = ?
            AND ((? IS NULL AND a.security_id IS NULL) OR a.security_id = ?)
        """,
        (source_type, account_id, security_id, security_id),
    ).fetchone()
    return float(row["assigned_amount"] or 0)
