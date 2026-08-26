import logging
import os
import threading
import time
import uuid
import webbrowser
from datetime import date

import uvicorn
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse
from plaid.model.country_code import CountryCode
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products

from finance.config.settings import cert_paths, token_label
from finance.exceptions import LinkError
from finance.plaid_client.auth import get_client
from finance.security.sanitize import wrap_plaid_call
from finance.security.token_store import set_token as set_keychain_token
from finance.services.history import history_days

logger = logging.getLogger(__name__)

DEFAULT_REDIRECT_PORT = 8080
LINK_TIMEOUT_SECONDS = 300


def redirect_port() -> int:
    return int(os.getenv("LINK_REDIRECT_PORT", str(DEFAULT_REDIRECT_PORT)))


def redirect_uri() -> str:
    return f"https://localhost:{redirect_port()}/callback"


def _ensure_certs(config: dict) -> None:
    missing = [p for p in cert_paths(config) if not os.path.exists(p)]
    if missing:
        raise LinkError(
            "HTTPS certificates not found. Generate them with:\n"
            "  brew install mkcert\n"
            "  mkcert -install\n"
            "  mkdir -p certs && cd certs && mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1\n"
            "Then re-run and use Diagnostics (Doctor) in Link / Sync if needed."
        )


def link_institution(
    config: dict,
    institution_name: str,
    history_date: date | None = None,
    connection_type: str = "DEPOSITORY",
    client_user_id: str | None = None,
) -> str:
    client = get_client(config)
    _ensure_certs(config)

    port = redirect_port()
    redirect_uri_value = redirect_uri()
    cert_file, key_file = cert_paths(config)

    user_id = client_user_id or str(uuid.uuid4())
    days = history_days(history_date)
    webhook_url = config.get("webhook_url")
    if not webhook_url:
        days = min(days, 30)
    link_kwargs = {
        "user": LinkTokenCreateRequestUser(client_user_id=user_id),
        "client_name": "Personal Finance Dashboard",
        "products": [
            Products(
                "investments" if connection_type == "INVESTMENT" else "transactions"
            )
        ],
        "country_codes": [CountryCode("US")],
        "language": "en",
        "redirect_uri": redirect_uri_value,
        **(
            {}
            if connection_type == "INVESTMENT"
            else {"transactions": LinkTokenTransactions(days_requested=days)}
        ),
    }
    if webhook_url:
        link_kwargs["webhook"] = webhook_url
    link_request = LinkTokenCreateRequest(**link_kwargs)
    link_response = wrap_plaid_call(lambda: client.link_token_create(link_request))
    link_token = link_response["link_token"]
    logger.info("Link token created for %s", institution_name)

    app = FastAPI()
    received_token = {}
    page_html = _link_page_html(link_token)

    @app.get("/", response_class=HTMLResponse)
    async def index():
        return page_html

    @app.get("/callback")
    async def callback(
        public_token: str | None = Query(None), error: str | None = Query(None)
    ):
        if error:
            received_token["error"] = error
        elif public_token:
            received_token["public_token"] = public_token
        else:
            return "Waiting for Plaid Link to finish..."
        server.should_exit = True
        if error:
            return f"Error from Plaid Link: {error}. You can close this tab."
        return "Bank linked successfully! You can close this tab and return to the terminal."

    def shutdown():
        time.sleep(LINK_TIMEOUT_SECONDS)
        if "public_token" not in received_token and "error" not in received_token:
            logger.warning("Link timed out after %s seconds", LINK_TIMEOUT_SECONDS)
            received_token["error"] = "timeout"
            server.should_exit = True

    config_uvicorn = uvicorn.Config(
        app=app,
        host="127.0.0.1",
        port=port,
        log_level="error",
        ssl_certfile=cert_file,
        ssl_keyfile=key_file,
    )
    server = uvicorn.Server(config_uvicorn)

    shutdown_thread = threading.Thread(target=shutdown, daemon=True)
    shutdown_thread.start()

    webbrowser.open(f"https://localhost:{port}/")
    logger.info(
        "Browser opened for Plaid Link. Waiting for callback on %s", redirect_uri_value
    )

    server.run()

    if "error" in received_token:
        raise LinkError(f"Plaid Link failed: {received_token['error']}")

    public_token = received_token["public_token"]

    exchange_request = ItemPublicTokenExchangeRequest(public_token=public_token)
    exchange_response = wrap_plaid_call(
        lambda: client.item_public_token_exchange(exchange_request)
    )
    access_token = exchange_response["access_token"]
    item_id = exchange_response["item_id"]

    keychain_label = token_label(config["plaid_environment"], institution_name)
    set_keychain_token(keychain_label, access_token)

    logger.info(
        "Link complete for %s (item_id=%s, token stored securely)",
        institution_name,
        item_id,
    )
    return access_token


_LINK_PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Link your bank</title>
  <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
</head>
<body>
  <h1>Personal Finance Dashboard</h1>
  <p>Connect your bank account to continue.</p>
  <button id="link-button">Link bank account</button>
  <script>
    var handler = null;
    document.getElementById('link-button').addEventListener('click', function () {
      if (handler) { handler.open(); }
    });
    (function init() {
      try {
        handler = Plaid.create({
          token: '__LINK_TOKEN__',
          onSuccess: function (public_token, metadata) {
            window.location.href = '/callback?public_token=' + encodeURIComponent(public_token);
          },
          onExit: function (err, metadata) {
            if (err != null) {
              window.location.href = '/callback?error=' + encodeURIComponent(err.error_message || 'exit_error');
            }
          }
        });
      } catch (err) {
        document.getElementById('link-button').textContent = 'Failed to load Plaid Link';
      }
    })();
  </script>
</body>
</html>
"""


def _link_page_html(link_token: str) -> str:
    return _LINK_PAGE_TEMPLATE.replace("__LINK_TOKEN__", link_token)
