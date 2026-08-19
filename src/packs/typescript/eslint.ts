import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import path from "node:path";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";

function tryEslint(
  root: string,
  files: string[] | undefined,
  extra: string[],
  designated?: string,
): { stdout: string; status: number | null; error?: string } {
  const targets = files && files.length > 0 ? files : ["."];
  const maxWarnings = extra.some((a) => a.includes("max-warnings")) ? [] : ["--max-warnings", "0"];
  const noWarnIgnored = extra.some((a) => a.includes("no-warn-ignored")) ? [] : ["--no-warn-ignored"];
  const args = [...extra, ...maxWarnings, ...noWarnIgnored, "--format", "json", ...targets];
  const local = designated ?? path.join(root, "node_modules", ".bin", "eslint");
  const candidates: Array<[string, string[]]> = [[local, args]];
  for (const [bin, a] of candidates) {
    try {
      const res = spawnSync(bin, a, { cwd: root, encoding: "utf8", timeout: 60000 });
      if (res.error) continue;
      if (res.status !== null) return { stdout: res.stdout || "", status: res.status };
    } catch {}
  }
  return { stdout: "", status: null, error: "eslint not found" };
}

function parseEslint(stdout: string): { errorCount: number; warnings: number; obs: Observation[]; parsed: boolean } {
  let errorCount = 0;
  let warnings = 0;
  let parsed = false;
  const obs: Observation[] = [];
  const t = (stdout || "").trim();
  if (t) {
    try {
      const json = JSON.parse(t);
      if (!Array.isArray(json)) return { errorCount: 0, warnings: 0, obs: [], parsed: false };
      parsed = true;
      for (const file of json as any[]) {
        for (const msg of file.messages || []) {
          if (msg.severity === 2) errorCount++;
          else if (msg.severity === 1) warnings++;
          obs.push({
            file: file.filePath,
            line: msg.line,
            col: msg.column,
            message: msg.message,
            severity: msg.severity === 2 ? "error" : "warn",
            ruleId: msg.ruleId,
          });
        }
      }
    } catch {
      return { errorCount: 0, warnings: 0, obs: [], parsed: false };
    }
  }
  return { errorCount, warnings, obs, parsed };
}

function baseMetrics(errors: number, fresh: number, warnings: number): Record<string, number | null> {
  return {
    "typescript.eslint.error_count": errors,
    "eslint.error_count": errors,
    "typescript.eslint.new_error_count": fresh,
    "eslint.new_error_count": fresh,
    "typescript.eslint.warning_count": warnings,
    "eslint.warning_count": warnings,
  };
}

export const eslintPlugin: QualityPlugin = {
  name: "typescript.eslint",
  pack: "typescript",
  aliases: ["eslint"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("eslint") || caps.get("typescript.eslint");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "typescript.eslint",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "eslint not found", severity: req ? "error" : "info" }],
        metrics: { "typescript.eslint.error_count": null, "eslint.error_count": null },
        reason: req ? "eslint not found but required=true" : "eslint not found, required=false",
      };
    }
    const cfg = ctx.config?.checks?.["typescript.eslint"] || ctx.config?.checks?.["eslint"];
    const extra = ctx.policyCheck?.args ?? ((cfg?.args || []) as string[]);
    const binary = ctx.workspace?.toolEnvironment.binaries.eslint;
    const tsChanged = (ctx.changedFiles || []).filter(
      (f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js"),
    );

    if (!ctx.full) {
      if (tsChanged.length === 0)
        return {
          plugin: "typescript.eslint",
          status: "PASS",
          observations: [],
          metrics: baseMetrics(0, 0, 0),
          score: 100,
          reason: "no ts/js files changed",
        };
      const res = tryEslint(ctx.root, tsChanged, extra, binary);
      if (res.status === null && !res.stdout)
        return {
          plugin: "typescript.eslint",
          status: "SKIPPED",
          observations: [{ message: "eslint not runnable, skipping", severity: "info" }],
          metrics: { "typescript.eslint.error_count": null, "eslint.error_count": null },
          reason: "not runnable",
        };
      const { errorCount, warnings, obs, parsed } = parseEslint(res.stdout);
      const failed = errorCount > 0 || warnings > 0 || (res.status !== 0 && !parsed);
      return {
        plugin: "typescript.eslint",
        status: failed ? "FAIL" : "PASS",
        score: failed ? 0 : 100,
        observations: obs,
        metrics: baseMetrics(errorCount, errorCount, warnings),
        reason: failed
          ? errorCount > 0
            ? `${errorCount} eslint errors`
            : warnings > 0
              ? `${warnings} eslint warnings (max-warnings 0)`
              : `eslint exited ${res.status}`
          : undefined,
      };
    }

    const totalRes = tryEslint(ctx.root, undefined, extra, binary);
    if (totalRes.status === null && !totalRes.stdout)
      return {
        plugin: "typescript.eslint",
        status: "SKIPPED",
        observations: [{ message: "eslint not runnable, skipping", severity: "info" }],
        metrics: { "typescript.eslint.error_count": null, "eslint.error_count": null },
        reason: "not runnable",
      };
    const total = parseEslint(totalRes.stdout);
    let fresh = { errorCount: 0, warnings: 0, obs: [] as Observation[], parsed: true };
    if (tsChanged.length > 0) {
      const freshRes = tryEslint(ctx.root, tsChanged, extra, binary);
      if (freshRes.status !== null || freshRes.stdout) fresh = parseEslint(freshRes.stdout);
    }
    const effective = ctx.policyCheck ? total : fresh;
    const failed = effective.errorCount > 0 || effective.warnings > 0;
    return {
      plugin: "typescript.eslint",
      status: failed ? "FAIL" : "PASS",
      score: failed ? 0 : 100,
      observations: effective.obs,
      metrics: baseMetrics(total.errorCount, fresh.errorCount, total.warnings),
      reason: failed
        ? effective.errorCount > 0
          ? `${effective.errorCount}${ctx.policyCheck ? "" : " new"} eslint errors`
          : `${effective.warnings}${ctx.policyCheck ? "" : " new"} eslint warnings (max-warnings 0)`
        : undefined,
    };
  },
};
