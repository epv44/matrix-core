import logging
from datetime import date, datetime, timezone
from decimal import Decimal

from plaid.exceptions import ApiException
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from finance.exceptions import PlaidSyncError
from finance.models.dataclasses import Institution as InstModel
from finance.models.dataclasses import Transaction
from finance.security.sanitize import sanitized_error, wrap_plaid_call
from finance.storage.repositories.transactions import (
    get_transaction_ids_for_institution,
)
from finance.storage.repository import (
    delete_transactions_for_institution,
    get_category_rules,
    get_institution_by_name,
    get_taxonomy_mappings,
    mark_transaction_removed,
    record_sync_history,
    reset_institution_cursor,
    update_institution_cursor,
    update_institution_item_id,
    upsert_cash_accounts,
    upsert_institution,
    upsert_transaction,
)

logger = logging.getLogger(__name__)


def _is_rate_limit(exc):
    return isinstance(exc, ApiException) and exc.status == 429


@retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=1, min=1, max=60),
    retry=retry_if_exception(_is_rate_limit),
)
def _call_with_retry(client, request: TransactionsSyncRequest):
    try:
        return client.transactions_sync(request)
    except ApiException as exc:
        if exc.status == 429:
            logger.warning("Rate limited, retrying...")
            raise
        raise PlaidSyncError(sanitized_error(exc)) from None


def sync_institution(
    client,
    conn,
    institution_name: str,
    access_token: str,
    config: dict,
    since: date | None = None,
    replace: bool = False,
    backfill: bool = False,
) -> dict:
    env = config["plaid_environment"]
    since_str = since.isoformat() if since else None
    if replace:
        reset_institution_cursor(conn, institution_name)
        delete_transactions_for_institution(conn, institution_name)
    elif backfill:
        reset_institution_cursor(conn, institution_name)
    institution = get_institution_by_name(conn, institution_name)
    institution_id = (
        upsert_institution(conn, InstModel(name=institution_name))
        if institution is None
        else institution.id
    )
    assert institution_id is not None

    _sync_account_balances(client, conn, institution_id, access_token)

    mappings = get_taxonomy_mappings(conn)
    category_rules = get_category_rules(conn)
    cursor = institution.cursor if institution and institution.cursor else ""
    existing_ids = get_transaction_ids_for_institution(conn, institution_id)
    totals = {"added": 0, "modified": 0, "removed": 0}
    try:
        cursor = _sync_pages(
            client,
            conn,
            institution_name,
            access_token,
            institution_id,
            cursor,
            since,
            mappings,
            category_rules,
            existing_ids,
            totals,
        )
        assert institution_id is not None
        update_institution_cursor(conn, institution_id, cursor)
        logger.info(
            "Sync complete for %s: +%d added (net-new), ~%d modified, -%d removed",
            institution_name,
            totals["added"],
            totals["modified"],
            totals["removed"],
        )
        record_sync_history(
            conn,
            env,
            institution_id,
            since_str,
            replace,
            "ok",
            added=totals["added"],
            modified=totals["modified"],
            removed=totals["removed"],
            backfill=backfill,
        )
        return totals
    except Exception as exc:
        record_sync_history(
            conn,
            env,
            institution_id,
            since_str,
            replace,
            "error",
            added=totals["added"],
            modified=totals["modified"],
            removed=totals["removed"],
            error=sanitized_error(exc),
            backfill=backfill,
        )
        raise


def _sync_account_balances(client, conn, institution_id, access_token) -> None:
    """Capture current depository balances when the client supports AccountsGet."""
    if not hasattr(client, "accounts_get"):
        return

    response = wrap_plaid_call(
        lambda: client.accounts_get(AccountsGetRequest(access_token=access_token))
    )
    data = client.api_client.sanitize_for_serialization(response)
    upsert_cash_accounts(
        conn,
        institution_id,
        data.get("accounts", []),
        datetime.now(timezone.utc).date().isoformat(),
    )


def _sync_pages(
    client,
    conn,
    institution_name,
    access_token,
    institution_id,
    cursor,
    since,
    mappings,
    category_rules,
    existing_ids,
    totals,
):
    has_more = True
    page = 0
    while has_more:
        page += 1
        request = _sync_request(access_token, cursor)
        response = _call_with_retry(client, request)
        data = client.api_client.sanitize_for_serialization(response)
        _update_item_id(conn, institution_id, data.get("item_id"))
        _apply_sync_page(
            conn,
            data,
            institution_id,
            since,
            mappings,
            category_rules,
            existing_ids,
            totals,
        )
        cursor = data.get("next_cursor", cursor)
        has_more = data.get("has_more", False)
        _log_sync_page(institution_name, page, data, has_more)
    return cursor


def _sync_request(access_token: str, cursor: str) -> TransactionsSyncRequest:
    if cursor:
        return TransactionsSyncRequest(
            access_token=access_token, cursor=cursor, count=500
        )
    return TransactionsSyncRequest(access_token=access_token, count=500)


def _update_item_id(conn, institution_id, item_id) -> None:
    if item_id is not None and institution_id is not None:
        update_institution_item_id(conn, institution_id, item_id)


def _apply_sync_page(
    conn, data, institution_id, since, mappings, category_rules, existing_ids, totals
) -> None:
    _apply_added(
        conn,
        data.get("added", []),
        institution_id,
        since,
        mappings,
        category_rules,
        existing_ids,
        totals,
    )
    _apply_modified(
        conn,
        data.get("modified", []),
        institution_id,
        since,
        mappings,
        category_rules,
        totals,
    )
    _apply_removed(conn, data.get("removed", []), totals)


def _mapped_transaction(data, institution_id, mappings, category_rules):
    return _map_plaid_transaction(
        data,
        institution_id,
        mappings=mappings,
        category_rules=category_rules,
    )


def _within_window(txn, since) -> bool:
    return since is None or txn.date.date() >= since


def _apply_added(
    conn, rows, institution_id, since, mappings, category_rules, existing_ids, totals
) -> None:
    for row in rows:
        txn = _mapped_transaction(row, institution_id, mappings, category_rules)
        if not _within_window(txn, since):
            continue
        upsert_transaction(conn, txn)
        if txn.plaid_transaction_id in existing_ids:
            totals["modified"] += 1
        else:
            existing_ids.add(txn.plaid_transaction_id)
            totals["added"] += 1


def _apply_modified(
    conn, rows, institution_id, since, mappings, category_rules, totals
) -> None:
    for row in rows:
        txn = _mapped_transaction(row, institution_id, mappings, category_rules)
        if _within_window(txn, since):
            upsert_transaction(conn, txn)
            totals["modified"] += 1


def _apply_removed(conn, rows, totals) -> None:
    for row in rows:
        txn_id = row.get("transaction_id", "")
        if txn_id:
            mark_transaction_removed(conn, txn_id)
            totals["removed"] += 1


def _log_sync_page(institution_name, page, data, has_more) -> None:
    added = data.get("added", [])
    dates = [
        row.get("date")
        for row in added
        if isinstance(row.get("date"), str) and row.get("date")
    ]
    logger.info(
        "Sync %s page=%d added=%d modified=%d removed=%d earliest=%s latest=%s has_more=%s",
        institution_name,
        page,
        len(added),
        len(data.get("modified", [])),
        len(data.get("removed", [])),
        min(dates) if dates else None,
        max(dates) if dates else None,
        has_more,
    )


def _map_plaid_transaction(
    txn_data, institution_id: int | None = None, mappings=None, category_rules=None
) -> Transaction:
    amount = Decimal(str(txn_data.get("amount", "0")))
    txn_date = _transaction_date(txn_data.get("date"))
    plaid_cat = txn_data.get("category", [])
    plaid_cat_str = _list_value(plaid_cat, 0)
    plaid_subcat_str = _list_value(plaid_cat, 1)
    merchant = txn_data.get("merchant_name") or txn_data.get("name")
    raw_desc = txn_data.get("original_description") or txn_data.get("name")
    pfc = txn_data.get("personal_finance_category")
    pfc_primary = pfc.get("primary") if pfc else None
    pfc_detailed = pfc.get("detailed") if pfc else None
    payment_meta = txn_data.get("payment_meta") or {}
    payment_processor = payment_meta.get("payment_processor")
    return Transaction(
        plaid_transaction_id=txn_data.get("transaction_id", ""),
        account_id=txn_data.get("account_id", ""),
        institution_id=institution_id,
        date=txn_date,
        amount=amount,
        merchant=merchant,
        raw_description=raw_desc,
        manual_category_id=None,
        pending=bool(txn_data.get("pending", False)),
        currency=txn_data.get("iso_currency_code", "USD"),
        plaid_category=plaid_cat_str,
        plaid_subcategory=plaid_subcat_str,
        pfc_primary=pfc_primary,
        pfc_detailed=pfc_detailed,
        payment_processor=payment_processor,
        removed=False,
    )


def _transaction_date(raw_date) -> datetime:
    if isinstance(raw_date, str) and raw_date:
        year, month, day = raw_date.split("-")
        return datetime(int(year), int(month), int(day), tzinfo=timezone.utc)
    if isinstance(raw_date, date):
        return datetime.combine(raw_date, datetime.min.time(), tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _list_value(values, index: int):
    return values[index] if values and len(values) > index else None


def group_transactions(txns: list) -> dict:
    months: dict[tuple[int, int], list[Transaction]] = {}
    for t in txns:
        key = (t.date.year, t.date.month)
        months.setdefault(key, []).append(t)
    return months


def sync_dry_run(
    client,
    access_token: str,
    since: date | None = None,
    institution_name: str | None = None,
    mappings=None,
    category_rules=None,
) -> dict:
    txns = []
    cursor = ""
    has_more = True
    while has_more:
        kwargs = {"access_token": access_token}
        if cursor:
            kwargs["cursor"] = cursor
        response = _call_with_retry(client, TransactionsSyncRequest(**kwargs))
        added = response.get("added", [])
        passed_cutoff = False
        for t in (
            _map_plaid_transaction(
                t, None, mappings=mappings, category_rules=category_rules
            )
            for t in added
        ):
            if since is not None and t.date.date() < since:
                passed_cutoff = True
                continue
            txns.append(t)
        cursor = response.get("next_cursor", cursor)
        has_more = response.get("has_more", False)
        if since is not None and added and passed_cutoff:
            break
    return group_transactions(txns)
