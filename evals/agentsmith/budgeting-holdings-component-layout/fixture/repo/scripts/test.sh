#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

python_bin="python3"
if [[ -x "$repo_root/.venv/bin/python" ]]; then
  python_bin="$repo_root/.venv/bin/python"
fi

profile="${1:-deterministic}"
case "$profile" in
  deterministic)
    exec "$python_bin" -m pytest -m "not integration"
    ;;
  plaid)
    "$python_bin" -c 'from finance.config.settings import load_config, resolve_environment; resolve_environment(load_config(), "sandbox")'
    exec "$python_bin" -m pytest -m integration
    ;;
  all)
    exec "$python_bin" -m pytest
    ;;
  *)
    echo "Usage: $0 {deterministic|plaid|all}" >&2
    exit 2
    ;;
esac
