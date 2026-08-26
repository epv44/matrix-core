from datetime import date, timedelta

import pytest

from finance.services.history import (
    MAX_HISTORY_DAYS,
    history_days,
    validate_backfill_since,
)

TODAY = date(2026, 8, 4)


def test_history_days_defaults_to_max():
    assert history_days(None, today=TODAY) == MAX_HISTORY_DAYS


def test_history_days_computes_days_from_date():
    target = date(2026, 1, 1)
    assert history_days(target, today=TODAY) == (TODAY - target).days


def test_history_days_allows_max_boundary():
    target = TODAY - timedelta(days=MAX_HISTORY_DAYS)
    assert history_days(target, today=TODAY) == MAX_HISTORY_DAYS


def test_history_days_rejects_future():
    with pytest.raises(ValueError, match="future"):
        history_days(date(2027, 1, 1), today=TODAY)


def test_history_days_rejects_older_than_max():
    with pytest.raises(ValueError, match="730"):
        history_days(TODAY - timedelta(days=MAX_HISTORY_DAYS + 1), today=TODAY)


def test_history_days_rejects_today():
    with pytest.raises(ValueError, match="one day"):
        history_days(TODAY, today=TODAY)


def test_validate_backfill_since_allows_today():
    validate_backfill_since(TODAY, today=TODAY)


def test_validate_backfill_since_rejects_future():
    with pytest.raises(ValueError, match="future"):
        validate_backfill_since(date(2027, 1, 1), today=TODAY)


def test_validate_backfill_since_rejects_older_than_max():
    with pytest.raises(ValueError, match="730"):
        validate_backfill_since(
            TODAY - timedelta(days=MAX_HISTORY_DAYS + 1), today=TODAY
        )
