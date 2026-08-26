import pathlib

from finance.config.settings import cert_paths, load_config


def _write_pair(directory: pathlib.Path, cert_name: str, key_name: str) -> None:
    directory.joinpath(cert_name).write_text("certificate")
    directory.joinpath(key_name).write_text("key")


def test_cert_paths_prefers_explicit_localhost_pair(tmp_path):
    _write_pair(tmp_path, "lan.pem", "lan-key.pem")
    _write_pair(tmp_path, "localhost.pem", "localhost-key.pem")
    config = {"certs_dir": str(tmp_path)}

    cert_file, key_file = cert_paths(config)

    assert cert_file.endswith("localhost.pem")
    assert key_file.endswith("localhost-key.pem")


def test_cert_paths_prefers_localhost2_over_discovery_when_lan_cert_sorts_first(
    tmp_path,
):
    _write_pair(tmp_path, "lan.pem", "lan-key.pem")
    _write_pair(tmp_path, "localhost+2.pem", "localhost+2-key.pem")
    config = {"certs_dir": str(tmp_path)}

    cert_file, key_file = cert_paths(config)

    assert cert_file.endswith("localhost+2.pem")
    assert key_file.endswith("localhost+2-key.pem")


def test_cert_paths_falls_back_to_discovery(tmp_path):
    _write_pair(tmp_path, "lan.pem", "lan-key.pem")
    config = {"certs_dir": str(tmp_path)}

    cert_file, key_file = cert_paths(config)

    assert cert_file.endswith("lan.pem")
    assert key_file.endswith("lan-key.pem")


def test_plaid_redirect_uri_is_read_from_environment(monkeypatch):
    monkeypatch.setenv("PLAID_CLIENT_ID", "client-id")
    monkeypatch.setenv("PLAID_SECRET", "secret")
    monkeypatch.setenv("PLAID_SANDBOX_SECRET", "sandbox-secret")
    monkeypatch.setenv(
        "PLAID_REDIRECT_URI", "https://example.local:3443/oauth/callback"
    )

    config = load_config()

    assert config["plaid_redirect_uri"] == "https://example.local:3443/oauth/callback"


def test_plaid_redirect_uri_defaults_to_none(monkeypatch):
    monkeypatch.setenv("PLAID_CLIENT_ID", "client-id")
    monkeypatch.setenv("PLAID_SECRET", "secret")
    monkeypatch.setenv("PLAID_SANDBOX_SECRET", "sandbox-secret")
    monkeypatch.delenv("PLAID_REDIRECT_URI", raising=False)

    config = load_config()

    assert config["plaid_redirect_uri"] is None
