import { ENGINE_NAME, ENGINE_VERSION } from "./meta.js";
import { resolveConfig } from "./config-resolver.js";
import { runEngine } from "./runner.js";
import { computeWorkspaceVersion } from "./version.js";
import { writeGateResult } from "./gate-store.js";
import { getChangedFiles } from "./changed.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { GateResult } from "./types.js";
import { resolveWorkspaceSet } from "./workspace.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import { engineRuntimeIdentity, recordEngineRuntime } from "./runtime.js";

export interface RunGateOptions {
  cwd: string;
  configFlag?: string;
  mode?: "changed" | "full";
  fast?: boolean;
  base?: string;
  tool?: string;
  adapter?: string;
  signal?: AbortSignal;
  changedFiles?: string[];
}

export function resolveConfigRoot(cwd: string, configFlag?: string): string {
  return resolveConfig({ cwd, configFlag }).configRoot;
}

function appendGateLog(root: string, level: "info" | "warn" | "error", line: string) {
  const full = `${new Date().toISOString()} [${level.toUpperCase()}] ${line}`;
  try {
    fs.mkdirSync(path.join(root, ".quality"), { recursive: true });
    fs.appendFileSync(path.join(root, ".quality", "gate.log"), `${full}\n`);
  } catch {}
  try {
    if (level === "error") console.error(`[${ENGINE_NAME}] ${full}`);
    else if (level === "warn") console.warn(`[${ENGINE_NAME}] ${full}`);
    else console.log(`[${ENGINE_NAME}] ${full}`);
  } catch {}
}

export function detectWorkspaceMutation(root: string, preVersion: string, postVersion: string): string[] {
  if (preVersion === postVersion) return [];
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {}
  return getChangedFiles({ cwd: realRoot }).map((f) => path.relative(realRoot, f) || f);
}

/**
 * Run the deterministic gate for the workspace state at `cwd`.
 *
 * The result is immutable once persisted: the store first records RUNNING
 * (so a crash can never leave a stale PASS alive), then the engine runs, then
 * the terminal PASS/FAIL result is written with the exact workspace version it
 * validated. Callers must not reuse a result for a different version.
 */
export async function runGate(opts: RunGateOptions): Promise<GateResult> {
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Quality gate cancelled");
  const root = resolveConfigRoot(opts.cwd, opts.configFlag);
  recordEngineRuntime(root, opts.adapter === "mcp" ? "mcp" : "cli");
  const mode = opts.mode ?? "full";
  const fast = opts.fast === true;
  const baseBranch = opts.base ?? "main";
  const changedFiles =
    mode === "changed" ? (opts.changedFiles ?? getChangedFiles({ cwd: root, base: baseBranch })) : undefined;
  const normalizedChangedFiles = (changedFiles ?? [])
    .map((file) =>
      path.relative(root, path.isAbsolute(file) ? file : path.resolve(root, file)).replaceAll(path.sep, "/"),
    )
    .sort();
  const changedFilesHash =
    mode === "changed"
      ? crypto.createHash("sha256").update(JSON.stringify(normalizedChangedFiles)).digest("hex")
      : null;
  const version = computeWorkspaceVersion(root);
  const initialResolved = resolveConfig({ cwd: root, configFlag: opts.configFlag });
  const manifest = initialResolved.config;
  const initialWorkspaces = resolveWorkspaceSet(root, manifest.application);
  const initialPolicy = resolvePolicyForConfig(initialResolved);
  const runtime = engineRuntimeIdentity();
  const createdBy = {
    tool: opts.tool ?? "cli",
    adapter: opts.adapter ?? ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    enginePath: runtime.executablePath,
    enginePackageRoot: runtime.packageRoot,
  };
  const startedAt = new Date().toISOString();
  const running: GateResult = {
    schemaVersion: 2,
    version,
    mode,
    fast,
    baseBranch,
    changedFilesHash,
    changedFileCount: normalizedChangedFiles.length,
    status: "RUNNING",
    checks: [],
    failures: [],
    metrics: {},
    timestamp: startedAt,
    createdBy,
    workspaces: initialWorkspaces.workspaces,
    workspaceHash: initialWorkspaces.workspaceHash,
    policy: initialPolicy,
    toolVersions: {},
  };
  writeGateResult(root, running);

  const engine = await runEngine({
    cwd: root,
    root,
    configFlag: opts.configFlag,
    changed: mode === "changed",
    full: mode !== "changed",
    baseBranch,
    fast,
    changedFiles,
    policy: initialPolicy,
  });
  if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("Quality gate cancelled");

  const postVersion = computeWorkspaceVersion(root);
  const postWorkspaces = resolveWorkspaceSet(root, manifest.application);
  let postPolicyHash: string | null = null;
  let postPolicyError: string | null = null;
  try {
    postPolicyHash = resolvePolicyForConfig(resolveConfig({ cwd: root, configFlag: opts.configFlag })).policyHash;
  } catch (error) {
    postPolicyError = error instanceof Error ? error.message : String(error);
  }
  const identityChanged =
    postVersion !== version ||
    postWorkspaces.workspaceHash !== initialWorkspaces.workspaceHash ||
    postPolicyHash !== initialPolicy.policyHash;
  if (identityChanged) {
    const mutated = detectWorkspaceMutation(root, version, postVersion);
    appendGateLog(
      root,
      "error",
      `runGate: gate identity changed during execution (${version.slice(0, 12)} -> ${postVersion.slice(0, 12)}) - ` +
        (mutated.length > 0
          ? `changed files: ${mutated.join(", ")} - `
          : "no changed files resolved (unignored artifact?) - ") +
        "a check is mutating the workspace; gitignore the artifact so the gate result stays valid",
    );
  }

  const mutationFailure = `Workspace, resolution, or policy changed during deterministic execution${postPolicyError ? `: ${postPolicyError}` : ""}`;
  const result: GateResult = {
    schemaVersion: 2,
    version,
    mode,
    fast,
    baseBranch,
    changedFilesHash,
    changedFileCount: normalizedChangedFiles.length,
    status: engine.passed && !identityChanged ? "PASS" : "FAIL",
    checks: engine.results,
    failures: identityChanged ? [...engine.failures, mutationFailure] : engine.failures,
    metrics: engine.metrics,
    timestamp: new Date().toISOString(),
    createdBy,
    workspaces: engine.config.workspaces!,
    workspaceHash: engine.config.workspaceHash!,
    policy: engine.config.policy!,
    toolVersions: Object.fromEntries(
      engine.capabilities
        .filter((capability) => capability.version)
        .map((capability) => [capability.name, capability.version!])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  writeGateResult(root, result);
  return result;
}

export function gatePassesForVersion(gate: GateResult | null, version: string): boolean {
  return !!gate && gate.status === "PASS" && gate.version === version;
}

export function gateMatchesIdentity(
  gate: GateResult | null,
  identity: { version: string; workspaceHash: string; policyHash: string },
): boolean {
  return (
    gatePassesForVersion(gate, identity.version) &&
    gate?.workspaceHash === identity.workspaceHash &&
    gate.policy?.policyHash === identity.policyHash
  );
}
