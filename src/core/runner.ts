import path from "node:path";

import { resolveConfig } from "./config-resolver.js";
import { aggregateMetrics } from "./policy.js";
import { formatReport } from "./report.js";
import { getChangedFiles } from "./changed.js";
import { appendVerboseLog, verboseEnabled } from "./verbose.js";
import type { EngineResult, PluginResult, ResolvedPolicy, RunCtx } from "./types.js";
import { getPluginByName } from "../packs/registry.js";
import { resolveWorkspaceSet } from "./workspace.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import { materializeTypeScriptConfig } from "./typescript-config.js";
import { describeToolProbe, probeToolVersion } from "./process-env.js";

export function toolVersion(binary: string): string | null {
  return probeToolVersion(binary).version;
}

export function versionAccepted(version: string, range: string) {
  return version === range;
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
    const workspaceChecks = policy.checks.filter((candidate) => candidate.language === workspace.language);
    if (workspaceChecks.length === 0)
      throw new Error(`No central quality profile exists for detected ${workspace.language} workspace ${workspace.id}`);
    for (const check of workspaceChecks) {
      if (
        opts.fast &&
        !["python.ruff", "python.ruff-format", "python.mypy", "typescript.tsc", "typescript.eslint"].includes(check.id)
      )
        continue;
      const binary = workspace.toolEnvironment.binaries[check.tool];
      const probe = binary ? probeToolVersion(binary) : null;
      const version = probe?.version ?? null;
      capabilities.push({
        name: `${workspace.id}:${check.tool}`,
        found: !!version,
        version: version ?? undefined,
        path: binary,
        required: true,
      });
      if (!binary || !version) {
        results.push({
          plugin: check.id,
          pack: workspace.language,
          status: "FAIL",
          observations: [
            {
              message:
                binary && probe
                  ? `${describeToolProbe(check.tool, probe)}; designated environment=${workspace.id}; global fallbacks are prohibited`
                  : `${check.tool} is missing from designated ${workspace.id} environment; global fallbacks are prohibited`,
              severity: "error",
            },
          ],
          reason: "required workspace tool missing",
        });
        continue;
      }
      if (!versionAccepted(version, check.requiredVersion)) {
        results.push({
          plugin: check.id,
          pack: workspace.language,
          status: "FAIL",
          observations: [
            {
              message: `${check.tool} ${version} does not satisfy central policy ${check.requiredVersion}`,
              severity: "error",
            },
          ],
          reason: "incompatible tool version",
        });
        continue;
      }
      const plugin = getPluginByName(check.id);
      if (!plugin) throw new Error(`Policy references unknown check: ${check.id}`);
      const executionRoot = workspace.executionRoot;
      const scoped = scopeChangedFiles(changed, resolved.configRoot, executionRoot);
      const ctx: RunCtx = {
        root: executionRoot,
        configRoot: resolved.configRoot,
        changedFiles: scoped,
        full: opts.full || !opts.changed,
        baseBranch: opts.baseBranch,
        config: resolved.config,
        fast: opts.fast,
        workspace,
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
          generatedConfig = materializeTypeScriptConfig(workspace, check.configAsset);
          workspace.effectiveConfigHash = generatedConfig.hash;
          ctx.policyCheck = { ...check, args: ["--project", generatedConfig.path] };
        }
        if (verboseEnabled()) {
          const targets = ctx.changedFiles?.length ? ctx.changedFiles.length : "all";
          appendVerboseLog(resolved.configRoot, `run ${check.id} (ws=${workspace.id}, targets=${targets})`);
        }
        const start = Date.now();
        const result = await plugin.run(ctx, capMap);
        if (verboseEnabled()) {
          appendVerboseLog(
            resolved.configRoot,
            `done ${check.id} -> ${result.status} in ${Date.now() - start}ms (score=${result.score ?? "n/a"})`,
          );
          if (result.observations?.length) {
            appendVerboseLog(resolved.configRoot, `  obs: ${result.observations.length} items`);
          }
        }
        results.push({
          ...normalizeObservationPaths(result, resolved.configRoot, executionRoot),
          plugin: check.id,
          pack: workspace.language,
        });
      } catch (error) {
        if (verboseEnabled()) {
          appendVerboseLog(
            resolved.configRoot,
            `error ${check.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        results.push({
          plugin: check.id,
          pack: workspace.language,
          status: "FAIL",
          observations: [{ message: error instanceof Error ? error.message : String(error), severity: "error" }],
          reason: "invalid application configuration",
        });
      } finally {
        generatedConfig?.cleanup();
      }
    }
    for (const facet of workspace.sqlFacets) {
      for (const check of policy.checks.filter((candidate) => candidate.language === "sql")) {
        const binary = facet.toolEnvironment.binaries[check.tool];
        const probe = binary ? probeToolVersion(binary) : null;
        const version = probe?.version ?? null;
        capabilities.push({
          name: `${facet.id}:${check.tool}`,
          found: !!version,
          version: version ?? undefined,
          path: binary,
          required: true,
        });
        if (!binary || !version) {
          results.push({
            plugin: check.id,
            pack: "sql",
            status: "FAIL",
            observations: [
              {
                message:
                  binary && probe
                    ? `${describeToolProbe(check.tool, probe)}; designated environment=${facet.id}; global fallbacks are prohibited`
                    : `${check.tool} is missing from designated ${facet.id} environment; global fallbacks are prohibited`,
                severity: "error",
              },
            ],
            reason: "required SQL tool environment missing",
          });
          continue;
        }
        if (!versionAccepted(version, check.requiredVersion)) {
          results.push({
            plugin: check.id,
            pack: "sql",
            status: "FAIL",
            observations: [
              {
                message: `${check.tool} ${version} does not satisfy central policy ${check.requiredVersion}`,
                severity: "error",
              },
            ],
            reason: "incompatible tool version",
          });
          continue;
        }
        const plugin = getPluginByName(check.id);
        if (!plugin) throw new Error(`Policy references unknown check: ${check.id}`);
        const scoped = scopeChangedFiles(changed, resolved.configRoot, workspace.executionRoot);
        const ctx: RunCtx = {
          root: workspace.executionRoot,
          configRoot: resolved.configRoot,
          changedFiles: scoped,
          full: opts.full || !opts.changed,
          baseBranch: opts.baseBranch,
          config: resolved.config,
          fast: opts.fast,
          workspace,
          sqlFacet: facet,
          policyCheck: check,
        };
        const capMap = new Map([
          [check.tool, { name: check.tool, found: true, version, path: binary, required: true }],
        ]);
        try {
          if (verboseEnabled()) {
            const targets = ctx.changedFiles?.length ? ctx.changedFiles.length : "all";
            appendVerboseLog(resolved.configRoot, `run ${check.id} (ws=${facet.id}, targets=${targets})`);
          }
          const start = Date.now();
          const result = await plugin.run(ctx, capMap);
          if (verboseEnabled()) {
            appendVerboseLog(
              resolved.configRoot,
              `done ${check.id} -> ${result.status} in ${Date.now() - start}ms (score=${result.score ?? "n/a"})`,
            );
            if (result.observations?.length) {
              appendVerboseLog(resolved.configRoot, `  obs: ${result.observations.length} items`);
            }
          }
          results.push({
            ...normalizeObservationPaths(result, resolved.configRoot, workspace.executionRoot),
            plugin: check.id,
            pack: "sql",
          });
        } catch (error) {
          if (verboseEnabled()) {
            appendVerboseLog(
              resolved.configRoot,
              `error ${check.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          results.push({
            plugin: check.id,
            pack: "sql",
            status: "FAIL",
            observations: [{ message: error instanceof Error ? error.message : String(error), severity: "error" }],
            reason: "invalid SQL application configuration",
          });
        }
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
