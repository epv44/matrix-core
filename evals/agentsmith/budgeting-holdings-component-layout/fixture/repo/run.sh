#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RUNTIME_MODE="${1:-development}"
unset BUDGET_NGROK_REUSED
case "$RUNTIME_MODE" in
  development) ;;
  --lan)
    export BUDGET_RUNTIME=lan
    export SESSION_COOKIE_SECURE=true
    ;;
  *)
    echo "Usage: ./run.sh [--lan]"
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 26 is required. Install it, then run: nvm use"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" != "26" ]; then
  echo "Node.js 26 is required; found $(node --version). Run: nvm install 26 && nvm use 26"
  exit 1
fi

WEBHOOK_CONFIG="$(node --env-file-if-exists=.env -e '
const raw = process.env.WEBHOOK_URL?.trim();
if (!raw) {
  console.log("disabled");
  process.exit(0);
}
let url;
try {
  url = new URL(raw);
} catch {
  console.error("WEBHOOK_URL must be a valid HTTPS URL ending in /webhook.");
  process.exit(1);
}
if (
  url.protocol !== "https:" ||
  url.pathname !== "/webhook" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
) {
  console.error("WEBHOOK_URL must be HTTPS, end in /webhook, and have no credentials, query, or fragment.");
  process.exit(1);
}
const ngrokSuffixes = [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.app", ".ngrok.dev"];
console.log(ngrokSuffixes.some((suffix) => url.hostname.endsWith(suffix)) ? `ngrok ${url.origin}` : "external");
')"

case "$WEBHOOK_CONFIG" in
  ngrok\ *)
    if ! command -v ngrok >/dev/null 2>&1; then
      echo "WEBHOOK_URL uses ngrok, but the ngrok CLI is not installed."
      exit 1
    fi
    if ! ngrok config check >/dev/null 2>&1; then
      echo "WEBHOOK_URL uses ngrok, but the ngrok configuration is invalid. Run: ngrok config check"
      exit 1
    fi
    export BUDGET_NGROK_BIN="$(command -v ngrok)"
    export BUDGET_NGROK_ORIGIN="${WEBHOOK_CONFIG#ngrok }"
    ;;
  external|disabled) ;;
  *)
    echo "Could not resolve WEBHOOK_URL configuration."
    exit 1
    ;;
esac

if [ "$RUNTIME_MODE" = "--lan" ]; then
  BUDGET_LAN_HOST="${BUDGET_LAN_HOST:-$(scutil --get LocalHostName 2>/dev/null || echo budget-app).local}"
  BUDGET_LAN_PORT="${BUDGET_LAN_PORT:-3443}"
  BUDGET_LAN_CERT="${BUDGET_LAN_CERT:-$ROOT/certs/lan.pem}"
  BUDGET_LAN_KEY="${BUDGET_LAN_KEY:-$ROOT/certs/lan-key.pem}"
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ ! -f "$BUDGET_LAN_CERT" ] || [ ! -f "$BUDGET_LAN_KEY" ]; then
    echo "LAN mode requires HTTPS certificates for the household host."
    echo "Generate them from the repository root with:"
    echo "  mkcert -install"
    echo "  mkdir -p certs && cd certs && mkcert -cert-file lan.pem -key-file lan-key.pem ${BUDGET_LAN_HOST} ${LAN_IP} localhost 127.0.0.1 ::1"
    echo "Then open https://${BUDGET_LAN_HOST}:${BUDGET_LAN_PORT} from each household device"
    echo "and click through the one-time self-signed warning — no installation is needed."
    exit 1
  fi
  export BUDGET_LAN_HOST BUDGET_LAN_PORT BUDGET_LAN_CERT BUDGET_LAN_KEY
  export PLAID_REDIRECT_URI="https://${BUDGET_LAN_HOST}:${BUDGET_LAN_PORT}/oauth/callback"
fi

if [ "$RUNTIME_MODE" = "development" ] && [[ "$WEBHOOK_CONFIG" == ngrok\ * ]]; then
  NGROK_LOCAL_STATUS="$(node scripts/detect-local-ngrok.mjs "$BUDGET_NGROK_ORIGIN")"
  if [ "$NGROK_LOCAL_STATUS" = "reuse" ]; then
    export BUDGET_NGROK_REUSED=true
  fi
fi

source .venv/bin/activate 2>/dev/null || { echo "Creating venv..."; python3 -m venv .venv; source .venv/bin/activate; pip install -q -r requirements.txt; }
[ -x node_modules/.bin/pm2-runtime ] || { echo "Installing root deps..."; npm ci --silent; }
[ -d frontend/node_modules ] || { echo "Installing frontend deps..."; (cd frontend && npm ci --silent); }

for port in 8000 9000 3000 3443; do
  listeners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$listeners" ]; then
    echo "Port $port is already in use by PID(s): $listeners"
    echo "Stop that process explicitly, then run ./run.sh again."
    exit 1
  fi
done

CACHE_KEY="$( { node --version; node -p 'require("./frontend/node_modules/next/package.json").version'; shasum frontend/package-lock.json frontend/next.config.ts; } | shasum | awk '{print $1}' )"
CACHE_STAMP="$ROOT/frontend/.next/.budget-cache-key"
if [ -d "$ROOT/frontend/.next" ] && { [ ! -f "$CACHE_STAMP" ] || [ "$(cat "$CACHE_STAMP")" != "$CACHE_KEY" ]; }; then
  echo "Frontend toolchain changed — clearing the generated Next.js cache..."
  rm -rf "$ROOT/frontend/.next"
fi
mkdir -p "$ROOT/frontend/.next"
echo "$CACHE_KEY" > "$CACHE_STAMP"

if [ "$RUNTIME_MODE" = "--lan" ]; then
  echo "Building the production LAN frontend..."
  npm --prefix frontend run build
  RUNTIME_LABEL="lan"
else
  RUNTIME_LABEL="development"
fi

echo "Runtime: $RUNTIME_LABEL"
echo "FastAPI: http://localhost:8000/docs"
echo "Webhook receiver: http://localhost:9000/webhook"
if [ "$RUNTIME_MODE" = "--lan" ]; then
  echo "Frontend (LAN HTTPS): https://${BUDGET_LAN_HOST}:${BUDGET_LAN_PORT}"
else
  echo "Frontend: http://localhost:3000"
fi
if [ "$RUNTIME_MODE" = "--lan" ] && [ "$WEBHOOK_CONFIG" != "disabled" ]; then
  echo "Public webhook: configure ngrok as an independent persistent host service"
elif [ "$WEBHOOK_CONFIG" = "disabled" ]; then
  echo "Public webhook: disabled (WEBHOOK_URL is not set)"
elif [ "$WEBHOOK_CONFIG" = "external" ]; then
  echo "Public webhook: externally managed"
elif [ "${BUDGET_NGROK_REUSED:-}" = "true" ]; then
  echo "Public webhook: $BUDGET_NGROK_ORIGIN/webhook (reusing persistent local ngrok tunnel)"
else
  echo "Public webhook: $BUDGET_NGROK_ORIGIN/webhook"
fi
echo "Logs interleaved by API, HOOK, WEB, and optional NGROK — Ctrl+C to stop"
if [ "${BUDGET_NGROK_REUSED:-}" = "true" ]; then
  echo "The reused ngrok tunnel is not owned by this run and remains online after Ctrl+C."
fi
echo ""

export PM2_HOME="$ROOT/.pm2"
exec node_modules/.bin/pm2-runtime start ecosystem.config.js --formatted
