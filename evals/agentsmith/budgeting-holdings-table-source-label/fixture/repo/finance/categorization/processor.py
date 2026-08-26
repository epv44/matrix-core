import logging
from decimal import Decimal

from finance.categorization.pfc_map import classify_txn

logger = logging.getLogger(__name__)

SHEET_CATEGORIES = [
    "Transportation",
    "Self",
    "Restaurants",
    "Groceries",
    "MISC.",
    "Living Expenses",
    "Baby",
    "Travel",
    "Cat Related",
    "Home Goods",
]

CATEGORY_MAP = {
    "Transportation": "Transportation",
    "Self": None,
    "Restaurants": "Restaurants",
    "Groceries": "Groceries",
    "MISC.": "MISC.",
    "Living Expenses": "Living Expenses",
    "Baby": "Baby",
    "Travel": "Travel",
    "Cat Related": "Cat Related",
    "Home Goods": None,
}


def process_monthly_data(
    monthly_txns: dict,
    type_resolver=None,
    category_resolver=None,
    sheet_categories=None,
) -> dict:
    result = {}
    cats = list(sheet_categories or SHEET_CATEGORIES)
    for (year, month), txns in monthly_txns.items():
        _log_transactions(year, month, txns)
        expenses, income_txns, transfer_txns = _partition_transactions(
            txns, cats, type_resolver, category_resolver
        )
        result[(year, month)] = _month_result(expenses, income_txns, transfer_txns)
    return result


def _log_transactions(year, month, txns) -> None:
    for txn in txns:
        logger.debug(
            "processor in %s-%s: %s $%s cat=%s id=%s",
            year,
            month,
            txn.merchant or txn.raw_description,
            txn.amount,
            txn.category,
            txn.plaid_transaction_id[:24],
        )


def _partition_transactions(txns, cats, type_resolver, category_resolver):
    expenses: dict[str, list[tuple[str, Decimal]]] = {cat: [] for cat in cats}
    income_txns = []
    transfer_txns = []
    for txn in txns:
        txn_type = type_resolver(txn) if type_resolver else classify_txn(txn)
        if txn_type == "transfer":
            transfer_txns.append(txn)
        elif txn_type == "income":
            income_txns.append(txn)
        else:
            category = (
                category_resolver(txn)
                if category_resolver
                else (txn.category or "MISC.")
            )
            _append_expense(expenses, cats, category, txn)
    return expenses, income_txns, transfer_txns


def _append_expense(expenses, cats, category, txn) -> None:
    sheet_category = next(
        (
            cat
            for cat in cats
            if CATEGORY_MAP.get(cat) and CATEGORY_MAP.get(cat) == category
        ),
        None,
    )
    destination = sheet_category or category
    if destination not in expenses:
        destination = "MISC." if "MISC." in expenses else SHEET_CATEGORIES[0]
    expenses[destination].append(
        (txn.merchant or txn.raw_description or "", abs(txn.amount))
    )


def _transaction_summary(txn) -> dict:
    return {
        "txn_id": txn.plaid_transaction_id,
        "merchant": txn.merchant or txn.raw_description or "",
        "amount": float(abs(txn.amount)),
    }


def _month_result(expenses, income_txns, transfer_txns) -> dict:
    income_total = sum(abs(txn.amount) for txn in income_txns)
    expense_total = sum(value for items in expenses.values() for _, value in items)
    net = income_total - expense_total
    saved_pct = net / income_total * 100 if income_total > 0 else Decimal("0.00")
    return {
        "expenses": expenses,
        "income": [_transaction_summary(txn) for txn in income_txns],
        "transfers": [_transaction_summary(txn) for txn in transfer_txns],
        "summary": {
            "total_spent": float(expense_total),
            "total_made": float(income_total),
            "net": float(net),
            "saved_pct": round(float(saved_pct), 2),
        },
    }
