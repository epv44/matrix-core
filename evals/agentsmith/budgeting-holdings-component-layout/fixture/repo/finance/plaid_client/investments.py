"""Plaid Investments synchronization kept separate from depository transactions."""

import logging
from datetime import date, datetime, timedelta, timezone

from finance.security.sanitize import sanitized_error, wrap_plaid_call
from finance.services.portfolio import reconcile_portfolio_flows
from finance.storage.repository import (
    get_institution_by_name,
    record_connection_sync_history,
    upsert_investment_data,
)

logger = logging.getLogger(__name__)


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _transaction_date_range(since: date | None) -> tuple[date, date]:
    """Resolve the mandatory Plaid investment transaction date window."""
    end_date = _today()
    return since or (end_date - timedelta(days=30)), end_date


def _request(module_name: str, **kwargs):
    module = __import__(f"plaid.model.{module_name}", fromlist=["Request"])
    cls = next(
        value
        for name, value in vars(module).items()
        if name.endswith(("Request", "RequestOptions")) and name != "BaseModel"
    )
    return cls(**kwargs)


def _transactions_request(
    access_token: str, start_date: date, end_date: date, offset: int
):
    options = _request(
        "investments_transactions_get_request_options",
        count=500,
        offset=offset,
    )
    return _request(
        "investments_transactions_get_request",
        access_token=access_token,
        start_date=start_date,
        end_date=end_date,
        options=options,
    )


def sync_investments(
    client,
    conn,
    institution_name: str,
    access_token: str,
    *,
    since: date | None = None,
    item_id: str | None = None,
) -> dict:
    institution = get_institution_by_name(conn, institution_name)
    if institution is None or institution.id is None:
        raise ValueError(f"Institution is not linked: {institution_name}")
    start_date, end_date = _transaction_date_range(since)
    try:
        holdings_request = _request(
            "investments_holdings_get_request", access_token=access_token
        )
        holdings_response = wrap_plaid_call(
            lambda: client.investments_holdings_get(holdings_request)
        )
        holdings = client.api_client.sanitize_for_serialization(holdings_response)
        transactions_request = _transactions_request(
            access_token, start_date, end_date, offset=0
        )
        transactions_response = wrap_plaid_call(
            lambda: client.investments_transactions_get(transactions_request)
        )
        transactions = client.api_client.sanitize_for_serialization(
            transactions_response
        )
        transaction_items = transactions.get(
            "investment_transactions", transactions.get("transactions", [])
        )
        merged = {
            **holdings,
            "transactions": transaction_items,
        }
        total_transactions = transactions.get(
            "total_investment_transactions", len(transaction_items)
        )
        # Plaid paginates investment transactions with options.offset and reports
        # the total available in total_investment_transactions.
        while len(merged["transactions"]) < total_transactions:
            offset = len(merged["transactions"])
            page_request = _transactions_request(
                access_token, start_date, end_date, offset=offset
            )
            page = client.api_client.sanitize_for_serialization(
                wrap_plaid_call(
                    lambda request=page_request: client.investments_transactions_get(
                        request
                    )
                )
            )
            page_items = page.get(
                "investment_transactions", page.get("transactions", [])
            )
            if not page_items:
                logger.warning(
                    "Plaid investment pagination returned an empty page: offset=%d total=%d",
                    offset,
                    total_transactions,
                )
                break
            merged["transactions"].extend(page_items)
            total_transactions = page.get(
                "total_investment_transactions", total_transactions
            )
        result = upsert_investment_data(
            conn,
            institution.id,
            item_id or institution.plaid_item_id,
            {
                "accounts": holdings.get("accounts", []),
                "securities": holdings.get("securities", []),
                "holdings": holdings.get("holdings", []),
                "transactions": merged["transactions"],
            },
            _today().isoformat(),
        )
        record_connection_sync_history(
            conn,
            institution.id,
            "INVESTMENT",
            "ok",
            since=start_date.isoformat(),
            added=result.get("added", 0),
        )
        _refresh_portfolio_derivatives(conn)
        result["status"] = "COMPLETE"
        return result
    except Exception as exc:
        record_connection_sync_history(
            conn,
            institution.id,
            "INVESTMENT",
            "error",
            since=start_date.isoformat(),
            error=sanitized_error(exc),
        )
        raise


def _refresh_portfolio_derivatives(conn) -> None:
    """Best-effort derived data refresh; Plaid persistence remains authoritative."""
    try:
        reconcile_portfolio_flows(conn)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Investment data synced but derived portfolio refresh failed: %s",
            sanitized_error(exc),
        )
