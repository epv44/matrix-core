import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

export const ENGINE_NAME = "matrix-core";

export const ENGINE_VERSION: string = (() => {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg?.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const GATE_STORE_DIR = ".quality";
export const CHANGED_GATE_RESULT_FILE = "changed-gate.json";
export const COMPLETION_GATE_RESULT_FILE = "completion-gate.json";
export const ACTIVE_COMPLETION_GATE_FILE = "completion-run.json";
export const COMPLETION_RESULT_FILE = "completion-result.json";
export const COMPLETION_LOCK_FILE = "completion.lock";
export const LEGACY_GATE_RESULT_FILE = "gate-result.json";
export const GATE_RESULT_FILE = COMPLETION_GATE_RESULT_FILE;

function normalizedRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function gateStorePath(root: string, mode: "changed" | "full" = "full"): string {
  return path.join(
    normalizedRoot(root),
    GATE_STORE_DIR,
    mode === "changed" ? CHANGED_GATE_RESULT_FILE : COMPLETION_GATE_RESULT_FILE,
  );
}

export function legacyGateStorePath(root: string): string {
  return path.join(normalizedRoot(root), GATE_STORE_DIR, LEGACY_GATE_RESULT_FILE);
}

export function qualityStorePath(root: string, file: string): string {
  return path.join(normalizedRoot(root), GATE_STORE_DIR, file);
}
