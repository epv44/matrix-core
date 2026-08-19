import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";

export const gotestPlugin: QualityPlugin = {
  name: "go.test",
  pack: "go",
  aliases: ["go test", "gotest"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("go") || caps.get("go.test");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "go.test",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "go not found", severity: req ? "error" : "info" }],
        metrics: { "go.test.failed": null, "go.test.passed": null },
        reason: "go missing",
      };
    }
    if (!ctx.full && ctx.changedFiles) {
      const hasGo = ctx.changedFiles.some((f) => f.endsWith(".go"));
      if (!hasGo)
        return {
          plugin: "go.test",
          status: "PASS",
          observations: [],
          metrics: { "go.test.failed": 0, "go.test.passed": 0 },
          score: 100,
          reason: "no go files changed",
        };
    }
    try {
      const res = spawnSync("go", ["test", "-json", "./..."], { cwd: ctx.root, encoding: "utf8", timeout: 120000 });
      let passed = 0,
        failed = 0;
      const obs: Observation[] = [];
      const lines = (res.stdout || "").split("\n");
      for (const line of lines) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.Action === "pass" && ev.Test) passed++;
          if (ev.Action === "fail" && ev.Test) {
            failed++;
            obs.push({ message: ev.Output || `${ev.Package} ${ev.Test} failed`, severity: "error", ruleId: "go test" });
          }
        } catch {}
      }
      const status = failed > 0 || res.status !== 0 ? "FAIL" : "PASS";
      return {
        plugin: "go.test",
        status: status as any,
        observations:
          obs.length > 0
            ? obs
            : res.status !== 0
              ? [{ message: (res.stderr || res.stdout).slice(0, 5000), severity: "error" as const, ruleId: "go test" }]
              : [],
        metrics: { "go.test.failed": failed, "go.test.passed": passed, "go.test.count": passed + failed },
        reason: failed > 0 ? `${failed} failed` : `${passed} passed`,
      };
    } catch (e: any) {
      return {
        plugin: "go.test",
        status: "ERROR",
        observations: [{ message: e.message, severity: "error" }],
        metrics: { "go.test.failed": null },
        reason: "exception",
      };
    }
  },
};
