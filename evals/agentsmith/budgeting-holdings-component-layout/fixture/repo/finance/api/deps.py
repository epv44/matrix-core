import logging
import sqlite3
from typing import Annotated

from fastapi import Depends, Query

from finance.config.settings import load_config, resolve_environment
from finance.storage.connection import get_connection

logger = logging.getLogger(__name__)


def get_env_param(
    env: str = Query("sandbox", description="sandbox or production"),
) -> str:
    env = env.lower()
    if env not in ("sandbox", "production"):
        return "sandbox"
    return env


def get_db_connection(env: str):
    cfg = load_config()
    resolved = resolve_environment(cfg, env)
    conn = get_connection(resolved["db_path"], check_same_thread=False)
    return conn, resolved


def get_db(env: str = Query("sandbox")):
    cfg = load_config()
    resolved = resolve_environment(cfg, env)
    conn = get_connection(resolved["db_path"], check_same_thread=False)
    try:
        yield conn, resolved
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            logger.warning("Failed to close database connection", exc_info=True)


EnvDep = Annotated[str, Depends(get_env_param)]
DbDep = Annotated[tuple[sqlite3.Connection, dict], Depends(get_db)]
