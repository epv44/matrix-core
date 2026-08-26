import hashlib
import os
import shutil
import sqlite3
import stat
import subprocess

from finance.config.settings import cert_paths, get_token_for_institution, token_label
from finance.exceptions import ConfigError, PlaidError
from finance.plaid_client.auth import get_client, health_check_token
from finance.security.audit import check_dependency_vulnerabilities
from finance.security.token_store import (
    get_token as get_keychain_token,
)
from finance.security.token_store import (
    set_token as set_keychain_token,
)
from finance.storage.connection import get_connection
from finance.storage.repository import get_all_institutions, run_integrity_check


def run_doctor(config: dict, security: bool = False) -> list[dict]:
    checks = [
        _check_config(config),
        _check_db(config),
        _check_keychain(config),
        _check_tokens(config),
        _check_permissions(config),
        _check_cert_system(config),
        _check_cert_project(config),
    ]
    if security:
        checks.append(_check_security())
    return [
        {"name": name, "status": status, "detail": detail}
        for name, status, detail in checks
    ]


def ensure_env_scoped_tokens(config: dict) -> dict:
    env = config["plaid_environment"]
    repaired: dict[str, str] = {}
    for inst in _linked_institution_names(config):
        if get_keychain_token(token_label(env, inst)) is not None:
            continue
        for legacy in (
            f"plaid_access_token_{inst}",
            f"plaid_access_token_production_{inst}",
        ):
            token = get_keychain_token(legacy)
            if token:
                set_keychain_token(token_label(env, inst), token)
                repaired[inst] = legacy
                break
    return repaired


def _linked_institution_names(config: dict) -> list[str]:
    conn = get_connection(config["db_path"])
    try:
        return [i.name for i in get_all_institutions(conn)]
    finally:
        conn.close()


def _check_config(config: dict) -> tuple[str, bool, str]:
    names = _linked_institution_names(config)
    missing = []
    for inst in names:
        try:
            get_token_for_institution(config, inst)
        except ConfigError:
            missing.append(inst)
    if missing:
        return (
            "Config",
            False,
            f"Missing credential-store tokens for: {', '.join(missing)}",
        )
    return ("Config", True, f"All {len(names)} linked institutions configured")


def _check_keychain(config: dict) -> tuple[str, bool, str]:
    env = config["plaid_environment"]
    names = _linked_institution_names(config)
    missing = [
        inst for inst in names if get_keychain_token(token_label(env, inst)) is None
    ]
    if missing:
        return (
            "Credential Store",
            False,
            f"Missing env-scoped token ({env}) for: {', '.join(missing)}. Use Diagnostics (Doctor) in Link / Sync to repair legacy tokens, or re-link the institution.",
        )
    backend = os.getenv("TOKEN_STORE_BACKEND", "macos-keychain")
    return (
        "Credential Store",
        True,
        f"{backend}: all {len(names)} institutions have env-scoped tokens",
    )


def _check_db(config: dict) -> tuple[str, bool, str]:
    db_path = config["db_path"]
    if not os.path.exists(db_path):
        return ("Database", False, f"Database not found at {db_path}")
    try:
        conn = get_connection(db_path)
        results = run_integrity_check(conn)
        conn.close()
        if any("ok" not in r.lower() for r in results):
            return ("Database", False, f"Integrity check failed: {results}")
        return (
            "Database",
            True,
            f"OK ({os.path.getsize(db_path)} bytes, permissions 0600)",
        )
    except (sqlite3.Error, OSError) as exc:
        return ("Database", False, str(exc))


def _check_tokens(config: dict) -> tuple[str, bool, str]:
    try:
        client = get_client(config)
    except (ConfigError, OSError, PlaidError) as exc:
        return ("Tokens", False, str(exc))
    issues = []
    for inst in _linked_institution_names(config):
        try:
            token = get_token_for_institution(config, inst)
            ok, code = health_check_token(client, token)
            if not ok:
                issues.append(f"{inst}: {code}")
        except ConfigError:
            issues.append(f"{inst}: missing")
    if issues:
        return ("Tokens", False, "; ".join(issues))
    return ("Tokens", True, "All tokens valid")


def _check_permissions(config: dict) -> tuple[str, bool, str]:
    db_path = config["db_path"]
    env_path = os.path.join(config["project_root"], ".env")
    for p in [db_path, env_path]:
        if not os.path.exists(p):
            continue
        mode = stat.S_IMODE(os.stat(p).st_mode)
        if mode != 0o600:
            return ("Permissions", False, f"{p} permissions {oct(mode)}, expected 0600")
    return ("Permissions", True, "All file permissions correct")


def _check_cert_system(config: dict) -> tuple[str, bool, str]:
    if shutil.which("mkcert") is None:
        return (
            "Certs (System)",
            False,
            "mkcert not installed. Run: brew install mkcert && mkcert -install",
        )
    try:
        result = subprocess.run(
            ["security", "find-certificate", "-c", "mkcert", "-a"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return ("Certs (System)", False, f"Could not check trust store: {exc}")
    if result.returncode != 0 or "mkcert" not in result.stdout:
        return (
            "Certs (System)",
            False,
            "mkcert root CA not installed. Run: mkcert -install",
        )
    return ("Certs (System)", True, "mkcert installed and root CA trusted")


def _check_cert_project(config: dict) -> tuple[str, bool, str]:
    cert_file, key_file = cert_paths(config)
    missing = [p for p in (cert_file, key_file) if not os.path.exists(p)]
    if missing:
        return (
            "Certs (Project)",
            False,
            f"Missing certificate files: {', '.join(missing)}. Run: mkdir -p certs && cd certs && mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1",
        )
    for p in (cert_file, key_file):
        if not os.access(p, os.R_OK):
            return ("Certs (Project)", False, f"Certificate file not readable: {p}")
    try:
        checkend = subprocess.run(
            ["openssl", "x509", "-checkend", "0", "-noout", "-in", cert_file],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if checkend.returncode != 0:
            return (
                "Certs (Project)",
                False,
                "Certificate is expired. Regenerate with: cd certs && mkcert localhost 127.0.0.1 ::1",
            )
        san = subprocess.run(
            ["openssl", "x509", "-noout", "-ext", "subjectAltName", "-in", cert_file],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if "DNS:localhost" not in san.stdout:
            return (
                "Certs (Project)",
                False,
                "Certificate does not cover localhost. Regenerate with: cd certs && mkcert localhost 127.0.0.1 ::1",
            )
        cert_pubkey = subprocess.run(
            ["openssl", "x509", "-pubkey", "-noout", "-in", cert_file],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        key_pubkey = subprocess.run(
            ["openssl", "pkey", "-pubout", "-in", key_file],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if (
            hashlib.md5(cert_pubkey.stdout.encode()).digest()
            != hashlib.md5(key_pubkey.stdout.encode()).digest()
        ):
            return ("Certs (Project)", False, "Private key does not match certificate")
    except (OSError, subprocess.SubprocessError) as exc:
        return ("Certs (Project)", False, f"Certificate validation failed: {exc}")
    return ("Certs (Project)", True, "Certificates present, valid, and matching")


def _check_security() -> tuple[str, bool, str]:
    vulns = check_dependency_vulnerabilities()
    if vulns is None:
        return (
            "Security",
            True,
            "pip-audit not installed - install with: pip install pip-audit",
        )
    if vulns:
        return ("Security", False, f"{len(vulns)} vulnerability(ies) found")
    return ("Security", True, "No vulnerabilities found")
