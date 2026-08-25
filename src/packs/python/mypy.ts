import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
import { verboseEnabled } from "../../core/verbose.js";
import { getCheckConfig } from "../common.js";

function tryMypy(root: string, files: string[] | undefined, extra: string[], binary = "mypy") {
  const args = [...extra, ...(files && files.length > 0 ? files : ["."])];
  if (verboseEnabled()) {
    console.debug(`[matrix-core] mypy argv: ${binary} ${args.join(" ")}`);
  }
  try {
    const res = spawnSync(binary, args, { cwd: root, encoding: "utf8", timeout: 60000 });
    if (verboseEnabled()) {
      console.debug(
        `[matrix-core] mypy exit=${res.status} stdout=${(res.stdout || "").slice(0, 500)} stderr=${(res.stderr || "").slice(0, 500)}`,
      );
    }
    if (res.error) return { stdout: "", stderr: (res.error as any).message, status: null };
    return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
  } catch (e: any) {
    if (verboseEnabled()) {
      console.debug(`[matrix-core] mypy exception: ${e.message}`);
    }
    return { stdout: "", stderr: e.message, status: null };
  }
}

function parseOut(out: string): Observation[] {
  const obs: Observation[] = [];
  const re = /^(.*?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.*)$/;
  const STUB_NOISE = /\b(import-not-found|import-untyped|import-any|no-redef|import-not-found \[\])\b/;
  for (const line of out.split("\n")) {
    const m = line.match(re);
    if (m) {
      const isStubNoise = STUB_NOISE.test(line);
      const severity = isStubNoise ? "warn" : m[4] === "error" ? "error" : m[4] === "warning" ? "warn" : "info";
      obs.push({
        file: m[1],
        line: parseInt(m[2], 10),
        col: m[3] ? parseInt(m[3], 10) : undefined,
        message: m[5],
        severity,
        ruleId: "mypy",
      });
    }
  }
  return obs;
}

function runMypy(
  ctx: RunCtx,
  targets: string[] | undefined,
  extra: string[],
  binary = "mypy",
): { errs: number; obs: Observation[]; error?: string } {
  const result = tryMypy(ctx.root, targets, extra, binary);
  if (result.status === null) return { errs: 0, obs: [], error: `mypy failed: ${result.stderr}` };
  const obs = parseOut(result.stdout + "\n" + result.stderr);
  return { errs: obs.filter((o) => o.severity === "error").length, obs };
}

function baseMetrics(errs: number, fresh: number): Record<string, number | null> {
  return {
    "python.mypy.error_count": errs,
    "mypy.error_count": errs,
    "python.mypy.new_error_count": fresh,
    "mypy.new_error_count": fresh,
  };
}

export const mypyPlugin: QualityPlugin = {
  name: "python.mypy",
  pack: "python",
  aliases: ["mypy"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("mypy") || caps.get("python.mypy");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "python.mypy",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "mypy executable not found", severity: req ? "error" : "info" }],
        metrics: { "python.mypy.error_count": null, "mypy.error_count": null },
        reason: req ? "executable not found but required=true" : "executable not found, required=false",
      };
    }
    const extra = ctx.policyCheck?.args ?? ((getCheckConfig(ctx, ["python.mypy", "mypy"])?.args || []) as string[]);
    const binary = ctx.workspace?.toolEnvironment.binaries.mypy ?? "mypy";
    const pyChanged = (ctx.changedFiles || []).filter((f) => f.endsWith(".py"));

    if (!ctx.full) {
      if (pyChanged.length === 0)
        return {
          plugin: "python.mypy",
          status: "PASS",
          observations: [],
          metrics: baseMetrics(0, 0),
          score: 100,
          reason: "no python files changed",
        };
      const { errs, obs, error } = runMypy(
        ctx,
        pyChanged,
        ctx.fast ? [...extra, "--follow-imports=skip"] : extra,
        binary,
      );
      if (error)
        return {
          plugin: "python.mypy",
          status: "ERROR",
          observations: [{ message: error, severity: "error" }],
          metrics: { "python.mypy.error_count": null, "mypy.error_count": null },
          reason: "engine malfunction",
        };
      return {
        plugin: "python.mypy",
        status: errs > 0 ? "FAIL" : "PASS",
        score: errs === 0 ? 100 : Math.max(0, 100 - errs * 5),
        observations: obs,
        metrics: baseMetrics(errs, errs),
        reason: errs > 0 ? `${errs} mypy errors` : undefined,
      };
    }

    const totalRes = runMypy(ctx, undefined, extra, binary);
    if (totalRes.error)
      return {
        plugin: "python.mypy",
        status: "ERROR",
        observations: [{ message: totalRes.error, severity: "error" }],
        metrics: { "python.mypy.error_count": null, "mypy.error_count": null },
        reason: "engine malfunction",
      };
    if (ctx.policyCheck) {
      const failed = totalRes.errs > 0;
      return {
        plugin: "python.mypy",
        status: failed ? "FAIL" : "PASS",
        score: failed ? Math.max(0, 100 - totalRes.errs * 5) : 100,
        observations: totalRes.obs,
        metrics: baseMetrics(totalRes.errs, 0),
        reason: failed ? `${totalRes.errs} mypy errors` : undefined,
      };
    }
    let fresh = 0;
    let obs: Observation[] = [];
    if (pyChanged.length > 0) {
      const freshRes = runMypy(ctx, pyChanged, extra, binary);
      if (!freshRes.error) {
        fresh = freshRes.errs;
        obs = freshRes.obs;
      }
    }
    const failed = fresh > 0;
    const status = failed ? "FAIL" : "PASS";
    return {
      plugin: "python.mypy",
      status,
      score: fresh === 0 ? 100 : Math.max(0, 100 - fresh * 5),
      observations: obs,
      metrics: baseMetrics(totalRes.errs, fresh),
      reason: status === "FAIL" ? `${fresh} new mypy errors` : undefined,
    };
  },
};
