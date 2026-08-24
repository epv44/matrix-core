import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
import { verboseEnabled } from "../../core/verbose.js";

function getCfg(ctx: RunCtx, keys: string[]) {
  for (const k of keys) {
    const cfg = ctx.config?.checks?.[k];
    if (cfg) return cfg;
  }
  return undefined;
}

function runRuff(
  root: string,
  targets: string[] | undefined,
  extra: string[],
  binary = "ruff",
): { violations: any[]; error?: string } {
  const args = ["check", "--output-format", "json", ...(extra as string[]), ...(targets || ["."])];
  if (verboseEnabled()) {
    console.debug(`[matrix-core] ruff argv: ${binary} ${args.join(" ")}`);
  }
  const res = spawnSync(binary, args, { cwd: root, encoding: "utf8", timeout: 30000 });
  if (verboseEnabled()) {
    console.debug(
      `[matrix-core] ruff exit=${res.status} stdout=${(res.stdout || "").slice(0, 500)} stderr=${(res.stderr || "").slice(0, 500)}`,
    );
  }
  if (res.status === null && !res.stdout)
    return { violations: [], error: `ruff execution failed: ${res.stderr?.slice(0, 2000)}` };
  let violations: any[] = [];
  try {
    const t = (res.stdout || "").trim();
    if (t) {
      const p = JSON.parse(t);
      if (Array.isArray(p)) violations = p;
    }
  } catch {
    violations = [];
  }
  return { violations };
}

function toObs(violations: any[]): Observation[] {
  return violations.map((v: any) => ({
    file: v.filename || v.location?.path,
    line: v.location?.row || v.row || v.line,
    col: v.location?.column,
    message: v.message || JSON.stringify(v),
    severity: "error" as const,
    ruleId: v.code || v.rule,
  }));
}

function baseMetrics(total: number, fresh: number): Record<string, number | null> {
  return {
    "python.ruff.violation_count": total,
    "ruff.violation_count": total,
    "python.ruff.new_violation_count": fresh,
    "ruff.new_violation_count": fresh,
    "python.ruff.complexity.max": null,
    "ruff.complexity.max": null,
  };
}

export const ruffPlugin: QualityPlugin = {
  name: "python.ruff",
  pack: "python",
  aliases: ["ruff"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("ruff") || caps.get("python.ruff");
    if (!cap || !cap.found) {
      const req = cap?.required ?? true;
      return {
        plugin: "python.ruff",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "ruff executable not found", severity: req ? "error" : "info" }],
        metrics: {
          "python.ruff.violation_count": null,
          "ruff.violation_count": null,
          "python.ruff.new_violation_count": null,
          "ruff.new_violation_count": null,
          "python.ruff.complexity.max": null,
          "ruff.complexity.max": null,
        },
        reason: req ? "executable not found but required=true" : "executable not found, required=false",
      };
    }
    const extraArgs = ctx.policyCheck?.args ?? getCfg(ctx, ["python.ruff", "ruff"])?.args ?? [];
    const binary = ctx.workspace?.toolEnvironment.binaries.ruff ?? "ruff";
    const pyChanged = (ctx.changedFiles || []).filter((f) => f.endsWith(".py"));

    if (!ctx.full) {
      if (pyChanged.length === 0)
        return {
          plugin: "python.ruff",
          status: "PASS",
          observations: [],
          metrics: baseMetrics(0, 0),
          score: 100,
          reason: "no python files changed",
        };
      try {
        const { violations, error } = runRuff(ctx.root, pyChanged, extraArgs, binary);
        if (error)
          return {
            plugin: "python.ruff",
            status: "ERROR",
            observations: [{ message: error, severity: "error" }],
            metrics: { "python.ruff.violation_count": null, "ruff.violation_count": null },
            reason: "engine/plugin malfunction",
          };
        const obs = toObs(violations);
        const count = violations.length;
        return {
          plugin: "python.ruff",
          status: count > 0 ? "FAIL" : "PASS",
          score: count === 0 ? 100 : Math.max(0, 100 - count),
          observations: obs,
          metrics: baseMetrics(count, count),
          reason: count > 0 ? `${count} violations in changed files` : undefined,
        };
      } catch (e: any) {
        return {
          plugin: "python.ruff",
          status: "ERROR",
          observations: [{ message: e.message, severity: "error" }],
          metrics: { "python.ruff.violation_count": null, "ruff.violation_count": null },
          reason: "exception",
        };
      }
    }

    try {
      const totalRes = runRuff(ctx.root, undefined, extraArgs, binary);
      if (totalRes.error)
        return {
          plugin: "python.ruff",
          status: "ERROR",
          observations: [{ message: totalRes.error, severity: "error" }],
          metrics: { "python.ruff.violation_count": null, "ruff.violation_count": null },
          reason: "engine/plugin malfunction",
        };
      const total = totalRes.violations.length;
      let fresh = 0;
      let obs: Observation[] = ctx.policyCheck ? toObs(totalRes.violations) : [];
      if (pyChanged.length > 0) {
        const freshRes = runRuff(ctx.root, pyChanged, extraArgs, binary);
        if (!freshRes.error) {
          fresh = freshRes.violations.length;
          if (!ctx.policyCheck) obs = toObs(freshRes.violations);
        }
      }
      const failed = ctx.policyCheck ? total > 0 : fresh > 0;
      const status = failed ? "FAIL" : "PASS";
      return {
        plugin: "python.ruff",
        status,
        score: fresh === 0 ? 100 : Math.max(0, 100 - fresh),
        observations: obs,
        metrics: baseMetrics(total, fresh),
        reason:
          status === "FAIL"
            ? ctx.policyCheck
              ? `${total} violations`
              : `${fresh} new violations in changed files`
            : undefined,
      };
    } catch (e: any) {
      return {
        plugin: "python.ruff",
        status: "ERROR",
        observations: [{ message: e.message, severity: "error" }],
        metrics: { "python.ruff.violation_count": null, "ruff.violation_count": null },
        reason: "exception",
      };
    }
  },
};
