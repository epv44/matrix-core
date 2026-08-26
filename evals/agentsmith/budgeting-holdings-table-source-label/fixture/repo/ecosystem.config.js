const shared = {
  exec_mode: "fork",
  instances: 1,
  watch: false,
  kill_timeout: 10000,
  restart_delay: 1000,
  max_restarts: 5,
};

const lanMode = process.env.BUDGET_RUNTIME === "lan";
const LAN_PORT = process.env.BUDGET_LAN_PORT || "3443";
const LAN_CERT = process.env.BUDGET_LAN_CERT || "certs/lan.pem";
const LAN_KEY = process.env.BUDGET_LAN_KEY || "certs/lan-key.pem";

const apps = [
  {
    ...shared,
    name: "API",
    script: ".venv/bin/python",
    args: `-m uvicorn finance.api.main:app ${lanMode ? "" : "--reload "}--host 127.0.0.1 --port 8000`,
  },
  {
    ...shared,
    name: "HOOK",
    script: ".venv/bin/python",
    args: "-m uvicorn finance.webhook_receiver:app --host 127.0.0.1 --port 9000",
  },
  {
    ...shared,
    name: "WEB",
    cwd: "frontend",
    script: "node_modules/.bin/next",
    args: lanMode
      ? "start --hostname 127.0.0.1 --port 3000"
      : "dev --hostname 127.0.0.1 --port 3000",
  },
];

if (lanMode) {
  apps.push({
    ...shared,
    name: "LAN-TLS",
    script: ".venv/bin/python",
    args: `-m uvicorn finance.api.lan_proxy:app --host 0.0.0.0 --port ${LAN_PORT} --ssl-certfile ${LAN_CERT} --ssl-keyfile ${LAN_KEY}`,
  });
}

if (
  !lanMode &&
  process.env.BUDGET_NGROK_REUSED !== "true" &&
  process.env.BUDGET_NGROK_BIN &&
  process.env.BUDGET_NGROK_ORIGIN
) {
  apps.push({
    ...shared,
    name: "NGROK",
    script: process.env.BUDGET_NGROK_BIN,
    args: ["http", "9000", "--url", process.env.BUDGET_NGROK_ORIGIN],
    interpreter: "none",
  });
}

module.exports = {
  apps,
};
