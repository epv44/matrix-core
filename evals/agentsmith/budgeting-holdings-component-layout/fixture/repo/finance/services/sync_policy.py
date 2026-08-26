import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone

from finance.storage.repository import (
    get_all_institutions,
    get_last_connection_sync,
)

SYNC_TTL_SECONDS = 24 * 60 * 60
SYNC_COOLDOWN_SECONDS = 30

FRESH = "fresh"
IN_FLIGHT = "in_flight"
COOLDOWN = "cooldown"
RUN = "run"

_state_lock = threading.Lock()
_scope_locks: dict[str, threading.Lock] = {}
_last_completed: dict[str, float] = {}


def _scope_key(names: tuple[str, ...]) -> str:
    return ",".join(names)


def _timestamp(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value))
        except ValueError:
            return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _last_successful_timestamps(conn, names: tuple[str, ...]) -> dict[str, float]:
    timestamps: dict[str, float] = {}
    for institution in get_all_institutions(conn):
        if institution.name not in names:
            continue
        raw_value: str | datetime | None
        if institution.connection_type == "INVESTMENT" and institution.id is not None:
            raw_value = get_last_connection_sync(conn, institution.id, "INVESTMENT")
        else:
            raw_value = institution.last_successful_sync
        timestamps[institution.name] = _timestamp(raw_value)
    return timestamps


@contextmanager
def acquire_sync_scope(
    conn,
    *,
    names: tuple[str, ...],
    force: bool = False,
    cooldown_seconds: int = SYNC_COOLDOWN_SECONDS,
) -> Iterator[str]:
    if not force:
        timestamps = _last_successful_timestamps(conn, names)
        if timestamps and all(
            time.time() - timestamp < SYNC_TTL_SECONDS
            for timestamp in timestamps.values()
        ):
            yield FRESH
            return
    key = _scope_key(tuple(sorted(names)))
    with _state_lock:
        completed_at = _last_completed.get(key)
        if completed_at is not None and (
            time.monotonic() - completed_at < cooldown_seconds
        ):
            yield COOLDOWN
            return
        lock = _scope_locks.get(key)
        if lock is not None:
            if not lock.acquire(blocking=False):
                yield IN_FLIGHT
                return
        else:
            lock = _scope_locks.setdefault(key, threading.Lock())
            lock.acquire()
    try:
        yield RUN
    finally:
        lock.release()
        _last_completed[key] = time.monotonic()


def reset() -> None:
    with _state_lock:
        _scope_locks.clear()
        _last_completed.clear()
