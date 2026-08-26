import json

from plaid.exceptions import ApiException
from plaid.model.item_remove_request import ItemRemoveRequest

from finance.exceptions import PlaidError
from finance.security.sanitize import sanitized_error


def remove_item(client, access_token: str) -> str:
    """Revoke one Plaid Item, accepting an Item that is already absent."""

    try:
        client.item_remove(ItemRemoveRequest(access_token=access_token))
    except ApiException as exc:
        if _plaid_error_code(exc) == "ITEM_NOT_FOUND":
            return "already_missing"
        raise PlaidError(sanitized_error(exc)) from None
    return "removed"


def _plaid_error_code(exc: ApiException) -> str | None:
    body = getattr(exc, "body", None)
    if body is None:
        response = getattr(exc, "http_resp", None)
        body = getattr(response, "data", None)
    if isinstance(body, bytes):
        body = body.decode("utf-8", errors="replace")
    if not isinstance(body, str):
        return None
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None
    code = payload.get("error_code")
    return code if isinstance(code, str) else None
