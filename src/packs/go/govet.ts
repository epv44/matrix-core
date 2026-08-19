import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";

export const govetPlugin: QualityPlugin = {
  name: "go.vet",
  pack: "go",
  aliases: ["go vet", "govet"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("go") || caps.get("go.vet") || caps.get("govet");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "go.vet",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "go not found", severity: req ? "error" : "info" }],
        metrics: { "go.vet.error_count": null },
        reason: "go missing",
      };
    }
    if (!ctx.full && ctx.changedFiles) {
      const hasGo = ctx.changedFiles.some((f) => f.endsWith(".go"));
      if (!hasGo)
        return {
          plugin: "go.vet",
          status: "PASS",
          observations: [],
          metrics: { "go.vet.error_count": 0 },
          score: 100,
          reason: "no go files changed",
        };
    }
    try {
      const res = spawnSync("go", ["vet", "./..."], { cwd: ctx.root, encoding: "utf8", timeout: 60000 });
      const out = (res.stdout || "") + (res.stderr || "");
      const lines = out.split("\n").filter(Boolean);
      const obs: Observation[] = lines.map((l) => ({ message: l, severity: "error" as const, ruleId: "go vet" }));
      const count = obs.length;
      return {
        plugin: "go.vet",
        status: count > 0 ? "FAIL" : "PASS",
        observations: obs,
        metrics: { "go.vet.error_count": count },
        reason: count > 0 ? `${count} vet issues` : undefined,
      };
    } catch (e: any) {
      return {
        plugin: "go.vet",
        status: "ERROR",
        observations: [{ message: e.message, severity: "error" }],
        metrics: { "go.vet.error_count": null },
        reason: "exception",
      };
    }
  },
};
