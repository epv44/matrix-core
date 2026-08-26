import logging
import re
import subprocess

from finance.exceptions import KeychainError

logger = logging.getLogger(__name__)


KEYCHAIN_SERVICE = "finance-plaid-tokens"


def get_keychain_token(label: str) -> str | None:
    try:
        result = subprocess.run(
            [
                "security",
                "find-internet-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                label,
                "-w",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

        return result.stdout.strip() if result.returncode == 0 else None
    except FileNotFoundError:
        raise KeychainError("'security' CLI not found. This module requires macOS.")
    except subprocess.TimeoutExpired:
        raise KeychainError("Keychain lookup timed out.")
    except (OSError, subprocess.SubprocessError) as exc:
        raise KeychainError(f"Keychain error: {exc}")


def set_keychain_token(label: str, token: str) -> None:
    try:
        existing = get_keychain_token(label)
        if existing:
            cmd = [
                "security",
                "delete-internet-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                label,
            ]
            subprocess.run(cmd, capture_output=True, timeout=10, check=False)

        result = subprocess.run(
            [
                "security",
                "add-internet-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                label,
                "-w",
                token,
                "-U",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            raise KeychainError(
                f"Failed to store token in Keychain: {result.stderr.strip()}"
            )
        logger.info("Access token stored in macOS Keychain (label=%s)", label)
    except FileNotFoundError:
        raise KeychainError("'security' CLI not found. This module requires macOS.")
    except subprocess.TimeoutExpired:
        raise KeychainError("Keychain write timed out.")
    except (OSError, subprocess.SubprocessError) as exc:
        raise KeychainError(f"Keychain error: {exc}")


def delete_keychain_token(label: str) -> None:
    try:
        cmd = [
            "security",
            "delete-internet-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            label,
        ]
        subprocess.run(cmd, capture_output=True, timeout=10, check=False)
    except FileNotFoundError:
        raise KeychainError("'security' CLI not found.")
    except subprocess.TimeoutExpired:
        raise KeychainError("Keychain deletion timed out.")


def list_keychain_tokens() -> list[str]:
    try:
        result = subprocess.run(
            ["security", "dump-keychain"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if result.returncode != 0:
            return []
        labels = []
        for block in re.split(r"^keychain:", result.stdout, flags=re.MULTILINE):
            if f'"srvr"<blob>="{KEYCHAIN_SERVICE}"' not in block:
                continue
            for line in block.splitlines():
                if '"acct"<blob>=' in line:
                    label = line.split("=", 1)[1].strip().strip('"')
                    if label and label != "<NULL>":
                        labels.append(label)
        return labels
    except FileNotFoundError:
        raise KeychainError("'security' CLI not found. This module requires macOS.")
    except subprocess.TimeoutExpired:
        raise KeychainError("Keychain list timed out.")
