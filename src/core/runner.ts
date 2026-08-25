import path from "node:path";

import { resolveConfig } from "./config-resolver.js";
import { aggregateMetrics } from "./policy.js";
import { formatReport } from "./report.js";
import { getChangedFiles } from "./changed.js";
import { appendVerboseLog, verboseEnabled } from "./verbose.js";
import type {
  EngineResult,
  LanguageWorkspace,
  PluginResult,
  PolicyCheck,
  ResolvedPolicy,
  RunCtx,
  SqlWorkspaceFacet,
  ToolEnvironment,
} from "./types.js";
import { getPluginByName } from "../packs/registry.js";
import { resolveWorkspaceSet } from "./workspace.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import { materializeTypeScriptConfig } from "./typescript-config.js";
import { describeToolProbe, probeToolVersion } from "./process-env.js";

const FAST_CHECKS = new Set([
  "python.ruff",
  "python.ruff-format",
  "python.mypy",
  "typescript.tsc",
  "typescript.eslint",
]);

interface ExecutionTarget {
  id: string;
  pack: LanguageWorkspace["language"] | "sql";
  executionRoot: string;
  workspace: LanguageWorkspace;
  sqlFacet?: SqlWorkspaceFacet;
  toolEnvironment: ToolEnvironment;
  checks: PolicyCheck[];
  missingReason: string;
  invalidReason: string;
}

export function toolVersion(binary: string): string | null {
  return probeToolVersion(binary).version;
}

export function versionAccepted(version: string, range: string) {
  return version === range;
}

function executionTargets(workspace: LanguageWorkspace, policy: ResolvedPolicy): ExecutionTarget[] {
  const checks = policy.checks.filter((candidate) => candidate.language === workspace.language);
  if (checks.length === 0)
    throw new Error(`No central quality profile exists for detected ${workspace.language} workspace ${workspace.id}`);
  return [
    {
      id: workspace.id,
      pack: workspace.language,
      executionRoot: workspace.executionRoot,
      workspace,
      toolEnvironment: workspace.toolEnvironment,
      checks,
      missingReason: "required workspace tool missing",
      invalidReason: "invalid application configuration",
    },
    ...workspace.sqlFacets.map((sqlFacet) => ({
      id: sqlFacet.id,
      pack: "sql" as const,
      executionRoot: workspace.executionRoot,
      workspace,
      sqlFacet,
      toolEnvironment: sqlFacet.toolEnvironment,
      checks: policy.checks.filter((candidate) => candidate.language === "sql"),
      missingReason: "required SQL tool environment missing",
      invalidReason: "invalid SQL application configuration",
    })),
  ];
}

function failedCheck(check: PolicyCheck, target: ExecutionTarget, message: string, reason: string): PluginResult {
  return {
    plugin: check.id,
    pack: target.pack,
    status: "FAIL",
    observations: [{ message, severity: "error" }],
    reason,
  };
}

async function executeCheck(opts: {
  resolved: ReturnType<typeof resolveConfig>;
  target: ExecutionTarget;
  check: PolicyCheck;
  binary: string;
  version: string;
  changed: string[];
  run: Parameters<typeof runEngine>[0];
}): Promise<PluginResult> {
  const { resolved, target, check, binary, version } = opts;
  const plugin = getPluginByName(check.id);
  if (!plugin) throw new Error(`Policy references unknown check: ${check.id}`);
  const scoped = scopeChangedFiles(opts.changed, resolved.configRoot, target.executionRoot);
  const ctx: RunCtx = {
    root: target.executionRoot,
    configRoot: resolved.configRoot,
    changedFiles: scoped,
    full: opts.run.full || !opts.run.changed,
    baseBranch: opts.run.baseBranch,
    config: resolved.config,
    fast: opts.run.fast,
    workspace: target.workspace,
    sqlFacet: target.sqlFacet,
    policyCheck: check,
  };
  const capMap = new Map([
    [
      check.tool === "tsc" ? "typescript" : check.tool,
      { name: check.tool, found: true, version, path: binary, required: true },
    ],
  ]);
  let generatedConfig: ReturnType<typeof materializeTypeScriptConfig> | undefined;
  try {
    if (check.id === "typescript.tsc") {
      if (!check.configAsset) throw new Error("Central TypeScript profile is missing its configuration asset");
      generatedConfig = materializeTypeScriptConfig(target.workspace, check.configAsset);
      target.workspace.effectiveConfigHash = generatedConfig.hash;
      ctx.policyCheck = { ...check, args: ["--project", generatedConfig.path] };
    }
    if (verboseEnabled()) {
      const targets = ctx.changedFiles?.length ? ctx.changedFiles.length : "all";
      appendVerboseLog(resolved.configRoot, `run ${check.id} (ws=${target.id}, targets=${targets})`);
    }
    const start = Date.now();
    const result = await plugin.run(ctx, capMap);
    if (verboseEnabled()) {
      appendVerboseLog(
        resolved.configRoot,
        `done ${check.id} -> ${result.status} in ${Date.now() - start}ms (score=${result.score ?? "n/a"})`,
      );
      if (result.observations?.length)
        appendVerboseLog(resolved.configRoot, `  obs: ${result.observations.length} items`);
    }
    return {
      ...normalizeObservationPaths(result, resolved.configRoot, target.executionRoot),
      plugin: check.id,
      pack: target.pack,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (verboseEnabled()) appendVerboseLog(resolved.configRoot, `error ${check.id}: ${message}`);
    return {
      plugin: check.id,
      pack: target.pack,
      status: "FAIL",
      observations: [{ message, severity: "error" }],
      reason: target.invalidReason,
    };
  } finally {
    generatedConfig?.cleanup();
  }
}

async function runPolicyEngine(
  resolved: ReturnType<typeof resolveConfig>,
  opts: Parameters<typeof runEngine>[0],
): Promise<EngineResult> {
  const workspaceSet = resolveWorkspaceSet(resolved.configRoot, resolved.config.application);
  const workspaces = workspaceSet.workspaces;
  const policy = opts.policy ?? resolvePolicyForConfig(resolved);
  resolved.workspaces = workspaces;
  resolved.workspaceHash = workspaceSet.workspaceHash;
  resolved.policy = policy;
  const baseline = null;
  const changed = opts.changedFiles ?? getChangedFiles({ cwd: resolved.configRoot, base: opts.baseBranch });
  const results: PluginResult[] = [];
  const capabilities = [] as EngineResult["capabilities"];

  for (const workspace of workspaces) {
    for (const target of executionTargets(workspace, policy)) {
      for (const check of target.checks) {
        if (opts.fast && target.pack !== "sql" && !FAST_CHECKS.has(check.id)) continue;
        const binary = target.toolEnvironment.binaries[check.tool];
        const probe = binary ? probeToolVersion(binary) : null;
        const version = probe?.version ?? null;
        capabilities.push({
          name: `${target.id}:${check.tool}`,
          found: !!version,
          version: version ?? undefined,
          path: binary,
          required: true,
        });
        if (!binary || !version) {
          const message =
            binary && probe
              ? `${describeToolProbe(check.tool, probe)}; designated environment=${target.id}; global fallbacks are prohibited`
              : `${check.tool} is missing from designated ${target.id} environment; global fallbacks are prohibited`;
          results.push(failedCheck(check, target, message, target.missingReason));
          continue;
        }
        if (!versionAccepted(version, check.requiredVersion)) {
          results.push(
            failedCheck(
              check,
              target,
              `${check.tool} ${version} does not satisfy central policy ${check.requiredVersion}`,
              "incompatible tool version",
            ),
          );
          continue;
        }
        results.push(await executeCheck({ resolved, target, check, binary, version, changed, run: opts }));
      }
    }
  }

  const metrics = aggregateMetrics(results);
  const failures = results
    .filter((result) => result.status === "FAIL" || result.status === "ERROR")
    .map((result) => `${result.plugin}: ${result.reason ?? result.status}`);
  const passed = failures.length === 0;
  const report = formatReport({
    results,
    capabilities,
    config: resolved,
    baseline,
    metrics,
    evaluation: { passed: true, failures: [], warnings: [] },
    changedMode: !!opts.changed,
  });
  return { passed, results, metrics, baseline, config: resolved, capabilities, failures, report };
}

export function scopeChangedFiles(files: string[] | undefined, configRoot: string, checkRoot: string) {
  if (!files) return undefined;
  return files.flatMap((file) => {
    const absolute = path.resolve(configRoot, file);
    const relative = path.relative(checkRoot, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
    return [relative || path.basename(absolute)];
  });
}

function normalizeObservationPaths(result: PluginResult, configRoot: string, checkRoot: string): PluginResult {
  if (checkRoot === configRoot) return result;
  return {
    ...result,
    observations: result.observations.map((observation) => {
      if (!observation.file) return observation;
      const absolute = path.isAbsolute(observation.file) ? observation.file : path.resolve(checkRoot, observation.file);
      const relative = path.relative(configRoot, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return observation;
      return { ...observation, file: relative };
    }),
  };
}

export async function runEngine(opts: {
  configFlag?: string;
  cwd?: string;
  root?: string;
  changed?: boolean;
  full?: boolean;
  baseBranch?: string;
  json?: boolean;
  changedFiles?: string[];
  fast?: boolean;
  policy?: ResolvedPolicy;
}): Promise<EngineResult> {
  const cwd = path.resolve(opts.cwd || opts.root || process.cwd());
  const resolved = resolveConfig({ configFlag: opts.configFlag, cwd });
  if (resolved.isDefault)
    throw new Error(
      "MatrixCore is not configured. Add quality.yaml with: version: 2, project: <name>, review: { agentsmith: false }",
    );
  return runPolicyEngine(resolved, opts);
}
