"""Budget-facing normalization for equity compensation."""

import math
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import yfinance as yf

from finance.storage.repositories.investments import (
    get_first_snapshot_date,
    get_latest_benchmark_price_date,
)
from finance.storage.repository import get_setting, set_setting, upsert_benchmark_prices

BENCHMARK = "SP500_TOTAL_RETURN_PROXY"
BENCHMARK_REFRESH_SETTING = "benchmark_sp500_last_refresh_attempt"


def refresh_sp500_prices(conn, start_date=None, end_date=None) -> int:
    """Cache SPY adjusted closes as an S&P 500 total-return proxy."""
    start_date = start_date or _benchmark_start_date(conn)
    end_date = end_date or (datetime.now(timezone.utc).date() + timedelta(days=1))
    if _date_value(start_date) >= _date_value(end_date):
        return 0
    history = yf.Ticker("SPY").history(
        start=start_date, end=end_date, auto_adjust=False
    )
    rows = []
    for index, row in history.iterrows():
        close = row.get("Adj Close")
        if close is not None and math.isfinite(float(close)):
            rows.append((index.date().isoformat(), float(close)))
    upsert_benchmark_prices(conn, rows, benchmark=BENCHMARK, source="yfinance:SPY")
    return len(rows)


def _benchmark_start_date(conn):
    latest_date = get_latest_benchmark_price_date(conn, BENCHMARK)
    if latest_date:
        return (_date_value(latest_date) + timedelta(days=1)).isoformat()
    first_date = get_first_snapshot_date(conn)
    if first_date:
        return first_date
    return (datetime.now(timezone.utc).date() - timedelta(days=365 * 5)).isoformat()


def refresh_sp500_prices_if_stale(conn, force: bool = False) -> tuple[int, bool]:
    """Refresh the benchmark at most once per 24 hours unless explicitly forced."""
    now = datetime.now(timezone.utc)
    last_attempt = get_setting(conn, BENCHMARK_REFRESH_SETTING)
    if not force and last_attempt:
        attempted_at = datetime.fromisoformat(last_attempt)
        if now - attempted_at < timedelta(hours=24):
            return 0, False
    set_setting(conn, BENCHMARK_REFRESH_SETTING, now.isoformat())
    return refresh_sp500_prices(conn), True


def _date_value(value: date | datetime | str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.fromisoformat(value).date()


def normalize_rsu_vest(shares, fair_market_value, withholding=0) -> dict[str, Decimal]:
    shares = Decimal(str(shares or 0))
    fair_market_value = Decimal(str(fair_market_value or 0))
    withholding = Decimal(str(withholding or 0))
    gross = shares * fair_market_value
    return {
        "gross_income": gross,
        "withholding": withholding,
        "net_shares": (gross - withholding) / fair_market_value
        if fair_market_value
        else Decimal(0),
        "budget_income_source": "RSU vest",
        "withholding_treatment": "tax expense",
    }


def normalize_option_exercise(
    shares, strike_price, fair_market_value, withholding=0
) -> dict[str, Decimal]:
    shares = Decimal(str(shares or 0))
    spread = max(
        Decimal(str(fair_market_value or 0)) - Decimal(str(strike_price or 0)),
        Decimal(0),
    )
    withholding = Decimal(str(withholding or 0))
    return {
        "gross_income": shares * spread,
        "withholding": withholding,
        "net_shares": shares - withholding / Decimal(str(fair_market_value or 1)),
    }
