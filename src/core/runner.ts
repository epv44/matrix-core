import path from "node:path";
import { resolveConfig } from "./config-resolver.js";
import { detectAll, detectMap } from "./capability.js";
import { loadBaseline } from "./baseline.js";
import { evaluatePolicy, aggregateMetrics } from "./policy.js";
import { formatReport } from "./report.js";
import { getChangedFiles } from "./changed.js";
import type { EngineResult, PluginResult, RunCtx } from "./types.js";
import { ruffPlugin } from "../plugins/python/ruff.js";
import { mypyPlugin } from "../plugins/python/mypy.js";
import { pytestPlugin } from "../plugins/python/pytest.js";
const ALL_PLUGINS = [ruffPlugin, mypyPlugin, pytestPlugin];
export async function runEngine(opts: {
  configFlag?: string;
  cwd?: string;
  root?: string;
  changed?: boolean;
  full?: boolean;
  baseBranch?: string;
  json?: boolean;
}): Promise<EngineResult> {
  const cwd = path.resolve(opts.cwd || opts.root || process.cwd());
  const resolved = resolveConfig({ configFlag: opts.configFlag, cwd });
  const capabilities = detectAll(resolved.config);
  const capMap = detectMap(capabilities);
  const baseline = loadBaseline(resolved.configRoot);
  let changedFiles: string[] | undefined;
  if (opts.changed) changedFiles = getChangedFiles({ cwd: resolved.configRoot, base: opts.baseBranch });
  const ctx: RunCtx = {
    root: resolved.configRoot,
    configRoot: resolved.configRoot,
    changedFiles,
    full: opts.full || !opts.changed,
    baseBranch: opts.baseBranch,
    config: resolved.config,
  };
  const results: PluginResult[] = [];
  const toRun: typeof ALL_PLUGINS = [];
  for (const plugin of ALL_PLUGINS) {
    const key = plugin.name;
    const cfg = resolved.config.checks[key];
    if (cfg && !cfg.enabled) {
      results.push({ plugin: key, status: "SKIPPED", observations: [{ message: `${key} disabled via config`, severity: "info" }], metrics: {}, reason: "disabled via config" });
      continue;
    }
    if (resolved.config.plugins && resolved.config.plugins.length > 0 && !resolved.config.plugins.includes(key)) {
      results.push({ plugin: key, status: "SKIPPED", observations: [{ message: `${key} not in plugins allowlist`, severity: "info" }], metrics: {}, reason: "not in plugins list" });
      continue;
    }
    toRun.push(plugin);
  }
  const runPromises = toRun.map(async (p) => {
    try { return await p.run(ctx, capMap); }
    catch (e: any) {
      return { plugin: p.name, status: "ERROR" as const, observations: [{ message: e.message || String(e), severity: "error" as const }], metrics: {}, reason: "exception in runner" };
    }
  });
  const ran = await Promise.all(runPromises);
  results.push(...ran);
  const metrics = aggregateMetrics(results);
  const evaluation = evaluatePolicy(metrics, resolved.config, baseline);
  const hasFailOrError = results.some((r) => r.status === "FAIL" || r.status === "ERROR");
  const passed = !hasFailOrError && evaluation.passed;
  const failures: string[] = [];
  if (hasFailOrError) for (const r of results) if (r.status === "FAIL" || r.status === "ERROR") failures.push(`${r.plugin}: ${r.reason || r.status}`);
  failures.push(...evaluation.failures);
  const report = formatReport({ results, capabilities, config: resolved, baseline, metrics, evaluation, changedMode: !!opts.changed });
  return { passed, results, metrics, baseline, config: resolved, capabilities, failures, report };
}
