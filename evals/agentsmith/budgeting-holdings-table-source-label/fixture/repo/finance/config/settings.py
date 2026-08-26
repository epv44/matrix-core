import logging
import os
import pathlib
import stat

from dotenv import load_dotenv

from finance.exceptions import ConfigError
from finance.security.token_store import (
    get_token as get_keychain_token,
)
from finance.security.token_store import (
    set_token as set_keychain_token,
)

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DEFAULT_DB_PATH = PROJECT_ROOT / "finance.db"
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"
DEFAULT_TEMPLATE_PATH = PROJECT_ROOT / "Untitled spreadsheet.xlsx"
DEFAULT_IDENTITY_DB_PATH = PROJECT_ROOT / "finance_identity.db"
logger = logging.getLogger(__name__)
VALID_ENVIRONMENTS = ("sandbox", "production")


def _enforce_file_permissions(path: pathlib.Path, mode: int = 0o600) -> None:
    try:
        current = stat.S_IMODE(path.stat().st_mode)
        if current != mode:
            path.chmod(mode)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("Could not set permissions on %s", path)


def load_config() -> dict:
    env_path = DEFAULT_ENV_PATH
    if env_path.exists():
        load_dotenv(env_path)
        _enforce_file_permissions(env_path, 0o600)
    client_id = os.getenv("PLAID_CLIENT_ID")
    prod_secret = os.getenv("PLAID_SECRET")
    sandbox_secret = os.getenv("PLAID_SANDBOX_SECRET")
    db_path = os.getenv("DB_PATH")
    if not db_path:
        db_path = str(DEFAULT_DB_PATH)
    log_level = os.getenv("LOG_LEVEL", "INFO")
    log_file = os.getenv("LOG_FILE") or str(PROJECT_ROOT / "logs" / "finance.log")
    webhook_url = os.getenv("WEBHOOK_URL")
    identity_db_path = os.getenv("IDENTITY_DB_PATH") or str(DEFAULT_IDENTITY_DB_PATH)
    plaid_redirect_uri = os.getenv("PLAID_REDIRECT_URI")
    session_cookie_secure = _boolean_env("SESSION_COOKIE_SECURE", default=False)
    if not client_id:
        raise ConfigError("PLAID_CLIENT_ID must be set in .env file")
    return {
        "plaid_client_id": client_id,
        "plaid_secret": prod_secret,
        "plaid_sandbox_secret": sandbox_secret,
        "db_path": db_path,
        "log_level": log_level,
        "log_file": log_file,
        "webhook_url": webhook_url or None,
        "identity_db_path": identity_db_path,
        "plaid_redirect_uri": plaid_redirect_uri or None,
        "session_cookie_secure": session_cookie_secure,
        "template_path": str(DEFAULT_TEMPLATE_PATH),
        "project_root": str(PROJECT_ROOT),
        "certs_dir": str(PROJECT_ROOT / "certs"),
    }


def _boolean_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be true or false")


def db_path_for_env(base_path: str, env: str) -> str:
    env = env.lower()
    # Honor explicit prod db that already exists: if user previously used finance.db as production
    # If base already contains env tag, replace
    p = pathlib.Path(base_path)
    stem = p.stem
    suffix = p.suffix or ".db"
    parent = p.parent
    for e in VALID_ENVIRONMENTS:
        tag = f"_{e}"
        if stem.endswith(tag):
            stem = stem[: -len(tag)]
            break
    new_name = f"{stem}_{env}{suffix}"
    isolated = str(parent / new_name)
    # Fallback: if legacy finance.db exists and isolated is prod and isolated file empty/missing but legacy has data, auto-migrate
    # This fallback is handled in get_connection_migrate_legacy, not here
    return isolated


def resolve_environment(config: dict, env: str | None) -> dict:
    environment = (env or os.getenv("PLAID_ENVIRONMENT") or "sandbox").lower()
    if environment not in VALID_ENVIRONMENTS:
        raise ConfigError(
            f"Invalid environment '{environment}'. Must be one of: {', '.join(VALID_ENVIRONMENTS)}"
        )
    resolved = dict(config)
    resolved["plaid_environment"] = environment
    secret_var = "PLAID_SANDBOX_SECRET" if environment == "sandbox" else "PLAID_SECRET"
    secret = (
        config["plaid_sandbox_secret"]
        if environment == "sandbox"
        else config["plaid_secret"]
    )
    if not secret:
        raise ConfigError(
            f"{secret_var} must be set in .env file for environment '{environment}'"
        )
    resolved["plaid_secret"] = secret
    resolved["db_path"] = db_path_for_env(config["db_path"], environment)
    return resolved


def token_label(environment: str, institution: str) -> str:
    return f"plaid_access_token_{environment}_{institution}"


def connection_token_label(environment: str, connection_uuid: str) -> str:
    return f"plaid_access_token_{environment}_connection_{connection_uuid}"


def _discover_cert_pair(certs_dir: str) -> tuple[str, str] | None:
    if not os.path.isdir(certs_dir):
        return None
    names = os.listdir(certs_dir)
    certs = sorted(
        n for n in names if n.endswith(".pem") and not n.endswith("-key.pem")
    )
    keys = sorted(n for n in names if n.endswith("-key.pem"))
    if not certs or not keys:
        return None
    return os.path.join(certs_dir, certs[0]), os.path.join(certs_dir, keys[0])


def cert_paths(config: dict) -> tuple[str, str]:
    certs_dir = config["certs_dir"]
    for cert_name, key_name in (
        ("localhost.pem", "localhost-key.pem"),
        ("localhost+2.pem", "localhost+2-key.pem"),
    ):
        cert_file = os.path.join(certs_dir, cert_name)
        key_file = os.path.join(certs_dir, key_name)
        if os.path.exists(cert_file) and os.path.exists(key_file):
            return cert_file, key_file
    pair = _discover_cert_pair(certs_dir)
    if pair:
        return pair
    return os.path.join(certs_dir, "localhost.pem"), os.path.join(
        certs_dir, "localhost-key.pem"
    )


def get_token_for_institution(config: dict, institution_name: str) -> str:
    environment = config["plaid_environment"]
    token = get_keychain_token(token_label(environment, institution_name))
    if token is None:
        # legacy fallbacks
        token = get_keychain_token(f"plaid_access_token_{institution_name}")
    if token is None:
        token = get_keychain_token(f"plaid_access_token_production_{institution_name}")
    if token is None:
        token = get_keychain_token(
            f"plaid_access_token_{environment}_{institution_name}".lower()
        )
    if token is None:
        raise ConfigError(
            f"Access token for '{institution_name}' ({environment}) not found in the credential store. Link the institution from the Link / Sync page."
        )
    return token


def get_token_for_connection(config: dict, connection) -> str:
    environment = config["plaid_environment"]
    if connection.connection_uuid:
        label = connection_token_label(environment, connection.connection_uuid)
        token = get_keychain_token(label)
        if token is not None:
            return token
    token = get_token_for_institution(config, connection.name)
    if connection.connection_uuid:
        set_keychain_token(label, token)
    return token
