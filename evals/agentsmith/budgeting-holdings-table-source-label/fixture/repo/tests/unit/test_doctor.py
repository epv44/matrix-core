import pytest

from finance.config.settings import token_label
from finance.models.dataclasses import Institution
from finance.services.doctor import ensure_env_scoped_tokens, run_doctor
from finance.storage.connection import get_connection
from finance.storage.repository import upsert_institution
from finance.storage.schema import run_migrations


@pytest.fixture(autouse=True)
def _stub_side_effect_checks(monkeypatch):
    monkeypatch.setattr(
        "finance.services.doctor._check_config", lambda config: ("Config", True, "ok")
    )
    monkeypatch.setattr(
        "finance.services.doctor._check_db", lambda config: ("Database", True, "ok")
    )
    monkeypatch.setattr(
        "finance.services.doctor._check_tokens", lambda config: ("Tokens", True, "ok")
    )
    monkeypatch.setattr(
        "finance.services.doctor._check_permissions",
        lambda config: ("Permissions", True, "ok"),
    )
    monkeypatch.setattr(
        "finance.services.doctor._check_cert_system",
        lambda config: ("Certs (System)", True, "ok"),
    )
    monkeypatch.setattr(
        "finance.services.doctor._check_cert_project",
        lambda config: ("Certs (Project)", True, "ok"),
    )


def _seed(db_path):
    conn = get_connection(db_path)
    run_migrations(conn)
    upsert_institution(conn, Institution(name="usaa"))
    conn.close()


def _config(db_path):
    return {"plaid_environment": "sandbox", "db_path": db_path, "project_root": "."}


def test_doctor_keychain_reports_missing_env_scoped_token(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    _seed(db_path)
    monkeypatch.setattr(
        "finance.services.doctor.get_keychain_token", lambda label: None
    )
    checks = {c["name"]: c for c in run_doctor(_config(db_path))}
    assert checks["Credential Store"]["status"] is False
    assert "usaa" in checks["Credential Store"]["detail"]


def test_doctor_keychain_passes_when_env_scoped_token_exists(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    _seed(db_path)
    monkeypatch.setattr(
        "finance.services.doctor.get_keychain_token", lambda label: "tok"
    )
    checks = {c["name"]: c for c in run_doctor(_config(db_path))}
    assert checks["Credential Store"]["status"] is True


def test_ensure_env_scoped_tokens_copies_legacy(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    _seed(db_path)
    tokens = {"plaid_access_token_usaa": "LEGACY"}
    stored: dict[str, str] = {}
    monkeypatch.setattr(
        "finance.services.doctor.get_keychain_token", lambda label: tokens.get(label)
    )
    monkeypatch.setattr(
        "finance.services.doctor.set_keychain_token",
        lambda label, token: stored.__setitem__(label, token),
    )
    repaired = ensure_env_scoped_tokens(_config(db_path))
    assert repaired == {"usaa": "plaid_access_token_usaa"}
    assert stored[token_label("sandbox", "usaa")] == "LEGACY"


def test_ensure_env_scoped_tokens_skips_when_present(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    _seed(db_path)
    monkeypatch.setattr(
        "finance.services.doctor.get_keychain_token", lambda label: "tok"
    )

    def fail_set(label, token):
        raise AssertionError("should not write")

    monkeypatch.setattr("finance.services.doctor.set_keychain_token", fail_set)
    assert ensure_env_scoped_tokens(_config(db_path)) == {}
