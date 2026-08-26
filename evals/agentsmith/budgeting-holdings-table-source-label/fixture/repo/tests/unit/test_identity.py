import sqlite3

import pytest

from finance.storage.identity import (
    accept_household_invitation,
    authenticate,
    create_household_admin,
    create_household_invitation,
    create_session,
    get_household_invitation,
    identity_connection,
    initialize_identity_database,
    list_household_invitations,
    resolve_session,
    revoke_household_invitation,
    setup_required,
)


def test_household_setup_login_and_sessions(tmp_path):
    path = str(tmp_path / "identity.db")
    initialize_identity_database(path)
    conn = identity_connection(path)
    assert setup_required(conn) is True

    admin = create_household_admin(
        conn, "Home", "admin", "admin@example.com", "a-secure-password"
    )
    assert setup_required(conn) is False
    authenticated = authenticate(conn, "ADMIN@EXAMPLE.COM", "a-secure-password")
    assert authenticated is not None
    assert authenticated["id"] == admin["id"]
    assert authenticated["email"] == "admin@example.com"
    assert authenticate(conn, "admin", "a-secure-password") is None
    assert authenticate(conn, "admin@example.com", "incorrect-password") is None

    token, csrf_token = create_session(conn, admin["id"])
    resolved = resolve_session(conn, token)
    assert resolved is not None
    assert resolved["id"] == admin["id"]
    assert resolved["csrf_token"] == csrf_token
    conn.close()


def test_identity_rejects_invalid_and_duplicate_emails(tmp_path):
    path = str(tmp_path / "identity.db")
    initialize_identity_database(path)
    conn = identity_connection(path)

    with pytest.raises(ValueError, match="valid email"):
        create_household_admin(
            conn, "Home", "admin", "not-an-email", "a-secure-password"
        )

    create_household_admin(
        conn, "Home", "admin", "admin@example.com", "a-secure-password"
    )
    conn.close()


def test_invitation_acceptance_creates_member_and_consumes_token(tmp_path):
    path = str(tmp_path / "identity.db")
    initialize_identity_database(path)
    conn = identity_connection(path)
    admin = create_household_admin(
        conn, "Home", "admin", "admin@example.com", "a-secure-password"
    )

    invitation, token = create_household_invitation(
        conn, admin["household_id"], admin["id"], "MEMBER@example.com"
    )
    assert invitation["email"] == "member@example.com"
    assert invitation["household_name"] == "Home"
    assert (
        list_household_invitations(conn, admin["household_id"])[0]["id"]
        == invitation["id"]
    )
    stored = conn.execute(
        "SELECT token_hash FROM household_invitations WHERE id = ?", (invitation["id"],)
    ).fetchone()
    assert stored["token_hash"] != token

    member = accept_household_invitation(
        conn, token, "new.member", "member-chosen-password"
    )
    assert member["email"] == "member@example.com"
    assert member["role"] == "MEMBER"
    assert member["must_change_password"] == 0
    assert (
        authenticate(conn, "member@example.com", "member-chosen-password") is not None
    )
    assert list_household_invitations(conn, admin["household_id"]) == []
    with pytest.raises(ValueError, match="invalid or expired"):
        get_household_invitation(conn, token)
    conn.close()


def test_invitation_can_be_revoked_and_reissued(tmp_path):
    path = str(tmp_path / "identity.db")
    initialize_identity_database(path)
    conn = identity_connection(path)
    admin = create_household_admin(
        conn, "Home", "admin", "admin@example.com", "a-secure-password"
    )
    first, first_token = create_household_invitation(
        conn, admin["household_id"], admin["id"], "member@example.com"
    )
    second, second_token = create_household_invitation(
        conn, admin["household_id"], admin["id"], "member@example.com"
    )

    with pytest.raises(ValueError, match="invalid or expired"):
        get_household_invitation(conn, first_token)
    revoke_household_invitation(conn, admin["household_id"], second["id"])
    with pytest.raises(ValueError, match="invalid or expired"):
        get_household_invitation(conn, second_token)
    with pytest.raises(ValueError, match="not found"):
        revoke_household_invitation(conn, admin["household_id"], first["id"])
    conn.close()


def test_invitation_rejects_existing_email_and_expired_token(tmp_path):
    path = str(tmp_path / "identity.db")
    initialize_identity_database(path)
    conn = identity_connection(path)
    admin = create_household_admin(
        conn, "Home", "admin", "admin@example.com", "a-secure-password"
    )
    with pytest.raises(ValueError, match="already exists"):
        create_household_invitation(
            conn, admin["household_id"], admin["id"], "ADMIN@example.com"
        )

    invitation, token = create_household_invitation(
        conn, admin["household_id"], admin["id"], "member@example.com"
    )
    conn.execute(
        "UPDATE household_invitations SET expires_at = ? WHERE id = ?",
        ("2000-01-01T00:00:00+00:00", invitation["id"]),
    )
    conn.commit()
    with pytest.raises(ValueError, match="invalid or expired"):
        accept_household_invitation(conn, token, "member", "member-chosen-password")
    conn.close()


def test_empty_v1_identity_schema_migrates_to_email(tmp_path):
    path = str(tmp_path / "identity.db")
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE identity_schema_version (version INTEGER NOT NULL);
        INSERT INTO identity_schema_version (version) VALUES (1);
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL
        );
        """
    )
    conn.close()

    initialize_identity_database(path)

    conn = identity_connection(path)
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info (users)").fetchall()
    }
    version = conn.execute("SELECT version FROM identity_schema_version").fetchone()[
        "version"
    ]
    assert version == 3
    assert "email" in columns
    assert "display_name" not in columns
    conn.close()


def test_v2_identity_schema_migrates_without_deleting_users(tmp_path):
    path = str(tmp_path / "identity.db")
    initialize_identity_database(path)
    conn = identity_connection(path)
    admin = create_household_admin(
        conn, "Home", "admin", "admin@example.com", "a-secure-password"
    )
    conn.execute("DROP TABLE household_invitations")
    conn.execute("UPDATE identity_schema_version SET version = 2")
    conn.commit()
    conn.close()

    initialize_identity_database(path)

    conn = identity_connection(path)
    version = conn.execute("SELECT version FROM identity_schema_version").fetchone()[
        "version"
    ]
    assert version == 3
    assert authenticate(conn, admin["email"], "a-secure-password") is not None
    assert conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'household_invitations'"
    ).fetchone()
    conn.close()


def test_v1_identity_schema_with_users_is_not_deleted(tmp_path):
    path = str(tmp_path / "identity.db")
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE identity_schema_version (version INTEGER NOT NULL);
        INSERT INTO identity_schema_version (version) VALUES (1);
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            display_name TEXT NOT NULL
        );
        INSERT INTO users (id, username, display_name)
        VALUES ('existing', 'existing', 'Existing User');
        """
    )
    conn.close()

    with pytest.raises(RuntimeError, match="cannot be reset automatically"):
        initialize_identity_database(path)

    conn = sqlite3.connect(path)
    assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    conn.close()
