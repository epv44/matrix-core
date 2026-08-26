from datetime import date, datetime, timedelta, timezone

MAX_HISTORY_DAYS = 730


def _today() -> date:
    return datetime.now(timezone.utc).date()


def max_history_start(today: date | None = None) -> date:
    today = today or _today()
    return today - timedelta(days=MAX_HISTORY_DAYS)


def validate_backfill_since(since: date, today: date | None = None) -> None:
    today = today or _today()
    if since > today:
        raise ValueError("backfill start date must not be in the future")
    if since < max_history_start(today):
        raise ValueError(
            "backfill start date cannot be older than 730 days (24 months)"
        )


def history_days(history_date: date | None, today: date | None = None) -> int:
    today = today or _today()
    if history_date is None:
        return MAX_HISTORY_DAYS
    validate_backfill_since(history_date, today)
    days = (today - history_date).days
    if days < 1:
        raise ValueError("history date must be at least one day in the past")
    return days
