import logging
import threading

from finance.config.settings import load_config, resolve_environment
from finance.exceptions import ConfigError
from finance.plaid_client.auth import get_client
from finance.services.plaid_sync import sync_all
from finance.storage.connection import get_connection
from finance.storage.repository import (
    claim_next_webhook_job,
    finish_webhook_job,
    get_institution_name_by_item_id,
    recover_webhook_jobs,
)

logger = logging.getLogger(__name__)


class WebhookJobWorker:
    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="webhook-job-worker", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            worked = False
            for environment in ("production", "sandbox"):
                if self._stop.is_set():
                    return
                worked = self._process_one(environment) or worked
            if not worked:
                self._stop.wait(1)

    def _process_one(self, environment: str) -> bool:

        try:
            resolved = resolve_environment(load_config(), environment)
        except ConfigError:
            return False
        conn = get_connection(resolved["db_path"], check_same_thread=False)
        try:
            recover_webhook_jobs(conn)
            job = claim_next_webhook_job(conn)
            if job is None:
                return False
            try:
                name = get_institution_name_by_item_id(conn, job["item_id"])
                if name is None:
                    raise LookupError(f"Unknown Plaid item {job['item_id']}")

                result = sync_all(
                    conn,
                    get_client(resolved),
                    resolved,
                    institution_filter=name,
                ).get(name, {})
                if not result.get("ok"):
                    raise RuntimeError(str(result.get("error") or "sync failed"))
                finish_webhook_job(conn, job["id"])
                logger.info("Completed webhook job %s for %s", job["id"], name)
            except Exception as exc:
                logger.exception("Webhook job %s failed", job["id"])
                finish_webhook_job(conn, job["id"], str(exc))
            return True
        finally:
            conn.close()


worker = WebhookJobWorker()
