import logging
import re
import sqlite3

from finance.categorization.pfc_map import (
    classify_txn,
    map_legacy_category,
    map_pfc,
)
from finance.categorization.processor import (
    CATEGORY_MAP,
    process_monthly_data,
)
from finance.models.dataclasses import Transaction
from finance.storage.repository import (
    ensure_category,
    get_category_caps,
    get_category_ids,
    get_category_name,
    get_category_names,
    get_category_rules,
    get_monthly_budget,
    get_sheet_layout,
    get_taxonomy_mappings,
    get_transaction_by_id,
    get_transactions_by_date_range,
    get_type_rules,
    record_category_change,
    set_manual_category,
    set_transaction_type_override,
    upsert_category_rule,
    upsert_type_rule,
)
from finance.storage.repository import get_transactions_by_date_range as gt

logger = logging.getLogger(__name__)


def get_all_categories(conn) -> list[str]:
    try:
        names = get_category_names(conn)
        if names:
            return names
    except sqlite3.Error:
        logger.warning("Could not load categories from database", exc_info=True)
    base = set(get_sheet_layout(conn))
    for m in get_taxonomy_mappings(conn):
        base.add(m["category"])
    for r in get_category_rules(conn):
        if r.category:
            base.add(r.category)
    return sorted(base)


def _haystack(txn: Transaction) -> str:
    return ((txn.merchant or "") + " " + (txn.raw_description or "")).strip()


def _rule_matches(rule, txn: Transaction) -> bool:
    if not rule.enabled or not rule.pattern:
        return False
    merchant = (txn.merchant or "").upper()
    desc = (txn.raw_description or "").upper()
    hay = _haystack(txn).upper()
    pattern = rule.pattern.upper()
    mtype = rule.match_type
    if mtype == "REGEX":
        return _regex_matches(rule.pattern, hay)
    matchers = {
        "EXACT": lambda: pattern in (merchant, desc),
        "PREFIX": lambda: any(value.startswith(pattern) for value in (merchant, desc)),
        "MERCHANT": lambda: pattern in merchant,
        "DESCRIPTION": lambda: pattern in desc,
    }
    if mtype in matchers:
        return matchers[mtype]()
    return pattern in hay


def _regex_matches(pattern: str, haystack: str) -> bool:
    try:
        return re.search(pattern, haystack) is not None
    except re.error:
        return False


def find_matching_rule(conn, txn: Transaction, rules=None):
    if rules is None:
        rules = get_category_rules(conn)
    best = None
    for r in rules:
        if _rule_matches(r, txn) and (
            best is None
            or (r.priority, len(r.pattern)) > (best.priority, len(best.pattern))
        ):
            best = r
    return best


def find_matching_type_rule(conn, txn: Transaction, rules=None):
    if rules is None:
        rules = get_type_rules(conn)
    best = None
    for r in rules:
        if _rule_matches(r, txn) and (
            best is None
            or (r.priority, len(r.pattern)) > (best.priority, len(best.pattern))
        ):
            best = r
    return best


def resolve_transaction_type(
    conn, txn: Transaction, type_rules=None, category_rules=None
) -> str:
    if txn.type_override:
        return txn.type_override.lower()
    rule = find_matching_type_rule(conn, txn, rules=type_rules)
    if rule:
        return rule.transaction_type.lower()
    return classify_txn(txn, category_rules=category_rules)


def resolve_category_for_transaction(
    conn, txn: Transaction, rules=None, mappings=None
) -> str | None:
    if txn.manual_category_id:
        name = get_category_name(conn, txn.manual_category_id)
        if name:
            return name
    rule = find_matching_rule(conn, txn, rules=rules)
    if rule and rule.category:
        return rule.category
    pfc = map_pfc(conn, txn.pfc_primary, txn.pfc_detailed, mappings=mappings)
    if pfc:
        return pfc
    legacy = map_legacy_category(
        conn, [txn.plaid_category] if txn.plaid_category else None, mappings=mappings
    )
    if legacy:
        return legacy
    return None


def get_classification_trace(conn, txn: Transaction) -> list[dict]:
    trace = []
    manual_name = (
        get_category_name(conn, txn.manual_category_id)
        if txn.manual_category_id
        else None
    )
    trace.append(
        {
            "order": 1,
            "source": "manual override",
            "description": "manual_category_id user override",
            "matched": manual_name is not None,
            "result": manual_name,
        }
    )
    rule = find_matching_rule(conn, txn)
    trace.append(
        {
            "order": 2,
            "source": "category_rules",
            "description": "rule match (priority + specificity)",
            "matched": rule is not None,
            "pattern": rule.pattern if rule else None,
            "category": rule.category if rule else None,
            "result": rule.category if rule else None,
        }
    )
    pfc_mapped = map_pfc(conn, txn.pfc_primary, txn.pfc_detailed)
    trace.append(
        {
            "order": 3,
            "source": "taxonomy_mappings PFC",
            "description": f"{txn.pfc_primary}/{txn.pfc_detailed}",
            "matched": pfc_mapped is not None,
            "result": pfc_mapped,
            "pfc_primary": txn.pfc_primary,
            "pfc_detailed": txn.pfc_detailed,
        }
    )
    legacy = map_legacy_category(
        conn, [txn.plaid_category] if txn.plaid_category else None
    )
    trace.append(
        {
            "order": 4,
            "source": "taxonomy_mappings legacy",
            "description": f"plaid_category={txn.plaid_category}",
            "matched": legacy is not None,
            "result": legacy,
        }
    )
    trace.append(
        {
            "order": 5,
            "source": "fallback MISC.",
            "description": "Fallback",
            "matched": True,
            "result": "MISC.",
        }
    )
    return trace


def assign_category(
    conn,
    txn_id: str,
    new_category: str,
    remember: bool = False,
    pattern: str | None = None,
    match_type: str = "BOTH",
    source: str = "user",
) -> Transaction | None:
    new_category = new_category.strip()
    if not new_category:
        return None
    category_id = ensure_category(conn, new_category)
    txn = get_transaction_by_id(conn, txn_id)
    if not txn:
        return None
    old_id = txn.manual_category_id
    set_manual_category(conn, txn_id, category_id)
    record_category_change(conn, txn_id, old_id, category_id, reason="MANUAL")
    if remember:
        pat = pattern or (txn.merchant or txn.raw_description or "").strip()
        if pat:
            upsert_category_rule(
                conn, pat, category_id, match_type=match_type, source=source
            )
    logger.info(
        "cat changed %s -> %s remember=%s pat=%s",
        txn_id,
        new_category,
        remember,
        pattern,
    )
    return get_transaction_by_id(conn, txn_id)


def assign_type(
    conn,
    txn_id: str,
    new_type: str,
    remember: bool = False,
    pattern: str | None = None,
    match_type: str = "BOTH",
) -> Transaction | None:
    normalized = new_type.strip().lower()
    if normalized not in ("auto", "income", "transfer", "expense"):
        return None
    txn = get_transaction_by_id(conn, txn_id)
    if not txn:
        return None
    if normalized == "auto":
        updated = set_transaction_type_override(conn, txn_id, None)
    else:
        updated = set_transaction_type_override(conn, txn_id, normalized.upper())
        if remember and pattern:
            upsert_type_rule(conn, pattern, normalized.upper(), match_type=match_type)
    return updated


def monthly_spreadsheet_data(
    conn, year: int, month: int, owner_user_id: str | None = None
) -> dict:
    start, end = (
        f"{year}-{month:02d}-01",
        f"{year + 1}-01-01" if month == 12 else f"{year}-{month + 1:02d}-01",
    )
    txns = get_transactions_by_date_range(conn, start, end, owner_user_id=owner_user_id)
    layout = get_sheet_layout(conn)
    rules = get_category_rules(conn)
    mappings = get_taxonomy_mappings(conn)
    type_rules = get_type_rules(conn)
    processed = process_monthly_data(
        {(year, month): txns},
        type_resolver=lambda t: resolve_transaction_type(
            conn, t, type_rules=type_rules, category_rules=rules
        ),
        category_resolver=lambda t: (
            resolve_category_for_transaction(conn, t, rules=rules, mappings=mappings)
            or "MISC."
        ),
        sheet_categories=layout,
    )
    spread = processed.get(
        (year, month),
        {
            "expenses": {c: [] for c in layout},
            "income": [],
            "transfers": [],
            "summary": {"total_spent": 0, "total_made": 0, "net": 0, "saved_pct": 0},
        },
    )
    detailed, internal_by_id, type_by_id = _monthly_details(
        conn, txns, layout, rules, mappings, type_rules
    )
    return {
        "summary": spread["summary"],
        "expenses": spread["expenses"],
        "income": spread["income"],
        "transfers": spread["transfers"],
        "transactions": [
            _monthly_transaction(t, internal_by_id, type_by_id) for t in txns
        ],
        "detailed": detailed,
        "sheet_categories": layout,
    }


def _monthly_details(conn, txns, layout, rules, mappings, type_rules):
    detailed: dict[str, list[dict]] = {category: [] for category in layout}
    detailed.update({"income": [], "transfers": []})
    internal_by_id: dict[str, str] = {}
    type_by_id: dict[str, str] = {}
    for txn in txns:
        resolved = resolve_transaction_type(
            conn, txn, type_rules=type_rules, category_rules=rules
        )
        internal = (
            resolve_category_for_transaction(conn, txn, rules=rules, mappings=mappings)
            or "MISC."
        )
        internal_by_id[txn.plaid_transaction_id] = internal
        type_by_id[txn.plaid_transaction_id] = resolved
        sheet = _sheet_for_transaction(resolved, internal, layout, detailed)
        detailed[sheet].append(_detail_row(conn, txn, internal, resolved, sheet))
    for entries in detailed.values():
        entries.sort(key=lambda item: item["date"], reverse=True)
    return detailed, internal_by_id, type_by_id


def _sheet_for_transaction(resolved, internal, layout, detailed) -> str:
    if resolved in ("income", "transfer"):
        return "transfers" if resolved == "transfer" else "income"
    mapped = next(
        (
            category
            for category in layout
            if CATEGORY_MAP.get(category) and CATEGORY_MAP.get(category) == internal
        ),
        None,
    )
    return mapped or (internal if internal in detailed else "MISC.")


def _classification_trace(conn, txn) -> list:
    try:
        return get_classification_trace(conn, txn)
    except sqlite3.Error:
        return []


def _detail_row(conn, txn, internal, resolved, sheet) -> dict:
    return {
        "txn_id": txn.plaid_transaction_id,
        "merchant": _first_text(txn.merchant, txn.raw_description),
        "raw_description": _first_text(txn.raw_description),
        "amount": float(abs(txn.amount)),
        "signed_amount": float(txn.amount),
        "date": _date_text(txn.date),
        "institution": _first_text(txn.institution),
        "account_id": _first_text(txn.account_id),
        "category_internal": internal,
        "category_mapped": internal,
        "sheet_category": sheet,
        "pfc_primary": _first_text(txn.pfc_primary),
        "pfc_detailed": _first_text(txn.pfc_detailed),
        "plaid_category": _first_text(txn.plaid_category),
        "plaid_subcategory": _first_text(txn.plaid_subcategory),
        "payment_processor": _first_text(txn.payment_processor),
        "pending": bool(txn.pending),
        "transaction_type": _first_text(txn.type_override, resolved).upper(),
        "type_override": _first_text(txn.type_override),
        "trace": _classification_trace(conn, txn),
    }


def _first_text(*values) -> str:
    return next((value for value in values if value), "")


def _date_text(value) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _monthly_transaction(txn, internal_by_id, type_by_id) -> dict:
    return {
        "plaid_transaction_id": txn.plaid_transaction_id,
        "merchant": txn.merchant,
        "raw_description": txn.raw_description,
        "amount": float(txn.amount),
        "date": _date_text(txn.date),
        "category": internal_by_id.get(txn.plaid_transaction_id, "MISC."),
        "institution": txn.institution,
        "account_id": txn.account_id,
        "transaction_type": (
            txn.type_override or type_by_id.get(txn.plaid_transaction_id, "")
        ).upper(),
        "type_override": txn.type_override,
        "pfc_primary": txn.pfc_primary,
        "pfc_detailed": txn.pfc_detailed,
    }


def summary_stats(
    conn, year: int, month: int, owner_user_id: str | None = None
) -> dict:
    data = monthly_spreadsheet_data(conn, year, month, owner_user_id)

    start, end = (
        f"{year}-{month:02d}-01",
        f"{year + 1}-01-01" if month == 12 else f"{year}-{month + 1:02d}-01",
    )
    raw = gt(conn, start, end, owner_user_id=owner_user_id)
    category_rules = get_category_rules(conn)
    mappings = get_taxonomy_mappings(conn)
    uncat_list = [
        {
            "txn_id": t.plaid_transaction_id,
            "merchant": t.merchant or t.raw_description or "",
            "amount": float(abs(t.amount)),
        }
        for t in raw
        if resolve_category_for_transaction(
            conn, t, rules=category_rules, mappings=mappings
        )
        is None
        and resolve_transaction_type(conn, t, category_rules=category_rules)
        == "expense"
    ]
    s = data["summary"]
    return {
        "uncategorized_count": len(uncat_list),
        "uncategorized": uncat_list,
        "total_spent": s["total_spent"],
        "total_made": s["total_made"],
        "net": s["net"],
        "saved_pct": s["saved_pct"],
        "txn_count": len(raw),
    }


def yearly_summary(conn, year: int, owner_user_id: str | None = None) -> dict:
    layout = get_sheet_layout(conn)
    rules = get_category_rules(conn)
    mappings = get_taxonomy_mappings(conn)
    type_rules = get_type_rules(conn)
    monthly_txns = _year_transactions(conn, year, owner_user_id)
    processed = process_monthly_data(
        monthly_txns,
        type_resolver=lambda t: resolve_transaction_type(
            conn, t, type_rules=type_rules, category_rules=rules
        ),
        category_resolver=lambda t: (
            resolve_category_for_transaction(conn, t, rules=rules, mappings=mappings)
            or "MISC."
        ),
        sheet_categories=layout,
    )
    budget = get_monthly_budget(conn)
    budget_amt = float(budget) if budget is not None else 0.0
    caps_by_id = get_category_caps(conn)
    id_by_name = get_category_ids(conn)
    expense_by_month = [0.0] * 12
    categories, totals = _year_categories(
        year, layout, processed, caps_by_id, id_by_name, expense_by_month
    )
    income_by_month = _year_income(year, processed)
    year_total = round(sum(expense_by_month), 2)
    for c, total in zip(categories, totals):
        c["percentage"] = round(total / year_total * 100, 2) if year_total else 0.0
    budget_row = [budget_amt] * 12
    net_row = [round(budget_amt - expense_by_month[m], 2) for m in range(12)]
    net_income_row = [
        round(income_by_month[m] - expense_by_month[m], 2) for m in range(12)
    ]
    return {
        "year": year,
        "categories": categories,
        "annual": {
            "expense": [round(x, 2) for x in expense_by_month],
            "expense_total": year_total,
            "expense_average": round(sum(expense_by_month) / 12, 2),
            "budget": budget_row,
            "budget_total": round(sum(budget_row), 2),
            "budget_average": round(sum(budget_row) / 12, 2),
            "net": net_row,
            "net_total": round(sum(net_row), 2),
            "net_average": round(sum(net_row) / 12, 2),
            "income": [round(x, 2) for x in income_by_month],
            "income_total": round(sum(income_by_month), 2),
            "income_average": round(sum(income_by_month) / 12, 2),
            "net_income": net_income_row,
            "net_income_total": round(sum(net_income_row), 2),
            "net_income_average": round(sum(net_income_row) / 12, 2),
        },
    }


def _year_transactions(conn, year: int, owner_user_id: str | None = None) -> dict:
    monthly = {}
    for month in range(1, 13):
        start = f"{year}-{month:02d}-01"
        end = f"{year + 1}-01-01" if month == 12 else f"{year}-{month + 1:02d}-01"
        monthly[(year, month)] = get_transactions_by_date_range(
            conn, start, end, owner_user_id=owner_user_id
        )
    return monthly


def _year_categories(year, layout, processed, caps_by_id, id_by_name, expense_by_month):
    categories = []
    totals = []
    for category in layout:
        monthly = _category_months(year, category, processed)
        for index, amount in enumerate(monthly):
            expense_by_month[index] += amount
        total = round(sum(monthly), 2)
        totals.append(total)
        category_id = id_by_name.get(category)
        cap = caps_by_id.get(category_id) if category_id is not None else None
        categories.append(_year_category(category, monthly, total, cap))
    return categories, totals


def _category_months(year, category, processed) -> list[float]:
    amounts = []
    for month in range(1, 13):
        expenses = processed.get((year, month), {"expenses": {}}).get("expenses", {})
        amounts.append(
            round(sum(float(item[1]) for item in expenses.get(category, [])), 2)
        )
    return amounts


def _year_category(category, monthly, total, cap) -> dict:
    return {
        "name": category,
        "monthly": monthly,
        "total": total,
        "average": round(total / 12, 2),
        "percentage": 0.0,
        "cap": float(cap) if cap is not None else None,
    }


def _year_income(year, processed) -> list[float]:
    totals = []
    for month in range(1, 13):
        income = processed.get((year, month), {"income": []}).get("income", [])
        totals.append(round(sum(float(item["amount"]) for item in income), 2))
    return totals
