import logging
from datetime import date

from finance.config.settings import get_token_for_connection, get_token_for_institution
from finance.exceptions import ConfigError
from finance.plaid_client.investments import sync_investments
from finance.plaid_client.sync import sync_dry_run, sync_institution
from finance.security.sanitize import sanitized_error
from finance.services.history import validate_backfill_since
from finance.storage.repository import get_all_institutions

logger = logging.getLogger(__name__)


def sync_all(
    conn,
    client,
    config,
    since: date | None = None,
    institution_filter: str | None = None,
    replace: bool = False,
    backfill: bool = False,
) -> dict:
    _validate_sync_options(since, replace, backfill)
    results: dict[str, dict[str, object]] = {}
    models = {i.name: i for i in get_all_institutions(conn)}
    institutions = [institution_filter] if institution_filter else list(models)
    for name in institutions:
        try:
            results[name] = _sync_one(
                conn, client, config, models[name], since, replace, backfill
            )
        except Exception as exc:  # noqa: BLE001
            safe = sanitized_error(exc)
            logger.error("Sync failed for %s: %s", name, safe)
            results[name] = {"ok": False, "error": safe}
    return results


def _validate_sync_options(since, replace: bool, backfill: bool) -> None:
    if backfill and replace:
        raise ValueError("backfill and replace are mutually exclusive")
    if backfill:
        if since is None:
            raise ValueError("backfill requires a start date (since)")
        validate_backfill_since(since)


def _sync_one(conn, client, config, model, since, replace, backfill) -> dict:
    try:
        token = get_token_for_connection(config, model)
    except ConfigError:
        token = get_token_for_institution(config, model.name)
    if model.connection_type == "INVESTMENT":
        stats = sync_investments(client, conn, model.name, token, since=since)
        stats.setdefault("modified", 0)
        stats.setdefault("removed", 0)
    else:
        stats = sync_institution(
            client,
            conn,
            model.name,
            token,
            config,
            since=since,
            replace=replace,
            backfill=backfill,
        )
    return {
        "ok": True,
        "added": stats["added"],
        "modified": stats["modified"],
        "removed": stats["removed"],
    }


def dry_run_sync(client, config, institution: str, since: date | None = None):
    token = get_token_for_institution(config, institution)
    return sync_dry_run(client, token, since=since)
