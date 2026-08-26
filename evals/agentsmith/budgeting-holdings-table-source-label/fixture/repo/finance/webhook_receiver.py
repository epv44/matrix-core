import json
import logging

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from finance.exceptions import ConfigError
from finance.security.webhook_verify import (
    WebhookBodyHashError,
    WebhookVerificationError,
    get_webhook_client,
    verify_webhook,
)

logger = logging.getLogger(__name__)

INTERNAL_WEBHOOK_URL = "http://127.0.0.1:8000/api/webhook/transactions"

app = FastAPI(
    title="Budget App Webhook Receiver",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


async def _forward(raw_body: bytes, header: str) -> None:
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.post(
            INTERNAL_WEBHOOK_URL,
            content=raw_body,
            headers={"Plaid-Verification": header},
        )
        response.raise_for_status()


@app.post("/webhook")
async def webhook(request: Request):
    raw_body = await request.body()
    header = request.headers.get("plaid-verification", "")
    try:
        data = json.loads(raw_body)
        environment = data.get("environment")
    except (json.JSONDecodeError, AttributeError):
        return JSONResponse(status_code=400, content={"ok": False})
    if environment not in ("production", "sandbox"):
        return JSONResponse(status_code=400, content={"ok": False})
    try:
        verify_webhook(get_webhook_client(environment), raw_body, header, environment)
    except WebhookBodyHashError as exc:
        logger.warning("Webhook receiver rejected body: %s", exc)
        return JSONResponse(status_code=400, content={"ok": False})
    except (WebhookVerificationError, ConfigError) as exc:
        logger.warning("Webhook receiver rejected signature: %s", exc)
        return JSONResponse(status_code=401, content={"ok": False})
    try:
        await _forward(raw_body, header)
    except httpx.HTTPError as exc:
        logger.warning("Failed to forward webhook to internal API: %s", exc)
        return JSONResponse(status_code=502, content={"ok": False})
    return {"ok": True}
