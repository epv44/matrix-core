#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_bin="${repo_root}/.venv/bin/python"
ruff_bin="${repo_root}/.venv/bin/ruff"

if [[ ! -x "$python_bin" ]]; then
  python_bin="python3"
fi
if [[ ! -x "$ruff_bin" ]]; then
  ruff_bin="ruff"
fi

cd "$repo_root"
"$python_bin" scripts/check_policy.py
"$python_bin" scripts/sync_agent_ignore.py
"$ruff_bin" check finance tests
