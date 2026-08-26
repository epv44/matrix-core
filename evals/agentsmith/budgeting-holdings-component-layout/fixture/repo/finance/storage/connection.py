import logging
import os
import pathlib
import shutil
import sqlite3
import stat

logger = logging.getLogger(__name__)


def _migrate_legacy_if_needed(db_path: str):
    p = pathlib.Path(db_path)
    if not p.exists():
        legacy = p.parent / (
            p.stem.replace("_sandbox", "").replace("_production", "")
            + (p.suffix or ".db")
        )
        alt = p.parent / "finance.db"
        for candidate in [legacy, alt]:
            if candidate.exists() and candidate != p:
                try:
                    sz = candidate.stat().st_size
                    if sz > 0:
                        shutil.copy(str(candidate), str(p))
                        logger.info("Auto-migrated legacy DB %s -> %s", candidate, p)
                        break
                except OSError:
                    logger.warning(
                        "Could not auto-migrate legacy DB %s -> %s", candidate, p
                    )


def get_connection(db_path: str, check_same_thread: bool = True) -> sqlite3.Connection:
    _migrate_legacy_if_needed(db_path)
    db_exists = os.path.exists(db_path)
    conn = sqlite3.connect(db_path, check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.Error:
        logger.debug("Could not enable WAL mode", exc_info=True)
    if not db_exists:
        try:
            os.chmod(db_path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            logger.debug("Could not set permissions on new database %s", db_path)
        logger.info("Created database at %s with permissions 0600", db_path)
    else:
        try:
            current_mode = stat.S_IMODE(os.stat(db_path).st_mode)
            expected_mode = stat.S_IRUSR | stat.S_IWUSR
            if current_mode != expected_mode:
                os.chmod(db_path, expected_mode)
        except OSError:
            logger.debug("Could not enforce permissions on %s", db_path)
    return conn
