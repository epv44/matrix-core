import importlib.util
import pathlib
import sys

REQUIRED_MODULES = ("dotenv", "openpyxl", "plaid", "tenacity")


def _bootstrap_project_dependencies() -> None:
    if all(importlib.util.find_spec(module) is not None for module in REQUIRED_MODULES):
        return
    project_root = pathlib.Path(__file__).resolve().parent
    site_packages = sorted(
        (project_root / ".venv" / "lib").glob("python*/site-packages")
    )
    if site_packages:
        sys.path.insert(0, str(site_packages[-1]))


_bootstrap_project_dependencies()
