from datetime import datetime, timedelta, timezone

import pytest

from finance.models.dataclasses import Institution
from finance.services.sync_policy import (
    COOLDOWN,
    FRESH,
    IN_FLIGHT,
    RUN,
    acquire_sync_scope,
    reset,
)
from finance.storage.connection import get_connection
from finance.storage.repository import (
    record_connection_sync_history,
    upsert_institution,
)
from finance.storage.schema import run_migrations


@pytest.fixture(autouse=True)
def _isolated_policy_state():
    reset()
    yield
    reset()


def _db(tmp_path):
    conn = get_connection(str(tmp_path / "policy.db"))
    run_migrations(conn)
    return conn


def _seed(conn, name: str, age_hours: int) -> None:
    institution_id = upsert_institution(conn, Institution(name=name))
    timestamp = (datetime.now(timezone.utc) - timedelta(hours=age_hours)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    conn.execute(
        "UPDATE institutions SET last_successful_sync = ? WHERE id = ?",
        (timestamp, institution_id),
    )
    conn.commit()


def test_recent_sync_is_fresh(tmp_path):
    conn = _db(tmp_path)
    _seed(conn, "usaa", age_hours=1)

    with acquire_sync_scope(conn, names=("usaa",)) as status:
        assert status == FRESH


def test_stale_sync_allowed_to_run(tmp_path):
    conn = _db(tmp_path)
    _seed(conn, "usaa", age_hours=25)

    with acquire_sync_scope(conn, names=("usaa",)) as status:
        assert status == RUN


def test_mixed_freshness_triggers_sync(tmp_path):
    conn = _db(tmp_path)
    _seed(conn, "usaa", age_hours=1)
    _seed(conn, "chase", age_hours=25)

    with acquire_sync_scope(conn, names=("usaa", "chase")) as status:
        assert status == RUN


def test_force_bypasses_freshness_ttl(tmp_path):
    conn = _db(tmp_path)
    _seed(conn, "usaa", age_hours=1)

    with acquire_sync_scope(conn, names=("usaa",), force=True) as status:
        assert status == RUN


def test_single_flight_blocks_concurrent_sync(tmp_path):
    conn = _db(tmp_path)
    _seed(conn, "usaa", age_hours=25)
    first = acquire_sync_scope(conn, names=("usaa",))
    assert first.__enter__() == RUN
    try:
        with acquire_sync_scope(conn, names=("usaa",), cooldown_seconds=0) as status:
            assert status == IN_FLIGHT
    finally:
        first.__exit__(None, None, None)


def test_lock_released_after_run(tmp_path):
    conn = _db(tmp_path)
    _seed(conn, "usaa", age_hours=25)

    with acquire_sync_scope(conn, names=("usaa",), cooldown_seconds=0) as status:
        assert status == RUN
    with acquire_sync_scope(conn, names=("usaa",), cooldown_seconds=0) as status:
        assert status == RUN


def test_cooldown_blocks_immediate_rerun(tmp_path):
    conn = _db(tmp_path)
    _seed(conn, "usaa", age_hours=25)

    with acquire_sync_scope(conn, names=("usaa",), cooldown_seconds=60) as status:
        assert status == RUN
    with acquire_sync_scope(conn, names=("usaa",), cooldown_seconds=60) as status:
        assert status == COOLDOWN


def test_investment_freshness_uses_connection_history(tmp_path):
    conn = _db(tmp_path)
    institution_id = upsert_institution(
        conn, Institution(name="fidelity", connection_type="INVESTMENT")
    )
    record_connection_sync_history(conn, institution_id, "INVESTMENT", "ok")
    conn.commit()

    with acquire_sync_scope(conn, names=("fidelity",)) as status:
        assert status == FRESH


def test_investment_without_history_is_not_fresh(tmp_path):
    conn = _db(tmp_path)
    upsert_institution(conn, Institution(name="fidelity", connection_type="INVESTMENT"))
    conn.commit()

    with acquire_sync_scope(conn, names=("fidelity",)) as status:
        assert status == RUN
