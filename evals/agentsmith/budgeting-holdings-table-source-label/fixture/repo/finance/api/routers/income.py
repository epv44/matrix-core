from fastapi import APIRouter, Query

from finance.api.deps import DbDep, EnvDep
from finance.services.reports import get_income_breakdown

router = APIRouter(prefix="/api/income", tags=["income"])


@router.get("/breakdown")
def income_breakdown(
    env: EnvDep,
    db: DbDep,
    group_by: str = Query(
        "merchant", description="merchant|account|institution|payment_processor"
    ),
    from_date: str | None = None,
    to_date: str | None = None,
    owner_user_id: str | None = None,
):
    conn, _ = db

    result = get_income_breakdown(
        conn,
        group_by=group_by,
        from_date=from_date,
        to_date=to_date,
        owner_user_id=owner_user_id,
    )
    return {
        "env": env,
        "group_by": group_by,
        "total": result["total"],
        "breakdown": result["breakdown"],
    }
