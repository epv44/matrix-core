from collections import defaultdict
from decimal import Decimal

from finance.services.categorization import resolve_transaction_type
from finance.storage.repository import (
    count_category_changes,
    filtered_transactions,
    get_available_months,
    get_category_changes,
    get_income_transactions,
)


def get_months(conn):
    return get_available_months(conn)


def get_transactions(conn, filters: dict):
    return filtered_transactions(conn, filters)


def get_income_breakdown(
    conn,
    group_by: str = "merchant",
    from_date: str | None = None,
    to_date: str | None = None,
    owner_user_id: str | None = None,
) -> dict:
    txns = get_income_transactions(conn, from_date, to_date, owner_user_id)
    groups = defaultdict(list)
    for t in txns:
        if resolve_transaction_type(conn, t) != "income":
            continue
        key = _income_group_key(t, group_by)
        groups[key].append(t)
    breakdown = []
    for src, lst in groups.items():
        total = sum((abs(x.amount) for x in lst), Decimal(0))
        breakdown.append((src, float(total), len(lst)))
    breakdown.sort(key=lambda item: item[1], reverse=True)
    total_all = sum((item[1] for item in breakdown), 0.0)
    return {
        "breakdown": [
            {"source": src, "amount": amount, "count": count}
            for src, amount, count in breakdown
        ],
        "total": total_all,
    }


def _income_group_key(txn, group_by: str) -> str:
    if group_by in ("account_id", "account"):
        return txn.account_id or "Unknown"
    if group_by == "institution":
        return txn.institution or "Unknown"
    if group_by == "payment_processor":
        return txn.payment_processor or "Unknown"
    return txn.merchant or txn.raw_description or "Unknown"


def get_audit_history(
    conn, txn_id: str | None = None, limit: int = 200, offset: int = 0
):
    return get_category_changes(conn, txn_id=txn_id, limit=limit, offset=offset)


def count_audit_history(conn, txn_id: str | None = None) -> int:
    return count_category_changes(conn, txn_id=txn_id)
