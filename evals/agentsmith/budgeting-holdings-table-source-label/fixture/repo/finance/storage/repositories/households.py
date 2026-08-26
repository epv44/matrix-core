"""Household account ownership and provider-source reconciliation."""


def list_household_accounts(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            h.id,
            h.display_name,
            GROUP_CONCAT(DISTINCT a.account_id) AS provider_account_ids,
            GROUP_CONCAT(DISTINCT o.user_id) AS owner_user_ids,
            MAX(CASE WHEN a.is_authoritative = 1 THEN a.account_id END)
                AS authoritative_account_id
        FROM household_accounts AS h
        LEFT JOIN financial_accounts AS a ON h.id = a.household_account_id
        LEFT JOIN account_owners AS o ON h.id = o.household_account_id
        GROUP BY h.id, h.display_name
        ORDER BY LOWER(COALESCE(h.display_name, h.id))
        """
    ).fetchall()
    return [
        {
            **dict(row),
            "provider_account_ids": _split(row["provider_account_ids"]),
            "owner_user_ids": _split(row["owner_user_ids"]),
        }
        for row in rows
    ]


def list_household_connections(conn) -> list[dict]:
    """Return connection groups with friendly household-account references."""

    rows = conn.execute(
        """
        SELECT DISTINCT
            institutions.id AS institution_id,
            institutions.connection_uuid AS connection_id,
            institutions.name,
            institutions.institution_name,
            institutions.connection_type,
            institutions.status,
            financial_accounts.household_account_id
        FROM institutions
        LEFT JOIN financial_accounts
            ON institutions.id = financial_accounts.institution_id
        ORDER BY
            LOWER(COALESCE(institutions.institution_name, institutions.name)),
            financial_accounts.household_account_id
        """
    ).fetchall()
    groups: dict[int, dict] = {}
    for row in rows:
        institution_id = int(row["institution_id"])
        group = groups.setdefault(
            institution_id,
            {
                "connection_id": row["connection_id"],
                "name": row["name"],
                "institution_name": row["institution_name"],
                "connection_type": row["connection_type"],
                "status": row["status"],
                "household_account_ids": [],
            },
        )
        household_account_id = row["household_account_id"]
        if household_account_id is not None:
            group["household_account_ids"].append(household_account_id)
    return list(groups.values())


def adopt_existing_household_data(conn, household_id: str, user_id: str) -> None:
    conn.execute(
        """
        INSERT INTO household_scope (singleton, household_id)
        VALUES (1, ?)
        ON CONFLICT (singleton) DO UPDATE SET
            household_id = excluded.household_id,
            updated_at = CURRENT_TIMESTAMP
        """,
        (household_id,),
    )
    conn.execute(
        """
        UPDATE institutions
        SET
            household_id = COALESCE(household_id, ?),
            owner_user_id = COALESCE(owner_user_id, ?)
        """,
        (household_id, user_id),
    )
    conn.execute(
        """
        UPDATE household_accounts
        SET household_id = COALESCE(household_id, ?)
        """,
        (household_id,),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO account_owners (household_account_id, user_id)
        SELECT
            household_account_id,
            ? AS user_id
        FROM financial_accounts
        WHERE household_account_id IS NOT NULL
        """,
        (user_id,),
    )
    conn.commit()


def list_merge_suggestions(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            id,
            account_id,
            candidate_account_id,
            reason,
            status,
            created_at
        FROM account_merge_suggestions
        WHERE status = 'PENDING'
        ORDER BY id
        """
    ).fetchall()
    return [dict(row) for row in rows]


def merge_provider_accounts(
    conn, primary_account_id: str, secondary_account_id: str
) -> None:
    primary = _provider_account(conn, primary_account_id)
    secondary = _provider_account(conn, secondary_account_id)
    primary_household_id = primary["household_account_id"]
    secondary_household_id = secondary["household_account_id"]
    if not primary_household_id or not secondary_household_id:
        raise ValueError("Both provider accounts must have household identities")
    if primary_household_id == secondary_household_id:
        return
    try:
        conn.execute(
            """
            INSERT OR IGNORE INTO account_owners (household_account_id, user_id)
            SELECT
                ? AS household_account_id,
                user_id
            FROM account_owners
            WHERE household_account_id = ?
            """,
            (primary_household_id, secondary_household_id),
        )
        conn.execute(
            """
            UPDATE financial_accounts
            SET
                household_account_id = ?,
                is_authoritative = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE household_account_id = ?
            """,
            (primary_household_id, secondary_household_id),
        )
        conn.execute(
            """
            UPDATE financial_accounts
            SET
                is_authoritative = CASE WHEN account_id = ? THEN 1 ELSE 0 END
            WHERE household_account_id = ?
            """,
            (primary_account_id, primary_household_id),
        )
        conn.execute(
            """
            UPDATE account_merge_suggestions
            SET status = 'MERGED', updated_at = CURRENT_TIMESTAMP
            WHERE
                (account_id = ? AND candidate_account_id = ?)
                OR (account_id = ? AND candidate_account_id = ?)
            """,
            (
                primary_account_id,
                secondary_account_id,
                secondary_account_id,
                primary_account_id,
            ),
        )
    except Exception:
        conn.rollback()
        raise
    conn.commit()


def split_provider_account(conn, account_id: str) -> None:
    account = _provider_account(conn, account_id)
    original = account["original_household_account_id"]
    if not original:
        raise ValueError("Provider account has no original household identity")
    conn.execute(
        """
        UPDATE financial_accounts
        SET
            household_account_id = original_household_account_id,
            is_authoritative = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE account_id = ?
        """,
        (account_id,),
    )
    conn.commit()


def set_account_owners(conn, household_account_id: str, user_ids: list[str]) -> None:
    if not user_ids:
        raise ValueError("An account must have at least one owner")
    conn.execute(
        """
        DELETE FROM account_owners
        WHERE household_account_id = ?
        """,
        (household_account_id,),
    )
    conn.executemany(
        """
        INSERT INTO account_owners (household_account_id, user_id)
        VALUES (?, ?)
        """,
        ((household_account_id, user_id) for user_id in user_ids),
    )
    conn.commit()


def promote_provider_account(conn, household_account_id: str, account_id: str) -> None:
    account = _provider_account(conn, account_id)
    if account["household_account_id"] != household_account_id:
        raise ValueError("Provider account does not belong to this household account")
    conn.execute(
        """
        UPDATE financial_accounts
        SET
            is_authoritative = CASE WHEN account_id = ? THEN 1 ELSE 0 END,
            updated_at = CURRENT_TIMESTAMP
        WHERE household_account_id = ?
        """,
        (account_id, household_account_id),
    )
    conn.commit()


def _provider_account(conn, account_id: str):
    row = conn.execute(
        """
        SELECT
            account_id,
            household_account_id,
            original_household_account_id
        FROM financial_accounts
        WHERE account_id = ?
        """,
        (account_id,),
    ).fetchone()
    if row is None:
        raise ValueError("Provider account not found")
    return row


def _split(value: str | None) -> list[str]:
    return value.split(",") if value else []
