from finance.categorization.processor import process_monthly_data
from finance.excel.exporter import export_months_to_bytes, export_to_excel
from finance.storage.repository import get_transactions_by_date_range


def export_range(
    conn,
    output_dir: str,
    year_start: int,
    month_start: int,
    year_end: int,
    month_end: int,
) -> str:
    return export_to_excel(
        conn, output_dir, year_start, month_start, year_end, month_end
    )


def export_range_to_bytes(
    conn,
    year_start: int,
    month_start: int,
    year_end: int,
    month_end: int,
    owner_user_id: str | None = None,
) -> bytes:
    raw = {}
    y, m = year_start, month_start
    while (y < year_end) or (y == year_end and m <= month_end):
        if m == 12:
            start, end = f"{y}-12-01", f"{y + 1}-01-01"
        else:
            start, end = f"{y}-{m:02d}-01", f"{y}-{m + 1:02d}-01"
        txns = get_transactions_by_date_range(
            conn, start, end, owner_user_id=owner_user_id
        )
        if txns:
            raw[(y, m)] = txns
        m += 1
        if m > 12:
            m = 1
            y += 1
    processed = process_monthly_data(raw)
    return export_months_to_bytes(conn, processed)


def export_single_month_to_bytes(
    conn, year: int, month: int, owner_user_id: str | None = None
) -> bytes:
    return export_range_to_bytes(
        conn, year, month, year, month, owner_user_id=owner_user_id
    )
