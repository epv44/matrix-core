"""Investment persistence projections used by application services."""


def get_first_snapshot_date(conn) -> str | None:
    row = conn.execute(
        """
        SELECT MIN(snapshot_date) AS first_date
        FROM (
            SELECT snapshot_date FROM investment_holding_snapshots
            UNION ALL
            SELECT snapshot_date FROM cash_account_snapshots
        ) AS snapshot_dates
        """
    ).fetchone()
    return str(row["first_date"]) if row and row["first_date"] else None


def get_latest_benchmark_price_date(conn, benchmark: str) -> str | None:
    row = conn.execute(
        """
        SELECT MAX(price_date) AS latest_date
        FROM benchmark_prices
        WHERE benchmark = ?
        """,
        (benchmark,),
    ).fetchone()
    return str(row["latest_date"]) if row and row["latest_date"] else None
