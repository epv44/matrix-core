"""Deterministic portfolio resolution, flow reconciliation, and reporting."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from itertools import pairwise

from finance.services.categorization import resolve_transaction_type
from finance.services.goals import (
    _assigned_to_source,
    _source_value,
    goal_summary,
    reserved_amounts,
)
from finance.storage.repositories.goals import get_account_type
from finance.storage.repositories.portfolio import (
    account_exists,
    create_cash_earmark_records,
    delete_account_asset_allocations,
    delete_cash_earmark_records,
    delete_security_asset_allocations,
    get_flow_row,
    get_latest_snapshot_date,
    list_account_asset_allocations,
    list_account_rows,
    list_account_sync_rows,
    list_benchmark_prices,
    list_cash_earmarks,
    list_cash_snapshot_rows,
    list_current_holding_rows,
    list_depository_flow_source_rows,
    list_equity_compensation_rows,
    list_flow_rows,
    list_holding_snapshot_rows,
    list_investment_flow_source_rows,
    list_latest_cash_balance_rows,
    list_security_asset_allocations,
    list_security_rows,
    list_snapshot_coverage_rows,
    replace_account_asset_allocations,
    replace_security_asset_allocations,
    security_exists,
    update_flow_classification,
    upsert_account_preferences,
    upsert_system_flow,
)
from finance.storage.repository import (
    get_target_allocation,
    get_transactions_by_date_range,
)

ASSET_CLASSES = (
    "US_EQUITY",
    "INTERNATIONAL_EQUITY",
    "BONDS",
    "CASH",
    "REAL_ESTATE",
    "OTHER",
)
TARGET_CLASSES = ("US_EQUITY", "INTERNATIONAL_EQUITY", "BONDS")
ACCOUNT_CATEGORIES = {
    "CASH",
    "BROKERAGE",
    "RETIREMENT",
    "EDUCATION",
    "HEALTH_SAVINGS",
    "EQUITY_COMPENSATION",
    "OTHER",
}
RETIREMENT_SUBTYPES = {
    "401k",
    "403b",
    "457b",
    "ira",
    "roth",
    "roth 401k",
    "simple ira",
    "sep ira",
    "pension",
}
ACCOUNT_SUBTYPE_CATEGORIES = {
    **dict.fromkeys(RETIREMENT_SUBTYPES, "RETIREMENT"),
    "529": "EDUCATION",
    "hsa": "HEALTH_SAVINGS",
    "stock plan": "EQUITY_COMPENSATION",
    "brokerage": "BROKERAGE",
}
US_TICKERS = {
    "VTI",
    "VOO",
    "SPY",
    "IVV",
    "ITOT",
    "SCHB",
    "META",
    "AAPL",
    "MSFT",
    "AMZN",
    "GOOG",
    "GOOGL",
    "NVDA",
    "TSLA",
}
INTERNATIONAL_TICKERS = {"VXUS", "VEA", "VWO", "IXUS", "SCHF", "IEMG"}
BOND_TICKERS = {"BND", "AGG", "BSV", "BIV", "BLV", "TLT", "IEF", "SCHZ"}
REAL_ESTATE_TICKERS = {"VNQ", "SCHH", "IYR", "USRT"}
TICKER_ASSET_CLASSES = {
    **dict.fromkeys(INTERNATIONAL_TICKERS, ("INTERNATIONAL_EQUITY", "SYSTEM")),
    **dict.fromkeys(BOND_TICKERS, ("BONDS", "SYSTEM")),
    **dict.fromkeys(REAL_ESTATE_TICKERS, ("REAL_ESTATE", "SYSTEM")),
    **dict.fromkeys(US_TICKERS, ("US_EQUITY", "SYSTEM")),
}
TEXT_CLASSIFICATION_RULES = (
    (("INTERNATIONAL",), ("INTERNATIONAL_EQUITY", "SYSTEM")),
    ((" BOND", "FIXED INCOME"), ("BONDS", "SYSTEM")),
    (("REAL ESTATE", " REIT"), ("REAL_ESTATE", "SYSTEM")),
    (("CASH", "MONEY MARKET"), ("CASH", "PROVIDER")),
)


@dataclass(frozen=True)
class PortfolioFilters:
    range: str = "1Y"
    start_date: date | None = None
    end_date: date | None = None
    view: str = "ALL_ASSETS"
    account_ids: tuple[str, ...] = ()
    include_401k: bool = True
    cash_policy: str = "ALL"
    include_goal_reserved: bool = True


def get_investment_dashboard(conn) -> dict:
    """Compatibility projection of the unified portfolio dashboard."""
    dashboard = build_dashboard(conn, PortfolioFilters(range="ALL"))
    summary = dashboard["summary"]
    securities = [
        {
            "id": row["security_id"],
            "label": row["holding"],
            "value": row["value"],
            "percentage": row["allocation"],
        }
        for row in dashboard["holdings"]
        if row["security_id"] is not None
    ]
    return {
        "total_value": summary["current_portfolio_value"],
        "cost_basis": summary["cost_basis"] or 0.0,
        "market_appreciation": summary["unrealized_gain_loss"] or 0.0,
        "accounts": dashboard["accounts"],
        "securities": securities,
        "flows": {
            "contributions": dashboard["flows"]["contributions"],
            "dividends_interest": dashboard["flows"]["dividends"]
            + dashboard["flows"]["interest"],
            "purchases": 0.0,
            "sales": 0.0,
            "employer_equity": 0.0,
            "tax_withholding": 0.0,
        },
        "snapshots": dashboard["snapshots"],
        "asset_allocation": dashboard["allocation"],
        "target_allocation": dashboard["target_allocation"],
        "target_comparison": dashboard["target_comparison"]["rows"],
        "data_quality": dashboard["data_quality"],
    }


def build_dashboard(conn, filters: PortfolioFilters | None = None) -> dict:
    filters = filters or PortfolioFilters()
    reconcile_portfolio_flows(conn)
    accounts = _load_accounts(conn)
    all_assets = _load_current_assets(conn, accounts)
    assets = _filter_assets(all_assets, accounts, filters)
    period_start, period_end = _period_boundaries(conn, filters)
    flows = _filtered_flows(conn, accounts, filters, period_start, period_end)
    snapshots = _portfolio_snapshots(conn, accounts, filters, period_start, period_end)
    equity_compensation = _equity_compensation(
        conn, accounts, filters, period_start, period_end
    )
    performance = _performance(
        conn, snapshots, flows, equity_compensation["linked_flows"]
    )
    growth = _growth_decomposition(
        snapshots, flows, equity_compensation["linked_asset_additions"]
    )
    allocation = _allocation(assets)
    target = _target_allocation(conn)
    target_comparison = _target_comparison(allocation, target, _asset_total(assets))
    holdings = _holdings(assets)
    ytd_filters = PortfolioFilters(
        range="YTD",
        end_date=period_end,
        view=filters.view,
        account_ids=filters.account_ids,
        include_401k=filters.include_401k,
        cash_policy=filters.cash_policy,
        include_goal_reserved=filters.include_goal_reserved,
    )
    ytd_start = date(period_end.year, 1, 1)
    ytd_flows = _filtered_flows(conn, accounts, ytd_filters, ytd_start, period_end)
    ytd_equity = _equity_compensation(
        conn, accounts, ytd_filters, ytd_start, period_end
    )
    contribution_summary = _contribution_summary(
        ytd_flows, accounts, assets, ytd_equity["linked_asset_additions"]
    )
    wealth_bridge = _wealth_bridge(
        conn,
        accounts,
        filters,
        period_start,
        period_end,
        flows,
        growth,
        equity_compensation,
    )

    goals = goal_summary(conn)
    summary = _summary(
        conn,
        all_assets,
        assets,
        accounts,
        filters,
        flows,
        snapshots,
        performance,
        growth,
        holdings,
    )
    warnings = _data_quality_warnings(
        assets, holdings, snapshots, performance, flows, allocation
    )
    if equity_compensation["unlinked_events"]:
        warnings.append(
            {
                "code": "UNLINKED_EQUITY_COMPENSATION",
                "message": (
                    f"{equity_compensation['unlinked_events']} equity compensation "
                    "event(s) are not linked to an investment account."
                ),
            }
        )
    return {
        "summary": summary,
        "filters": _filter_metadata(accounts, filters, period_start, period_end),
        "accounts": _account_allocation(assets),
        "allocation": allocation,
        "risk_allocation": _risk_allocation(allocation),
        "target_allocation": target,
        "target_comparison": target_comparison,
        "rebalancing": _contribution_guidance(target_comparison),
        "performance": performance,
        "growth_decomposition": growth,
        "contribution_activity": _contribution_activity(flows, accounts),
        "contribution_summary": contribution_summary,
        "wealth_bridge": wealth_bridge,
        "goals": goals,
        "wealth_allocation": _wealth_allocation(all_assets, accounts, filters, goals),
        "equity_compensation": equity_compensation,
        "sync": _sync_freshness(conn, accounts, filters),
        "flows": _flow_totals(flows),
        "holdings": holdings,
        "snapshots": snapshots,
        "data_quality": {
            "status": "COMPLETE" if not warnings else "PARTIAL",
            "warnings": warnings,
            "history_start": performance.get("coverage_start"),
            "history_end": performance.get("coverage_end"),
            "benchmark_available": bool(_benchmark_prices(conn)),
            "benchmark_label": "S&P 500 total-return proxy (SPY adjusted close)",
        },
    }


def _load_accounts(conn) -> dict[str, dict]:
    rows = list_account_rows(conn)

    earmarks: defaultdict[str, float] = defaultdict(float)
    for (source_type, account_id, security_id), amount in reserved_amounts(
        conn
    ).items():
        if source_type == "ACCOUNT" and security_id is None:
            earmarks[account_id] += amount
    return {
        row["account_id"]: _account_metadata(row, earmarks[row["account_id"]])
        for row in rows
    }


def _account_metadata(row: dict, earmarked: float) -> dict:
    subtype = (row.get("subtype") or "").lower()
    is_401k = (
        bool(row["preferred_is_401k"])
        if row.get("preferred_is_401k") is not None
        else bool(row.get("is_401k")) or subtype in {"401k", "roth 401k"}
    )
    automatic_category = _automatic_account_category(row, is_401k)
    preferred_category = row.get("preferred_account_category")
    account_category = preferred_category or automatic_category
    preferred_tax_status = row.get("preferred_tax_status")
    provider_tax_status = row.get("tax_status")
    tax_status = _normalized_tax_status(
        preferred_tax_status
        if preferred_tax_status is not None
        else (
            None
            if account_category in {"EDUCATION", "HEALTH_SAVINGS"}
            else provider_tax_status
        ),
        account_category,
    )
    illiquid = account_category in {"RETIREMENT", "EDUCATION", "HEALTH_SAVINGS"}
    return {
        **row,
        "is_401k": is_401k,
        "tax_status": tax_status,
        "account_category": account_category,
        "category_source": "USER" if preferred_category else "AUTOMATIC",
        "liquidity": row.get("liquidity") or ("ILLIQUID" if illiquid else "LIQUID"),
        "include_by_default": row.get("include_by_default") != 0,
        "is_active": row.get("is_active") != 0,
        "inactive_since": row.get("inactive_since"),
        "earmarked": earmarked,
    }


def _automatic_account_category(account: dict, is_401k: bool) -> str:
    account_type = (account.get("type") or "").lower()
    subtype = (account.get("subtype") or "").lower()
    name = (account.get("name") or "").lower()
    if account_type == "depository":
        return "CASH"
    if is_401k:
        return "RETIREMENT"
    mapped = ACCOUNT_SUBTYPE_CATEGORIES.get(subtype)
    if mapped:
        return mapped
    if _is_espp(subtype, name):
        return "EQUITY_COMPENSATION"
    return "OTHER"


def _load_current_assets(conn, accounts: dict[str, dict]) -> list[dict]:
    holdings = list_current_holding_rows(conn)
    assets = [_holding_asset(conn, row, accounts) for row in holdings]
    holding_accounts = {asset["account_id"] for asset in assets}
    assets.extend(_balance_assets(conn, accounts, holding_accounts))
    _attach_goal_reservations(conn, assets)
    return [asset for asset in assets if asset["value"] != 0]


def _attach_goal_reservations(conn, assets) -> None:

    reserved = reserved_amounts(conn)
    for asset in assets:
        source_type = "HOLDING" if asset.get("security_id") else "ACCOUNT"
        key = (source_type, asset["account_id"], asset.get("security_id"))
        asset["reserved"] = min(asset["value"], reserved.get(key, 0.0))


def _holding_asset(conn, row: dict, accounts: dict[str, dict]) -> dict:
    account = accounts.get(row["account_id"], _missing_account(row["account_id"]))
    allocation, class_source = resolve_security_allocation(
        conn,
        row.get("security_id"),
        row.get("ticker"),
        row.get("security_name"),
        row.get("security_type"),
        row.get("security_subtype"),
    )
    asset_class = _dominant_asset_class(allocation)
    return {
        **row,
        "id": f"security:{row['account_id']}:{row.get('security_id') or 'unknown'}",
        "label": row.get("ticker") or row.get("security_name") or "Unknown holding",
        "account_name": account.get("name") or row["account_id"],
        "account_category": account.get("account_category", "OTHER"),
        "category_source": account.get("category_source", "AUTOMATIC"),
        "asset_class": asset_class,
        "asset_allocation": allocation,
        "classification_source": class_source,
        "instrument_type": row.get("security_type"),
        "instrument_subtype": row.get("security_subtype"),
        "value": float(row.get("value") or 0),
        "cost_basis": _optional_float(row.get("cost_basis")),
        "value_source": "holdings",
    }


def _balance_assets(conn, accounts, holding_accounts) -> list[dict]:
    snapshots = _latest_cash_balances(conn)
    assets = []
    for account_id, account in accounts.items():
        if account_id in holding_accounts or account.get("type") not in {
            "depository",
            "investment",
        }:
            continue
        balance, source = snapshots.get(account_id, (None, None))
        if balance is None:
            balance = _raw_current_balance(account.get("raw_payload"))
            source = "account_balance"
        if balance is None:
            continue
        allocation, class_source = resolve_account_allocation(
            conn, account_id, account.get("type")
        )
        asset_class = _dominant_asset_class(allocation)
        assets.append(
            {
                "id": f"account:{account_id}",
                "account_id": account_id,
                "account_name": account.get("name") or account_id,
                "account_category": account.get("account_category", "OTHER"),
                "category_source": account.get("category_source", "AUTOMATIC"),
                "security_id": None,
                "ticker": None,
                "label": account.get("name") or account_id,
                "quantity": None,
                "price": None,
                "value": float(balance),
                "cost_basis": None,
                "asset_class": asset_class,
                "asset_allocation": allocation,
                "classification_source": class_source,
                "instrument_type": account.get("type"),
                "instrument_subtype": account.get("subtype"),
                "value_source": source,
            }
        )
    return assets


def _latest_cash_balances(conn) -> dict[str, tuple[float, str]]:
    rows = list_latest_cash_balance_rows(conn)
    return {
        row["account_id"]: (float(row["balance"] or 0), "cash_snapshot") for row in rows
    }


def _raw_current_balance(raw_payload) -> float | None:
    try:
        current = json.loads(raw_payload or "{}").get("balances", {}).get("current")
        return float(current) if current is not None else None
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def _normalized_tax_status(raw_status, account_category):
    if raw_status:
        status = str(raw_status).upper().replace(" ", "_")
        if status in {"RETIREMENT", "TAX_DEFERRED", "TAX_EXEMPT"}:
            return "RETIREMENT"
        if status == "TAXABLE":
            return "TAXABLE"
    if account_category == "RETIREMENT":
        return "RETIREMENT"
    if account_category == "EDUCATION":
        return "EDUCATION"
    if account_category == "HEALTH_SAVINGS":
        return "HEALTH_SAVINGS"
    return "TAXABLE"


def resolve_account_allocation(
    conn, account_id, account_type=None
) -> tuple[list[dict], str]:
    override = list_account_asset_allocations(conn, account_id)
    if override:
        return (
            [
                {
                    "asset_class": row["asset_class"],
                    "percent": float(row["allocation_percent"]),
                }
                for row in override
            ],
            "USER",
        )
    asset_class = "CASH" if account_type == "depository" else "OTHER"
    return [{"asset_class": asset_class, "percent": 100.0}], "SYSTEM"


def resolve_security_allocation(
    conn, security_id, ticker=None, name=None, security_type=None, subtype=None
) -> tuple[list[dict], str]:
    override = list_security_asset_allocations(conn, security_id)
    if override:
        return (
            [
                {
                    "asset_class": row["asset_class"],
                    "percent": float(row["allocation_percent"]),
                }
                for row in override
            ],
            "USER"
            if any(row["source"] == "USER" for row in override)
            else override[0]["source"],
        )
    symbol = (ticker or "").upper().strip()
    text = f"{name or ''} {security_type or ''} {subtype or ''}".upper()
    asset_class, source = _inferred_security_classification(
        symbol, text, has_provider_metadata=bool(security_type or subtype)
    )
    return [{"asset_class": asset_class, "percent": 100.0}], source


def resolve_security_classification(
    conn, security_id, ticker=None, name=None, security_type=None, subtype=None
) -> tuple[str, str]:
    allocation, source = resolve_security_allocation(
        conn, security_id, ticker, name, security_type, subtype
    )
    return _dominant_asset_class(allocation), source


def _dominant_asset_class(allocation) -> str:
    order = {asset_class: index for index, asset_class in enumerate(ASSET_CLASSES)}
    return max(
        allocation,
        key=lambda row: (row["percent"], -order[row["asset_class"]]),
    )["asset_class"]


def _inferred_security_classification(symbol, text, *, has_provider_metadata):
    ticker_match = TICKER_ASSET_CLASSES.get(symbol)
    if ticker_match:
        return ticker_match
    text_match = next(
        (
            classification
            for terms, classification in TEXT_CLASSIFICATION_RULES
            if any(term in text for term in terms)
        ),
        None,
    )
    if text_match:
        return text_match
    return "OTHER", "PROVIDER" if has_provider_metadata else "SYSTEM"


def _filter_assets(assets, accounts, filters: PortfolioFilters) -> list[dict]:
    selected = [
        dict(asset)
        for asset in assets
        if _account_selected(accounts.get(asset["account_id"], {}), filters)
        and _asset_selected(asset, accounts.get(asset["account_id"], {}), filters)
    ]
    if not filters.include_goal_reserved:
        for asset in selected:
            asset["value"] -= min(asset["value"], asset.get("reserved", 0.0))
    elif filters.cash_policy == "EXCLUDE_EARMARKED":
        _subtract_earmarks(selected, accounts)
    return [asset for asset in selected if asset["value"] > 0]


def _account_selected(
    account: dict, filters: PortfolioFilters, *, include_inactive=False
) -> bool:
    if not include_inactive and not account.get("is_active", True):
        return False
    if not account.get("include_by_default", True):
        return False
    if filters.account_ids and account.get("account_id") not in filters.account_ids:
        return False
    return filters.include_401k or not account.get("is_401k", False)


def _account_selected_at(account, filters, event_date) -> bool:
    if not _account_selected(account, filters, include_inactive=True):
        return False
    inactive_since = account.get("inactive_since")
    return inactive_since is None or _as_date(event_date) <= _as_date(inactive_since)


def _asset_selected(asset: dict, account: dict, filters: PortfolioFilters) -> bool:
    if filters.cash_policy == "EXCLUDE_ALL" and _is_direct_cash(asset):
        return False
    if filters.view == "INVESTMENTS":
        return account.get("type") == "investment"
    if filters.view == "TAXABLE":
        return account.get("account_category") in {
            "BROKERAGE",
            "EQUITY_COMPENSATION",
        }
    if filters.view == "RETIREMENT":
        return account.get("account_category") == "RETIREMENT"
    if filters.view == "EDUCATION":
        return account.get("account_category") == "EDUCATION"
    if filters.view == "HEALTH_SAVINGS":
        return account.get("account_category") == "HEALTH_SAVINGS"
    if filters.view == "LIQUID":
        return account.get("liquidity") == "LIQUID"
    return True


def _is_direct_cash(asset: dict) -> bool:
    allocation = asset.get("asset_allocation")
    return (
        len(allocation) == 1 and allocation[0]["asset_class"] == "CASH"
        if allocation
        else asset["asset_class"] == "CASH"
    )


def _subtract_earmarks(assets, accounts) -> None:
    by_account = defaultdict(list)
    for asset in assets:
        if _is_direct_cash(asset):
            by_account[asset["account_id"]].append(asset)
    for account_id, cash_assets in by_account.items():
        remaining = accounts.get(account_id, {}).get("earmarked", 0.0)
        for asset in sorted(cash_assets, key=lambda item: item["value"], reverse=True):
            reduction = min(asset["value"], remaining)
            asset["value"] -= reduction
            remaining -= reduction


def _period_boundaries(conn, filters: PortfolioFilters) -> tuple[date | None, date]:
    latest = get_latest_snapshot_date(conn)
    end = filters.end_date or (
        _as_date(latest) if latest else datetime.now(timezone.utc).date()
    )
    if filters.start_date:
        return filters.start_date, end
    days = {"1M": 30, "3M": 90, "1Y": 365, "3Y": 1095, "5Y": 1825}
    if filters.range == "YTD":
        return date(end.year, 1, 1), end
    return (
        (end - timedelta(days=days[filters.range]), end)
        if filters.range in days
        else (None, end)
    )


def reconcile_portfolio_flows(conn) -> list[dict]:
    existing_rows = {
        (row["source_type"], row["source_id"]): row for row in list_flow_rows(conn)
    }
    user_rows = {
        key: row for key, row in existing_rows.items() if row["source"] == "USER"
    }
    events = _source_flow_events(conn)
    _restore_flow_classifications(events, existing_rows, user_rows)
    _match_internal_transfers(events)
    _persist_system_flows(conn, events, user_rows)
    conn.commit()
    return events


def _restore_flow_classifications(events, existing_rows, user_rows) -> None:
    event_keys = {_flow_key(event) for event in events}
    for event in events:
        override = user_rows.get((event["source_type"], event["source_id"]))
        if override:
            event.update(override)
            continue
        previous = existing_rows.get(_flow_key(event))
        if previous and _preservable_transfer(previous, event_keys):
            event.update(previous)


def _persist_system_flows(conn, events, user_rows) -> None:
    for event in events:
        if (event["source_type"], event["source_id"]) in user_rows:
            continue
        _upsert_flow(conn, event)


def _source_flow_events(conn) -> list[dict]:
    events: list[dict] = []
    rows = list_depository_flow_source_rows(conn)
    events.extend(_depository_flow(row) for row in rows if row["amount"])
    rows = list_investment_flow_source_rows(conn)
    events.extend(_investment_flow(row) for row in rows if row["amount"])
    return events


def _depository_flow(row: dict) -> dict:
    amount = -float(row["amount"] or 0)
    text = " ".join(
        str(row.get(key) or "")
        for key in (
            "merchant",
            "raw_description",
            "type_override",
            "pfc_primary",
            "pfc_detailed",
        )
    ).upper()
    if "INTEREST" in text:
        flow_type = "INTEREST"
        amount = abs(amount)
    else:
        flow_type = "CONTRIBUTION" if amount > 0 else "WITHDRAWAL"
    return _flow_event(
        "DEPOSITORY",
        row,
        amount,
        flow_type,
        "TRANSFER" in text,
        row.get("currency") or "USD",
    )


def _investment_flow(row: dict) -> dict:
    amount = -float(row["amount"] or 0)
    text = f"{row.get('type') or ''} {row.get('subtype') or ''}".upper()
    if "DIVIDEND" in text:
        flow_type, amount = "DIVIDEND", abs(amount)
    elif "INTEREST" in text:
        flow_type, amount = "INTEREST", abs(amount)
    elif any(
        word in text for word in ("TRANSFER", "CONTRIBUTION", "DEPOSIT", "WITHDRAW")
    ):
        flow_type = "CONTRIBUTION" if amount > 0 else "WITHDRAWAL"
    else:
        flow_type = "IGNORE"
    return _flow_event(
        "INVESTMENT",
        row,
        amount,
        flow_type,
        "TRANSFER" in text,
        _investment_currency(row.get("raw_payload")),
    )


def _flow_event(source_type, row, amount, flow_type, transfer_hint, currency):
    return {
        "source_type": source_type,
        "source_id": row["plaid_transaction_id"],
        "date": _as_date(row["date"]),
        "account_id": row["account_id"],
        "amount": amount,
        "currency": currency,
        "flow_type": flow_type,
        "matched_source_type": None,
        "matched_source_id": None,
        "source": "SYSTEM",
        "transfer_hint": transfer_hint,
    }


def _match_internal_transfers(events) -> None:
    candidates = [
        event
        for event in events
        if event["source"] != "USER"
        and event["flow_type"] in {"CONTRIBUTION", "WITHDRAWAL"}
    ]
    used: set[tuple[str, str]] = set()
    for outgoing in sorted(
        (event for event in candidates if event["amount"] < 0), key=_flow_sort_key
    ):
        matches = [
            incoming
            for incoming in candidates
            if _is_transfer_match(incoming, outgoing, used)
        ]
        if not matches:
            continue
        incoming = min(
            matches,
            key=lambda item: (
                abs((item["date"] - outgoing["date"]).days),
                _flow_sort_key(item),
            ),
        )
        _mark_transfer_pair(outgoing, incoming)
        used.update({_flow_key(outgoing), _flow_key(incoming)})


def _is_transfer_match(incoming, outgoing, used) -> bool:
    transfer_context = (
        incoming["transfer_hint"]
        or outgoing["transfer_hint"]
        or incoming["source_type"] != outgoing["source_type"]
    )
    return all(
        (
            incoming["amount"] > 0,
            incoming["account_id"] != outgoing["account_id"],
            _same_amount(incoming["amount"], outgoing["amount"]),
            incoming["currency"] == outgoing["currency"],
            abs((incoming["date"] - outgoing["date"]).days) <= 3,
            transfer_context,
            _flow_key(incoming) not in used,
        )
    )


def _mark_transfer_pair(left, right):
    left["flow_type"] = right["flow_type"] = "INTERNAL_TRANSFER"
    left["matched_source_type"], left["matched_source_id"] = _flow_key(right)
    right["matched_source_type"], right["matched_source_id"] = _flow_key(left)


def _upsert_flow(conn, event) -> None:
    upsert_system_flow(conn, event)


def _filtered_flows(conn, accounts, filters, start, end) -> list[dict]:
    rows = list_flow_rows(conn)
    result = []
    for row in rows:
        account = accounts.get(row["account_id"], {})
        flow_date = _as_date(row["flow_date"])
        if start and flow_date < start or flow_date > end:
            continue
        probe = {
            "asset_class": "CASH" if account.get("type") == "depository" else "OTHER"
        }
        if not _account_selected_at(account, filters, flow_date) or not _asset_selected(
            probe, account, filters
        ):
            continue
        row["date"] = flow_date.isoformat()
        row["amount"] = float(row["amount"] or 0)
        result.append(row)
    return result


def _portfolio_snapshots(conn, accounts, filters, start, end) -> list[dict]:

    by_date = defaultdict(list)
    holding_accounts_by_date = defaultdict(set)
    reservations = reserved_amounts(conn)
    expected_accounts = _selected_snapshot_accounts(accounts, filters)
    coverage = _snapshot_account_coverage(conn, accounts, expected_accounts, start, end)
    rows = list_holding_snapshot_rows(conn)
    for raw in rows:
        row = raw
        snapshot_date = _as_date(row["snapshot_date"])
        if not _date_selected(snapshot_date, start, end):
            continue
        account = accounts.get(row["account_id"], {})
        allocation, _ = resolve_security_allocation(
            conn,
            row["security_id"],
            row["ticker"],
            row["security_name"],
            row["security_type"],
            row["security_subtype"],
        )
        asset_class = _dominant_asset_class(allocation)
        asset = {
            "account_id": row["account_id"],
            "asset_class": asset_class,
            "asset_allocation": allocation,
        }
        if _account_selected_at(account, filters, snapshot_date) and _asset_selected(
            asset, account, filters
        ):
            row["asset_class"] = asset_class
            row["reserved"] = reservations.get(
                ("HOLDING", row["account_id"], row["security_id"]), 0.0
            )
            by_date[snapshot_date].append(row)
            holding_accounts_by_date[snapshot_date].add(row["account_id"])
    _add_cash_snapshot_rows(
        conn,
        by_date,
        holding_accounts_by_date,
        accounts,
        filters,
        start,
        end,
        reservations,
    )
    if coverage:
        for snapshot_date in coverage["dates"]:
            by_date.setdefault(snapshot_date, [])
    return _snapshot_totals(by_date, accounts, filters, expected_accounts, coverage)


def _selected_snapshot_accounts(accounts, filters):
    selected = set()
    for account_id, account in accounts.items():
        if account.get("type") not in {"depository", "investment"}:
            continue
        probe = {
            "account_id": account_id,
            "asset_class": "CASH" if account.get("type") == "depository" else "OTHER",
        }
        if _account_selected(
            account, filters, include_inactive=True
        ) and _asset_selected(probe, account, filters):
            selected.add(account_id)
    return selected


def _collect_snapshot_status(rows, expected_accounts):
    first_complete = {}
    status_by_date: defaultdict[date, dict[str, bool]] = defaultdict(dict)
    for row in rows:
        if row["account_id"] not in expected_accounts:
            continue
        snapshot_date = _as_date(row["snapshot_date"])
        is_complete = bool(row["is_complete"])
        status_by_date[snapshot_date][row["account_id"]] = is_complete
        if is_complete and row["account_id"] not in first_complete:
            first_complete[row["account_id"]] = snapshot_date
    return first_complete, status_by_date


def _account_inactive_dates(accounts, expected_accounts):
    result = {}
    for account_id in expected_accounts:
        inactive_since = accounts[account_id].get("inactive_since")
        result[account_id] = _as_date(inactive_since) if inactive_since else None
    return result


def _snapshot_account_coverage(conn, accounts, expected_accounts, start, end):
    if not expected_accounts:
        return None
    rows = list_snapshot_coverage_rows(conn, end.isoformat())
    if not rows:
        return None
    first_complete, status_by_date = _collect_snapshot_status(rows, expected_accounts)
    if not expected_accounts.issubset(first_complete):
        return None
    common_start = max(first_complete.values())
    effective_start = max(common_start, start) if start else common_start
    dates = {
        snapshot_date
        for snapshot_date in status_by_date
        if effective_start <= snapshot_date <= end
    }
    return {
        "common_start": common_start,
        "dates": dates,
        "status_by_date": status_by_date,
        "first_complete": first_complete,
        "inactive_since": _account_inactive_dates(accounts, expected_accounts),
    }


def _add_cash_snapshot_rows(
    conn, by_date, holding_accounts_by_date, accounts, filters, start, end, reservations
):
    rows = list_cash_snapshot_rows(conn)
    for raw in rows:
        row = raw
        snapshot_date = _as_date(row["snapshot_date"])
        account = accounts.get(row["account_id"], {})
        asset_class = "CASH" if account.get("type") == "depository" else "OTHER"
        asset = {
            "account_id": row["account_id"],
            "asset_class": asset_class,
            "asset_allocation": [{"asset_class": asset_class, "percent": 100.0}],
        }
        if not _date_selected(snapshot_date, start, end):
            continue
        if row["account_id"] in holding_accounts_by_date[snapshot_date]:
            continue
        if _account_selected_at(account, filters, snapshot_date) and _asset_selected(
            asset, account, filters
        ):
            row["asset_class"] = asset_class
            row["cost_basis"] = None
            row["reserved"] = reservations.get(
                ("ACCOUNT", row["account_id"], None), 0.0
            )
            by_date[snapshot_date].append(row)


def _snapshot_totals(by_date, accounts, filters, expected_accounts, coverage):
    return [
        _snapshot_total(
            snapshot_date,
            rows,
            accounts,
            filters,
            expected_accounts,
            coverage,
        )
        for snapshot_date, rows in sorted(by_date.items())
        if coverage is None or snapshot_date >= coverage["common_start"]
    ]


def _snapshot_total(
    snapshot_date, rows, accounts, filters, expected_accounts, coverage
):
    adjusted = [dict(row) for row in rows]
    if not filters.include_goal_reserved:
        _subtract_snapshot_reservations(adjusted, accounts)
    elif filters.cash_policy == "EXCLUDE_EARMARKED":
        _subtract_earmarks(adjusted, accounts)
    values = [max(0.0, float(row.get("value") or 0)) for row in adjusted]
    complete = (
        _coverage_is_complete(coverage, snapshot_date, expected_accounts)
        if coverage
        else _snapshot_is_complete(adjusted, expected_accounts)
    )
    return {
        "date": snapshot_date.isoformat(),
        "value": sum(values),
        "cost_basis": _snapshot_cost_basis(adjusted),
        "complete": complete,
    }


def _subtract_snapshot_reservations(rows, accounts) -> None:
    # Goal assignments do not currently have historical effective dates. Applying the
    # present reservation is deterministic and matches the current allocation filter.
    for row in rows:
        row["value"] = max(
            0.0, float(row.get("value") or 0) - float(row.get("reserved") or 0)
        )


def _coverage_is_complete(coverage, snapshot_date, expected_accounts):
    statuses = coverage["status_by_date"].get(snapshot_date, {})
    required_accounts = {
        account_id
        for account_id in expected_accounts
        if coverage["first_complete"][account_id] <= snapshot_date
        and (
            coverage["inactive_since"][account_id] is None
            or snapshot_date <= coverage["inactive_since"][account_id]
        )
    }
    return required_accounts.issubset(statuses) and all(
        statuses[account_id] for account_id in required_accounts
    )


def _snapshot_cost_basis(rows):
    return sum(
        float(row["cost_basis"]) for row in rows if row.get("cost_basis") is not None
    )


def _snapshot_is_complete(rows, expected_accounts):
    present = {row["account_id"] for row in rows if float(row.get("value") or 0) != 0}
    return all(bool(row.get("is_complete", 1)) for row in rows) and (
        expected_accounts.issubset(present)
    )


def _unavailable_performance(complete_snapshots):
    return {
        "available": False,
        "reason": "At least two complete portfolio snapshots are required.",
        "method": None,
        "is_estimate": False,
        "portfolio_return": None,
        "twr": None,
        "benchmark_return": None,
        "difference": None,
        "series": [],
        "coverage_start": complete_snapshots[0]["date"] if complete_snapshots else None,
        "coverage_end": complete_snapshots[-1]["date"] if complete_snapshots else None,
    }


def _external_performance_flows(flows, additional_external_flows):
    external_flows = []
    signs = {"CONTRIBUTION": 1, "WITHDRAWAL": -1}
    for flow in flows:
        if flow["flow_type"] in signs:
            amount = signs[flow["flow_type"]] * abs(flow["amount"])
            external_flows.append((flow["date"], amount))
    external_flows.extend(
        (flow["date"], float(flow["amount"]))
        for flow in additional_external_flows or []
    )
    return external_flows


def _period_performance(previous, current, external_flows):
    if previous["value"] <= 0:
        return None
    period_flows = [
        (flow_date, amount)
        for flow_date, amount in external_flows
        if previous["date"] < flow_date <= current["date"]
    ]
    if all(flow_date == current["date"] for flow_date, _ in period_flows):
        external = sum(amount for _, amount in period_flows)
        return (current["value"] - external) / previous["value"] - 1, False
    result = _modified_dietz(previous, current, period_flows)
    return (result, True) if result is not None else None


def _chain_performance(complete_snapshots, external_flows):
    chained = 1.0
    used_dietz = False
    series = [
        {"date": complete_snapshots[0]["date"], "portfolio": 100.0, "benchmark": None}
    ]
    for previous, current in pairwise(complete_snapshots):
        period = _period_performance(previous, current, external_flows)
        if period is None:
            return None
        period_return, period_used_dietz = period
        chained *= 1 + period_return
        used_dietz = used_dietz or period_used_dietz
        series.append(
            {"date": current["date"], "portfolio": chained * 100, "benchmark": None}
        )
    return chained, used_dietz, series


def _performance(conn, snapshots, flows, additional_external_flows=None) -> dict:
    complete_snapshots = [row for row in snapshots if row["complete"]]
    unavailable: dict = {**_unavailable_performance(complete_snapshots)}
    if len(complete_snapshots) < 2:
        return unavailable
    chained_result = _chain_performance(
        complete_snapshots,
        _external_performance_flows(flows, additional_external_flows),
    )
    if chained_result is None:
        return unavailable
    chained, used_dietz, series = chained_result
    benchmark_return = _align_benchmark(conn, series)
    portfolio_return = chained - 1
    method = "MODIFIED_DIETZ" if used_dietz else "TWR"
    return {
        "available": True,
        "reason": None,
        "method": method,
        "is_estimate": used_dietz,
        "portfolio_return": portfolio_return,
        "twr": None if used_dietz else portfolio_return,
        "benchmark_return": benchmark_return,
        "difference": portfolio_return - benchmark_return
        if benchmark_return is not None
        else None,
        "series": series,
        "coverage_start": complete_snapshots[0]["date"],
        "coverage_end": complete_snapshots[-1]["date"],
    }


def _modified_dietz(previous, current, flows):
    start_date = _as_date(previous["date"])
    end_date = _as_date(current["date"])
    days = (end_date - start_date).days
    if days <= 0:
        return None
    net_flow = sum(amount for _, amount in flows)
    weighted_flows = sum(
        amount * (end_date - _as_date(flow_date)).days / days
        for flow_date, amount in flows
    )
    denominator = previous["value"] + weighted_flows
    if denominator <= 0:
        return None
    return (current["value"] - previous["value"] - net_flow) / denominator


def _align_benchmark(conn, series) -> float | None:
    prices = _benchmark_prices(conn)
    if not prices:
        return None
    usable = []
    for point in series:
        matches = [price for price in prices if price[0] <= point["date"]]
        if matches:
            usable.append((point, matches[-1][1]))
    if len(usable) < 2 or usable[0][1] == 0:
        return None
    base = usable[0][1]
    for point, price in usable:
        point["benchmark"] = price / base * 100
    return usable[-1][1] / base - 1


def _growth_decomposition(snapshots, flows, linked_asset_additions=0.0) -> dict:
    totals = _flow_totals(flows)
    complete_snapshots = [row for row in snapshots if row["complete"]]
    contributions = totals["contributions"] + linked_asset_additions
    if len(complete_snapshots) < 2:
        return {
            "available": False,
            "starting_value": None,
            "ending_value": None,
            "contributions": contributions,
            "withdrawals": totals["withdrawals"],
            "dividends": totals["dividends"],
            "interest": totals["interest"],
            "market_appreciation": None,
            "reconciliation_difference": None,
        }
    starting = complete_snapshots[0]["value"]
    ending = complete_snapshots[-1]["value"]
    appreciation = (
        ending
        - starting
        - contributions
        + totals["withdrawals"]
        - totals["dividends"]
        - totals["interest"]
    )
    reconciled = (
        starting
        + contributions
        - totals["withdrawals"]
        + totals["dividends"]
        + totals["interest"]
        + appreciation
    )
    return {
        "available": True,
        "starting_value": starting,
        "ending_value": ending,
        "contributions": contributions,
        "withdrawals": totals["withdrawals"],
        "dividends": totals["dividends"],
        "interest": totals["interest"],
        "market_appreciation": appreciation,
        "reconciliation_difference": ending - reconciled,
    }


def _summary(
    conn,
    all_assets,
    assets,
    accounts,
    filters,
    flows,
    snapshots,
    performance,
    growth,
    holdings,
):
    total = _asset_total(assets)
    known_basis = [
        item["cost_basis"] for item in holdings if item["cost_basis"] is not None
    ]
    unrealized = sum(
        item["unrealized_gain"]
        for item in holdings
        if item["unrealized_gain"] is not None
    )
    return {
        "total_financial_assets": _asset_total(
            _filter_assets(all_assets, accounts, _replace_view(filters, "ALL_ASSETS"))
        ),
        "total_investment_assets": _asset_total(
            _filter_assets(all_assets, accounts, _replace_view(filters, "INVESTMENTS"))
        ),
        "liquid_assets": _asset_total(
            _filter_assets(all_assets, accounts, _replace_view(filters, "LIQUID"))
        ),
        "current_portfolio_value": total,
        "ytd_return": _return_for_range(conn, accounts, filters, "YTD"),
        "one_year_return": performance["portfolio_return"]
        if filters.range == "1Y"
        else _return_for_range(conn, accounts, filters, "1Y"),
        "total_contributions": growth["contributions"],
        "total_investment_gains": growth["market_appreciation"]
        + growth["dividends"]
        + growth["interest"]
        if growth["available"]
        else None,
        "cost_basis": sum(known_basis) if known_basis else None,
        "unrealized_gain_loss": unrealized if known_basis else None,
    }


def _return_for_range(conn, accounts, filters, range_name):
    alternate = PortfolioFilters(
        range=range_name,
        view=filters.view,
        account_ids=filters.account_ids,
        include_401k=filters.include_401k,
        cash_policy=filters.cash_policy,
        include_goal_reserved=filters.include_goal_reserved,
    )
    start, end = _period_boundaries(conn, alternate)
    flows = _filtered_flows(conn, accounts, alternate, start, end)
    snapshots = _portfolio_snapshots(conn, accounts, alternate, start, end)
    equity = _equity_compensation(conn, accounts, alternate, start, end)
    return _performance(conn, snapshots, flows, equity["linked_flows"])[
        "portfolio_return"
    ]


def _allocation(assets):
    totals: defaultdict[str, float] = defaultdict(float)
    for asset in assets:
        allocation = asset.get("asset_allocation") or [
            {"asset_class": asset["asset_class"], "percent": 100.0}
        ]
        for row in allocation:
            totals[row["asset_class"]] += asset["value"] * row["percent"] / 100
    total = sum(totals.values())
    return [
        {
            "asset_class": asset_class,
            "value": totals.get(asset_class, 0.0),
            "percentage": totals.get(asset_class, 0.0) / total * 100 if total else 0.0,
        }
        for asset_class in ASSET_CLASSES
        if totals.get(asset_class, 0.0)
    ]


def _risk_allocation(allocation):
    values = {row["asset_class"]: row["value"] for row in allocation}
    growth = values.get("US_EQUITY", 0) + values.get("INTERNATIONAL_EQUITY", 0)
    defensive = values.get("BONDS", 0) + values.get("CASH", 0)
    other = values.get("REAL_ESTATE", 0) + values.get("OTHER", 0)
    total = growth + defensive + other
    return {
        "growth": {"value": growth, "percentage": growth / total * 100 if total else 0},
        "defensive": {
            "value": defensive,
            "percentage": defensive / total * 100 if total else 0,
        },
        "other": {"value": other, "percentage": other / total * 100 if total else 0},
    }


def _target_allocation(conn):

    target = get_target_allocation(conn)
    return {
        asset_class: float(target.get(asset_class, 0)) for asset_class in ASSET_CLASSES
    }


def _target_comparison(allocation, target, portfolio_value):
    actual = {row["asset_class"]: row for row in allocation}
    rows = []
    for asset_class in ASSET_CLASSES:
        actual_percent = actual.get(asset_class, {}).get("percentage", 0.0)
        target_percent = target.get(asset_class, 0.0)
        drift = actual_percent - target_percent
        rows.append(
            {
                "asset_class": asset_class,
                "actual_percent": actual_percent,
                "target_percent": target_percent,
                "drift_percent": drift,
                "actual_value": actual.get(asset_class, {}).get("value", 0.0),
                "target_value": portfolio_value * target_percent / 100,
                "drift_value": portfolio_value * drift / 100,
                "status": "ON_TARGET"
                if abs(drift) <= 5
                else ("OVERWEIGHT" if drift > 0 else "UNDERWEIGHT"),
            }
        )
    overweight = max(rows, key=lambda row: row["drift_percent"])
    underweight = min(rows, key=lambda row: row["drift_percent"])
    return {
        "rows": rows,
        "largest_overweight": overweight["asset_class"],
        "largest_underweight": underweight["asset_class"],
        "overall_deviation": sum(abs(row["drift_percent"]) for row in rows) / 2,
        "tolerance": 5.0,
    }


def _contribution_guidance(comparison):
    deficits = {
        row["asset_class"]: max(0.0, -row["drift_value"])
        for row in comparison["rows"]
        if row["asset_class"] in TARGET_CLASSES
    }
    total = sum(deficits.values())
    return {
        "method": "CONTRIBUTIONS_ONLY",
        "allocations": [
            {
                "asset_class": asset_class,
                "percentage": value / total * 100 if total else 0.0,
                "deficit": value,
            }
            for asset_class, value in deficits.items()
        ],
    }


def _holdings(assets):
    total = _asset_total(assets)
    rows = []
    for asset in sorted(assets, key=lambda item: item["value"], reverse=True):
        basis = asset.get("cost_basis")
        gain = asset["value"] - basis if basis is not None else None
        rows.append(
            {
                "id": asset["id"],
                "holding": asset["label"],
                "security_id": asset.get("security_id"),
                "account_id": asset["account_id"],
                "account": asset["account_name"],
                "account_category": asset.get("account_category", "OTHER"),
                "category_source": asset.get("category_source", "AUTOMATIC"),
                "asset_class": asset["asset_class"],
                "asset_allocation": asset.get("asset_allocation")
                or [{"asset_class": asset["asset_class"], "percent": 100.0}],
                "classification_source": asset["classification_source"],
                "instrument_type": asset.get("instrument_type"),
                "instrument_subtype": asset.get("instrument_subtype"),
                "value_source": asset["value_source"],
                "quantity": asset.get("quantity"),
                "price": asset.get("price"),
                "value": asset["value"],
                "allocation": asset["value"] / total * 100 if total else 0,
                "cost_basis": basis,
                "unrealized_gain": gain,
                "unrealized_gain_percent": gain / basis * 100
                if gain is not None and basis
                else None,
            }
        )
    return rows


def _account_allocation(assets):
    totals: defaultdict[str, float] = defaultdict(float)
    labels = {}
    sources = defaultdict(set)
    for asset in assets:
        totals[asset["account_id"]] += asset["value"]
        labels[asset["account_id"]] = asset["account_name"]
        sources[asset["account_id"]].add(asset["value_source"])
    total = sum(totals.values())
    return [
        {
            "id": account_id,
            "label": labels[account_id],
            "value": value,
            "percentage": value / total * 100 if total else 0,
            "value_source": "holdings"
            if "holdings" in sources[account_id]
            else next(iter(sources[account_id])),
        }
        for account_id, value in sorted(
            totals.items(), key=lambda item: item[1], reverse=True
        )
    ]


def _flow_totals(flows):
    result = {
        "contributions": 0.0,
        "withdrawals": 0.0,
        "dividends": 0.0,
        "interest": 0.0,
        "internal_transfers": 0.0,
    }
    for flow in flows:
        if flow["flow_type"] == "CONTRIBUTION":
            result["contributions"] += abs(flow["amount"])
        elif flow["flow_type"] == "WITHDRAWAL":
            result["withdrawals"] += abs(flow["amount"])
        elif flow["flow_type"] == "DIVIDEND":
            result["dividends"] += abs(flow["amount"])
        elif flow["flow_type"] == "INTEREST":
            result["interest"] += abs(flow["amount"])
        elif flow["flow_type"] == "INTERNAL_TRANSFER":
            result["internal_transfers"] += abs(flow["amount"])
    result["internal_transfers"] /= 2
    return result


def _contribution_activity(flows, accounts):
    monthly: defaultdict[str, defaultdict[str, float]] = defaultdict(
        lambda: defaultdict(float)
    )
    for flow in flows:
        if flow["flow_type"] not in {
            "CONTRIBUTION",
            "WITHDRAWAL",
            "INTERNAL_TRANSFER",
        }:
            continue
        account = accounts.get(flow["account_id"], {})
        destination = _contribution_destination(account)
        monthly[flow["date"][:7]][destination] += float(flow["amount"])
    return [
        {
            "month": month,
            "total": sum(destinations.values()),
            "destinations": dict(destinations),
        }
        for month, destinations in sorted(monthly.items())
    ]


def _is_espp(subtype, name):
    return "espp" in subtype or "espp" in name or "employee stock" in name


def _equity_contribution_destination(account):
    subtype = (account.get("subtype") or "").lower()
    name = (account.get("name") or "").lower()
    return "ESPP" if _is_espp(subtype, name) else "Equity compensation"


def _retirement_contribution_destination(account):
    subtype = (account.get("subtype") or "").lower()
    if account.get("is_401k"):
        return "401(k)"
    return "IRA" if "ira" in subtype else "Retirement"


def _cash_contribution_destination(account):
    subtype = (account.get("subtype") or "").lower()
    return "HYSA" if subtype in {"savings", "money market"} else "Cash"


STATIC_CONTRIBUTION_DESTINATIONS = {
    "EDUCATION": "529",
    "HEALTH_SAVINGS": "HSA",
    "BROKERAGE": "Brokerage",
}
CONTRIBUTION_DESTINATION_RESOLVERS = {
    "EQUITY_COMPENSATION": _equity_contribution_destination,
    "RETIREMENT": _retirement_contribution_destination,
    "CASH": _cash_contribution_destination,
}


def _contribution_destination(account):
    category = account.get("account_category")
    destination = STATIC_CONTRIBUTION_DESTINATIONS.get(category)
    if destination:
        return destination
    resolver = CONTRIBUTION_DESTINATION_RESOLVERS.get(category)
    return resolver(account) if resolver else "Other"


def _category_balances(assets) -> dict[str, float]:
    balances: defaultdict[str, float] = defaultdict(float)
    for asset in assets:
        balances[asset.get("account_category", "OTHER")] += float(asset["value"])
    return dict(sorted(balances.items()))


def _contribution_summary(flows, accounts, assets, linked_asset_additions=0.0):
    destinations: defaultdict[str, float] = defaultdict(float)
    external_net = linked_asset_additions
    for flow in flows:
        if flow["flow_type"] not in {
            "CONTRIBUTION",
            "WITHDRAWAL",
            "INTERNAL_TRANSFER",
        }:
            continue
        amount = float(flow["amount"])
        destinations[
            _contribution_destination(accounts.get(flow["account_id"], {}))
        ] += amount
        if flow["flow_type"] != "INTERNAL_TRANSFER":
            external_net += amount
    invested_destinations = {
        "Brokerage",
        "401(k)",
        "IRA",
        "Retirement",
        "ESPP",
        "Equity compensation",
        "529",
        "HSA",
    }
    retirement_destinations = {"401(k)", "IRA", "Retirement"}
    cash_destinations = {"HYSA", "Cash"}
    category_balances = _category_balances(assets)
    return {
        "destinations": dict(sorted(destinations.items())),
        "invested_this_year": linked_asset_additions
        + sum(destinations.get(name, 0.0) for name in invested_destinations),
        "saved_this_year": external_net,
        "retirement_contributions": sum(
            destinations.get(name, 0.0) for name in retirement_destinations
        ),
        "taxable_contributions": linked_asset_additions
        + destinations.get("Brokerage", 0.0)
        + destinations.get("ESPP", 0.0),
        "cash_savings": sum(destinations.get(name, 0.0) for name in cash_destinations),
        "education_contributions": destinations.get("529", 0.0),
        "education_balance": category_balances.get("EDUCATION", 0.0),
        "category_balances": category_balances,
    }


def _equity_event_linked(row, accounts, filters):
    account_id = row.get("account_id")
    account = accounts.get(account_id, {}) if account_id else {}
    probe = {"asset_class": "CASH" if account.get("type") == "depository" else "OTHER"}
    return bool(
        account_id
        and _account_selected_at(account, filters, row["event_date"])
        and _asset_selected(probe, account, filters)
    )


def _equity_asset_addition(row, gross, withheld, linked):
    if not linked:
        return 0.0
    net_shares = row.get("net_shares")
    fair_market_value = row.get("fair_market_value")
    if net_shares is not None and fair_market_value is not None:
        return float(net_shares) * float(fair_market_value)
    return max(0.0, gross - withheld)


def _equity_event_effect(row, accounts, filters):
    linked = _equity_event_linked(row, accounts, filters)
    if filters.account_ids and not linked:
        return None
    gross = float(row.get("gross_income") or 0)
    withheld = float(row.get("withholding") or 0)
    return {
        "gross_income": gross,
        "withholding": withheld,
        "asset_addition": _equity_asset_addition(row, gross, withheld, linked),
        "unlinked": not linked and bool(gross or row.get("shares")),
        "date": str(row["event_date"]),
    }


def _equity_compensation(conn, accounts, filters, start, end):
    rows = list_equity_compensation_rows(conn, start, end)
    gross_income = 0.0
    withholding = 0.0
    linked_asset_additions = 0.0
    linked_flows = []
    unlinked_events = 0
    for raw in rows:
        effect = _equity_event_effect(dict(raw), accounts, filters)
        if effect is None:
            continue
        gross_income += effect["gross_income"]
        withholding += effect["withholding"]
        linked_asset_additions += effect["asset_addition"]
        unlinked_events += int(effect["unlinked"])
        if effect["asset_addition"]:
            linked_flows.append(
                {"date": effect["date"], "amount": effect["asset_addition"]}
            )
    return {
        "gross_income": gross_income,
        "withholding": withholding,
        "linked_asset_additions": linked_asset_additions,
        "linked_flows": linked_flows,
        "unlinked_events": unlinked_events,
    }


def _transaction_selected(transaction, accounts, filters):
    account = accounts.get(transaction.account_id, {})
    probe = {"asset_class": "CASH" if account.get("type") == "depository" else "OTHER"}
    return _account_selected_at(account, filters, transaction.date) and _asset_selected(
        probe, account, filters
    )


def _budget_impact(conn, transaction):

    transaction_type = resolve_transaction_type(conn, transaction)
    text = " ".join(
        value or ""
        for value in (
            transaction.merchant,
            transaction.raw_description,
            transaction.pfc_primary,
            transaction.pfc_detailed,
        )
    ).upper()
    amount = abs(float(transaction.amount))
    if transaction_type == "income" and "INTEREST" not in text:
        return amount, 0.0
    if transaction_type == "expense":
        return 0.0, amount
    return 0.0, 0.0


def _budget_totals(conn, accounts, filters, start, end):

    transactions = get_transactions_by_date_range(
        conn,
        start.isoformat() if start else "0001-01-01",
        end.isoformat(),
    )
    income = 0.0
    spending = 0.0
    for transaction in transactions:
        if not _transaction_selected(transaction, accounts, filters):
            continue
        transaction_income, transaction_spending = _budget_impact(conn, transaction)
        income += transaction_income
        spending += transaction_spending
    return {"income": income, "spending": spending}


def _wealth_bridge(
    conn, accounts, filters, start, end, flows, growth, equity_compensation
):
    budget = _budget_totals(conn, accounts, filters, start, end)
    earned_income = budget["income"] + equity_compensation["gross_income"]
    spending = budget["spending"] + equity_compensation["withholding"]
    flow_totals = _flow_totals(flows)
    verified_savings = (
        flow_totals["contributions"]
        - flow_totals["withdrawals"]
        + equity_compensation["linked_asset_additions"]
    )
    budget_surplus = earned_income - spending
    other_external_flows = verified_savings - budget_surplus
    starting = growth["starting_value"]
    ending = growth["ending_value"]
    expected_ending = None
    reconciliation = None
    if growth["available"]:
        expected_ending = (
            starting
            + earned_income
            - spending
            + other_external_flows
            + growth["dividends"]
            + growth["interest"]
            + growth["market_appreciation"]
        )
        reconciliation = ending - expected_ending
    return {
        "label": "Tracked Financial Wealth",
        "available": growth["available"],
        "starting_value": starting,
        "earned_income": earned_income,
        "spending": spending,
        "other_external_flows": other_external_flows,
        "dividends": growth["dividends"],
        "interest": growth["interest"],
        "market_appreciation": growth["market_appreciation"],
        "ending_value": ending,
        "budget_surplus": budget_surplus,
        "verified_savings": verified_savings,
        "budget_surplus_rate": budget_surplus / earned_income
        if earned_income
        else None,
        "verified_savings_rate": verified_savings / earned_income
        if earned_income
        else None,
        "savings_reconciliation_difference": verified_savings - budget_surplus,
        "reconciliation_difference": reconciliation,
    }


def _wealth_allocation(all_assets, accounts, filters, goals):
    inclusive_filters = PortfolioFilters(
        range=filters.range,
        start_date=filters.start_date,
        end_date=filters.end_date,
        view=filters.view,
        account_ids=filters.account_ids,
        include_401k=filters.include_401k,
        cash_policy=filters.cash_policy,
        include_goal_reserved=True,
    )
    selected = _filter_assets(all_assets, accounts, inclusive_filters)
    tracked = _asset_total(selected)
    reserved = sum(
        min(asset["value"], asset.get("reserved", 0.0)) for asset in selected
    )
    return {
        "tracked_financial_wealth": tracked,
        "goal_reserved_assets": reserved,
        "long_term_investable_assets": max(0.0, tracked - reserved),
        "unallocated_assets": max(0.0, tracked - reserved),
        "goal_underfunding": goals["underfunded_amount"],
    }


def _parse_sync_timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _selected_sync_timestamps(rows, selected_ids):
    timestamps = []
    for row in rows:
        if row["account_id"] in selected_ids:
            parsed = _parse_sync_timestamp(row["last_successful_sync"])
            if parsed:
                timestamps.append(parsed)
    return timestamps


def _sync_freshness(conn, accounts, filters):
    selected_ids = {
        account_id
        for account_id, account in accounts.items()
        if _account_selected(account, filters)
    }
    rows = list_account_sync_rows(conn)
    timestamps = _selected_sync_timestamps(rows, selected_ids)
    latest = max(timestamps) if timestamps else None
    stale = latest is None or datetime.now(timezone.utc) - latest > timedelta(hours=24)
    return {
        "last_successful_sync": latest.isoformat() if latest else None,
        "is_stale": stale,
        "selected_account_count": len(selected_ids),
    }


def _filter_metadata(accounts, filters, start, end):
    return {
        "selected": {
            "range": filters.range,
            "start_date": start.isoformat() if start else None,
            "end_date": end.isoformat(),
            "view": filters.view,
            "account_ids": list(filters.account_ids),
            "include_401k": filters.include_401k,
            "cash_policy": filters.cash_policy,
            "include_goal_reserved": filters.include_goal_reserved,
        },
        "accounts": [
            {
                "id": account_id,
                "name": account.get("name") or account_id,
                "type": account.get("type"),
                "subtype": account.get("subtype"),
                "is_401k": account.get("is_401k"),
                "tax_status": account.get("tax_status"),
                "account_category": account.get("account_category"),
                "category_source": account.get("category_source"),
                "liquidity": account.get("liquidity"),
                "earmarked": account.get("earmarked", 0),
            }
            for account_id, account in sorted(
                accounts.items(), key=lambda item: item[1].get("name") or item[0]
            )
        ],
    }


def _data_quality_warnings(assets, holdings, snapshots, performance, flows, allocation):
    return list(
        filter(
            None,
            (
                _balance_only_warning(assets),
                _missing_cost_basis_warning(holdings),
                _unclassified_security_warning(holdings),
                _incomplete_history_warning(snapshots, performance),
                _missing_benchmark_warning(performance),
                _empty_allocation_warning(assets, allocation),
                _unmatched_transfer_warning(flows),
                _unclassified_account_warning(assets),
            ),
        )
    )


def _balance_only_warning(assets):
    balance_only = [
        asset["account_name"] for asset in assets if asset["value_source"] != "holdings"
    ]
    return _warning_if(
        bool(balance_only),
        "BALANCE_ONLY_ACCOUNTS",
        f"Using account balances for: {', '.join(sorted(set(balance_only)))}.",
    )


def _missing_cost_basis_warning(holdings):
    missing = any(
        item["cost_basis"] is None and item["value_source"] == "holdings"
        for item in holdings
    )
    return _warning_if(
        missing,
        "MISSING_COST_BASIS",
        "Some holdings do not include cost basis.",
    )


def _unclassified_security_warning(holdings):
    unresolved = any(
        item["classification_source"] != "USER"
        and len(item["asset_allocation"]) == 1
        and item["asset_allocation"][0]["asset_class"] == "OTHER"
        for item in holdings
    )
    return _warning_if(
        unresolved,
        "UNCLASSIFIED_SECURITIES",
        "Some securities need an asset-class override.",
    )


def _incomplete_history_warning(snapshots, performance):
    return _warning_if(
        not snapshots or not performance["available"],
        "INCOMPLETE_HISTORY",
        performance["reason"],
    )


def _missing_benchmark_warning(performance):
    return _warning_if(
        performance["available"] and performance["benchmark_return"] is None,
        "MISSING_BENCHMARK",
        "SPY adjusted-close benchmark prices are unavailable for this range.",
    )


def _empty_allocation_warning(assets, allocation):
    return _warning_if(
        bool(assets) and not allocation,
        "EMPTY_ALLOCATION",
        "Filtered assets could not be allocated.",
    )


def _unmatched_transfer_warning(flows):
    unmatched = sum(1 for flow in flows if _is_unmatched_transfer(flow))
    return _warning_if(
        unmatched > 0,
        "POSSIBLE_UNMATCHED_TRANSFERS",
        f"{unmatched} transfer-like flows could not be paired.",
    )


def _unclassified_account_warning(assets):
    names = sorted(
        {
            asset["account_name"]
            for asset in assets
            if asset.get("account_category") == "OTHER"
        }
    )
    return _warning_if(
        bool(names),
        "UNCLASSIFIED_ACCOUNT_CATEGORY",
        f"Choose an account category for: {', '.join(names)}.",
    )


def _is_unmatched_transfer(flow):
    return all(
        (
            flow["source"] == "SYSTEM",
            flow["flow_type"] in {"CONTRIBUTION", "WITHDRAWAL"},
            bool(flow.get("transfer_hint")),
        )
    )


def _warning_if(condition, code, message):
    return {"code": code, "message": message} if condition else None


def list_investment_accounts(conn) -> list[dict]:
    accounts = _load_accounts(conn)
    earmarks = defaultdict(list)
    for row in list_cash_earmarks(conn):
        earmarks[row["account_id"]].append(
            {**dict(row), "amount": float(row["amount"])}
        )
    return [
        {
            "account_id": account_id,
            "name": account.get("name"),
            "type": account.get("type"),
            "subtype": account.get("subtype"),
            "tax_status": account.get("tax_status"),
            "account_category": account.get("account_category"),
            "category_source": account.get("category_source"),
            "liquidity": account.get("liquidity"),
            "include_by_default": account.get("include_by_default"),
            "is_401k": account.get("is_401k"),
            "earmarked": account.get("earmarked"),
            "earmarks": earmarks[account_id],
        }
        for account_id, account in accounts.items()
    ]


def set_account_preferences(
    conn,
    account_id,
    *,
    tax_status=None,
    liquidity=None,
    include_by_default=True,
    is_401k=None,
    account_category=None,
):
    allowed_tax_statuses = {
        "TAXABLE",
        "RETIREMENT",
        "EDUCATION",
        "HEALTH_SAVINGS",
    }
    if tax_status is not None and tax_status not in allowed_tax_statuses:
        raise ValueError("Unsupported tax_status")
    if liquidity is not None and liquidity not in {"LIQUID", "ILLIQUID"}:
        raise ValueError("liquidity must be LIQUID or ILLIQUID")
    if not account_exists(conn, account_id):
        raise ValueError("Unknown account")
    if account_category is not None and account_category not in ACCOUNT_CATEGORIES:
        raise ValueError("Unsupported account category")
    upsert_account_preferences(
        conn,
        account_id,
        tax_status,
        liquidity,
        int(include_by_default),
        None if is_401k is None else int(is_401k),
        account_category,
    )


def add_cash_earmark(conn, account_id, name, amount) -> int:
    amount = float(amount)
    if not name.strip() or amount < 0:
        raise ValueError("Earmark name is required and amount must be non-negative")
    if get_account_type(conn, account_id) != "depository":
        raise ValueError("Earmarks require a cash account")

    if (
        _assigned_to_source(conn, "ACCOUNT", account_id, None) + amount
        > _source_value(conn, "ACCOUNT", account_id, None) + 0.005
    ):
        raise ValueError("Goal allocations cannot exceed the account's current value")
    return create_cash_earmark_records(conn, account_id, name.strip(), amount)


def delete_cash_earmark(conn, earmark_id) -> bool:
    return delete_cash_earmark_records(conn, earmark_id)


def list_security_classifications(conn) -> list[dict]:
    rows = list_security_rows(conn)
    result = []
    for row in rows:
        allocation, source = resolve_security_allocation(
            conn,
            row["security_id"],
            row["ticker"],
            row["name"],
            row["type"],
            row["subtype"],
        )
        result.append(
            {
                **row,
                "asset_class": _dominant_asset_class(allocation),
                "allocations": allocation,
                "source": source,
            }
        )
    return result


def set_security_classification(conn, security_id, asset_class):
    set_security_allocations(
        conn, security_id, [{"asset_class": asset_class, "percent": 100}]
    )


def set_security_allocations(conn, security_id: str, allocations: list[dict]) -> None:
    if not security_exists(conn, security_id):
        raise ValueError("Unknown security")
    normalized = _normalize_asset_allocations(allocations)
    replace_security_asset_allocations(conn, security_id, normalized)


def set_account_allocations(conn, account_id: str, allocations: list[dict]) -> None:
    if not account_exists(conn, account_id):
        raise ValueError("Unknown account")
    normalized = _normalize_asset_allocations(allocations)
    replace_account_asset_allocations(conn, account_id, normalized)


def _normalize_asset_allocations(allocations: list[dict]) -> list[dict]:
    if not allocations:
        raise ValueError("At least one asset allocation is required")
    seen: set[str] = set()
    normalized = [_normalize_security_allocation(row, seen) for row in allocations]
    return _normalize_allocation_total(normalized)


def _normalize_security_allocation(row: dict, seen: set[str]) -> dict:
    asset_class = row["asset_class"]
    if asset_class not in ASSET_CLASSES:
        raise ValueError("Unsupported asset class")
    if asset_class in seen:
        raise ValueError("Asset classes must be unique")
    seen.add(asset_class)
    return {
        "asset_class": asset_class,
        "percent": float(_allocation_percent(row["percent"])),
    }


def _allocation_percent(value) -> Decimal:
    try:
        raw_percent = Decimal(str(value))
        if not raw_percent.is_finite():
            raise ValueError
        percent = raw_percent.quantize(Decimal("0.01"))
    except (ValueError, TypeError, ArithmeticError) as exc:
        raise ValueError("Allocation percentages must be numeric") from exc
    if raw_percent != percent:
        raise ValueError("Allocation percentages support at most two decimal places")
    if percent <= 0 or percent > 100:
        raise ValueError(
            "Allocation percentages must be greater than 0 and at most 100"
        )
    return percent


def _normalize_allocation_total(normalized: list[dict]) -> list[dict]:
    total = sum((Decimal(str(row["percent"])) for row in normalized), start=Decimal(0))
    difference = Decimal(100) - total
    if abs(difference) > Decimal("0.01"):
        raise ValueError("Allocation percentages must total 100")
    if difference:
        largest = max(normalized, key=lambda row: row["percent"])
        largest["percent"] += float(difference)
    return normalized


def reset_security_allocations(conn, security_id) -> bool:
    if not security_exists(conn, security_id):
        raise ValueError("Unknown security")
    return delete_security_asset_allocations(conn, security_id)


def reset_account_allocations(conn, account_id) -> bool:
    if not account_exists(conn, account_id):
        raise ValueError("Unknown account")
    return delete_account_asset_allocations(conn, account_id)


def set_flow_classification(conn, source_type, source_id, flow_type):
    allowed_sources = {"DEPOSITORY", "INVESTMENT"}
    allowed_types = {
        "CONTRIBUTION",
        "WITHDRAWAL",
        "INTERNAL_TRANSFER",
        "DIVIDEND",
        "INTEREST",
        "OTHER_RETURN",
        "IGNORE",
    }
    if source_type not in allowed_sources or flow_type not in allowed_types:
        raise ValueError("Unsupported flow source or classification")
    row = get_flow_row(conn, source_type, source_id)
    if not row:
        reconcile_portfolio_flows(conn)
        row = get_flow_row(conn, source_type, source_id)
    if not row:
        raise ValueError("Unknown portfolio flow")
    update_flow_classification(conn, source_type, source_id, flow_type)


def _benchmark_prices(conn):
    return list_benchmark_prices(conn)


def _flows_between(flow_by_date, start, end):
    return sum(
        value for flow_date, value in flow_by_date.items() if start < flow_date <= end
    )


def _replace_view(filters, view):
    return PortfolioFilters(
        range=filters.range,
        start_date=filters.start_date,
        end_date=filters.end_date,
        view=view,
        account_ids=filters.account_ids,
        include_401k=filters.include_401k,
        cash_policy=filters.cash_policy,
        include_goal_reserved=filters.include_goal_reserved,
    )


def _date_selected(value, start, end):
    return (start is None or value >= start) and value <= end


def _asset_total(assets):
    return sum(float(asset["value"]) for asset in assets)


def _optional_float(value):
    return float(value) if value is not None else None


def _missing_account(account_id):
    return {
        "account_id": account_id,
        "name": account_id,
        "type": "investment",
        "tax_status": "TAXABLE",
        "account_category": "OTHER",
        "category_source": "AUTOMATIC",
        "liquidity": "LIQUID",
        "include_by_default": True,
        "is_401k": False,
        "earmarked": 0.0,
    }


def _as_date(value) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _same_amount(left, right):
    return Decimal(str(abs(left))).quantize(Decimal("0.01")) == Decimal(
        str(abs(right))
    ).quantize(Decimal("0.01"))


def _flow_key(event):
    return event["source_type"], event["source_id"]


def _flow_sort_key(event):
    return event["date"], event["source_type"], event["source_id"]


def _investment_currency(raw_payload):
    try:
        raw = json.loads(raw_payload or "{}")
    except (TypeError, json.JSONDecodeError):
        return "USD"
    return raw.get("iso_currency_code") or raw.get("unofficial_currency_code") or "USD"


def _preservable_transfer(previous, event_keys):
    matched = (previous.get("matched_source_type"), previous.get("matched_source_id"))
    return previous.get("flow_type") == "INTERNAL_TRANSFER" and matched in event_keys
