import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Capability, Observation, PluginResult, RunCtx } from "../../core/types.js";
import type { QualityPlugin } from "../interface.js";

function observations(output: string, root: string): Observation[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((message) => {
      const location = message.match(/["']?([^"']+\.py):(\d+)(?::(\d+))?/);
      const file = location?.[1];
      return {
        file: file ? (path.isAbsolute(file) ? path.relative(root, file) : file) : undefined,
        line: location ? Number(location[2]) : undefined,
        col: location?.[3] ? Number(location[3]) : undefined,
        message,
        severity: "error" as const,
        ruleId: "complexity",
      };
    });
}

export const xenonPlugin: QualityPlugin = {
  name: "python.xenon",
  pack: "python",
  aliases: ["xenon"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("xenon") ?? caps.get("python.xenon");
    const binary = ctx.workspace?.toolEnvironment.binaries.xenon;
    if (!cap?.found || !binary)
      return {
        plugin: "python.xenon",
        status: "FAIL",
        observations: [{ message: "xenon executable not found in designated environment", severity: "error" }],
        metrics: { "python.xenon.violation_count": null },
        reason: "required workspace tool missing",
      };
    const args = [...(ctx.policyCheck?.args ?? []), ctx.workspace?.sourceRoot ?? ctx.root];
    const run = spawnSync(binary, args, { cwd: ctx.root, encoding: "utf8", timeout: 30000 });
    if (run.error || run.status === null)
      return {
        plugin: "python.xenon",
        status: "ERROR",
        observations: [{ message: run.error?.message ?? run.stderr ?? "xenon failed to start", severity: "error" }],
        metrics: { "python.xenon.violation_count": null },
        reason: "xenon execution failed",
      };
    const found = observations(`${run.stdout ?? ""}\n${run.stderr ?? ""}`, ctx.configRoot);
    const failed = run.status !== 0;
    return {
      plugin: "python.xenon",
      status: failed ? "FAIL" : "PASS",
      observations:
        failed && found.length === 0 ? [{ message: "Xenon thresholds were exceeded", severity: "error" }] : found,
      metrics: { "python.xenon.violation_count": failed ? Math.max(found.length, 1) : 0 },
      score: failed ? 0 : 100,
      reason: failed ? "central B/B/A complexity thresholds exceeded" : undefined,
    };
  },
};
