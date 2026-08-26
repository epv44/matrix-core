from datetime import date
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from finance.api.deps import DbDep, EnvDep
from finance.exceptions import NotFoundError
from finance.security.auth import request_user
from finance.security.sanitize import sanitized_error
from finance.services.categorization import (
    monthly_spreadsheet_data,
    summary_stats,
    yearly_summary,
)
from finance.services.goals import (
    add_goal_allocation,
    create_goal,
    delete_goal,
    delete_goal_allocation,
    goal_summary,
    update_goal,
)
from finance.services.investments import refresh_sp500_prices_if_stale
from finance.services.portfolio import (
    PortfolioFilters,
    add_cash_earmark,
    build_dashboard,
    delete_cash_earmark,
    list_investment_accounts,
    list_security_classifications,
    reset_account_allocations,
    reset_security_allocations,
    set_account_allocations,
    set_account_preferences,
    set_flow_classification,
    set_security_allocations,
    set_security_classification,
)
from finance.storage.repository import account_ids_for_owner, get_available_months

router = APIRouter(prefix="/api", tags=["dashboard"])


class SecurityAllocationItem(BaseModel):
    asset_class: str
    percent: float


class SecurityClassificationUpdate(BaseModel):
    asset_class: str | None = None
    allocations: list[SecurityAllocationItem] | None = None


class AccountPreferencesUpdate(BaseModel):
    tax_status: str | None = None
    liquidity: str | None = None
    include_by_default: bool = True
    is_401k: bool | None = None
    account_category: str | None = None


class CashEarmarkCreate(BaseModel):
    account_id: str
    name: str
    amount: float


class FlowClassificationUpdate(BaseModel):
    flow_type: str


class GoalCreate(BaseModel):
    name: str
    goal_type: str = "OTHER"
    target_amount: float | None = None
    target_date: date | None = None
    scope: str = "HOUSEHOLD"


class GoalUpdate(GoalCreate):
    status: str = "ACTIVE"


class GoalAllocationCreate(BaseModel):
    source_type: str
    account_id: str
    security_id: str | None = None
    assigned_amount: float


@router.get("/months")
def list_months(env: EnvDep, db: DbDep):
    conn, _ = db

    months = get_available_months(conn)
    return {"months": [f"{y}-{m:02d}" for y, m in months], "raw": months}


@router.get("/dashboard/yearly/{year}")
def get_yearly(year: int, env: EnvDep, db: DbDep, owner_user_id: str | None = None):
    conn, _ = db

    return yearly_summary(conn, year, owner_user_id)


@router.get("/dashboard/{year}/{month}")
def get_dashboard(
    year: int,
    month: int,
    env: EnvDep,
    db: DbDep,
    owner_user_id: str | None = None,
):
    conn, _ = db

    data = monthly_spreadsheet_data(conn, year, month, owner_user_id)
    stats = summary_stats(conn, year, month, owner_user_id)
    return {
        "year": year,
        "month": month,
        "env": env,
        "summary": data["summary"],
        "stats": stats,
        "expenses": data["expenses"],
        "income": data["income"],
        "transfers": data["transfers"],
        "transactions": data["transactions"],
        "detailed": data["detailed"],
        "sheet_categories": data["sheet_categories"],
    }


@router.get("/investments/dashboard")
def get_investment_dashboard(
    env: EnvDep,
    db: DbDep,
    range: str = Query("1Y", pattern="^(1M|3M|YTD|1Y|3Y|5Y|ALL)$"),
    start_date: date | None = None,
    end_date: date | None = None,
    view: str = Query(
        "ALL_ASSETS",
        pattern=(
            "^(ALL_ASSETS|INVESTMENTS|TAXABLE|RETIREMENT|EDUCATION|"
            "HEALTH_SAVINGS|LIQUID)$"
        ),
    ),
    account_ids: Annotated[list[str] | None, Query()] = None,
    include_401k: bool = True,
    cash_policy: str = Query("ALL", pattern="^(ALL|EXCLUDE_EARMARKED|EXCLUDE_ALL)$"),
    include_goal_reserved: bool = True,
    owner_user_id: str | None = None,
):
    conn, _ = db
    authorized_account_ids = account_ids_for_owner(conn, owner_user_id)
    selected_account_ids = tuple(account_ids or authorized_account_ids)
    if owner_user_id and account_ids:
        allowed = set(authorized_account_ids)
        selected_account_ids = tuple(
            account_id for account_id in account_ids if account_id in allowed
        ) or ("__NO_AUTHORIZED_ACCOUNT__",)

    filters = PortfolioFilters(
        range=range,
        start_date=start_date,
        end_date=end_date,
        view=view,
        account_ids=selected_account_ids,
        include_401k=include_401k,
        cash_policy=cash_policy,
        include_goal_reserved=include_goal_reserved,
    )
    return {"env": env, **build_dashboard(conn, filters)}


@router.post("/investments/benchmark/refresh")
def refresh_investment_benchmark(env: EnvDep, db: DbDep, force: bool = Query(False)):
    conn, _ = db

    try:
        count, refreshed = refresh_sp500_prices_if_stale(conn, force=force)
    except ImportError as exc:
        raise HTTPException(
            status_code=503, detail="yfinance is not installed"
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=sanitized_error(exc)) from None
    return {"ok": True, "count": count, "refreshed": refreshed}


@router.get("/investments/classifications")
def get_investment_classifications(env: EnvDep, db: DbDep):
    conn, _ = db

    return {"classifications": list_security_classifications(conn)}


@router.put("/investments/classifications/{security_id}")
def update_investment_classification(
    security_id: str,
    payload: SecurityClassificationUpdate,
    env: EnvDep,
    db: DbDep,
):
    conn, _ = db

    try:
        if payload.asset_class is not None and payload.allocations is not None:
            raise ValueError("Provide either asset_class or allocations, not both")
        if payload.allocations is not None:
            set_security_allocations(
                conn, security_id, [row.model_dump() for row in payload.allocations]
            )
        elif payload.asset_class is not None:
            set_security_classification(conn, security_id, payload.asset_class)
        else:
            raise ValueError("An asset_class or allocations value is required")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "security_id": security_id}


@router.delete("/investments/classifications/{security_id}")
def delete_investment_classification(
    security_id: str,
    env: EnvDep,
    db: DbDep,
):
    conn, _ = db

    try:
        reset_security_allocations(conn, security_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "security_id": security_id}


@router.put("/investments/accounts/{account_id}/allocations")
def update_investment_account_allocations(
    account_id: str,
    payload: SecurityClassificationUpdate,
    env: EnvDep,
    db: DbDep,
):
    conn, _ = db

    try:
        if payload.asset_class is not None and payload.allocations is not None:
            raise ValueError("Provide either asset_class or allocations, not both")
        if payload.allocations is not None:
            set_account_allocations(
                conn, account_id, [row.model_dump() for row in payload.allocations]
            )
        elif payload.asset_class is not None:
            set_account_allocations(
                conn,
                account_id,
                [{"asset_class": payload.asset_class, "percent": 100}],
            )
        else:
            raise ValueError("An asset_class or allocations value is required")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "account_id": account_id}


@router.delete("/investments/accounts/{account_id}/allocations")
def delete_investment_account_allocations(account_id: str, env: EnvDep, db: DbDep):
    conn, _ = db

    try:
        reset_account_allocations(conn, account_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "account_id": account_id}


@router.get("/investments/accounts")
def get_investment_accounts(env: EnvDep, db: DbDep):
    conn, _ = db

    return {"accounts": list_investment_accounts(conn)}


@router.put("/investments/accounts/{account_id}/preferences")
def update_investment_account_preferences(
    account_id: str,
    payload: AccountPreferencesUpdate,
    env: EnvDep,
    db: DbDep,
):
    conn, _ = db

    try:
        set_account_preferences(conn, account_id, **payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/investments/earmarks")
def create_investment_earmark(payload: CashEarmarkCreate, env: EnvDep, db: DbDep):
    conn, _ = db

    try:
        earmark_id = add_cash_earmark(
            conn, payload.account_id, payload.name, payload.amount
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "id": earmark_id}


@router.delete("/investments/earmarks/{earmark_id}")
def remove_investment_earmark(earmark_id: int, env: EnvDep, db: DbDep):
    conn, _ = db

    if not delete_cash_earmark(conn, earmark_id):
        raise HTTPException(status_code=404, detail="Earmark not found")
    return {"ok": True}


@router.get("/investments/goals")
def get_financial_goals(
    request: Request,
    env: EnvDep,
    db: DbDep,
    scope: str = Query("HOUSEHOLD"),
):
    conn, _ = db
    user = request_user(request) or {}
    goal_scope = str(scope or "HOUSEHOLD").upper()
    if goal_scope not in {"HOUSEHOLD", "PERSONAL"}:
        raise HTTPException(status_code=400, detail="Unsupported goal scope")
    owner_user_id = user.get("id") if goal_scope == "PERSONAL" else None
    if goal_scope == "PERSONAL" and not owner_user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    return goal_summary(conn, goal_scope, owner_user_id)


@router.post("/investments/goals")
def create_financial_goal(
    payload: GoalCreate, env: EnvDep, db: DbDep, request: Request
):
    conn, _ = db
    user = request_user(request) or {}
    body = payload.model_dump()
    scope = str(body.pop("scope") or "HOUSEHOLD").upper()
    if scope not in {"HOUSEHOLD", "PERSONAL"}:
        raise HTTPException(status_code=400, detail="Unsupported goal scope")
    owner_user_id = user.get("id") if scope == "PERSONAL" else None
    if scope == "PERSONAL" and not owner_user_id:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        goal_id = create_goal(conn, **body, scope=scope, owner_user_id=owner_user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "id": goal_id}


@router.put("/investments/goals/{goal_id}")
def update_financial_goal(
    goal_id: int, payload: GoalUpdate, env: EnvDep, db: DbDep, request: Request
):
    conn, _ = db
    user = request_user(request) or {}
    try:
        update_goal(conn, goal_id, **payload.model_dump(), user_id=user.get("id"))
    except NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@router.delete("/investments/goals/{goal_id}")
def remove_financial_goal(goal_id: int, env: EnvDep, db: DbDep, request: Request):
    conn, _ = db
    user = request_user(request) or {}
    try:
        if not delete_goal(conn, goal_id, user_id=user.get("id")):
            raise HTTPException(status_code=404, detail="Goal not found")
    except NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/investments/goals/{goal_id}/allocations")
def create_goal_allocation(
    goal_id: int,
    payload: GoalAllocationCreate,
    env: EnvDep,
    db: DbDep,
    request: Request,
):
    conn, _ = db
    user = request_user(request) or {}
    try:
        allocation_id = add_goal_allocation(
            conn, goal_id, **payload.model_dump(), user_id=user.get("id")
        )
    except NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "id": allocation_id}


@router.delete("/investments/goal-allocations/{allocation_id}")
def remove_goal_allocation(
    allocation_id: int, env: EnvDep, db: DbDep, request: Request
):
    conn, _ = db
    user = request_user(request) or {}
    try:
        if not delete_goal_allocation(conn, allocation_id, user_id=user.get("id")):
            raise HTTPException(status_code=404, detail="Goal allocation not found")
    except NotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.put("/investments/flows/{source_type}/{source_id}")
def update_investment_flow(
    source_type: str,
    source_id: str,
    payload: FlowClassificationUpdate,
    env: EnvDep,
    db: DbDep,
):
    conn, _ = db

    try:
        set_flow_classification(
            conn, source_type.upper(), source_id, payload.flow_type.upper()
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}
