import hashlib
import json
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from finance.api.deps import DbDep, EnvDep
from finance.config.settings import load_config, resolve_environment
from finance.exceptions import ConfigError
from finance.security.webhook_verify import (
    WebhookBodyHashError,
    WebhookVerificationError,
    get_webhook_client,
    verify_webhook,
)
from finance.storage.connection import get_connection
from finance.storage.repository import enqueue_webhook_job

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/webhook", tags=["webhook"])


class TransactionsWebhook(BaseModel):
    webhook_type: str | None = None
    webhook_code: str | None = None
    item_id: str | None = None
    initial_update_complete: bool | None = None
    historical_update_complete: bool | None = None
    environment: str | None = None


def should_trigger_sync(
    webhook_type: str | None,
    webhook_code: str | None,
    initial_update_complete: bool | None,
    historical_update_complete: bool | None,
) -> bool:
    if webhook_type != "TRANSACTIONS":
        return False
    return webhook_code == "SYNC_UPDATES_AVAILABLE"


@router.get("/status")
def webhook_status(env: EnvDep, db: DbDep):
    _, resolved = db
    url = resolved.get("webhook_url")
    return {"enabled": bool(url), "url": url}


@router.post("/transactions")
async def transactions_webhook(request: Request):
    raw_body = await request.body()
    header = request.headers.get("plaid-verification", "")
    try:
        data = json.loads(raw_body)
        payload = TransactionsWebhook(**data)
    except (json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    if payload.environment not in ("production", "sandbox"):
        raise HTTPException(status_code=400, detail="Invalid webhook environment")
    try:
        verify_webhook(
            get_webhook_client(payload.environment),
            raw_body,
            header,
            payload.environment,
        )
    except WebhookBodyHashError as exc:
        logger.warning("Webhook body verification failed: %s", exc)
        raise HTTPException(status_code=400, detail=str(exc))
    except (WebhookVerificationError, ConfigError) as exc:
        logger.warning("Webhook signature verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid webhook signature")
    logger.info(
        "Webhook received type=%s code=%s item=%s initial_complete=%s historical_complete=%s",
        payload.webhook_type,
        payload.webhook_code,
        payload.item_id,
        payload.initial_update_complete,
        payload.historical_update_complete,
    )
    if payload.item_id and should_trigger_sync(
        payload.webhook_type,
        payload.webhook_code,
        payload.initial_update_complete,
        payload.historical_update_complete,
    ):
        resolved = resolve_environment(load_config(), payload.environment)
        conn = get_connection(resolved["db_path"], check_same_thread=False)
        try:
            inserted = enqueue_webhook_job(
                conn,
                hashlib.sha256(header.encode("utf-8")).hexdigest(),
                payload.environment,
                payload.item_id,
                payload.webhook_type or "",
                payload.webhook_code or "",
                payload.initial_update_complete,
                payload.historical_update_complete,
            )
        finally:
            conn.close()
        logger.info("Webhook job queued=%s for item %s", inserted, payload.item_id)
        return {"ok": True, "queued": inserted}
    return {"ok": True, "queued": False}
