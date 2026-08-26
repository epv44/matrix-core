import asyncio
import subprocess
import sys

import pytest

from finance.api import main as api_main
from finance.services.webhook_jobs import worker


@pytest.mark.parametrize(
    "module",
    (
        "finance.api.main",
        "finance.services.portfolio",
        "finance.services.webhook_jobs",
        "finance.storage.schema",
    ),
)
def test_application_modules_import_without_cycles(module):
    result = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_api_lifespan_migrates_before_worker_starts(monkeypatch):

    events: list[str] = []
    config = {
        "db_path": "/tmp/finance.db",
        "plaid_secret": "production-secret",
        "plaid_sandbox_secret": "sandbox-secret",
    }
    monkeypatch.setattr(api_main, "load_config", lambda: config)
    monkeypatch.setattr(api_main, "VALID_ENVIRONMENTS", ("sandbox", "production"))
    monkeypatch.setattr(
        api_main,
        "resolve_environment",
        lambda _config, env: {"db_path": f"/tmp/finance_{env}.db"},
    )
    monkeypatch.setattr(
        api_main,
        "initialize_database",
        lambda path, **_kwargs: events.append(f"migrate:{path}"),
    )
    monkeypatch.setattr(worker, "start", lambda: events.append("worker:start"))
    monkeypatch.setattr(worker, "stop", lambda: events.append("worker:stop"))

    async def exercise_lifespan():
        async with api_main.lifespan(api_main.app):
            events.append("serving")

    asyncio.run(exercise_lifespan())

    assert events == [
        "migrate:/tmp/finance_sandbox.db",
        "migrate:/tmp/finance_production.db",
        "worker:start",
        "serving",
        "worker:stop",
    ]


def test_api_lifespan_does_not_start_worker_when_migration_fails(monkeypatch):

    started = False
    monkeypatch.setattr(api_main, "load_config", dict)
    monkeypatch.setattr(api_main, "VALID_ENVIRONMENTS", ("sandbox",))
    monkeypatch.setattr(
        api_main,
        "resolve_environment",
        lambda _config, _env: {"db_path": "/tmp/finance_sandbox.db"},
    )

    def fail_migration(_path, **_kwargs):
        raise RuntimeError("migration failed")

    def start_worker():
        nonlocal started
        started = True

    monkeypatch.setattr(api_main, "initialize_database", fail_migration)
    monkeypatch.setattr(worker, "start", start_worker)

    async def exercise_lifespan():
        async with api_main.lifespan(api_main.app):
            pass

    with pytest.raises(RuntimeError, match="migration failed"):
        asyncio.run(exercise_lifespan())
    assert started is False
