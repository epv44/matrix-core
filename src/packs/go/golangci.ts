import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
import { verboseEnabled } from "../../core/verbose.js";

export const golangciPlugin: QualityPlugin = {
  name: "go.golangci",
  pack: "go",
  aliases: ["golangci-lint", "golangci"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("golangci-lint") || caps.get("go.golangci") || caps.get("golangci");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "go.golangci",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "golangci-lint not found", severity: req ? "error" : "info" }],
        metrics: { "go.golangci.error_count": null, "golangci.error_count": null },
        reason: req ? "not found but required=true" : "not found, required=false",
      };
    }
    if (!ctx.full && ctx.changedFiles) {
      const hasGo = ctx.changedFiles.some((f) => f.endsWith(".go"));
      if (!hasGo)
        return {
          plugin: "go.golangci",
          status: "PASS",
          observations: [],
          metrics: { "go.golangci.error_count": 0, "golangci.error_count": 0 },
          score: 100,
          reason: "no go files changed",
        };
    }
    try {
      const args = ["run", "--out-format", "json", "./..."];
      if (verboseEnabled()) {
        console.debug(`[matrix-core] golangci-lint argv: golangci-lint ${args.join(" ")}`);
      }
      const res = spawnSync("golangci-lint", args, {
        cwd: ctx.root,
        encoding: "utf8",
        timeout: 120000,
      });
      if (verboseEnabled()) {
        console.debug(
          `[matrix-core] golangci-lint exit=${res.status} stdout=${(res.stdout || "").slice(0, 500)} stderr=${(res.stderr || "").slice(0, 500)}`,
        );
      }
      let errorCount = 0;
      const obs: Observation[] = [];
      try {
        const data = res.stdout ? JSON.parse(res.stdout) : { Issues: [] };
        const issues = data.Issues || [];
        errorCount = issues.length;
        for (const iss of issues.slice(0, 100)) {
          obs.push({
            file: iss.Pos?.Filename,
            line: iss.Pos?.Line,
            message: iss.Text,
            severity: "error",
            ruleId: iss.FromLinter,
          });
        }
      } catch {
        errorCount = res.status !== 0 ? 1 : 0;
        if (res.stdout) obs.push({ message: res.stdout.slice(0, 5000), severity: "error" });
      }
      return {
        plugin: "go.golangci",
        status: errorCount > 0 ? "FAIL" : "PASS",
        score: errorCount === 0 ? 100 : Math.max(0, 100 - errorCount),
        observations: obs,
        metrics: { "go.golangci.error_count": errorCount, "golangci.error_count": errorCount },
        reason: errorCount > 0 ? `${errorCount} issues` : undefined,
      };
    } catch (e: any) {
      return {
        plugin: "go.golangci",
        status: "ERROR",
        observations: [{ message: e.message, severity: "error" }],
        metrics: { "go.golangci.error_count": null },
        reason: "exception",
      };
    }
  },
};
