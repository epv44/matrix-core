import io

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from finance.api.deps import DbDep, EnvDep
from finance.services.exports import export_range_to_bytes, export_single_month_to_bytes

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/month/{year}/{month}")
def export_month(
    year: int,
    month: int,
    env: EnvDep,
    db: DbDep,
    owner_user_id: str | None = None,
):
    conn, _ = db

    b = export_single_month_to_bytes(conn, year, month, owner_user_id)
    return StreamingResponse(
        io.BytesIO(b),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename=finance_{year}_{month:02d}.xlsx"
        },
    )


@router.get("/range")
def export_range(
    env: EnvDep,
    db: DbDep,
    from_month: str = Query(..., description="YYYY-MM"),
    to_month: str = Query(..., description="YYYY-MM"),
    owner_user_id: str | None = None,
):
    conn, _ = db

    def parse_ym(s: str) -> tuple[int, int]:
        y, m = s.split("-")
        return int(y), int(m)

    try:
        fy, fm = parse_ym(from_month)
        ty, tm = parse_ym(to_month)
    except ValueError:
        raise HTTPException(status_code=400, detail="from/to must be YYYY-MM")
    b = export_range_to_bytes(conn, fy, fm, ty, tm, owner_user_id)
    return StreamingResponse(
        io.BytesIO(b),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename=finance_report_{fy}_{fm:02d}_to_{ty}_{tm:02d}.xlsx"
        },
    )
