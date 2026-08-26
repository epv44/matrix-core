"""Platform-neutral storage for long-lived Plaid access tokens."""

import base64
import binascii
import json
import os
import pathlib
import tempfile
from typing import Protocol

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from finance.exceptions import KeychainError
from finance.security import keychain

_VAULT_AAD = b"budget-app-plaid-token-v1"


class TokenStore(Protocol):
    """Minimal credential operations required by Plaid integrations."""

    def get(self, label: str) -> str | None: ...

    def set(self, label: str, token: str) -> None: ...

    def delete(self, label: str) -> None: ...

    def list(self) -> list[str]: ...


class MacOSKeychainTokenStore:
    """Plaid token storage backed by the logged-in user's macOS Keychain."""

    def get(self, label: str) -> str | None:
        return keychain.get_keychain_token(label)

    def set(self, label: str, token: str) -> None:
        keychain.set_keychain_token(label, token)

    def delete(self, label: str) -> None:
        keychain.delete_keychain_token(label)

    def list(self) -> list[str]:
        return keychain.list_keychain_tokens()


class EncryptedFileTokenStore:
    """AES-GCM token vault for a single-user Linux service account."""

    def __init__(self, vault_path: str, key_path: str):
        self.vault_path = pathlib.Path(vault_path).expanduser()
        self.key_path = pathlib.Path(key_path).expanduser()

    def get(self, label: str) -> str | None:
        return self._read().get(label)

    def set(self, label: str, token: str) -> None:
        if not token:
            raise KeychainError("Refusing to store an empty Plaid token")
        values = self._read()
        values[label] = token
        self._write(values)

    def delete(self, label: str) -> None:
        values = self._read()
        if values.pop(label, None) is not None:
            self._write(values)

    def list(self) -> list[str]:
        return sorted(self._read())

    def _key(self) -> bytes:
        self._require_private_file(self.key_path, "token-store key")
        try:
            encoded = self.key_path.read_text(encoding="ascii").strip()
            key = base64.urlsafe_b64decode(encoded)
        except (OSError, UnicodeError, ValueError, binascii.Error) as exc:
            raise KeychainError(f"Could not read token-store key: {exc}") from exc
        if len(key) != 32:
            raise KeychainError("Token-store key must decode to exactly 32 bytes")
        return key

    def _read(self) -> dict[str, str]:
        if not self.vault_path.exists():
            return {}
        self._require_private_file(self.vault_path, "token vault")
        try:
            envelope = json.loads(self.vault_path.read_text(encoding="utf-8"))
            if envelope.get("version") != 1:
                raise ValueError("unsupported vault version")
            nonce = base64.urlsafe_b64decode(envelope["nonce"])
            ciphertext = base64.urlsafe_b64decode(envelope["ciphertext"])
            plaintext = AESGCM(self._key()).decrypt(nonce, ciphertext, _VAULT_AAD)
            values = json.loads(plaintext)
        except (
            OSError,
            KeyError,
            ValueError,
            TypeError,
            binascii.Error,
            InvalidTag,
        ) as exc:
            raise KeychainError(f"Could not open encrypted token vault: {exc}") from exc
        if not isinstance(values, dict) or not all(
            isinstance(label, str) and isinstance(token, str)
            for label, token in values.items()
        ):
            raise KeychainError("Encrypted token vault contains invalid data")
        return values

    def _write(self, values: dict[str, str]) -> None:
        key = self._key()
        nonce = os.urandom(12)
        ciphertext = AESGCM(key).encrypt(
            nonce,
            json.dumps(values, sort_keys=True).encode("utf-8"),
            _VAULT_AAD,
        )
        envelope = {
            "version": 1,
            "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
            "ciphertext": base64.urlsafe_b64encode(ciphertext).decode("ascii"),
        }
        self.vault_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp_path: pathlib.Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.vault_path.parent,
                prefix=f".{self.vault_path.name}.",
                delete=False,
            ) as handle:
                temp_path = pathlib.Path(handle.name)
                os.chmod(temp_path, 0o600)
                json.dump(envelope, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.vault_path)
        except OSError as exc:
            raise KeychainError(
                f"Could not write encrypted token vault: {exc}"
            ) from exc
        finally:
            if temp_path is not None and temp_path.exists():
                temp_path.unlink()

    @staticmethod
    def _require_private_file(path: pathlib.Path, description: str) -> None:
        try:
            mode = path.stat().st_mode & 0o777
        except OSError as exc:
            raise KeychainError(f"Could not access {description}: {exc}") from exc
        if mode & 0o077:
            raise KeychainError(f"{description.capitalize()} must have mode 0600")


def build_token_store(
    backend: str,
    *,
    vault_path: str | None = None,
    key_path: str | None = None,
) -> TokenStore:
    normalized = backend.strip().lower()
    if normalized == "macos-keychain":
        return MacOSKeychainTokenStore()
    if normalized == "encrypted-file":
        if not vault_path or not key_path:
            raise KeychainError(
                "TOKEN_STORE_PATH and TOKEN_STORE_KEY_FILE are required for encrypted-file"
            )
        return EncryptedFileTokenStore(vault_path, key_path)
    raise KeychainError(f"Unsupported TOKEN_STORE_BACKEND: {backend}")


def configured_token_store() -> TokenStore:
    backend = os.getenv("TOKEN_STORE_BACKEND", "macos-keychain")
    return build_token_store(
        backend,
        vault_path=os.getenv("TOKEN_STORE_PATH"),
        key_path=os.getenv("TOKEN_STORE_KEY_FILE"),
    )


def get_token(label: str) -> str | None:
    return configured_token_store().get(label)


def set_token(label: str, token: str) -> None:
    configured_token_store().set(label, token)


def delete_token(label: str) -> None:
    configured_token_store().delete(label)


def list_tokens() -> list[str]:
    return configured_token_store().list()
