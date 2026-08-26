import base64
import os

import pytest

from finance.exceptions import KeychainError
from finance.security.token_store import (
    EncryptedFileTokenStore,
    build_token_store,
)


def _key_file(tmp_path):
    path = tmp_path / "token-store.key"
    path.write_text(base64.urlsafe_b64encode(os.urandom(32)).decode("ascii"))
    path.chmod(0o600)
    return path


def test_encrypted_file_store_round_trips_without_plaintext(tmp_path):
    key_path = _key_file(tmp_path)
    vault_path = tmp_path / "tokens.enc"
    store = EncryptedFileTokenStore(str(vault_path), str(key_path))

    store.set("plaid_access_token_production_connection_one", "access-secret")

    assert store.get("plaid_access_token_production_connection_one") == "access-secret"
    assert store.list() == ["plaid_access_token_production_connection_one"]
    assert "access-secret" not in vault_path.read_text()
    assert vault_path.stat().st_mode & 0o777 == 0o600
    store.delete("plaid_access_token_production_connection_one")
    assert store.get("plaid_access_token_production_connection_one") is None


def test_encrypted_store_rejects_readable_key_file(tmp_path):
    key_path = _key_file(tmp_path)
    key_path.chmod(0o644)
    store = EncryptedFileTokenStore(str(tmp_path / "tokens.enc"), str(key_path))

    with pytest.raises(KeychainError, match="mode 0600"):
        store.set("label", "token")


def test_unknown_token_backend_fails_closed():
    with pytest.raises(KeychainError, match="Unsupported"):
        build_token_store("plaintext")
