import logging

from finance.config.settings import (
    connection_token_label,
    get_token_for_connection,
    token_label,
)
from finance.exceptions import ConfigError, KeychainError
from finance.plaid_client.items import remove_item
from finance.security.token_store import delete_token as delete_keychain_token
from finance.storage.repositories.institutions import delete_connection_data
from finance.storage.repository import get_institution_by_uuid

logger = logging.getLogger(__name__)


def unlink_connection(conn, client, config: dict, connection_id: str) -> dict:
    institution = get_institution_by_uuid(conn, connection_id)
    if institution is None or institution.id is None:
        raise ValueError("Connection not found")
    try:
        access_token = get_token_for_connection(config, institution)
    except ConfigError as exc:
        raise ConfigError(
            "The connection token is unavailable, so Plaid access cannot be revoked"
        ) from exc

    remote_status = remove_item(client, access_token)
    counts = delete_connection_data(conn, institution.id, institution.plaid_item_id)
    labels = _connection_token_labels(config["plaid_environment"], institution)
    keychain_deleted = True
    for label in labels:
        try:
            delete_keychain_token(label)
        except KeychainError:
            keychain_deleted = False
            logger.warning(
                "Revoked Keychain credential could not be deleted for connection %s",
                connection_id,
                exc_info=True,
            )
    logger.info(
        "Unlinked connection %s (%s): remote_status=%s accounts=%d transactions=%d investment_transactions=%d",
        connection_id,
        config["plaid_environment"],
        remote_status,
        counts["accounts"],
        counts["transactions"],
        counts["investment_transactions"],
    )
    return {
        "ok": True,
        "connection_id": connection_id,
        "remote_status": remote_status,
        "keychain_deleted": keychain_deleted,
    }


def _connection_token_labels(environment: str, institution) -> set[str]:
    labels = {
        token_label(environment, institution.name),
        f"plaid_access_token_{institution.name}",
        f"plaid_access_token_production_{institution.name}",
        f"plaid_access_token_{environment}_{institution.name}".lower(),
    }
    if institution.connection_uuid:
        labels.add(connection_token_label(environment, institution.connection_uuid))
    return labels
