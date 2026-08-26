#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
user_name="$(id -un)"
user_id="$(id -u)"
user_home="$(dscl . -read "/Users/${user_name}" NFSHomeDirectory | awk '{print $2}')"
launch_agents_dir="${user_home}/Library/LaunchAgents"
target="${launch_agents_dir}/com.budget-app.lan.plist"
template="${project_root}/deploy/com.budget-app.lan.plist.template"
webhook_target="${launch_agents_dir}/com.budget-app.webhook-tunnel.plist"
webhook_template="${project_root}/deploy/com.budget-app.webhook-tunnel.plist.template"

mkdir -p "${launch_agents_dir}" "${project_root}/logs"
lan_host="${BUDGET_LAN_HOST:-$(scutil --get LocalHostName 2>/dev/null || echo budget-app).local}"
sed \
  -e "s|__PROJECT_ROOT__|${project_root}|g" \
  -e "s|__BUDGET_LAN_HOST__|${lan_host}|g" \
  "${template}" > "${target}"
chmod 600 "${target}"
plutil -lint "${target}"
launchctl bootout "gui/${user_id}" "${target}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${user_id}" "${target}"
launchctl enable "gui/${user_id}/com.budget-app.lan"
echo "Installed and started com.budget-app.lan for ${user_name} (https://${lan_host}:3443)."

webhook_config="$(cd "${project_root}" && node --env-file-if-exists=.env -e '
const value = process.env.WEBHOOK_URL?.trim();
if (!value) process.exit(0);
const url = new URL(value);
const suffixes = [".ngrok-free.dev", ".ngrok-free.app", ".ngrok.app", ".ngrok.dev"];
if (suffixes.some((suffix) => url.hostname.endsWith(suffix))) console.log(url.origin);
')"
if [[ -n "${webhook_config}" ]]; then
  ngrok_bin="$(command -v ngrok)"
  sed \
    -e "s|__PROJECT_ROOT__|${project_root}|g" \
    -e "s|__NGROK_BIN__|${ngrok_bin}|g" \
    -e "s|__NGROK_ORIGIN__|${webhook_config}|g" \
    "${webhook_template}" > "${webhook_target}"
  chmod 600 "${webhook_target}"
  plutil -lint "${webhook_target}"
  launchctl bootout "gui/${user_id}" "${webhook_target}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${user_id}" "${webhook_target}"
  launchctl enable "gui/${user_id}/com.budget-app.webhook-tunnel"
  echo "Installed the public webhook tunnel for ${webhook_config}/webhook."
fi
