from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from finance.api.deps import DbDep, EnvDep
from finance.services.categorization import (
    assign_category,
    assign_type,
    get_classification_trace,
    resolve_category_for_transaction,
    resolve_transaction_type,
)
from finance.services.investments import normalize_rsu_vest
from finance.storage.repository import (
    create_equity_compensation_event,
    filtered_transactions,
    get_category_changes,
    get_category_rules,
    get_institution_id_by_name,
    get_taxonomy_mappings,
    get_transaction_by_id,
    set_transaction_ignored,
)
from finance.storage.repository import list_investment_transactions as list_rows

router = APIRouter(prefix="/api/transactions", tags=["transactions"])


class ReclassifyRequest(BaseModel):
    new_category: str | None = None
    new_type: str | None = None
    pattern: str | None = None
    match_type: str = "BOTH"
    remember: bool = False


class IgnoreRequest(BaseModel):
    ignored: bool


class EquityCompensationRequest(BaseModel):
    event_type: str
    event_date: str
    account_id: str | None = None
    investment_transaction_id: str | None = None
    security_id: str | None = None
    shares: float | None = None
    fair_market_value: float | None = None
    gross_income: float | None = None
    withholding: float | None = None
    net_shares: float | None = None
    source: str = "manual"
    notes: str | None = None
    raw_payload: str | None = None


@router.get("/investments")
def list_investment_transactions(
    env: EnvDep,
    db: DbDep,
    institution: str | None = None,
    owner_user_id: str | None = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    conn, _ = db

    rows = list_rows(
        conn,
        institution=institution,
        owner_user_id=owner_user_id,
        limit=limit,
        offset=offset,
    )
    return {"transactions": rows, "count": len(rows), "has_more": len(rows) == limit}


@router.post("/investments/equity-events")
def add_equity_event(payload: EquityCompensationRequest, env: EnvDep, db: DbDep):
    allowed = {
        "RSU_VEST",
        "RSU_WITHHOLDING",
        "OPTION_EXERCISE",
        "OPTION_WITHHOLDING",
        "EMPLOYER_STOCK_PURCHASE",
        "MANUAL_CORRECTION",
    }
    if payload.event_type not in allowed:
        raise HTTPException(
            status_code=400, detail="Unsupported equity compensation event type"
        )
    payload_data = payload.model_dump()
    if (
        payload.event_type == "RSU_VEST"
        and payload.shares is not None
        and payload.fair_market_value is not None
    ):
        payload_data.update(
            {
                k: float(v) if hasattr(v, "as_tuple") else v
                for k, v in normalize_rsu_vest(
                    payload.shares, payload.fair_market_value, payload.withholding
                ).items()
            }
        )
    conn, _ = db

    return {"ok": True, "id": create_equity_compensation_event(conn, payload_data)}


@router.get("")
def list_transactions(
    env: EnvDep,
    db: DbDep,
    uncategorized_only: bool = Query(False),
    category: str | None = None,
    institution: str | None = None,
    account_id: str | None = None,
    search: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
    pending_only: bool = Query(False),
    transaction_type: str | None = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    order: str = Query("date DESC"),
    include_ignored: bool = Query(False),
    owner_user_id: str | None = None,
):
    conn, _ = db

    rules = get_category_rules(conn)
    mappings = get_taxonomy_mappings(conn)
    institution_id = (
        get_institution_id_by_name(conn, institution) if institution else None
    )
    filters = {
        "institution_id": institution_id,
        "account_id": account_id,
        "search": search,
        "from_date": from_date,
        "to_date": to_date,
        "pending_only": pending_only,
        "limit": 100000,
        "offset": 0,
        "order": order,
        "include_ignored": include_ignored,
        "owner_user_id": owner_user_id,
    }
    txns = filtered_transactions(conn, filters)
    resolved = _resolve_transactions(
        conn,
        txns,
        rules,
        mappings,
        resolve_category_for_transaction,
        resolve_transaction_type,
        uncategorized_only,
        category,
        transaction_type,
    )
    total = len(resolved)
    page = resolved[offset : offset + limit]
    result = [_transaction_json(*item) for item in page]
    has_more = offset + len(result) < total
    return {
        "transactions": result,
        "count": total,
        "has_more": has_more,
        "filters": filters,
    }


def _resolve_transactions(
    conn,
    txns,
    rules,
    mappings,
    category_resolver,
    type_resolver,
    uncategorized_only,
    category,
    transaction_type,
):
    resolved = []
    for txn in txns:
        resolved_category = category_resolver(conn, txn, rules=rules, mappings=mappings)
        resolved_type = type_resolver(conn, txn)
        if _include_transaction(
            txn,
            resolved_category,
            resolved_type,
            uncategorized_only,
            category,
            transaction_type,
        ):
            resolved.append((txn, resolved_category, resolved_type))
    return resolved


def _include_transaction(
    txn, resolved_category, resolved_type, uncategorized_only, category, txn_type
) -> bool:
    if uncategorized_only and resolved_category is not None:
        return False
    if category and resolved_category != category:
        return False
    actual_type = (txn.type_override or resolved_type).upper()
    return not txn_type or actual_type == txn_type.upper()


def _transaction_json(txn, category, txn_type) -> dict:
    date_text = (
        txn.date.strftime("%Y-%m-%d")
        if hasattr(txn.date, "strftime")
        else str(txn.date)
    )
    return {
        "plaid_transaction_id": txn.plaid_transaction_id,
        "account_id": txn.account_id,
        "institution": txn.institution,
        "date": date_text,
        "amount": float(txn.amount),
        "merchant": txn.merchant,
        "raw_description": txn.raw_description,
        "category": category,
        "transaction_type": (txn.type_override or txn_type).upper(),
        "pending": bool(txn.pending),
        "is_ignored": bool(txn.is_ignored),
        "pfc_primary": txn.pfc_primary,
        "pfc_detailed": txn.pfc_detailed,
        "payment_processor": txn.payment_processor,
        "plaid_category": txn.plaid_category,
    }


@router.get("/{txn_id}")
def get_transaction(txn_id: str, env: EnvDep, db: DbDep):
    conn, _ = db

    txn = get_transaction_by_id(conn, txn_id)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    trace = get_classification_trace(conn, txn)
    resolved = resolve_category_for_transaction(conn, txn)
    ttype = resolve_transaction_type(conn, txn)
    history = get_category_changes(conn, txn_id=txn_id, limit=20)
    hist = [
        {
            "id": h.id,
            "transaction_id": h.transaction_id,
            "old_category": h.old_category,
            "new_category": h.new_category,
            "reason": h.reason,
            "timestamp": str(h.timestamp),
        }
        for h in history
    ]
    return {
        "transaction": {
            "plaid_transaction_id": txn.plaid_transaction_id,
            "account_id": txn.account_id,
            "institution": txn.institution,
            "date": txn.date.strftime("%Y-%m-%d")
            if hasattr(txn.date, "strftime")
            else str(txn.date),
            "amount": float(txn.amount),
            "merchant": txn.merchant,
            "raw_description": txn.raw_description,
            "category": resolved,
            "transaction_type": (txn.type_override or ttype).upper(),
            "pending": bool(txn.pending),
            "is_ignored": bool(txn.is_ignored),
            "pfc_primary": txn.pfc_primary,
            "pfc_detailed": txn.pfc_detailed,
            "payment_processor": txn.payment_processor,
            "plaid_category": txn.plaid_category,
            "plaid_subcategory": txn.plaid_subcategory,
            "currency": txn.currency,
            "type_override": txn.type_override,
        },
        "trace": trace,
        "history": hist,
    }


@router.post("/{txn_id}/reclassify")
def reclassify_transaction(txn_id: str, req: ReclassifyRequest, env: EnvDep, db: DbDep):
    conn, _ = db

    if req.new_category is None and req.new_type is None:
        raise HTTPException(
            status_code=400, detail="Provide a category or transaction type"
        )

    txn = get_transaction_by_id(conn, txn_id)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if req.new_category is not None:
        txn = assign_category(
            conn,
            txn_id,
            req.new_category,
            remember=req.remember,
            pattern=req.pattern,
            match_type=req.match_type,
        )
        if not txn:
            raise HTTPException(status_code=422, detail="Invalid category")
    if req.new_type is not None:
        txn = assign_type(
            conn,
            txn_id,
            req.new_type,
            remember=req.remember,
            pattern=req.pattern,
            match_type=req.match_type,
        )
        if not txn:
            raise HTTPException(status_code=422, detail="Invalid transaction type")
    txn = get_transaction_by_id(conn, txn_id)
    resolved_type = resolve_transaction_type(conn, txn) if txn else None
    return {
        "ok": True,
        "transaction_id": txn_id,
        "new_category": req.new_category,
        "remember": req.remember,
        "new_type": req.new_type,
        "resolved_type": resolved_type,
    }


@router.post("/{txn_id}/ignore")
def ignore_transaction(txn_id: str, req: IgnoreRequest, env: EnvDep, db: DbDep):
    conn, _ = db

    txn = get_transaction_by_id(conn, txn_id)
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    set_transaction_ignored(conn, txn_id, req.ignored)
    return {"ok": True, "ignored": req.ignored}
