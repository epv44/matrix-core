#!/usr/bin/env bash
set -euo pipefail

user_id="$(id -u)"
user_name="$(id -un)"
user_home="$(dscl . -read "/Users/${user_name}" NFSHomeDirectory | awk '{print $2}')"
launch_agents_dir="${user_home}/Library/LaunchAgents"

stop_agent() {
  local label="$1"
  local plist_path="${launch_agents_dir}/${label}.plist"
  if ! launchctl print "gui/${user_id}/${label}" >/dev/null 2>&1; then
    echo "${label} is already stopped."
    return
  fi
  launchctl bootout "gui/${user_id}" "${plist_path}"
  echo "Stopped ${label}."
}

stop_agent "com.budget-app.lan"
stop_agent "com.budget-app.webhook-tunnel"
echo "LAN services are stopped. Restart them with ./scripts/install-lan-launch-agent.sh."
