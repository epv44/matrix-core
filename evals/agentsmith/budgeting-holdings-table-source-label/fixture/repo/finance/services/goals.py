"""Financial goals and partial asset reservations."""

from __future__ import annotations

import json

from finance.exceptions import NotFoundError
from finance.storage.repositories.goals import (
    active_goal_exists,
    create_allocation_row,
    create_goal_row,
    delete_allocation_row,
    delete_goal_records,
    get_account_type,
    get_account_value_source,
    get_allocation_goal_id,
    get_assigned_amount,
    get_goal,
    get_holding_value,
    get_latest_cash_balance,
    holding_exists,
    list_allocation_rows,
    list_goal_rows,
    list_reserved_source_rows,
    update_goal_row,
)

GOAL_TYPES = {
    "EMERGENCY_FUND",
    "HOUSE_DOWN_PAYMENT",
    "UPCOMING_TAXES",
    "RETIREMENT",
    "529",
    "CASH_RESERVE",
    "OTHER",
}
GOAL_STATUSES = {"ACTIVE", "COMPLETED"}
GOAL_SCOPES = {"HOUSEHOLD", "PERSONAL"}
SOURCE_TYPES = {"ACCOUNT", "HOLDING"}


def list_goals(conn, scope=None, owner_user_id=None) -> list[dict]:
    goals = list_goal_rows(conn, scope, owner_user_id)
    allocations = _goal_allocations(conn)
    by_goal: dict[int, list[dict]] = {goal["id"]: [] for goal in goals}
    source_totals: dict[tuple[str, str, str | None], float] = {}
    for allocation in allocations:
        key = _source_key(allocation)
        source_totals[key] = source_totals.get(key, 0.0) + allocation["assigned_amount"]
    source_values = {key: _source_value(conn, *key) for key in source_totals}
    for allocation in allocations:
        key = _source_key(allocation)
        assigned_total = source_totals[key]
        ratio = min(1.0, source_values[key] / assigned_total) if assigned_total else 1.0
        allocation["funded_amount"] = allocation["assigned_amount"] * ratio
        allocation["source_value"] = source_values[key]
        by_goal.setdefault(allocation["goal_id"], []).append(allocation)
    return [_goal_result(goal, by_goal.get(goal["id"], [])) for goal in goals]


def create_goal(
    conn,
    name,
    goal_type="OTHER",
    target_amount=None,
    target_date=None,
    scope="HOUSEHOLD",
    owner_user_id=None,
) -> int:
    normalized_name = str(name or "").strip()
    normalized_type = str(goal_type or "OTHER").upper()
    normalized_scope = str(scope or "HOUSEHOLD").upper()
    amount = _optional_nonnegative(target_amount, "target_amount")
    if not normalized_name:
        raise ValueError("Goal name is required")
    if normalized_type not in GOAL_TYPES:
        raise ValueError("Unsupported goal type")
    if normalized_scope not in GOAL_SCOPES:
        raise ValueError("Unsupported goal scope")
    stored_owner = owner_user_id if normalized_scope == "PERSONAL" else None
    if normalized_scope == "PERSONAL" and not stored_owner:
        raise ValueError("Personal goals require an owner")
    return create_goal_row(
        conn,
        normalized_name,
        normalized_type,
        amount,
        target_date,
        normalized_scope,
        stored_owner,
    )


def update_goal(
    conn,
    goal_id,
    *,
    name,
    goal_type,
    target_amount=None,
    target_date=None,
    status="ACTIVE",
    user_id=None,
) -> None:
    normalized_name = str(name or "").strip()
    normalized_type = str(goal_type or "OTHER").upper()
    normalized_status = str(status or "ACTIVE").upper()
    amount = _optional_nonnegative(target_amount, "target_amount")
    if not normalized_name:
        raise ValueError("Goal name is required")
    if normalized_type not in GOAL_TYPES or normalized_status not in GOAL_STATUSES:
        raise ValueError("Unsupported goal type or status")
    _require_goal_access(conn, goal_id, user_id)
    if not update_goal_row(
        conn,
        goal_id,
        normalized_name,
        normalized_type,
        amount,
        target_date,
        normalized_status,
    ):
        raise NotFoundError("Unknown goal")


def delete_goal(conn, goal_id, user_id=None) -> bool:
    _require_goal_access(conn, goal_id, user_id)
    return delete_goal_records(conn, goal_id)


def add_goal_allocation(
    conn,
    goal_id,
    source_type,
    account_id,
    assigned_amount,
    security_id=None,
    user_id=None,
) -> int:
    normalized_source = str(source_type or "").upper()
    amount = _optional_nonnegative(assigned_amount, "assigned_amount")
    if amount is None or amount == 0:
        raise ValueError("assigned_amount must be greater than zero")
    if normalized_source not in SOURCE_TYPES:
        raise ValueError("Unsupported goal allocation source")
    if not active_goal_exists(conn, goal_id):
        raise ValueError("Unknown or inactive goal")
    _require_goal_access(conn, goal_id, user_id)
    _validate_source(conn, normalized_source, account_id, security_id)
    key = (normalized_source, account_id, security_id)
    current_value = _source_value(conn, *key)
    assigned = _assigned_to_source(conn, *key)
    if assigned + amount > current_value + 0.005:
        raise ValueError("Goal allocations cannot exceed the source's current value")
    return create_allocation_row(
        conn, goal_id, normalized_source, account_id, security_id, amount
    )


def delete_goal_allocation(conn, allocation_id, user_id=None) -> bool:
    goal_id = get_allocation_goal_id(conn, allocation_id)
    if goal_id is None:
        raise NotFoundError("Unknown goal allocation")
    _require_goal_access(conn, goal_id, user_id)
    return delete_allocation_row(conn, allocation_id)


def reserved_amounts(conn) -> dict[tuple[str, str, str | None], float]:
    result: dict[tuple[str, str, str | None], float] = {}
    for row in list_reserved_source_rows(conn):
        key = (row["source_type"], row["account_id"], row["security_id"])
        result[key] = min(float(row["assigned_amount"] or 0), _source_value(conn, *key))
    return result


def goal_summary(conn, scope=None, owner_user_id=None) -> dict:
    goals = list_goals(conn, scope, owner_user_id)
    reserved = sum(
        goal["funded_amount"] for goal in goals if goal["status"] == "ACTIVE"
    )
    return {
        "goals": goals,
        "assigned_amount": sum(
            goal["assigned_amount"] for goal in goals if goal["status"] == "ACTIVE"
        ),
        "funded_amount": reserved,
        "underfunded_amount": sum(
            goal["underfunded_amount"] for goal in goals if goal["status"] == "ACTIVE"
        ),
    }


def _goal_allocations(conn) -> list[dict]:
    return [
        {**row, "assigned_amount": float(row["assigned_amount"] or 0)}
        for row in list_allocation_rows(conn)
    ]


def _goal_result(goal, allocations):
    assigned = sum(row["assigned_amount"] for row in allocations)
    funded = sum(row["funded_amount"] for row in allocations)
    target = float(goal["target_amount"]) if goal["target_amount"] is not None else None
    return {
        **goal,
        "target_amount": target,
        "assigned_amount": assigned,
        "funded_amount": funded,
        "underfunded_amount": max(0.0, assigned - funded),
        "remaining_to_target": max(0.0, target - funded)
        if target is not None
        else None,
        "allocations": allocations,
    }


def _require_goal_access(conn, goal_id, user_id) -> None:
    goal = get_goal(conn, goal_id)
    if goal is None:
        raise NotFoundError("Unknown goal")
    if goal["scope"] == "PERSONAL" and goal["owner_user_id"] != user_id:
        raise NotFoundError("Unknown goal")


def _validate_source(conn, source_type, account_id, security_id) -> None:
    account_type = get_account_type(conn, account_id)
    if account_type is None:
        raise ValueError("Unknown account")
    if source_type == "HOLDING":
        if not security_id or not holding_exists(conn, account_id, security_id):
            raise ValueError("Unknown holding")
        return
    if security_id is not None:
        raise ValueError("Account allocations cannot specify a security")
    if account_type != "depository" and holding_exists(conn, account_id):
        raise ValueError(
            "Investment accounts with holdings must be allocated by holding"
        )


def _source_value(conn, source_type, account_id, security_id) -> float:
    if source_type == "HOLDING":
        return max(0.0, get_holding_value(conn, account_id, security_id))
    account = get_account_value_source(conn, account_id)
    if not account or not bool(account["is_active"]):
        return 0.0
    balance = get_latest_cash_balance(conn, account_id)
    if balance is not None:
        return max(0.0, balance)
    try:
        current = json.loads(account["raw_payload"] or "{}")["balances"]["current"]
        return max(0.0, float(current))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return 0.0


def _assigned_to_source(conn, source_type, account_id, security_id) -> float:
    return get_assigned_amount(conn, source_type, account_id, security_id)


def _source_key(allocation) -> tuple[str, str, str | None]:
    return (
        allocation["source_type"],
        allocation["account_id"],
        allocation["security_id"],
    )


def _optional_nonnegative(value, name):
    if value is None or value == "":
        return None
    amount = float(value)
    if amount < 0:
        raise ValueError(f"{name} must be non-negative")
    return amount
