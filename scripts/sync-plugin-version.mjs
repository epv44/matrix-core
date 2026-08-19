import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function syncPaths(root = repoRoot) {
  const pluginRoot = path.join(root, "plugins", "matrix-core");
  return {
    packagePath: path.join(root, "package.json"),
    pluginRoot,
    manifestPath: path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    statePath: path.join(pluginRoot, ".cachebuster.json"),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function filesBelow(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(absolute) : [absolute];
    })
    .sort();
}

export function pluginFingerprint(root = syncPaths().pluginRoot) {
  const hash = crypto.createHash("sha256");
  for (const absolute of filesBelow(root)) {
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (relative === ".cachebuster.json") continue;
    let contents = fs.readFileSync(absolute);
    if (relative === ".codex-plugin/plugin.json") {
      const manifest = JSON.parse(contents.toString("utf8"));
      manifest.version = "<engine-version>+codex.<cachebuster>";
      contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    hash.update(relative).update("\0").update(contents).update("\0");
  }
  return hash.digest("hex");
}

function cachebusterNow() {
  return new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

export function validatePluginSync(root = repoRoot) {
  const { packagePath, manifestPath, statePath, pluginRoot } = syncPaths(root);
  const packageVersion = readJson(packagePath).version;
  const manifest = readJson(manifestPath);
  const state = readJson(statePath);
  const [pluginBase, suffix] = String(manifest.version).split("+codex.");
  const errors = [];
  if (pluginBase !== packageVersion)
    errors.push(`plugin base version ${pluginBase} does not equal engine package version ${packageVersion}`);
  if (!suffix) errors.push("plugin version must contain one +codex.<cachebuster> suffix");
  if (state.engineVersion !== packageVersion) errors.push("cachebuster state engine version is stale");
  if (state.pluginVersion !== manifest.version) errors.push("cachebuster state plugin version is stale");
  if (state.fingerprint !== pluginFingerprint(pluginRoot))
    errors.push("plugin files changed without running npm run plugin:sync");
  if (errors.length) throw new Error(`MatrixCore plugin synchronization failed:\n- ${errors.join("\n- ")}`);
  return { packageVersion, pluginVersion: manifest.version, fingerprint: state.fingerprint };
}

export function syncPluginVersion(cachebuster = cachebusterNow(), root = repoRoot) {
  const { packagePath, manifestPath, statePath, pluginRoot } = syncPaths(root);
  if (!/^[A-Za-z0-9.-]+$/.test(cachebuster)) throw new Error(`Invalid cachebuster: ${cachebuster}`);
  const packageVersion = readJson(packagePath).version;
  const manifest = readJson(manifestPath);
  manifest.version = `${packageVersion}+codex.${cachebuster}`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const state = {
    schemaVersion: 1,
    engineVersion: packageVersion,
    pluginVersion: manifest.version,
    fingerprint: pluginFingerprint(pluginRoot),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function isMainModule() {
  return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const result = validatePluginSync();
    console.log(`Plugin synchronization valid: ${result.pluginVersion}`);
  } else {
    const cachebusterIndex = args.indexOf("--cachebuster");
    const result = syncPluginVersion(cachebusterIndex >= 0 ? args[cachebusterIndex + 1] : undefined);
    console.log(`Synchronized plugin version: ${result.pluginVersion}`);
  }
}
