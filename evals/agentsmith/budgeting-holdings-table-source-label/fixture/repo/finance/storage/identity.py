"""Application identity persistence, independent of Plaid data environments."""

import hashlib
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from email_validator import EmailNotValidError, validate_email

from finance.storage.connection import get_connection

SESSION_DAYS = 30
INVITATION_HOURS = 48
PASSWORD_MIN_LENGTH = 12
IDENTITY_SCHEMA_VERSION = 3
_password_hasher = PasswordHasher()


def initialize_identity_database(path: str) -> None:
    conn = get_connection(path, check_same_thread=False)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS identity_schema_version (
                version INTEGER NOT NULL
            )
            """
        )
        version_row = conn.execute(
            """
            SELECT version
            FROM identity_schema_version
            ORDER BY version DESC
            LIMIT 1
            """
        ).fetchone()
        if version_row is None:
            conn.execute(
                "INSERT INTO identity_schema_version (version) VALUES (?)",
                (IDENTITY_SCHEMA_VERSION,),
            )
        elif version_row["version"] == 1:
            _migrate_empty_identity_v1(conn)
        elif version_row["version"] == 2:
            _migrate_identity_v2(conn)
        elif version_row["version"] != IDENTITY_SCHEMA_VERSION:
            raise RuntimeError(
                f"Unsupported identity schema version: {version_row['version']}"
            )
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS households (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL COLLATE nocase UNIQUE,
                email TEXT NOT NULL COLLATE nocase UNIQUE,
                password_hash TEXT NOT NULL,
                plaid_client_user_id TEXT NOT NULL UNIQUE,
                is_active INTEGER NOT NULL DEFAULT 1,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS household_memberships (
                household_id TEXT NOT NULL,
                user_id TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MEMBER')),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (household_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                csrf_token TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                last_seen_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
            CREATE TABLE IF NOT EXISTS household_invitations (
                id TEXT PRIMARY KEY,
                household_id TEXT NOT NULL,
                email TEXT NOT NULL COLLATE nocase,
                token_hash TEXT NOT NULL UNIQUE,
                created_by_user_id TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                accepted_at TIMESTAMP,
                revoked_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_household_invitations_household
            ON household_invitations (household_id, created_at);
            """
        )
        conn.commit()
    finally:
        conn.close()


def _migrate_empty_identity_v1(conn) -> None:
    tables = {
        row["name"]
        for row in conn.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
            """
        )
    }
    user_count = (
        conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
        if "users" in tables
        else 0
    )
    if user_count:
        raise RuntimeError(
            "Identity schema contains users and cannot be reset automatically"
        )
    conn.executescript(
        """
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS household_memberships;
        DROP TABLE IF EXISTS users;
        DROP TABLE IF EXISTS households;
        """
    )
    conn.execute(
        "UPDATE identity_schema_version SET version = ?",
        (IDENTITY_SCHEMA_VERSION,),
    )


def _migrate_identity_v2(conn) -> None:
    conn.executescript(
        """
        CREATE TABLE household_invitations (
            id TEXT PRIMARY KEY,
            household_id TEXT NOT NULL,
            email TEXT NOT NULL COLLATE nocase,
            token_hash TEXT NOT NULL UNIQUE,
            created_by_user_id TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            accepted_at TIMESTAMP,
            revoked_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX idx_household_invitations_household
        ON household_invitations (household_id, created_at);
        """
    )
    conn.execute(
        "UPDATE identity_schema_version SET version = ?",
        (IDENTITY_SCHEMA_VERSION,),
    )


def identity_connection(path: str) -> sqlite3.Connection:
    return get_connection(path, check_same_thread=False)


def setup_required(conn) -> bool:
    row = conn.execute(
        """
        SELECT 1
        FROM users
        ORDER BY id
        LIMIT 1
        """
    ).fetchone()
    return row is None


def create_household_admin(
    conn, household_name: str, username: str, email: str, password: str
) -> dict:
    if not setup_required(conn):
        raise ValueError("Initial household setup is already complete")
    _validate_password(password)
    normalized_email = _normalize_email(email)
    household_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    try:
        conn.execute(
            "INSERT INTO households (id, name) VALUES (?, ?)",
            (household_id, household_name.strip()),
        )
        conn.execute(
            """
            INSERT INTO users
            (id, username, email, password_hash, plaid_client_user_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                user_id,
                _normalize_username(username),
                normalized_email,
                _password_hasher.hash(password),
                str(uuid.uuid4()),
            ),
        )
        conn.execute(
            """
            INSERT INTO household_memberships (household_id, user_id, role)
            VALUES (?, ?, 'ADMIN')
            """,
            (household_id, user_id),
        )
    except Exception:
        conn.rollback()
        raise
    conn.commit()
    return get_user(conn, user_id)


def create_household_invitation(
    conn, household_id: str, created_by_user_id: str, email: str
) -> tuple[dict, str]:
    normalized_email = _normalize_email(email)
    existing_user = conn.execute(
        """
        SELECT 1
        FROM users
        WHERE LOWER(email) = LOWER(?)
        """,
        (normalized_email,),
    ).fetchone()
    if existing_user is not None:
        raise ValueError("A user with that email already exists")

    household = conn.execute(
        """
        SELECT name
        FROM households
        WHERE id = ?
        """,
        (household_id,),
    ).fetchone()
    if household is None:
        raise ValueError("Household not found")

    now = datetime.now(timezone.utc)
    invitation_id = str(uuid.uuid4())
    token = secrets.token_urlsafe(32)
    conn.execute(
        """
        UPDATE household_invitations
        SET revoked_at = ?
        WHERE
            household_id = ?
            AND LOWER(email) = LOWER(?)
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        """,
        (
            now.isoformat(),
            household_id,
            normalized_email,
        ),
    )
    conn.execute(
        """
        INSERT INTO household_invitations
        (id, household_id, email, token_hash, created_by_user_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            invitation_id,
            household_id,
            normalized_email,
            _hash_token(token),
            created_by_user_id,
            (now + timedelta(hours=INVITATION_HOURS)).isoformat(),
        ),
    )
    conn.commit()
    return get_household_invitation(conn, token), token


def get_household_invitation(conn, token: str) -> dict:
    row = _active_invitation_row(conn, token)
    return {
        "id": row["id"],
        "email": row["email"],
        "household_name": row["household_name"],
        "expires_at": row["expires_at"],
        "created_at": row["created_at"],
    }


def list_household_invitations(conn, household_id: str) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    rows = conn.execute(
        """
        SELECT
            id,
            email,
            expires_at,
            created_at
        FROM household_invitations
        WHERE
            household_id = ?
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > ?
        ORDER BY created_at DESC
        """,
        (household_id, now),
    ).fetchall()
    return [dict(row) for row in rows]


def revoke_household_invitation(conn, household_id: str, invitation_id: str) -> None:
    result = conn.execute(
        """
        UPDATE household_invitations
        SET revoked_at = ?
        WHERE
            id = ?
            AND household_id = ?
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        """,
        (datetime.now(timezone.utc).isoformat(), invitation_id, household_id),
    )
    conn.commit()
    if result.rowcount != 1:
        raise ValueError("Invitation not found")


def accept_household_invitation(conn, token: str, username: str, password: str) -> dict:
    _validate_password(password)
    normalized_username = _normalize_username(username)
    row = _active_invitation_row(conn, token)
    user_id = str(uuid.uuid4())
    try:
        now = datetime.now(timezone.utc).isoformat()
        result = conn.execute(
            """
            UPDATE household_invitations
            SET accepted_at = ?
            WHERE
                id = ?
                AND accepted_at IS NULL
                AND revoked_at IS NULL
                AND expires_at > ?
            """,
            (now, row["id"], now),
        )
        if result.rowcount != 1:
            raise ValueError("Invitation is invalid or expired")
        existing_user = conn.execute(
            """
            SELECT 1
            FROM users
            WHERE
                LOWER(username) = LOWER(?)
                OR LOWER(email) = LOWER(?)
            """,
            (normalized_username, row["email"]),
        ).fetchone()
        if existing_user is not None:
            raise ValueError("Username or email is already in use")
        conn.execute(
            """
            INSERT INTO users
            (id, username, email, password_hash, plaid_client_user_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                user_id,
                normalized_username,
                row["email"],
                _password_hasher.hash(password),
                str(uuid.uuid4()),
            ),
        )
        conn.execute(
            """
            INSERT INTO household_memberships (household_id, user_id, role)
            VALUES (?, ?, 'MEMBER')
            """,
            (row["household_id"], user_id),
        )
    except Exception:
        conn.rollback()
        raise
    conn.commit()
    return get_user(conn, user_id)


def _active_invitation_row(conn, token: str):
    now = datetime.now(timezone.utc)
    row = conn.execute(
        """
        SELECT
            invitation.id,
            invitation.household_id,
            invitation.email,
            invitation.expires_at,
            invitation.created_at,
            household.name AS household_name
        FROM household_invitations AS invitation
        INNER JOIN households AS household
            ON invitation.household_id = household.id
        WHERE
            invitation.token_hash = ?
            AND invitation.accepted_at IS NULL
            AND invitation.revoked_at IS NULL
        """,
        (_hash_token(token),),
    ).fetchone()
    if row is None or datetime.fromisoformat(row["expires_at"]) <= now:
        raise ValueError("Invitation is invalid or expired")
    return row


def authenticate(conn, email: str, password: str) -> dict | None:
    try:
        normalized_email = _normalize_email(email)
    except ValueError:
        return None
    row = conn.execute(
        """
        SELECT
            u.id,
            u.username,
            u.email,
            u.password_hash,
            u.plaid_client_user_id,
            u.is_active,
            u.must_change_password,
            u.created_at,
            u.updated_at,
            m.household_id,
            m.role
        FROM users AS u
        INNER JOIN household_memberships AS m ON u.id = m.user_id
        WHERE
            LOWER(u.email) = LOWER(?)
            AND u.is_active = 1
        """,
        (normalized_email,),
    ).fetchone()
    if row is None:
        return None
    try:
        if not _password_hasher.verify(row["password_hash"], password):
            return None
    except (VerifyMismatchError, InvalidHashError):
        return None
    if _password_hasher.check_needs_rehash(row["password_hash"]):
        conn.execute(
            """
            UPDATE users
            SET password_hash = ?
            WHERE id = ?
            """,
            (_password_hasher.hash(password), row["id"]),
        )
        conn.commit()
    return _public_user(dict(row))


def get_user(conn, user_id: str) -> dict:
    row = conn.execute(
        """
        SELECT
            u.id,
            u.username,
            u.email,
            u.plaid_client_user_id,
            u.is_active,
            u.must_change_password,
            m.household_id,
            m.role
        FROM users AS u
        INNER JOIN household_memberships AS m ON u.id = m.user_id
        WHERE u.id = ?
        """,
        (user_id,),
    ).fetchone()
    if row is None:
        raise LookupError("User not found")
    return _public_user(dict(row))


def list_members(conn, household_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            u.id,
            u.username,
            u.email,
            u.plaid_client_user_id,
            u.is_active,
            u.must_change_password,
            m.household_id,
            m.role
        FROM users AS u
        INNER JOIN household_memberships AS m ON u.id = m.user_id
        WHERE m.household_id = ?
        ORDER BY LOWER(u.username)
        """,
        (household_id,),
    ).fetchall()
    return [_public_user(dict(row)) for row in rows]


def create_session(conn, user_id: str) -> tuple[str, str]:
    token = secrets.token_urlsafe(48)
    csrf_token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=SESSION_DAYS)
    conn.execute(
        """
        INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (_hash_token(token), user_id, csrf_token, expires.isoformat(), now.isoformat()),
    )
    conn.commit()
    return token, csrf_token


def resolve_session(conn, token: str | None) -> dict | None:
    if not token:
        return None
    now = datetime.now(timezone.utc)
    row = conn.execute(
        """
        SELECT
            s.csrf_token,
            s.expires_at,
            u.id,
            u.username,
            u.email,
            u.plaid_client_user_id,
            u.is_active,
            u.must_change_password,
            m.household_id,
            m.role
        FROM sessions AS s
        INNER JOIN users AS u ON s.user_id = u.id
        INNER JOIN household_memberships AS m ON u.id = m.user_id
        WHERE
            s.token_hash = ?
            AND u.is_active = 1
        """,
        (_hash_token(token),),
    ).fetchone()
    if row is None or datetime.fromisoformat(row["expires_at"]) <= now:
        delete_session(conn, token)
        return None
    conn.execute(
        """
        UPDATE sessions
        SET last_seen_at = ?, expires_at = ?
        WHERE token_hash = ?
        """,
        (
            now.isoformat(),
            (now + timedelta(days=SESSION_DAYS)).isoformat(),
            _hash_token(token),
        ),
    )
    conn.commit()
    user = _public_user(dict(row))
    user["csrf_token"] = row["csrf_token"]
    return user


def delete_session(conn, token: str | None) -> None:
    if token:
        conn.execute(
            """
            DELETE FROM sessions
            WHERE token_hash = ?
            """,
            (_hash_token(token),),
        )
        conn.commit()


def reset_password(conn, user_id: str, password: str, *, force_change: bool) -> None:
    _validate_password(password)
    conn.execute(
        """
        UPDATE users
        SET
            password_hash = ?,
            must_change_password = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (_password_hasher.hash(password), int(force_change), user_id),
    )
    conn.execute(
        """
        DELETE FROM sessions
        WHERE user_id = ?
        """,
        (user_id,),
    )
    conn.commit()


def find_user_id_by_username(conn, username: str) -> str | None:
    row = conn.execute(
        """
        SELECT id
        FROM users
        WHERE LOWER(username) = LOWER(?)
        """,
        (username.strip(),),
    ).fetchone()
    return str(row["id"]) if row else None


def list_active_users(conn) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
            u.id,
            u.username,
            u.email,
            u.plaid_client_user_id,
            u.is_active,
            u.must_change_password,
            m.household_id,
            m.role
        FROM users AS u
        INNER JOIN household_memberships AS m ON u.id = m.user_id
        WHERE u.is_active = 1
        ORDER BY LOWER(u.username)
        """
    ).fetchall()
    return [_public_user(dict(row)) for row in rows]


def _public_user(row: dict) -> dict:
    return {
        key: row[key]
        for key in (
            "id",
            "username",
            "email",
            "plaid_client_user_id",
            "household_id",
            "role",
            "is_active",
            "must_change_password",
        )
        if key in row
    }


def _validate_password(password: str) -> None:
    if len(password) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"Password must be at least {PASSWORD_MIN_LENGTH} characters")
    if len(password) > 128:
        raise ValueError("Password must be at most 128 characters")


def _normalize_username(username: str) -> str:
    normalized = username.strip().lower()
    if len(normalized) < 3 or len(normalized) > 64:
        raise ValueError("Username must be between 3 and 64 characters")
    if not all(character.isalnum() or character in "._-" for character in normalized):
        raise ValueError(
            "Username may contain letters, numbers, dot, dash, and underscore"
        )
    return normalized


def _normalize_email(email: str) -> str:
    try:
        normalized = validate_email(
            email.strip(), check_deliverability=False
        ).normalized
    except EmailNotValidError as exc:
        raise ValueError("Enter a valid email address") from exc
    return normalized.lower()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
