import pathlib

from finance.api.routers.webhook import should_trigger_sync
from finance.config.settings import load_config
from finance.models.dataclasses import Institution
from finance.storage.connection import get_connection
from finance.storage.repository import (
    claim_next_webhook_job,
    enqueue_webhook_job,
    finish_webhook_job,
    get_institution_name_by_item_id,
    update_institution_item_id,
    upsert_institution,
)
from finance.storage.schema import run_migrations


def test_should_trigger_sync_only_for_transactions_sync_updates():
    assert (
        should_trigger_sync("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", False, True)
        is True
    )
    assert (
        should_trigger_sync("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", True, False)
        is True
    )
    assert (
        should_trigger_sync("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", False, False)
        is True
    )
    assert should_trigger_sync("TRANSACTIONS", "INITIAL_UPDATE", False, False) is False
    assert should_trigger_sync("ITEM", "ERROR", False, False) is False
    assert should_trigger_sync(None, None, None, None) is False


def test_load_config_reads_webhook_url(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "finance.config.settings.DEFAULT_ENV_PATH",
        pathlib.Path(str(tmp_path / "missing.env")),
    )
    monkeypatch.setenv("PLAID_CLIENT_ID", "cid")
    monkeypatch.setenv("PLAID_SECRET", "sec")
    monkeypatch.delenv("WEBHOOK_URL", raising=False)
    assert load_config()["webhook_url"] is None
    monkeypatch.setenv("WEBHOOK_URL", "https://abc.ngrok-free.app")
    assert load_config()["webhook_url"] == "https://abc.ngrok-free.app"


def test_get_institution_name_by_item_id(tmp_path):

    conn = get_connection(str(tmp_path / "test.db"))
    run_migrations(conn)
    inst_id = upsert_institution(conn, Institution(name="usaa"))
    update_institution_item_id(conn, inst_id, "item-abc")
    assert get_institution_name_by_item_id(conn, "item-abc") == "usaa"
    assert get_institution_name_by_item_id(conn, "nope") is None
    conn.close()


def test_webhook_jobs_are_durable_and_deduplicated(tmp_path):
    conn = get_connection(str(tmp_path / "jobs.db"))
    run_migrations(conn)
    args = (
        "delivery-1",
        "sandbox",
        "item-abc",
        "TRANSACTIONS",
        "SYNC_UPDATES_AVAILABLE",
        False,
        False,
    )
    assert enqueue_webhook_job(conn, *args) is True
    assert enqueue_webhook_job(conn, *args) is False
    job = claim_next_webhook_job(conn)
    assert job is not None
    assert job["item_id"] == "item-abc"
    finish_webhook_job(conn, job["id"])
    assert claim_next_webhook_job(conn) is None
    conn.close()
