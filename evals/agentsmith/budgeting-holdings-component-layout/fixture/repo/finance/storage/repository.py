import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from finance.models.dataclasses import (
    CategoryChange,
    CategoryRule,
    Institution,
    Transaction,
    TypeRule,
)
from finance.models.setting_keys import SettingKey

logger = logging.getLogger(__name__)

_TXN_SELECT = """
SELECT
    t.plaid_transaction_id,
    t.account_id,
    t.institution_id,
    i.name AS institution,
    t.date,
    t.amount,
    t.merchant,
    t.raw_description,
    t.manual_category_id,
    t.manual_category_set_at,
    t.type_override,
    t.is_ignored,
    t.pending,
    t.currency,
    t.plaid_category,
    t.plaid_subcategory,
    t.pfc_primary,
    t.pfc_detailed,
    t.payment_processor,
    t.removed,
    t.created_at,
    t.updated_at
FROM transactions AS t
LEFT JOIN institutions AS i
    ON t.institution_id = i.id
"""


def _d(val):
    return str(val) if val is not None else None


def _dt(val):
    if val is None:
        return None
    if hasattr(val, "strftime"):
        return val.strftime("%Y-%m-%d %H:%M:%S")
    return str(val)


def _parse_txn(row) -> Transaction:
    d = dict(row)
    for key in ("date", "manual_category_set_at", "created_at", "updated_at"):
        if isinstance(d.get(key), str):
            d[key] = _parse_datetime(d[key], required=key == "date")
    d["amount"] = _parse_decimal(d.get("amount"))
    for key in ("pending", "removed", "is_ignored"):
        if key in d:
            d[key] = bool(d[key])
    known = {f.name for f in Transaction.__dataclass_fields__.values()}
    filtered = {k: v for k, v in d.items() if k in known}
    return Transaction(**filtered)


def _parse_datetime(value: str, *, required: bool):
    try:
        return datetime.fromisoformat(value.replace(" ", "T"))
    except ValueError:
        return datetime.now(timezone.utc) if required else None


def _parse_decimal(value):
    if isinstance(value, str):
        return Decimal(value)
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    return value


def upsert_institution(conn, inst: Institution) -> int:
    cursor = conn.execute(
        """
        INSERT INTO institutions (
            name, plaid_item_id, cursor, last_successful_sync, token_created_at,
            connection_type, status, superseded_by_item_id, connection_uuid,
            institution_name, plaid_institution_id, household_id, owner_user_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, lower(hex(randomblob(16)))), ?, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET
            plaid_item_id = COALESCE(excluded.plaid_item_id, institutions.plaid_item_id),
            cursor = COALESCE(excluded.cursor, institutions.cursor),
            last_successful_sync = COALESCE(excluded.last_successful_sync, institutions.last_successful_sync),
            token_created_at = COALESCE(excluded.token_created_at, institutions.token_created_at),
            connection_type = COALESCE(excluded.connection_type, institutions.connection_type),
            status = COALESCE(excluded.status, institutions.status),
            superseded_by_item_id = COALESCE(excluded.superseded_by_item_id, institutions.superseded_by_item_id),
            connection_uuid = COALESCE(institutions.connection_uuid, excluded.connection_uuid),
            institution_name = COALESCE(excluded.institution_name, institutions.institution_name),
            plaid_institution_id = COALESCE(excluded.plaid_institution_id, institutions.plaid_institution_id),
            household_id = COALESCE(excluded.household_id, institutions.household_id),
            owner_user_id = COALESCE(excluded.owner_user_id, institutions.owner_user_id),
            updated_at = CURRENT_TIMESTAMP
        RETURNING id
        """,
        (
            inst.name,
            inst.plaid_item_id,
            inst.cursor,
            _dt(inst.last_successful_sync),
            _dt(inst.token_created_at),
            inst.connection_type,
            inst.status,
            inst.superseded_by_item_id,
            inst.connection_uuid,
            inst.institution_name or inst.name,
            inst.plaid_institution_id,
            inst.household_id,
            inst.owner_user_id,
        ),
    )
    row = cursor.fetchone()
    conn.commit()
    return row["id"]


def get_institution_by_name(conn, name: str) -> Institution | None:
    row = conn.execute(
        """
        SELECT
            id,
            name,
            plaid_item_id,
            cursor,
            last_successful_sync,
            token_created_at,
            created_at,
            updated_at,
            connection_type,
            status,
            superseded_by_item_id
            , connection_uuid, institution_name, plaid_institution_id,
            household_id, owner_user_id
        FROM institutions
        WHERE name = ?
        """,
        (name,),
    ).fetchone()
    if row is None:
        return None
    return Institution(**dict(row))


def get_all_institutions(conn) -> list[Institution]:
    rows = conn.execute(
        """
        SELECT
            id,
            name,
            plaid_item_id,
            cursor,
            last_successful_sync,
            token_created_at,
            created_at,
            updated_at,
            connection_type,
            status,
            superseded_by_item_id
            , connection_uuid, institution_name, plaid_institution_id,
            household_id, owner_user_id
        FROM institutions
        ORDER BY LOWER(name)
        """
    ).fetchall()
    return [Institution(**dict(r)) for r in rows]


def get_institution_by_uuid(conn, connection_uuid: str) -> Institution | None:
    row = conn.execute(
        """
        SELECT
            id, name, plaid_item_id, cursor, last_successful_sync,
            token_created_at, created_at, updated_at, connection_type,
            status, superseded_by_item_id, connection_uuid, institution_name,
            plaid_institution_id, household_id, owner_user_id
        FROM institutions
        WHERE connection_uuid = ?
        """,
        (connection_uuid,),
    ).fetchone()
    return Institution(**dict(row)) if row else None


def unique_connection_name(conn, preferred: str, owner_name: str | None = None) -> str:
    base = preferred.strip() or "Plaid connection"
    if get_institution_by_name(conn, base) is None:
        return base
    if owner_name:
        base = f"{base} — {owner_name.strip()}"
        if get_institution_by_name(conn, base) is None:
            return base
    suffix = 2
    while get_institution_by_name(conn, f"{base} {suffix}") is not None:
        suffix += 1
    return f"{base} {suffix}"


def update_connection_status(conn, connection_uuid: str, status: str) -> None:
    conn.execute(
        """
        UPDATE institutions
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE connection_uuid = ?
        """,
        (status, connection_uuid),
    )
    conn.commit()


def get_institution_id_by_name(conn, name: str) -> int | None:
    row = conn.execute(
        """
        SELECT id
        FROM institutions
        WHERE name = ?
        """,
        (name,),
    ).fetchone()
    return row["id"] if row else None


def update_institution_cursor(conn, institution_id: int, cursor: str) -> None:
    conn.execute(
        """
        UPDATE institutions
        SET
            cursor = ?,
            last_successful_sync = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (cursor, _dt(datetime.now(timezone.utc)), institution_id),
    )
    conn.commit()


def update_institution_item_id(conn, institution_id: int, item_id: str) -> None:
    conn.execute(
        """
        UPDATE institutions
        SET
            plaid_item_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE
            id = ?
            AND NOT EXISTS (
                SELECT 1 FROM institutions AS existing
                WHERE existing.plaid_item_id = ? AND existing.id <> ?
            )
        """,
        (item_id, institution_id, item_id, institution_id),
    )
    conn.commit()


def reset_institution_cursor(conn, name: str) -> None:
    conn.execute(
        """
        UPDATE institutions
        SET
            cursor = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE name = ?
        """,
        (name,),
    )
    conn.commit()


def get_institution_name_by_item_id(conn, item_id: str) -> str | None:
    row = conn.execute(
        """
        SELECT name
        FROM institutions
        WHERE plaid_item_id = ?
        """,
        (item_id,),
    ).fetchone()
    return row["name"] if row else None


def delete_transactions_for_institution(conn, name: str) -> int:
    cid = get_institution_id_by_name(conn, name)
    if cid is None:
        return 0
    cursor = conn.execute(
        """
        DELETE FROM transactions
        WHERE institution_id = ?
        """,
        (cid,),
    )
    conn.commit()
    return cursor.rowcount


def replace_institution_transactions(conn, name: str) -> int:
    """Delete an institution's rows and transaction-scoped audit records atomically."""
    institution_id = get_institution_id_by_name(conn, name)
    if institution_id is None:
        return 0
    transaction_ids = conn.execute(
        """
        SELECT plaid_transaction_id
        FROM transactions
        WHERE institution_id = ?
        """,
        (institution_id,),
    ).fetchall()
    ids = [row["plaid_transaction_id"] for row in transaction_ids]
    if ids:
        conn.executemany(
            """
            DELETE FROM category_changes
            WHERE transaction_id = ?
            """,
            ((transaction_id,) for transaction_id in ids),
        )
    cursor = conn.execute(
        """
        DELETE FROM transactions
        WHERE institution_id = ?
        """,
        (institution_id,),
    )
    conn.commit()
    return cursor.rowcount


def create_relink_session(
    conn,
    session_id: str,
    env: str,
    institution_id: int,
    history_date: str,
    days_requested: int,
) -> None:
    conn.execute(
        """
        INSERT INTO relink_sessions (
            id,
            env,
            institution_id,
            history_date,
            days_requested,
            status
        )
        VALUES (?, ?, ?, ?, ?, 'pending')
        """,
        (session_id, env, institution_id, history_date, days_requested),
    )
    conn.commit()


def get_relink_session(conn, session_id: str):
    row = conn.execute(
        """
        SELECT
            id,
            env,
            institution_id,
            history_date,
            days_requested,
            status,
            pending_token_label,
            new_item_id,
            error,
            created_at,
            updated_at
        FROM relink_sessions
        WHERE id = ?
        """,
        (session_id,),
    ).fetchone()
    return dict(row) if row else None


def update_relink_session(conn, session_id: str, **fields) -> None:
    allowed = {"status", "pending_token_label", "new_item_id", "error"}
    values = {key: value for key, value in fields.items() if key in allowed}
    if not values:
        return
    conn.execute(
        """
        UPDATE relink_sessions
        SET
            status = COALESCE(?, status),
            pending_token_label = CASE WHEN ? THEN ? ELSE pending_token_label END,
            new_item_id = CASE WHEN ? THEN ? ELSE new_item_id END,
            error = CASE WHEN ? THEN ? ELSE error END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            values.get("status"),
            "pending_token_label" in values,
            values.get("pending_token_label"),
            "new_item_id" in values,
            values.get("new_item_id"),
            "error" in values,
            values.get("error"),
            session_id,
        ),
    )
    conn.commit()


def enqueue_webhook_job(
    conn,
    delivery_id: str,
    env: str,
    item_id: str,
    webhook_type: str,
    webhook_code: str,
    initial_update_complete: bool | None,
    historical_update_complete: bool | None,
) -> bool:
    cursor = conn.execute(
        """
        INSERT OR IGNORE INTO webhook_jobs
        (
            delivery_id, env, item_id, webhook_type, webhook_code,
            initial_update_complete, historical_update_complete
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            delivery_id,
            env,
            item_id,
            webhook_type,
            webhook_code,
            None if initial_update_complete is None else int(initial_update_complete),
            None
            if historical_update_complete is None
            else int(historical_update_complete),
        ),
    )
    conn.commit()
    return cursor.rowcount == 1


def claim_next_webhook_job(conn):
    row = conn.execute(
        """
        SELECT
            id,
            delivery_id,
            env,
            item_id,
            webhook_type,
            webhook_code,
            initial_update_complete,
            historical_update_complete,
            status,
            attempts,
            last_error,
            created_at,
            updated_at
        FROM webhook_jobs
        WHERE
            status IN ('pending', 'retry')
            AND attempts < 5
        ORDER BY id
        LIMIT 1
        """
    ).fetchone()
    if row is None:
        return None
    conn.execute(
        """
        UPDATE webhook_jobs
        SET
            status = 'processing',
            attempts = attempts + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (row["id"],),
    )
    conn.commit()
    return dict(row)


def finish_webhook_job(conn, job_id: int, error: str | None = None) -> None:
    conn.execute(
        """
        UPDATE webhook_jobs
        SET
            status = CASE
                WHEN ? IS NULL THEN 'done'
                WHEN attempts >= 5 THEN 'failed'
                ELSE 'retry'
            END,
            last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (error, error, job_id),
    )
    conn.commit()


def recover_webhook_jobs(conn) -> None:
    conn.execute(
        """
        UPDATE webhook_jobs
        SET
            status = 'retry',
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'processing'
        """
    )
    conn.commit()


def get_transaction_stats_by_institution(conn) -> dict:
    rows = conn.execute("""
                        SELECT
                            COALESCE(i.name, '') AS institution,
                            COUNT(*) AS count,
                            MIN(t.date) AS min_date,
                            MAX(t.date) AS max_date,
                            COUNT(DISTINCT t.account_id) AS accounts
                        FROM transactions AS t
                        LEFT JOIN institutions AS i
                            ON t.institution_id = i.id
                        WHERE t.removed = 0
                        GROUP BY t.institution_id
                        """).fetchall()
    return {
        r["institution"]: {
            "count": r["count"],
            "min_date": r["min_date"],
            "max_date": r["max_date"],
            "accounts": r["accounts"],
        }
        for r in rows
    }


def record_sync_history(
    conn,
    env: str,
    institution_id: int | None,
    since: str | None,
    replace: bool,
    status: str,
    added: int = 0,
    modified: int = 0,
    removed: int = 0,
    error: str | None = None,
    backfill: bool = False,
) -> int:
    now = _dt(datetime.now(timezone.utc))
    cursor = conn.execute(
        """
        INSERT INTO sync_history (env, institution_id, since, replace, backfill, status, added, modified, removed, error, started_at, finished_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            env,
            institution_id,
            since,
            int(replace),
            int(backfill),
            status,
            added,
            modified,
            removed,
            error,
            now,
            now,
        ),
    )
    conn.commit()
    return cursor.lastrowid


def get_sync_history(conn, env: str, limit: int = 50, offset: int = 0) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            s.id,
            s.env,
            s.institution_id,
            s.since,
            s."replace",
            s.backfill,
            s.status,
            s.added,
            s.modified,
            s.removed,
            s.error,
            s.started_at,
            s.finished_at,
            s.created_at,
            s.updated_at,
            i.name AS institution
        FROM sync_history AS s
        LEFT JOIN institutions AS i
            ON s.institution_id = i.id
        WHERE s.env = ?
        ORDER BY s.id DESC
        LIMIT ?
        OFFSET ?
        """,
        (env, limit, offset),
    ).fetchall()
    return [dict(r) for r in rows]


def count_sync_history(conn, env: str) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*) AS total
        FROM sync_history
        WHERE env = ?
        """,
        (env,),
    ).fetchone()
    return int(row["total"])


def record_connection_sync_history(
    conn,
    institution_id: int,
    connection_type: str,
    status: str,
    since: str | None = None,
    added: int = 0,
    modified: int = 0,
    error: str | None = None,
) -> int:
    """Record a sync for a non-depository connection without changing its cursor."""
    now = _dt(datetime.now(timezone.utc))
    cursor = conn.execute(
        """
        INSERT INTO connection_sync_history
        (institution_id, connection_type, status, since, added, modified, error, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            institution_id,
            connection_type,
            status,
            since,
            added,
            modified,
            error,
            now,
            now,
        ),
    )
    conn.commit()
    return cursor.lastrowid


def get_last_connection_sync(
    conn, institution_id: int, connection_type: str, status: str = "ok"
) -> str | None:
    row = conn.execute(
        """
        SELECT finished_at
        FROM connection_sync_history
        WHERE institution_id = ? AND connection_type = ? AND status = ?
        ORDER BY finished_at DESC, id DESC
        LIMIT 1
        """,
        (institution_id, connection_type, status),
    ).fetchone()
    return row["finished_at"] if row else None


def upsert_transaction(conn, txn: Transaction) -> None:
    conn.execute(
        """
        INSERT INTO transactions (
            plaid_transaction_id,
            account_id,
            institution_id,
            date,
            amount,
            merchant,
            raw_description,
            manual_category_id,
            manual_category_set_at,
            type_override,
            is_ignored,
            pending,
            currency,
            plaid_category,
            plaid_subcategory,
            pfc_primary,
            pfc_detailed,
            payment_processor,
            removed,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (plaid_transaction_id) DO UPDATE
        SET
            account_id = excluded.account_id,
            institution_id = COALESCE(excluded.institution_id, transactions.institution_id),
            date = excluded.date,
            amount = excluded.amount,
            merchant = excluded.merchant,
            raw_description = excluded.raw_description,
            pending = excluded.pending,
            currency = excluded.currency,
            plaid_category = excluded.plaid_category,
            plaid_subcategory = excluded.plaid_subcategory,
            pfc_primary = excluded.pfc_primary,
            pfc_detailed = excluded.pfc_detailed,
            payment_processor = excluded.payment_processor,
            removed = excluded.removed,
            updated_at = CURRENT_TIMESTAMP
        """,
        (
            txn.plaid_transaction_id,
            txn.account_id,
            txn.institution_id,
            _dt(txn.date),
            _d(txn.amount),
            txn.merchant,
            txn.raw_description,
            txn.manual_category_id,
            _dt(txn.manual_category_set_at),
            txn.type_override,
            int(txn.is_ignored),
            int(txn.pending),
            txn.currency,
            txn.plaid_category,
            txn.plaid_subcategory,
            txn.pfc_primary,
            txn.pfc_detailed,
            txn.payment_processor,
            int(txn.removed),
            _dt(txn.updated_at),
        ),
    )
    conn.commit()


def upsert_investment_data(
    conn, institution_id: int, item_id: str | None, data: dict, snapshot_date: str
) -> dict:
    """Atomically persist an authoritative investment response and snapshot."""

    accounts = data.get("accounts", [])
    securities = data.get("securities", [])
    source_holdings = data.get("holdings", [])
    holdings, consolidated_holdings = _normalize_investment_holdings(source_holdings)
    if consolidated_holdings:
        logger.warning(
            "Consolidated %d duplicate investment holding rows from the provider",
            consolidated_holdings,
        )
    transactions = data.get("transactions", [])
    conn.execute("""
                 SAVEPOINT investment_data_sync
                 """)
    try:
        closed_holding_count = _close_missing_accounts(
            conn,
            institution_id,
            "investment",
            {
                account.get("account_id")
                for account in accounts
                if account.get("account_id")
            },
            snapshot_date,
        )
        for account in accounts:
            _upsert_investment_account(
                conn, institution_id, account, snapshot_date, json
            )
        for security in securities:
            _upsert_investment_security(conn, security, json)
        holding_stats = _replace_current_holdings(
            conn, accounts, holdings, snapshot_date, json
        )
        holding_stats["removed"] += closed_holding_count
        added_transactions = _upsert_investment_transactions(
            conn, transactions, item_id, json
        )
        conn.execute("""
                     RELEASE SAVEPOINT investment_data_sync
                     """)
    except Exception:
        conn.execute("""
                     ROLLBACK TO SAVEPOINT investment_data_sync
                     """)
        conn.execute("""
                     RELEASE SAVEPOINT investment_data_sync
                     """)
        raise
    conn.commit()
    return {
        "accounts": len(accounts),
        "securities": len(securities),
        "holdings": len(holdings),
        "source_holdings": len(source_holdings),
        "consolidated_holdings": consolidated_holdings,
        "added": added_transactions,
        "modified": holding_stats["modified"],
        "removed": holding_stats["removed"],
        "transactions": len(transactions),
    }


def _upsert_investment_account(
    conn, institution_id, account, snapshot_date, json_module
) -> None:
    account_id = account.get("account_id")
    if not account_id:
        raise ValueError("Investment response contains an account without an id")
    household_account_id, persistent_account_id, is_authoritative = (
        _household_account_identity(conn, institution_id, account)
    )
    conn.execute(
        """
        INSERT INTO financial_accounts
        (
            account_id, institution_id, name, type, subtype, mask, tax_status,
            is_401k, raw_payload, is_active, inactive_since,
            household_account_id, persistent_account_id,
            original_household_account_id, is_authoritative
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)
        ON CONFLICT (
            account_id) DO UPDATE SET institution_id = excluded.institution_id,
        name = excluded.name, type = excluded.type, subtype = excluded.subtype, mask = excluded.mask,
        tax_status = excluded.tax_status, is_401k = excluded.is_401k, raw_payload = excluded.raw_payload,
        household_account_id = COALESCE(financial_accounts.household_account_id, excluded.household_account_id),
        persistent_account_id = COALESCE(excluded.persistent_account_id, financial_accounts.persistent_account_id),
        original_household_account_id = COALESCE(financial_accounts.original_household_account_id, excluded.original_household_account_id),
        updated_at = CURRENT_TIMESTAMP, is_active = 1, inactive_since = NULL
        """,
        (
            account_id,
            institution_id,
            account.get("name"),
            account.get("type"),
            account.get("subtype"),
            account.get("mask"),
            account.get("tax_status"),
            int(bool(account.get("subtype") == "401k" or account.get("is_401k"))),
            json_module.dumps(account, default=str),
            household_account_id,
            persistent_account_id,
            household_account_id,
            int(is_authoritative),
        ),
    )
    current_balance = (account.get("balances") or {}).get("current")
    if current_balance is not None:
        conn.execute(
            """
            INSERT INTO cash_account_snapshots
            (snapshot_date, account_id, balance, asset_subtype, raw_payload, source, is_complete)
            VALUES (?, ?, ?, ?, ?, 'PLAID', 1)
            ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
                balance = excluded.balance, asset_subtype = excluded.asset_subtype,
                raw_payload = excluded.raw_payload, source = 'PLAID', is_complete = 1
            """,
            (
                snapshot_date,
                account_id,
                current_balance,
                account.get("subtype"),
                json_module.dumps(account, default=str),
            ),
        )


def _upsert_investment_security(conn, security, json_module) -> None:
    if not security.get("security_id"):
        raise ValueError("Investment response contains a security without an id")
    conn.execute(
        """
        INSERT INTO investment_securities
        (security_id, ticker, name, type, subtype, cusip, isin, sedol, currency, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (
            security_id) DO UPDATE SET ticker = excluded.ticker, name = excluded.name,
        type = excluded.type, subtype = excluded.subtype, cusip = excluded.cusip, isin = excluded.isin,
        sedol = excluded.sedol, currency = excluded.currency, raw_payload = excluded.raw_payload,
        updated_at = CURRENT_TIMESTAMP
        """,
        (
            security.get("security_id"),
            security.get("ticker_symbol"),
            security.get("name"),
            security.get("type"),
            security.get("subtype"),
            security.get("cusip"),
            security.get("isin"),
            security.get("sedol"),
            security.get("iso_currency_code"),
            json_module.dumps(security, default=str),
        ),
    )


def _group_investment_holdings(accounts, holdings):
    account_ids = {account.get("account_id") for account in accounts}
    if None in account_ids:
        raise ValueError("Investment response contains an account without an id")
    holdings_by_account: dict[str, list[dict]] = {
        account_id: [] for account_id in account_ids if account_id is not None
    }
    for holding in holdings:
        account_id = holding.get("account_id")
        if account_id not in holdings_by_account or not holding.get("security_id"):
            raise ValueError(
                "Investment holding references an unknown account or security"
            )
        holdings_by_account[account_id].append(holding)
    return holdings_by_account


def _normalize_investment_holdings(holdings: list[dict]) -> tuple[list[dict], int]:
    """Collapse provider duplicates into the ledger's account/security grain."""

    grouped: dict[tuple[str | None, str | None], list[dict]] = {}
    for holding in holdings:
        key = (holding.get("account_id"), holding.get("security_id"))
        grouped.setdefault(key, []).append(holding)

    normalized: list[dict] = []
    consolidated = 0
    for rows in grouped.values():
        unique: list[dict] = []
        fingerprints: set[str] = set()
        for row in rows:
            fingerprint = json.dumps(row, sort_keys=True, default=str)
            if fingerprint not in fingerprints:
                unique.append(row)
                fingerprints.add(fingerprint)
        if len(rows) > 1:
            consolidated += len(rows) - 1
        if len(unique) == 1:
            normalized.append(unique[0])
            continue
        normalized.append(_aggregate_investment_holding_rows(unique))
    return normalized, consolidated


def _aggregate_investment_holding_rows(rows: list[dict]) -> dict:
    combined = dict(rows[0])
    for field in ("quantity", "vested_quantity", "institution_value", "cost_basis"):
        combined[field] = _sum_holding_field(rows, field)
    combined["institution_price"] = _aggregate_holding_price(rows, combined)
    combined["tax_lots"] = _unique_holding_tax_lots(rows)
    combined["source_holdings"] = rows
    return combined


def _sum_holding_field(rows: list[dict], field: str) -> str | None:
    values = [Decimal(str(row[field])) for row in rows if row.get(field) is not None]
    return str(sum(values, Decimal(0))) if values else None


def _aggregate_holding_price(rows: list[dict], combined: dict) -> str | int | None:
    quantities = Decimal(str(combined.get("quantity") or 0))
    combined_value = Decimal(str(combined.get("institution_value") or 0))
    prices = {row.get("institution_price") for row in rows}
    if len(prices) == 1:
        return rows[0].get("institution_price")
    return str(combined_value / quantities) if quantities else None


def _unique_holding_tax_lots(rows: list[dict]) -> list[dict]:
    lots: list[dict] = []
    lot_fingerprints: set[str] = set()
    for row in rows:
        for lot in row.get("tax_lots") or []:
            fingerprint = json.dumps(lot, sort_keys=True, default=str)
            if fingerprint not in lot_fingerprints:
                lots.append(lot)
                lot_fingerprints.add(fingerprint)
    return lots


def _replace_account_holdings(conn, account, current, snapshot_date, json_module):
    account_id = account["account_id"]
    previous = {
        row["security_id"]
        for row in conn.execute(
            """
            SELECT security_id FROM investment_holdings
            WHERE account_id = ?
            """,
            (account_id,),
        )
    }
    current_ids = {holding["security_id"] for holding in current}
    conn.execute(
        """
        DELETE FROM investment_holdings
        WHERE account_id = ?
        """,
        (account_id,),
    )
    conn.execute(
        """
        DELETE FROM investment_holding_snapshots
        WHERE snapshot_date = ? AND account_id = ?
        """,
        (snapshot_date, account_id),
    )
    for holding in current:
        _insert_current_holding(conn, holding, snapshot_date, json_module)
    balance = (account.get("balances") or {}).get("current")
    conn.execute(
        """
        INSERT INTO portfolio_snapshot_accounts
        (snapshot_date, account_id, source, balance, holdings_count, is_complete)
        VALUES (?, ?, 'PLAID', ?, ?, 1)
        ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
            source = 'PLAID', balance = excluded.balance,
            holdings_count = excluded.holdings_count, is_complete = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        (snapshot_date, account_id, balance, len(current)),
    )
    return len(previous & current_ids), len(previous - current_ids)


def _replace_current_holdings(conn, accounts, holdings, snapshot_date, json_module):
    holdings_by_account = _group_investment_holdings(accounts, holdings)
    modified = 0
    removed = 0
    for account in accounts:
        account_id = account["account_id"]
        account_modified, account_removed = _replace_account_holdings(
            conn,
            account,
            holdings_by_account[account_id],
            snapshot_date,
            json_module,
        )
        modified += account_modified
        removed += account_removed
    return {"modified": modified, "removed": removed}


def _close_missing_accounts(
    conn, institution_id, account_type, returned_account_ids, snapshot_date
) -> int:
    rows = conn.execute(
        """
        SELECT account_id
        FROM financial_accounts
        WHERE institution_id = ? AND type = ? AND is_active = 1
        """,
        (institution_id, account_type),
    ).fetchall()
    missing = {
        row["account_id"]
        for row in rows
        if row["account_id"] not in returned_account_ids
    }
    removed_holdings = 0
    for account_id in missing:
        removed_holdings += conn.execute(
            """
            SELECT COUNT(*) AS count
            FROM investment_holdings
            WHERE account_id = ?
            """,
            (account_id,),
        ).fetchone()["count"]
        conn.execute(
            """
            DELETE FROM investment_holdings
            WHERE account_id = ?
            """,
            (account_id,),
        )
        conn.execute(
            """
            DELETE FROM investment_holding_snapshots
            WHERE snapshot_date = ? AND account_id = ?
            """,
            (snapshot_date, account_id),
        )
        conn.execute(
            """
            INSERT INTO portfolio_snapshot_accounts
            (snapshot_date, account_id, source, balance, holdings_count, is_complete)
            VALUES (?, ?, 'PLAID_CLOSED', 0, 0, 1)
            ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
                source = 'PLAID_CLOSED', balance = 0, holdings_count = 0,
                is_complete = 1, updated_at = CURRENT_TIMESTAMP
            """,
            (snapshot_date, account_id),
        )
        conn.execute(
            """
            UPDATE financial_accounts
            SET is_active = 0, inactive_since = ?, updated_at = CURRENT_TIMESTAMP
            WHERE account_id = ?
            """,
            (snapshot_date, account_id),
        )
    return removed_holdings


def _insert_current_holding(conn, holding, snapshot_date, json_module) -> None:
    raw_payload = json_module.dumps(holding, default=str)
    conn.execute(
        """
        INSERT INTO investment_holdings
        (
            account_id, security_id, quantity, vested_quantity, price, value,
            cost_basis, tax_lots, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            holding.get("account_id"),
            holding.get("security_id"),
            holding.get("quantity"),
            holding.get("vested_quantity"),
            holding.get("institution_price"),
            holding.get("institution_value"),
            holding.get("cost_basis"),
            json_module.dumps(holding.get("tax_lots"), default=str),
            raw_payload,
        ),
    )
    conn.execute(
        """
        INSERT INTO investment_holding_snapshots
        (
            snapshot_date, account_id, security_id, quantity, price, value,
            cost_basis, raw_payload, source, is_complete
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PLAID', 1)
        """,
        (
            snapshot_date,
            holding.get("account_id"),
            holding.get("security_id"),
            holding.get("quantity"),
            holding.get("institution_price"),
            holding.get("institution_value"),
            holding.get("cost_basis"),
            raw_payload,
        ),
    )


def _upsert_investment_transactions(conn, transactions, item_id, json_module) -> int:
    added = 0
    for transaction in transactions:
        txn_id = transaction.get("investment_transaction_id") or transaction.get(
            "transaction_id"
        )
        if not txn_id:
            continue
        before = conn.execute(
            """
            SELECT 1 FROM investment_transactions
            WHERE plaid_transaction_id = ?
            """,
            (txn_id,),
        ).fetchone()
        conn.execute(
            """
            INSERT INTO investment_transactions
            (
                plaid_transaction_id,
                account_id,
                security_id,
                date,
                type,
                subtype,
                amount,
                quantity,
                price,
                fees,
                cash_impact,
                classification,
                raw_payload,
                source_item_id,
                reversed_transaction_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (
                plaid_transaction_id) DO UPDATE SET account_id = excluded.account_id,
            security_id = excluded.security_id, date = excluded.date, type = excluded.type, subtype = excluded.subtype,
            amount = excluded.amount, quantity = excluded.quantity, price = excluded.price, fees = excluded.fees,
            cash_impact = excluded.cash_impact, raw_payload = excluded.raw_payload, source_item_id = excluded.source_item_id,
            reversed_transaction_id = excluded.reversed_transaction_id, updated_at = CURRENT_TIMESTAMP
            """,
            (
                txn_id,
                transaction.get("account_id"),
                transaction.get("security_id"),
                transaction.get("date"),
                transaction.get("type"),
                transaction.get("subtype"),
                transaction.get("amount"),
                transaction.get("quantity"),
                transaction.get("price"),
                transaction.get("fees"),
                transaction.get("amount"),
                transaction.get("classification"),
                json_module.dumps(transaction, default=str),
                item_id,
                transaction.get("reversal_transaction_id"),
            ),
        )
        conn.execute(
            """
            INSERT INTO transaction_audit_events (
                investment_transaction_id, event_type, raw_payload, normalized_payload, classification
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                txn_id,
                "IMPORT",
                json_module.dumps(transaction, default=str),
                json_module.dumps(transaction, default=str),
                transaction.get("classification"),
            ),
        )
        added += int(before is None)
    return added


def upsert_cash_accounts(
    conn, institution_id: int, accounts, snapshot_date: str
) -> int:
    """Persist depository account metadata and one idempotent balance snapshot."""

    account_rows = [account for account in accounts or [] if account.get("account_id")]
    _close_missing_accounts(
        conn,
        institution_id,
        "depository",
        {account["account_id"] for account in account_rows},
        snapshot_date,
    )
    count = 0
    for account in account_rows:
        account_id = account["account_id"]
        household_account_id, persistent_account_id, is_authoritative = (
            _household_account_identity(conn, institution_id, account)
        )
        conn.execute(
            """
            INSERT INTO financial_accounts
            (
                account_id, institution_id, name, type, subtype, mask,
                tax_status, is_401k, raw_payload, is_active, inactive_since,
                household_account_id, persistent_account_id,
                original_household_account_id, is_authoritative
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, NULL, ?, ?, ?, ?)
            ON CONFLICT (
                account_id) DO UPDATE SET institution_id = excluded.institution_id,
            name = excluded.name, type = excluded.type, subtype = excluded.subtype,
            mask = excluded.mask, tax_status = excluded.tax_status, raw_payload = excluded.raw_payload,
            household_account_id = COALESCE(financial_accounts.household_account_id, excluded.household_account_id),
            persistent_account_id = COALESCE(excluded.persistent_account_id, financial_accounts.persistent_account_id),
            original_household_account_id = COALESCE(financial_accounts.original_household_account_id, excluded.original_household_account_id),
            updated_at = CURRENT_TIMESTAMP, is_active = 1, inactive_since = NULL
            """,
            (
                account_id,
                institution_id,
                account.get("name"),
                account.get("type"),
                account.get("subtype"),
                account.get("mask"),
                account.get("tax_status"),
                json.dumps(account, default=str),
                household_account_id,
                persistent_account_id,
                household_account_id,
                int(is_authoritative),
            ),
        )
        current = (account.get("balances") or {}).get("current")
        if current is not None:
            conn.execute(
                """
                INSERT INTO cash_account_snapshots
                (
                    snapshot_date, account_id, balance, asset_subtype, raw_payload,
                    source, is_complete
                )
                VALUES (?, ?, ?, ?, ?, 'PLAID', 1)
                ON CONFLICT (
                    snapshot_date, account_id) DO UPDATE SET balance = excluded.balance,
                asset_subtype = excluded.asset_subtype, raw_payload = excluded.raw_payload,
                source = 'PLAID', is_complete = 1
                """,
                (
                    snapshot_date,
                    account_id,
                    current,
                    account.get("subtype"),
                    json.dumps(account, default=str),
                ),
            )
            count += 1
        conn.execute(
            """
            INSERT INTO portfolio_snapshot_accounts
            (snapshot_date, account_id, source, balance, holdings_count, is_complete)
            VALUES (?, ?, 'PLAID', ?, 0, ?)
            ON CONFLICT (snapshot_date, account_id) DO UPDATE SET
                source = 'PLAID', balance = excluded.balance, holdings_count = 0,
                is_complete = excluded.is_complete, updated_at = CURRENT_TIMESTAMP
            """,
            (snapshot_date, account_id, current, int(current is not None)),
        )
    conn.commit()
    return count


def _household_account_identity(
    conn, institution_id: int, account: dict
) -> tuple[str, str | None, bool]:
    account_id = account["account_id"]
    existing = _existing_household_identity(conn, account_id, account)
    if existing is not None:
        return existing
    persistent_account_id = account.get("persistent_account_id")
    matched_id = _matched_household_account_id(conn, persistent_account_id)
    household_account_id = matched_id or f"acct_{uuid.uuid4()}"
    institution = conn.execute(
        """
        SELECT household_id, owner_user_id, plaid_institution_id
        FROM institutions WHERE id = ?
        """,
        (institution_id,),
    ).fetchone()
    _ensure_household_account(conn, household_account_id, institution, account)
    _assign_connection_owner(conn, household_account_id, institution)
    _suggest_account_merge(
        conn, account_id, persistent_account_id, institution, account
    )
    return household_account_id, persistent_account_id, matched_id is None


def _existing_household_identity(
    conn, account_id: str, account: dict
) -> tuple[str, str | None, bool] | None:
    row = conn.execute(
        """
        SELECT household_account_id, persistent_account_id, is_authoritative
        FROM financial_accounts
        WHERE account_id = ?
        """,
        (account_id,),
    ).fetchone()
    if not row or not row["household_account_id"]:
        return None
    return (
        row["household_account_id"],
        account.get("persistent_account_id") or row["persistent_account_id"],
        bool(row["is_authoritative"]),
    )


def _matched_household_account_id(conn, persistent_id: str | None) -> str | None:
    if not persistent_id:
        return None
    row = conn.execute(
        """
        SELECT household_account_id
        FROM financial_accounts
        WHERE persistent_account_id = ? AND household_account_id IS NOT NULL
        LIMIT 1
        """,
        (persistent_id,),
    ).fetchone()
    return str(row["household_account_id"]) if row else None


def _ensure_household_account(conn, household_account_id, institution, account) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO household_accounts
        (id, household_id, display_name)
        VALUES (?, ?, ?)
        """,
        (
            household_account_id,
            institution["household_id"] if institution else None,
            account.get("name") or account["account_id"],
        ),
    )


def _assign_connection_owner(conn, household_account_id, institution) -> None:
    if institution and institution["owner_user_id"]:
        conn.execute(
            """
            INSERT OR IGNORE INTO account_owners (household_account_id, user_id)
            VALUES (?, ?)
            """,
            (household_account_id, institution["owner_user_id"]),
        )


def _suggest_account_merge(
    conn, account_id, persistent_account_id, institution, account
) -> None:
    if persistent_account_id:
        return
    candidate = conn.execute(
        """
            SELECT a.account_id
            FROM financial_accounts AS a
            INNER JOIN institutions AS i ON i.id = a.institution_id
            WHERE
                a.account_id <> ?
                AND i.plaid_institution_id IS ?
                AND a.mask IS ?
                AND a.type IS ?
                AND a.subtype IS ?
                AND lower(COALESCE(a.name, '')) = lower(?)
            LIMIT 1
            """,
        (
            account_id,
            institution["plaid_institution_id"] if institution else None,
            account.get("mask"),
            account.get("type"),
            account.get("subtype"),
            account.get("name") or "",
        ),
    ).fetchone()
    if not candidate:
        return
    left, right = sorted((account_id, candidate["account_id"]))
    conn.execute(
        """
        INSERT OR IGNORE INTO account_merge_suggestions
        (account_id, candidate_account_id, reason)
        VALUES (?, ?, 'institution-mask-type-name')
        """,
        (left, right),
    )


def list_investment_transactions(
    conn,
    *,
    institution: str | None = None,
    owner_user_id: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            t.plaid_transaction_id,
            t.account_id,
            t.security_id,
            t.date,
            t.type,
            t.subtype,
            t.amount,
            t.quantity,
            t.price,
            t.fees,
            t.cash_impact,
            t.classification,
            t.raw_payload,
            t.source_item_id,
            t.reversed_transaction_id,
            t.created_at,
            t.updated_at,
            s.ticker,
            s.name AS security_name,
            a.institution_id,
            i.name AS institution
        FROM investment_transactions AS t
        LEFT JOIN investment_securities AS s ON t.security_id = s.security_id
        LEFT JOIN financial_accounts AS a ON t.account_id = a.account_id
        LEFT JOIN institutions AS i ON a.institution_id = i.id
        WHERE
            (? IS NULL OR i.name = ?)
            AND COALESCE(a.is_authoritative, 1) = 1
            AND (
                ? IS NULL
                OR EXISTS (
                    SELECT 1 FROM account_owners AS owner
                    WHERE
                        owner.household_account_id = a.household_account_id
                        AND owner.user_id = ?
                )
            )
        ORDER BY t.date DESC, t.plaid_transaction_id ASC
        LIMIT ? OFFSET ?
        """,
        (institution, institution, owner_user_id, owner_user_id, limit, offset),
    ).fetchall()
    return [dict(row) for row in rows]


ASSET_CLASSES = ("US_EQUITY", "INTERNATIONAL_EQUITY", "BONDS", "CASH", "OTHER")


def get_target_allocation(conn) -> dict[str, float]:

    defaults = {
        SettingKey.TARGET_US_EQUITY: 60.0,
        SettingKey.TARGET_INTERNATIONAL_EQUITY: 10.0,
        SettingKey.TARGET_BONDS: 30.0,
    }
    values = {
        key.value: float(get_setting(conn, key) or default)
        for key, default in defaults.items()
    }
    return {
        "US_EQUITY": values[SettingKey.TARGET_US_EQUITY.value],
        "INTERNATIONAL_EQUITY": values[SettingKey.TARGET_INTERNATIONAL_EQUITY.value],
        "BONDS": values[SettingKey.TARGET_BONDS.value],
        "CASH": 0.0,
        "OTHER": 0.0,
    }


def set_target_allocation(
    conn, us_equity, international_equity, bonds
) -> dict[str, float]:
    values = [float(us_equity), float(international_equity), float(bonds)]
    if any(value < 0 for value in values) or abs(sum(values) - 100.0) > 0.0001:
        raise ValueError(
            "Target allocation percentages must be non-negative and total 100"
        )

    for key, value in zip(
        (
            SettingKey.TARGET_US_EQUITY,
            SettingKey.TARGET_INTERNATIONAL_EQUITY,
            SettingKey.TARGET_BONDS,
        ),
        values,
    ):
        set_setting(conn, key, str(value))
    return get_target_allocation(conn)


def _security_asset_allocation(conn, security_id, ticker=None, name=None):
    rows = conn.execute(
        """
        SELECT asset_class, allocation_percent
        FROM security_asset_allocations
        WHERE security_id = ?
        ORDER BY asset_class
        """,
        (security_id,),
    ).fetchall()
    if rows:
        return _stored_security_asset_allocation(rows)
    return [
        {
            "asset_class": _legacy_inferred_asset_class(ticker, name),
            "percent": 100.0,
        }
    ]


def _stored_security_asset_allocation(rows):
    return [
        {
            "asset_class": row["asset_class"],
            "percent": float(row["allocation_percent"]),
        }
        for row in rows
    ]


def _legacy_inferred_asset_class(ticker, name):
    text = f"{ticker or ''} {name or ''}".upper()
    words = set(text.split())
    rules = (
        ({"BND", "BOND", "AGG", "BSV", "TLT"}, "BONDS"),
        (
            {"VXUS", "VEA", "VWO", "IXUS", "INTERNATIONAL"},
            "INTERNATIONAL_EQUITY",
        ),
    )
    matched = next(
        (asset_class for tokens, asset_class in rules if words.intersection(tokens)),
        None,
    )
    return matched or ("US_EQUITY" if ticker or name else "OTHER")


def _investment_asset_allocation(conn, holdings, account_balances):
    totals = {asset: 0.0 for asset in ASSET_CLASSES}
    holding_accounts = {row["account_id"] for row in holdings}
    _add_holding_asset_values(conn, totals, holdings)
    totals["CASH"] += sum(
        float(row["value"] or 0)
        for row in account_balances
        if row["account_id"] not in holding_accounts
    )
    total = sum(totals.values())
    return _asset_allocation_rows(totals, total)


def _add_holding_asset_values(conn, totals, holdings):
    for row in holdings:
        allocation = _security_asset_allocation(
            conn, row["security_id"], row["ticker"], row["security_name"]
        )
        value = float(row["value"] or 0)
        for item in allocation:
            totals[item["asset_class"]] += value * item["percent"] / 100


def _asset_allocation_rows(totals, total):
    return [
        {
            "asset_class": key,
            "value": value,
            "percentage": value / total * 100 if total else 0.0,
        }
        for key, value in totals.items()
        if value
    ]


def _target_comparison(actual, target):
    actual_map = {row["asset_class"]: row["percentage"] for row in actual}
    return [
        {
            "asset_class": asset,
            "actual": actual_map.get(asset, 0.0),
            "target": target.get(asset, 0.0),
            "drift": actual_map.get(asset, 0.0) - target.get(asset, 0.0),
        }
        for asset in ASSET_CLASSES
    ]


def _benchmark_rows(conn):
    return conn.execute(
        """
        SELECT
            price_date,
            adjusted_close
        FROM benchmark_prices
        WHERE benchmark = 'SP500'
        ORDER BY price_date
        """
    ).fetchall()


def upsert_benchmark_prices(conn, rows, benchmark="SP500", source="yfinance"):
    for price_date, adjusted_close in rows:
        conn.execute(
            """
            INSERT INTO benchmark_prices (benchmark, price_date, adjusted_close, source) VALUES (?, ?, ?, ?) ON CONFLICT (
                benchmark, price_date
            ) DO UPDATE SET adjusted_close = excluded.adjusted_close, source = excluded.source
            """,
            (benchmark, str(price_date), float(adjusted_close), source),
        )
    conn.commit()


def upsert_security_classification(conn, security_id, asset_class, source="USER"):
    if asset_class not in ASSET_CLASSES + ("REAL_ESTATE",):
        raise ValueError("Unsupported asset class")
    conn.execute(
        """
        DELETE FROM security_asset_allocations
        WHERE security_id = ?
        """,
        (security_id,),
    )
    conn.execute(
        """
        INSERT INTO security_asset_allocations (
            security_id,
            asset_class,
            allocation_percent,
            source
        )
        VALUES (?, ?, 100, ?)
        """,
        (security_id, asset_class, source),
    )
    conn.commit()


def _investment_flows(transactions, equity) -> dict[str, float]:
    flows = {
        "contributions": 0.0,
        "dividends_interest": 0.0,
        "purchases": 0.0,
        "sales": 0.0,
        "ignored": 0.0,
    }
    for row in transactions:
        flows[_investment_transaction_bucket(row)] += _investment_amount(row)
    flows["employer_equity"], flows["tax_withholding"] = _equity_flows(equity)
    flows.pop("ignored")
    return {key: float(value) for key, value in flows.items()}


def _investment_amount(row) -> float:
    return abs(row["amount"] or 0)


def _investment_transaction_bucket(row) -> str:
    kind = f"{row['type'] or ''} {row['subtype'] or ''}".lower()
    return _investment_flow_bucket(kind) or "ignored"


def _equity_flows(rows) -> tuple[float, float]:
    gross = sum((row["gross_income"] or 0 for row in rows), 0)
    withholding = sum((row["withholding"] or 0 for row in rows), 0)
    return gross, withholding


def _investment_flow_bucket(kind: str) -> str | None:
    if "dividend" in kind or "interest" in kind:
        return "dividends_interest"
    if "buy" in kind or "purchase" in kind:
        return "purchases"
    if "sell" in kind:
        return "sales"
    if "contribution" in kind or "deposit" in kind:
        return "contributions"
    return None


def _investment_snapshots(rows) -> list[dict]:
    return [
        {
            "date": row["snapshot_date"],
            "value": float(row["value"] or 0),
            "cost_basis": float(row["cost_basis"] or 0),
        }
        for row in rows
    ]


def _investment_allocation(rows, key, label, fallback=None) -> list[dict]:
    totals: dict[str, float] = {}
    labels: dict[str, str] = {}
    for row in rows:
        group_id = row[key] or "unknown"
        totals[group_id] = totals.get(group_id, 0) + (row["value"] or 0)
        labels[group_id] = (
            row[label] or (row[fallback] if fallback else None) or group_id
        )
    total = sum(totals.values(), 0)
    return [
        {
            "id": group_id,
            "label": labels[group_id],
            "value": float(value),
            "percentage": float(value / total * 100) if total else 0,
        }
        for group_id, value in sorted(
            totals.items(), key=lambda item: item[1], reverse=True
        )
    ]


def _investment_account_allocation(holdings, account_balances) -> list[dict]:
    """Use holdings per account, falling back to an account balance once."""
    holding_account_ids = {row["account_id"] for row in holdings}
    rows = _investment_holding_account_rows(holdings)
    rows.extend(_investment_balance_account_rows(account_balances, holding_account_ids))
    totals, labels, sources = _investment_account_totals(rows)
    return _investment_account_allocation_output(totals, labels, sources)


def _investment_account_balances(conn) -> list[dict]:

    accounts = conn.execute(
        """
        SELECT
            account_id,
            name,
            raw_payload
        FROM financial_accounts
        """
        "WHERE type = 'investment'"
    ).fetchall()
    balances = []
    for row in accounts:
        try:
            current = (
                json.loads(row["raw_payload"] or "{}")
                .get("balances", {})
                .get("current")
            )
            current = float(current) if current is not None else None
        except (TypeError, ValueError, json.JSONDecodeError):
            current = None
        if current is not None:
            balances.append(
                {
                    "account_id": row["account_id"],
                    "account_name": row["name"],
                    "value": current,
                }
            )
    cash_rows = conn.execute(
        """
        SELECT
            s.account_id,
            a.name,
            s.balance
        FROM cash_account_snapshots AS s
        INNER JOIN financial_accounts AS a ON s.account_id = a.account_id
        WHERE
            s.snapshot_date = (
                SELECT MAX(s2.snapshot_date) FROM cash_account_snapshots AS s2
                WHERE s2.account_id = s.account_id
            )
        """
    ).fetchall()
    known = {row["account_id"] for row in balances}
    for row in cash_rows:
        if row["account_id"] not in known:
            balances.append(
                {
                    "account_id": row["account_id"],
                    "account_name": row["name"],
                    "value": float(row["balance"] or 0),
                    "value_source": "cash_snapshot",
                }
            )
    return balances


def _investment_holding_account_rows(holdings) -> list[dict]:
    return [
        {
            "account_id": row["account_id"],
            "account_name": row["account_name"],
            "value": row["value"] or 0,
            "value_source": "holdings",
        }
        for row in holdings
    ]


def _investment_balance_account_rows(
    account_balances, holding_account_ids
) -> list[dict]:
    return [
        {
            "account_id": row["account_id"],
            "account_name": row["account_name"],
            "value": row["value"],
            "value_source": row.get("value_source", "account_balance"),
        }
        for row in account_balances
        if row["account_id"] not in holding_account_ids
    ]


def _investment_account_totals(rows):
    totals: dict[str, float] = {}
    labels: dict[str, str] = {}
    sources: dict[str, str] = {}
    for row in rows:
        account_id = row["account_id"] or "unknown"
        totals[account_id] = totals.get(account_id, 0) + row["value"]
        labels[account_id] = row["account_name"] or account_id
        sources[account_id] = row["value_source"]
    return totals, labels, sources


def _investment_account_allocation_output(totals, labels, sources) -> list[dict]:
    total = sum(totals.values(), 0)
    return [
        {
            "id": account_id,
            "label": labels[account_id],
            "value": float(value),
            "percentage": float(value / total * 100) if total else 0,
            "value_source": sources[account_id],
        }
        for account_id, value in sorted(
            totals.items(), key=lambda item: item[1], reverse=True
        )
    ]


def create_equity_compensation_event(conn, event: dict) -> int:
    fields = (
        event.get("event_type"),
        event.get("event_date"),
        event.get("account_id"),
        event.get("investment_transaction_id"),
        event.get("security_id"),
        event.get("shares"),
        event.get("fair_market_value"),
        event.get("gross_income"),
        event.get("withholding"),
        event.get("net_shares"),
        event.get("source", "manual"),
        event.get("notes"),
        event.get("raw_payload"),
    )
    cur = conn.execute(
        """
        INSERT INTO equity_compensation_events
        (
            event_type, event_date, account_id, investment_transaction_id,
            security_id, shares, fair_market_value, gross_income, withholding,
            net_shares, source, notes, raw_payload
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        fields,
    )
    conn.execute(
        """
        INSERT INTO transaction_audit_events (event_type, raw_payload, normalized_payload, classification)
        VALUES ('MANUAL_CORRECTION', ?, ?, ?)
        """,
        (event.get("raw_payload") or "{}", str(event), event.get("event_type")),
    )
    conn.commit()
    return cur.lastrowid


def mark_transaction_removed(conn, plaid_transaction_id: str) -> None:
    conn.execute(
        """
        UPDATE transactions
        SET
            removed = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE plaid_transaction_id = ?
        """,
        (plaid_transaction_id,),
    )
    conn.commit()


def set_transaction_ignored(conn, txn_id: str, ignored: bool) -> None:
    conn.execute(
        """
        UPDATE transactions
        SET
            is_ignored = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE plaid_transaction_id = ?
        """,
        (int(ignored), txn_id),
    )
    conn.commit()


def set_transaction_type_override(
    conn, txn_id: str, txn_type: str | None
) -> Transaction | None:
    conn.execute(
        """
        UPDATE transactions
        SET
            type_override = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE plaid_transaction_id = ?
        """,
        (txn_type, txn_id),
    )
    conn.commit()
    return get_transaction_by_id(conn, txn_id)


def get_transaction_by_id(conn, txn_id: str) -> Transaction | None:
    row = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.plaid_transaction_id = ?""",
        (txn_id,),
    ).fetchone()
    return _parse_txn(row) if row else None


def get_uncategorized_transactions(conn) -> list[Transaction]:
    rows = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.manual_category_id IS NULL
    AND t.removed = 0
    AND COALESCE(t.is_ignored, 0) = 0
ORDER BY t.date"""
    ).fetchall()
    return [_parse_txn(r) for r in rows]


def get_all_transactions_for_account(
    conn, account_id: str, limit: int = 500
) -> list[Transaction]:
    rows = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.account_id = ?
    AND t.removed = 0
ORDER BY t.date DESC
LIMIT ?""",
        (account_id, limit),
    ).fetchall()
    return [_parse_txn(r) for r in rows]


def get_transactions_by_date_range(
    conn,
    start: str,
    end: str,
    include_ignored: bool = False,
    owner_user_id: str | None = None,
) -> list[Transaction]:
    rows = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.date >= ?
    AND t.date <= ?
    AND t.removed = 0
    AND (? OR COALESCE(t.is_ignored, 0) = 0)
    AND (
        NOT EXISTS (
            SELECT 1 FROM financial_accounts AS source_account
            WHERE source_account.account_id = t.account_id
        )
        OR EXISTS (
            SELECT 1 FROM financial_accounts AS source_account
            WHERE source_account.account_id = t.account_id
            AND source_account.is_authoritative = 1
        )
    )
    AND (
        ? IS NULL
        OR EXISTS (
            SELECT 1
            FROM financial_accounts AS owned_account
            INNER JOIN account_owners AS owner
                ON owner.household_account_id = owned_account.household_account_id
            WHERE owned_account.account_id = t.account_id AND owner.user_id = ?
        )
    )
ORDER BY t.date""",
        (start, end, include_ignored, owner_user_id, owner_user_id),
    ).fetchall()
    return [_parse_txn(r) for r in rows]


def get_all_transactions(conn, removed: bool = False) -> list[Transaction]:
    rows = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.removed = ?
ORDER BY t.date DESC""",
        (int(removed),),
    ).fetchall()
    return [_parse_txn(r) for r in rows]


def purge_transactions_before(conn, cutoff: str) -> int:
    cursor = conn.execute(
        """
        DELETE FROM transactions
        WHERE date < ?
        """,
        (cutoff,),
    )
    conn.commit()
    return cursor.rowcount


def run_integrity_check(conn) -> list[str]:
    rows = conn.execute("""
                        PRAGMA integrity_check
                        """).fetchall()
    return [row[0] for row in rows]


def get_available_months(conn) -> list[tuple[int, int]]:
    rows = conn.execute(
        """
        SELECT DISTINCT
            STRFTIME('%Y', date) AS y,
            STRFTIME('%m', date) AS m
        FROM transactions
        WHERE
            removed = 0
        ORDER BY
            y DESC,
            m DESC
        """
    ).fetchall()
    return [(int(r["y"]), int(r["m"])) for r in rows if r["y"] and r["m"]]


_ALLOWED_ORDER_COLUMNS = frozenset(
    {
        "plaid_transaction_id",
        "account_id",
        "institution_id",
        "date",
        "amount",
        "merchant",
        "raw_description",
        "pending",
        "currency",
        "plaid_category",
        "plaid_subcategory",
        "pfc_primary",
        "pfc_detailed",
        "payment_processor",
        "removed",
        "is_ignored",
        "updated_at",
        "created_at",
    }
)


def _transaction_where(filters: dict) -> tuple[list[str], list]:
    clauses = ["t.removed = 0"]
    params = []
    if filters.get("institution_id"):
        clauses.append("t.institution_id = ?")
        params.append(filters["institution_id"])
    if filters.get("account_id"):
        clauses.append("t.account_id = ?")
        params.append(filters["account_id"])
    if filters.get("pending_only"):
        clauses.append("t.pending = 1")
    if filters.get("include_ignored") is not True:
        clauses.append("COALESCE(t.is_ignored,0)=0")
    if filters.get("from_date"):
        clauses.append("t.date >= ?")
        params.append(filters["from_date"])
    if filters.get("to_date"):
        clauses.append("t.date <= ?")
        params.append(filters["to_date"])
    if filters.get("search"):
        clauses.append("(t.merchant LIKE ? OR t.raw_description LIKE ?)")
        like = f"%{filters['search']}%"
        params.extend([like, like])
    return clauses, params


def _normalize_order(order: str | None) -> str:
    parts = (order or "date DESC").split()
    if (
        len(parts) != 2
        or parts[0].strip('"`[]') not in _ALLOWED_ORDER_COLUMNS
        or parts[1].upper() not in ("ASC", "DESC")
    ):
        return "t.date DESC, t.plaid_transaction_id DESC"
    column = parts[0].strip('"`[]')
    direction = parts[1].upper()
    return f"t.{column} {direction}, t.plaid_transaction_id {direction}"


def filtered_transactions(conn, filters: dict) -> list[Transaction]:
    institution_id = filters.get("institution_id")
    account_id = filters.get("account_id")
    pending_only = bool(filters.get("pending_only"))
    include_ignored = filters.get("include_ignored") is True
    from_date = filters.get("from_date")
    to_date = filters.get("to_date")
    search = filters.get("search")
    like = f"%{search}%" if search else None
    order = _normalize_order(filters.get("order", "date DESC"))
    limit = filters.get("limit", 1000)
    offset = filters.get("offset", 0)
    owner_user_id = filters.get("owner_user_id")
    rows = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.removed = 0
    AND (? IS NULL OR t.institution_id = ?)
    AND (? IS NULL OR t.account_id = ?)
    AND (NOT ? OR t.pending = 1)
    AND (? OR COALESCE(t.is_ignored, 0) = 0)
    AND (? IS NULL OR t.date >= ?)
    AND (? IS NULL OR t.date <= ?)
    AND (? IS NULL OR t.merchant LIKE ? OR t.raw_description LIKE ?)
    AND (
        NOT EXISTS (
            SELECT 1 FROM financial_accounts AS source_account
            WHERE source_account.account_id = t.account_id
        )
        OR EXISTS (
            SELECT 1 FROM financial_accounts AS source_account
            WHERE source_account.account_id = t.account_id
            AND source_account.is_authoritative = 1
        )
    )
    AND (
        ? IS NULL
        OR EXISTS (
            SELECT 1
            FROM financial_accounts AS owned_account
            INNER JOIN account_owners AS owner
                ON owner.household_account_id = owned_account.household_account_id
            WHERE owned_account.account_id = t.account_id AND owner.user_id = ?
        )
    )
ORDER BY
    CASE WHEN ? = 'amount ASC' THEN t.amount END ASC,
    CASE WHEN ? = 'amount DESC' THEN t.amount END DESC,
    CASE WHEN ? = 'date ASC' THEN t.date END ASC,
    t.date DESC,
    t.plaid_transaction_id DESC
LIMIT
    ?
    OFFSET
    ?""",
        (
            institution_id,
            institution_id,
            account_id,
            account_id,
            pending_only,
            include_ignored,
            from_date,
            from_date,
            to_date,
            to_date,
            like,
            like,
            like,
            owner_user_id,
            owner_user_id,
            order,
            order,
            order,
            limit,
            offset,
        ),
    ).fetchall()
    return [_parse_txn(r) for r in rows]


def count_filtered_transactions(conn, filters: dict) -> int:
    institution_id = filters.get("institution_id")
    account_id = filters.get("account_id")
    pending_only = bool(filters.get("pending_only"))
    include_ignored = filters.get("include_ignored") is True
    from_date = filters.get("from_date")
    to_date = filters.get("to_date")
    search = filters.get("search")
    like = f"%{search}%" if search else None
    row = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM transactions AS t
        WHERE
            t.removed = 0
            AND (? IS NULL OR t.institution_id = ?)
            AND (? IS NULL OR t.account_id = ?)
            AND (NOT ? OR t.pending = 1)
            AND (? OR COALESCE(t.is_ignored, 0) = 0)
            AND (? IS NULL OR t.date >= ?)
            AND (? IS NULL OR t.date <= ?)
            AND (? IS NULL OR t.merchant LIKE ? OR t.raw_description LIKE ?)
        """,
        (
            institution_id,
            institution_id,
            account_id,
            account_id,
            pending_only,
            include_ignored,
            from_date,
            from_date,
            to_date,
            to_date,
            like,
            like,
            like,
        ),
    ).fetchone()
    return row["n"]


def ensure_category(conn, name: str) -> int:
    name = name.strip()
    conn.execute(
        """
        INSERT OR IGNORE INTO categories (name)
        VALUES (?)
        """,
        (name,),
    )
    row = conn.execute(
        """
        SELECT id
        FROM categories
        WHERE name = ?
        """,
        (name,),
    ).fetchone()
    conn.commit()
    return row["id"]


def create_category(conn, name: str) -> int:
    return ensure_category(conn, name)


def get_category_names(conn) -> list[str]:
    rows = conn.execute(
        """
        SELECT name
        FROM categories
        ORDER BY LOWER(name)
        """
    ).fetchall()
    return [r["name"] for r in rows]


def get_category_name(conn, category_id: int) -> str | None:
    row = conn.execute(
        """
        SELECT name
        FROM categories
        WHERE id = ?
        """,
        (category_id,),
    ).fetchone()
    return row["name"] if row else None


def get_category_id_by_name(conn, name: str) -> int | None:
    row = conn.execute(
        """
        SELECT id
        FROM categories
        WHERE name = ?
        """,
        (name,),
    ).fetchone()
    return row["id"] if row else None


def delete_category(conn, name: str) -> None:
    category_id = get_category_id_by_name(conn, name)
    conn.execute(
        """
        DELETE FROM categories
        WHERE name = ?
        """,
        (name,),
    )
    if category_id is not None:
        conn.execute(
            """
            DELETE FROM category_caps
            WHERE category_id = ?
            """,
            (category_id,),
        )
    conn.commit()


def set_manual_category(conn, txn_id: str, category_id: int) -> None:
    conn.execute(
        """
        UPDATE transactions
        SET
            manual_category_id = ?,
            manual_category_set_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE plaid_transaction_id = ?
        """,
        (category_id, _dt(datetime.now(timezone.utc)), txn_id),
    )
    conn.commit()


def record_category_change(
    conn,
    txn_id: str,
    from_category_id: int | None,
    to_category_id: int | None,
    reason: str = "MANUAL",
) -> None:
    conn.execute(
        """
        INSERT INTO category_changes (
            transaction_id,
            from_category_id,
            to_category_id,
            reason
        )
        VALUES (?, ?, ?, ?)
        """,
        (txn_id, from_category_id, to_category_id, reason),
    )
    conn.commit()


def get_category_rules(conn) -> list[CategoryRule]:
    rows = conn.execute(
        """
        SELECT
            r.id,
            r.pattern,
            r.match_type,
            r.category_id,
            r.priority,
            r.source,
            r.enabled,
            r.created_at,
            r.updated_at,
            c.name AS category
        FROM category_rules AS r
        LEFT JOIN categories AS c
            ON r.category_id = c.id
        ORDER BY
            r.priority DESC,
            r.id ASC
        """
    ).fetchall()
    rules = []
    for r in rows:
        d = dict(r)
        d["category"] = d.get("category")
        rules.append(CategoryRule(**d))
    return rules


def upsert_category_rule(
    conn,
    pattern: str,
    category_id: int,
    match_type: str = "BOTH",
    priority: int = 100,
    source: str = "user",
) -> None:
    conn.execute(
        """
        INSERT INTO category_rules (
            pattern,
            match_type,
            category_id,
            priority,
            source,
            enabled,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT DO UPDATE
        SET
            category_id = excluded.category_id,
            priority = excluded.priority,
            source = excluded.source,
            enabled = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        (pattern.strip(), match_type, category_id, priority, source),
    )
    conn.commit()


def delete_category_rule(conn, rule_id: int) -> None:
    conn.execute(
        """
        UPDATE category_rules
        SET
            enabled = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (rule_id,),
    )
    conn.commit()


def set_category_rule_enabled(conn, rule_id: int, enabled: bool) -> None:
    conn.execute(
        """
        UPDATE category_rules
        SET
            enabled = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (int(enabled), rule_id),
    )
    conn.commit()


def get_type_rules(conn) -> list[TypeRule]:
    rows = conn.execute(
        """
        SELECT
            id,
            pattern,
            match_type,
            transaction_type,
            priority,
            source,
            enabled,
            created_at,
            updated_at
        FROM type_rules
        ORDER BY
            priority DESC,
            id ASC
        """
    ).fetchall()
    return [TypeRule(**dict(r)) for r in rows]


def upsert_type_rule(
    conn,
    pattern: str,
    transaction_type: str,
    match_type: str = "BOTH",
    priority: int = 100,
    source: str = "user",
) -> None:
    conn.execute(
        """
        INSERT INTO type_rules (
            pattern,
            match_type,
            transaction_type,
            priority,
            source,
            enabled,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT DO UPDATE
        SET
            transaction_type = excluded.transaction_type,
            priority = excluded.priority,
            source = excluded.source,
            enabled = 1,
            updated_at = CURRENT_TIMESTAMP
        """,
        (pattern.strip(), match_type, transaction_type.upper(), priority, source),
    )
    conn.commit()


def delete_type_rule(conn, rule_id: int) -> None:
    conn.execute(
        """
        UPDATE type_rules
        SET
            enabled = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (rule_id,),
    )
    conn.commit()


def set_type_rule_enabled(conn, rule_id: int, enabled: bool) -> None:
    conn.execute(
        """
        UPDATE type_rules
        SET
            enabled = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (int(enabled), rule_id),
    )
    conn.commit()


def get_taxonomy_mappings(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            m.taxonomy,
            m.external_key,
            m.external_subkey,
            m.category_id,
            m.priority,
            c.name AS category
        FROM taxonomy_mappings AS m
        LEFT JOIN categories AS c
            ON m.category_id = c.id
        """
    ).fetchall()
    return [dict(r) for r in rows]


def get_sheet_layout(conn) -> list[str]:
    rows = conn.execute(
        """
        SELECT c.name AS category
        FROM sheet_layout AS l
        LEFT JOIN categories AS c
            ON l.category_id = c.id
        ORDER BY l.position
        """
    ).fetchall()
    return [r["category"] for r in rows]


def get_category_changes(
    conn, txn_id: str | None = None, limit: int = 200, offset: int = 0
) -> list[CategoryChange]:
    if txn_id:
        rows = conn.execute(
            """
            SELECT
                cc.id,
                cc.transaction_id,
                cc.from_category_id,
                cc.to_category_id,
                cc.reason,
                cc.timestamp,
                cf.name AS from_category,
                ct.name AS to_category
            FROM category_changes AS cc
            LEFT JOIN categories AS cf
                ON cc.from_category_id = cf.id
            LEFT JOIN categories AS ct
                ON cc.to_category_id = ct.id
            WHERE cc.transaction_id = ?
            ORDER BY cc.id DESC
            LIMIT
                ?
                OFFSET
                ?
            """,
            (txn_id, limit, offset),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT
                cc.id,
                cc.transaction_id,
                cc.from_category_id,
                cc.to_category_id,
                cc.reason,
                cc.timestamp,
                cf.name AS from_category,
                ct.name AS to_category
            FROM category_changes AS cc
            LEFT JOIN categories AS cf
                ON cc.from_category_id = cf.id
            LEFT JOIN categories AS ct
                ON cc.to_category_id = ct.id
            ORDER BY cc.id DESC
            LIMIT
                ?
                OFFSET
                ?
            """,
            (limit, offset),
        ).fetchall()
    changes = []
    for r in rows:
        d = dict(r)
        d["old_category"] = d.get("from_category")
        d["new_category"] = d.get("to_category")
        known = {f.name for f in CategoryChange.__dataclass_fields__.values()}
        changes.append(CategoryChange(**{k: v for k, v in d.items() if k in known}))
    return changes


def count_category_changes(conn, txn_id: str | None = None) -> int:
    if txn_id:
        row = conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM category_changes
            WHERE transaction_id = ?
            """,
            (txn_id,),
        ).fetchone()
    else:
        row = conn.execute("""
                           SELECT COUNT(*) AS n FROM category_changes
                           """).fetchone()
    return row["n"]


def distinct_account_ids(conn) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT account_id
        FROM transactions
        WHERE
            removed = 0
            AND account_id <> ''
        ORDER BY account_id
        """
    ).fetchall()
    return [r["account_id"] for r in rows]


def get_income_transactions(
    conn,
    from_date: str | None = None,
    to_date: str | None = None,
    owner_user_id: str | None = None,
) -> list[Transaction]:
    rows = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.removed = 0
    AND COALESCE(t.is_ignored, 0) = 0
    AND (? IS NULL OR t.date >= ?)
    AND (? IS NULL OR t.date <= ?)
    AND (
        ? IS NULL
        OR EXISTS (
            SELECT 1
            FROM financial_accounts AS owned_account
            INNER JOIN account_owners AS owner
                ON owner.household_account_id = owned_account.household_account_id
            WHERE
                owned_account.account_id = t.account_id
                AND owned_account.is_authoritative = 1
                AND owner.user_id = ?
        )
    )
ORDER BY t.date DESC""",
        (from_date, from_date, to_date, to_date, owner_user_id, owner_user_id),
    ).fetchall()
    return [_parse_txn(r) for r in rows]


def account_ids_for_owner(conn, owner_user_id: str | None = None) -> list[str]:
    rows = conn.execute(
        """
        SELECT a.account_id
        FROM financial_accounts AS a
        WHERE
            a.is_authoritative = 1
            AND (
                ? IS NULL
                OR EXISTS (
                    SELECT 1 FROM account_owners AS owner
                    WHERE
                        owner.household_account_id = a.household_account_id
                        AND owner.user_id = ?
                )
            )
        ORDER BY a.account_id
        """,
        (owner_user_id, owner_user_id),
    ).fetchall()
    return [row["account_id"] for row in rows]


def find_transactions_by_pattern(conn, pattern: str, limit: int = 200) -> list:
    like = f"%{pattern}%"
    rows = conn.execute(
        _TXN_SELECT
        + """WHERE
    t.removed = 0
    AND (t.merchant LIKE ? OR t.raw_description LIKE ?)
ORDER BY t.date DESC
LIMIT ?""",
        (like, like, limit),
    ).fetchall()
    return [_parse_txn(r) for r in rows]


def get_category_ids(conn) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT
            id,
            name
        FROM categories
        """
    ).fetchall()
    return {r["name"]: r["id"] for r in rows}


def get_category_caps(conn) -> dict[int, Decimal]:
    rows = conn.execute(
        """
        SELECT
            category_id,
            monthly_cap
        FROM category_caps
        """
    ).fetchall()
    return {r["category_id"]: Decimal(r["monthly_cap"]) for r in rows}


def get_category_cap(conn, category_id: int) -> Decimal | None:
    row = conn.execute(
        """
        SELECT monthly_cap
        FROM category_caps
        WHERE category_id = ?
        """,
        (category_id,),
    ).fetchone()
    return Decimal(row["monthly_cap"]) if row else None


def set_category_cap(conn, category_id: int, amount: Decimal | None) -> None:
    if amount is None:
        conn.execute(
            """
            DELETE FROM category_caps
            WHERE category_id = ?
            """,
            (category_id,),
        )
    else:
        conn.execute(
            """
            INSERT INTO category_caps (
                category_id,
                monthly_cap,
                created_at,
                updated_at
            )
            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (category_id) DO UPDATE
            SET
                monthly_cap = excluded.monthly_cap,
                updated_at = CURRENT_TIMESTAMP
            """,
            (category_id, str(amount)),
        )
    conn.commit()


def get_setting(conn, key: str) -> str | None:
    row = conn.execute(
        """
        SELECT value
        FROM settings
        WHERE key = ?
        """,
        (key,),
    ).fetchone()
    return row["value"] if row else None


def set_setting(conn, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO settings (
            key,
            value,
            created_at,
            updated_at
        )
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE
        SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        """,
        (key, value),
    )
    conn.commit()


def get_all_settings(conn) -> dict[str, str]:
    rows = conn.execute(
        """
        SELECT
            key,
            value
        FROM settings
        """
    ).fetchall()
    return {r["key"]: r["value"] for r in rows}


def get_monthly_budget(conn) -> Decimal | None:
    val = get_setting(conn, SettingKey.MONTHLY_BUDGET)
    return Decimal(val) if val is not None else None


def set_monthly_budget(conn, amount) -> None:
    set_setting(conn, SettingKey.MONTHLY_BUDGET, str(amount))
