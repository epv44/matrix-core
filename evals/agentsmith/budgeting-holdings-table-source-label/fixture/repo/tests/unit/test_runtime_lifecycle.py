import json
import os
import subprocess

import pytest


def _ecosystem_app_names(**environment):
    process_environment = os.environ.copy()
    for name in (
        "BUDGET_RUNTIME",
        "BUDGET_NGROK_BIN",
        "BUDGET_NGROK_ORIGIN",
        "BUDGET_NGROK_REUSED",
    ):
        process_environment.pop(name, None)
    process_environment.update(environment)
    result = subprocess.run(
        [
            "node",
            "-e",
            (
                "const config = require('./ecosystem.config.js'); "
                "process.stdout.write(JSON.stringify(config.apps.map((app) => app.name)));"
            ),
        ],
        capture_output=True,
        text=True,
        check=False,
        env=process_environment,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _classify_tunnels(payload):
    script = (
        "import { classifyLocalTunnels } from './scripts/detect-local-ngrok.mjs'; "
        "const payload = JSON.parse(process.argv[1]); "
        "process.stdout.write(classifyLocalTunnels(payload, process.argv[2]));"
    )
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            script,
            json.dumps(payload),
            "https://example.ngrok-free.dev",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def test_development_pm2_owns_ngrok_when_no_tunnel_is_reused():
    names = _ecosystem_app_names(
        BUDGET_NGROK_BIN="/opt/homebrew/bin/ngrok",
        BUDGET_NGROK_ORIGIN="https://example.ngrok-free.dev",
    )

    assert names == ["API", "HOOK", "WEB", "NGROK"]


def test_pm2_omits_ngrok_when_tunnel_is_reused():
    names = _ecosystem_app_names(
        BUDGET_NGROK_BIN="/opt/homebrew/bin/ngrok",
        BUDGET_NGROK_ORIGIN="https://example.ngrok-free.dev",
        BUDGET_NGROK_REUSED="true",
    )

    assert names == ["API", "HOOK", "WEB"]


def test_lan_mode_pm2_apps_include_lan_tls_proxy():
    names = _ecosystem_app_names(BUDGET_RUNTIME="lan")

    assert names == ["API", "HOOK", "WEB", "LAN-TLS"]


@pytest.mark.parametrize("address", ("http://localhost:9000", "127.0.0.1:9000"))
def test_existing_configured_tunnel_can_be_reused(address):
    payload = {
        "tunnels": [
            {
                "public_url": "https://example.ngrok-free.dev",
                "config": {"addr": address},
            }
        ]
    }

    assert _classify_tunnels(payload) == "reuse"


def test_tunnel_detection_distinguishes_absent_and_wrong_upstream():
    assert _classify_tunnels({"tunnels": []}) == "absent"
    payload = {
        "tunnels": [
            {
                "public_url": "https://example.ngrok-free.dev",
                "config": {"addr": "http://localhost:8000"},
            }
        ]
    }

    assert _classify_tunnels(payload) == "wrong-upstream"


def test_lan_shutdown_script_has_valid_shell_syntax():
    result = subprocess.run(
        ["bash", "-n", "scripts/stop-lan-launch-agents.sh"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
