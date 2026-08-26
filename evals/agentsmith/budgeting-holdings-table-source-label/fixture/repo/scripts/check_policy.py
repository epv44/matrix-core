from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

import tomllib

SOURCE_ROOTS = ("finance", "tests", "frontend/src", "frontend/e2e")
SOURCE_SUFFIXES = {".py", ".sql", ".ts", ".tsx", ".js", ".jsx"}
PYTHON_NOQA = re.compile(
    r"#\s*noqa(?:\s*:\s*([A-Z][A-Z0-9]*(?:\s*,\s*[A-Z][A-Z0-9]*)*))?"
)
BANNED_PATTERNS = {
    "SQL noqa": re.compile(r"--\s*noqa\b", re.IGNORECASE),
    "type-checker suppression": re.compile(
        r"(?:type|pyright|mypy)\s*:\s*ignore", re.IGNORECASE
    ),
    "ESLint suppression": re.compile(r"eslint-disable", re.IGNORECASE),
    "TypeScript suppression": re.compile(
        r"@ts-(?:ignore|expect-error|nocheck)", re.IGNORECASE
    ),
    "formatter suppression": re.compile(
        r"(?:prettier-ignore|fmt\s*:\s*(?:off|skip))", re.IGNORECASE
    ),
    "security suppression": re.compile(r"#\s*nosec\b", re.IGNORECASE),
    "coverage suppression": re.compile(
        r"(?:pragma\s*:\s*no cover|coverage\s*:\s*ignore)", re.IGNORECASE
    ),
}
ABSOLUTE_USER_PATH = re.compile(r"(?:/Users/[^/\s]+/|[A-Za-z]:\\Users\\[^\\\s]+\\)")
SQL_METHODS = {"execute", "executemany", "executescript"}


def _source_files(root: Path) -> list[Path]:
    files = []
    for source_root in SOURCE_ROOTS:
        path = root / source_root
        if path.is_file() and path.suffix in SOURCE_SUFFIXES:
            files.append(path)
        elif path.is_dir():
            files.extend(
                candidate
                for candidate in path.rglob("*")
                if candidate.is_file() and candidate.suffix in SOURCE_SUFFIXES
            )
    return sorted(files)


def _scope_for_line(tree: ast.AST, line: int) -> str:
    scopes = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        end_line = node.end_lineno or node.lineno
        if node.lineno <= line <= end_line:
            scopes.append((end_line - node.lineno, node.name))
    return min(scopes)[1] if scopes else "<module>"


def _load_exceptions(root: Path) -> set[tuple[str, str, str]]:
    data = tomllib.loads((root / "quality-exceptions.toml").read_text())
    if data.get("version") != 1:
        raise ValueError("quality-exceptions.toml must use version 1")
    result = set()
    for entry in data.get("exceptions", []):
        required = ("path", "rule", "symbol", "reason")
        if any(not str(entry.get(field, "")).strip() for field in required):
            raise ValueError(
                "Every quality exception requires path, rule, symbol, and reason"
            )
        result.add((entry["path"], entry["symbol"], entry["rule"]))
    return result


def _check_python_noqa(
    root: Path,
    path: Path,
    text: str,
    allowed: set[tuple[str, str, str]],
    used: set[tuple[str, str, str]],
) -> list[str]:
    failures = []
    tree = ast.parse(text, filename=str(path))
    relative = path.relative_to(root).as_posix()
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = PYTHON_NOQA.search(line)
        if not match:
            continue
        if not match.group(1):
            failures.append(f"{relative}:{line_number}: generic noqa is prohibited")
            continue
        symbol = _scope_for_line(tree, line_number)
        for rule in (value.strip() for value in match.group(1).split(",")):
            key = (relative, symbol, rule)
            if key not in allowed:
                failures.append(
                    f"{relative}:{line_number}: {rule} is not in quality-exceptions.toml"
                )
            else:
                used.add(key)
    return failures


def _check_sql_boundary(root: Path, path: Path, text: str) -> list[str]:
    relative = path.relative_to(root)
    if relative.parts[:2] == ("finance", "storage") or relative.parts[0] != "finance":
        return []
    tree = ast.parse(text, filename=str(path))
    return [
        (
            f"{relative.as_posix()}:{node.lineno}: direct database execution "
            "is restricted to finance/storage"
        )
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in SQL_METHODS
    ]


def _check_agent_paths(root: Path) -> list[str]:
    candidates = [root / "AGENTS.md"]
    for directory in (root / ".cline", root / ".clinerules", root / ".codex"):
        if directory.exists():
            candidates.extend(path for path in directory.rglob("*") if path.is_file())
    failures = []
    for path in candidates:
        if path.exists() and ABSOLUTE_USER_PATH.search(
            path.read_text(errors="replace")
        ):
            failures.append(
                f"{path.relative_to(root)}: machine-specific user path is prohibited"
            )
    return failures


def check_repository(root: Path) -> list[str]:
    allowed = _load_exceptions(root)
    used: set[tuple[str, str, str]] = set()
    failures = []
    for path in _source_files(root):
        text = path.read_text(errors="replace")
        relative = path.relative_to(root).as_posix()
        if path.suffix == ".py":
            failures.extend(_check_python_noqa(root, path, text, allowed, used))
            failures.extend(_check_sql_boundary(root, path, text))
        for label, pattern in BANNED_PATTERNS.items():
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                failures.append(f"{relative}:{line}: {label} is prohibited")
    pyproject = (root / "pyproject.toml").read_text()
    if "per-file-ignores" in pyproject:
        failures.append("pyproject.toml: broad per-file Ruff ignores are prohibited")
    failures.extend(_check_agent_paths(root))
    for key in sorted(allowed - used):
        failures.append(f"quality-exceptions.toml: unused exception {key}")
    return failures


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    try:
        failures = check_repository(root)
    except (OSError, SyntaxError, ValueError, tomllib.TOMLDecodeError) as exc:
        print(f"Policy check could not run: {exc}", file=sys.stderr)
        return 2
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Policy check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
