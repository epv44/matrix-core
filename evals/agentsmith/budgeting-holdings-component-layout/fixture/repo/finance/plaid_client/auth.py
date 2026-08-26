import logging

import plaid
from plaid.api import plaid_api
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from plaid.model.products import Products
from plaid.model.sandbox_public_token_create_request import (
    SandboxPublicTokenCreateRequest,
)
from plaid.model.sandbox_public_token_create_request_options import (
    SandboxPublicTokenCreateRequestOptions,
)
from plaid.model.sandbox_public_token_create_request_options_transactions import (
    SandboxPublicTokenCreateRequestOptionsTransactions,
)

from finance.config.settings import token_label
from finance.exceptions import PlaidError
from finance.security.sanitize import sanitized_error, wrap_plaid_call
from finance.security.token_store import set_token as set_keychain_token

logger = logging.getLogger(__name__)

SANDBOX_INSTITUTION_ID = "ins_56"
SANDBOX_USERNAME = "user_good"
SANDBOX_PASSWORD = "pass_good"


def get_client(config: dict) -> plaid_api.PlaidApi:
    env = config["plaid_environment"]
    if env == "sandbox":
        host = plaid.Environment.Sandbox
    else:
        host = plaid.Environment.Production

    configuration = plaid.Configuration(
        host=host,
        api_key={
            "clientId": config["plaid_client_id"],
            "secret": config["plaid_secret"],
        },
    )
    api_client = plaid.ApiClient(configuration)
    return plaid_api.PlaidApi(api_client)


def setup_sandbox_institution(
    client: plaid_api.PlaidApi, institution_name: str, config: dict
) -> tuple[str, str]:
    days = 730 if config.get("webhook_url") else 30
    options_kwargs = {
        "override_username": SANDBOX_USERNAME,
        "override_password": SANDBOX_PASSWORD,
        "transactions": SandboxPublicTokenCreateRequestOptionsTransactions(
            days_requested=days
        ),
    }
    if config.get("webhook_url"):
        options_kwargs["webhook"] = config["webhook_url"]
    options = SandboxPublicTokenCreateRequestOptions(**options_kwargs)
    request = SandboxPublicTokenCreateRequest(
        institution_id=SANDBOX_INSTITUTION_ID,
        initial_products=[Products("transactions")],
        options=options,
    )
    response = wrap_plaid_call(lambda: client.sandbox_public_token_create(request))
    public_token = response["public_token"]

    exchange_request = ItemPublicTokenExchangeRequest(public_token=public_token)
    exchange_response = wrap_plaid_call(
        lambda: client.item_public_token_exchange(exchange_request)
    )
    access_token = exchange_response["access_token"]
    item_id = exchange_response["item_id"]

    keychain_label = token_label(config["plaid_environment"], institution_name)
    set_keychain_token(keychain_label, access_token)

    logger.info(
        "Sandbox link complete for %s (item_id=%s, token stored securely)",
        institution_name,
        item_id,
    )

    return access_token, item_id


def health_check_token(
    client: plaid_api.PlaidApi, access_token: str
) -> tuple[bool, str | None]:
    try:
        request = AccountsGetRequest(access_token=access_token)
        wrap_plaid_call(lambda: client.accounts_get(request))
        return True, None
    except PlaidError as exc:
        err_msg = str(exc)
        if "ITEM_LOGIN_REQUIRED" in err_msg:
            return False, "ITEM_LOGIN_REQUIRED"
        if "INVALID_ACCESS_TOKEN" in err_msg:
            return False, "INVALID_ACCESS_TOKEN"
        return False, sanitized_error(exc)
