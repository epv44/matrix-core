import { pathToFileURL } from "node:url";

const DEFAULT_API_URL = "http://127.0.0.1:4040/api/tunnels";

export function classifyLocalTunnels(payload, configuredOrigin) {
  const expectedOrigin = new URL(configuredOrigin).origin;
  const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
  const matching = tunnels.filter((tunnel) => {
    try {
      return new URL(tunnel.public_url).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
  if (matching.length === 0) return "absent";
  return matching.some((tunnel) => isWebhookReceiver(tunnel.config?.addr))
    ? "reuse"
    : "wrong-upstream";
}

function isWebhookReceiver(rawAddress) {
  if (typeof rawAddress !== "string" || !rawAddress.trim()) return false;
  const candidate = rawAddress.includes("://") ? rawAddress : `http://${rawAddress}`;
  try {
    const address = new URL(candidate);
    return (
      ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) &&
      address.port === "9000"
    );
  } catch {
    return false;
  }
}

async function main() {
  const configuredOrigin = process.argv[2];
  if (!configuredOrigin) {
    console.error("Usage: detect-local-ngrok.mjs <configured-origin>");
    process.exitCode = 2;
    return;
  }
  let payload;
  try {
    const response = await fetch(process.env.BUDGET_NGROK_API_URL || DEFAULT_API_URL, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch {
    console.log("absent");
    return;
  }
  const status = classifyLocalTunnels(payload, configuredOrigin);
  if (status === "wrong-upstream") {
    console.error(
      `The existing ${new URL(configuredOrigin).origin} tunnel does not forward to local port 9000.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
