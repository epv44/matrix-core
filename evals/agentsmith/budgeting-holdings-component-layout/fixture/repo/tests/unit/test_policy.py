from pathlib import Path

import pytest

from scripts.check_policy import check_repository
from scripts.sync_agent_ignore import synchronize


def _policy_root(tmp_path: Path) -> Path:
    (tmp_path / "finance").mkdir()
    (tmp_path / "finance" / "storage").mkdir()
    (tmp_path / "pyproject.toml").write_text("")
    (tmp_path / "quality-exceptions.toml").write_text("version = 1\nexceptions = []\n")
    return tmp_path


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("value = 1  " + "# no" + "qa\n", "generic noqa"),
        ('SQL = "-- no' + 'qa: disable=all SELECT 1"\n', "SQL noqa"),
        ("def load():\n    import json\n", ""),
    ],
)
def test_policy_checker_reports_suppressions_but_delegates_imports_to_ruff(
    tmp_path, source, expected
):
    root = _policy_root(tmp_path)
    (root / "finance" / "sample.py").write_text(source)

    failures = check_repository(root)

    if expected:
        assert any(expected in failure for failure in failures)
    else:
        assert failures == []


def test_agent_ignore_check_and_write(tmp_path):
    (tmp_path / ".agentignore").write_text("node_modules/\n")
    (tmp_path / ".clineignore").write_text("dist/\n")

    assert synchronize(tmp_path, write=False) is False
    assert synchronize(tmp_path, write=True) is True
    assert synchronize(tmp_path, write=False) is True


@pytest.mark.parametrize("method", ["execute", "executemany", "executescript"])
def test_policy_rejects_database_execution_outside_storage(tmp_path, method):
    root = _policy_root(tmp_path)
    (root / "finance" / "service.py").write_text(
        f"def load(conn):\n    return conn.{method}('SELECT 1')\n"
    )

    failures = check_repository(root)

    assert any("restricted to finance/storage" in failure for failure in failures)


def test_policy_allows_database_execution_in_storage(tmp_path):
    root = _policy_root(tmp_path)
    (root / "finance" / "storage" / "repository.py").write_text(
        "def load(conn):\n    return conn.execute('SELECT 1')\n"
    )

    assert check_repository(root) == []
