import json
import logging
import subprocess

logger = logging.getLogger(__name__)


def check_dependency_vulnerabilities() -> list[dict] | None:
    try:
        result = subprocess.run(
            ["pip-audit", "--format", "json", "--desc"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if result.returncode == 0:
            return []

        try:
            data = json.loads(result.stdout)
            return data.get("vulnerabilities", [])
        except (json.JSONDecodeError, AttributeError):
            return [{"warning": "pip-audit output could not be parsed"}]
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return [{"warning": "pip-audit timed out"}]
