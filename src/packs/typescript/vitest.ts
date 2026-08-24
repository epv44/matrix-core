import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import path from "node:path";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
import { verboseEnabled } from "../../core/verbose.js";
import { childProcessEnv } from "../../core/process-env.js";

function getCfg(ctx: RunCtx, keys: string[]) {
  for (const k of keys) {
    const cfg = ctx.config?.checks?.[k];
    if (cfg) return cfg;
  }
  return undefined;
}

function runVitest(root: string, extra: string[]): { stdout: string; stderr: string; status: number | null } {
  const local = path.join(root, "node_modules", ".bin", "vitest");
  const candidates: Array<[string, string[]]> = [
    [local, ["run", "--reporter=json", ...extra]],
    ["vitest", ["run", "--reporter=json", ...extra]],
    ["npx", ["--no-install", "vitest", "run", "--reporter=json", ...extra]],
  ];
  for (const [bin, a] of candidates) {
    if (verboseEnabled()) {
      console.debug(`[matrix-core] vitest argv: ${bin} ${a.join(" ")}`);
    }
    try {
      const res = spawnSync(bin, a, { cwd: root, encoding: "utf8", timeout: 120000, env: childProcessEnv() });
      if (verboseEnabled()) {
        console.debug(
          `[matrix-core] vitest exit=${res.status} stdout=${(res.stdout || "").slice(0, 500)} stderr=${(res.stderr || "").slice(0, 500)}`,
        );
      }
      if (res.error) continue;
      if (res.status !== null) return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
    } catch {}
  }
  return { stdout: "", stderr: "vitest not found", status: null };
}

export const vitestPlugin: QualityPlugin = {
  name: "typescript.vitest",
  pack: "typescript",
  aliases: ["vitest", "jest"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("vitest") || caps.get("typescript.vitest") || caps.get("jest");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "typescript.vitest",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "vitest not found", severity: req ? "error" : "info" }],
        metrics: {
          "typescript.vitest.test_count": null,
          "vitest.test_count": null,
          "vitest.passed": null,
          "vitest.failed": null,
        },
        reason: req ? "vitest not found but required=true" : "vitest not found, required=false",
      };
    }

    if (!ctx.full && ctx.changedFiles) {
      const hasTs = ctx.changedFiles.some(
        (f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.includes("/tests/") || f.endsWith(".test.ts"),
      );
      if (!hasTs) {
        return {
          plugin: "typescript.vitest",
          status: "PASS",
          observations: [],
          metrics: {
            "typescript.vitest.test_count": 0,
            "vitest.test_count": 0,
            "vitest.passed": 0,
            "vitest.failed": 0,
          },
          score: 100,
          reason: "no relevant ts files changed",
        };
      }
    }

    const cfg = getCfg(ctx, ["typescript.vitest", "vitest", "jest"]);
    const extra = (cfg?.args || []) as string[];

    try {
      const res = runVitest(ctx.root, extra);
      if (res.status === null && !res.stdout) {
        return {
          plugin: "typescript.vitest",
          status: "ERROR",
          observations: [{ message: res.stderr.slice(0, 2000), severity: "error" }],
          metrics: { "vitest.test_count": null },
          reason: "exec failed",
        };
      }
      const combined = res.stdout + "\n" + res.stderr;
      let total = 0,
        passed = 0,
        failed = 0;
      const obs: Observation[] = [];
      let parsedJson = false;
      try {
        const jsonStr = res.stdout.trim();
        if (jsonStr) {
          const data = JSON.parse(jsonStr);
          if (data.testResults) {
            for (const suite of data.testResults) {
              for (const test of suite.assertionResults || []) {
                total++;
                if (test.status === "passed") passed++;
                else if (test.status === "failed") {
                  failed++;
                  obs.push({ message: `${suite.name} - ${test.title}`, severity: "error", ruleId: "vitest" });
                }
              }
            }
            parsedJson = true;
          } else if (data.numTotalTests !== undefined) {
            total = data.numTotalTests;
            passed = data.numPassedTests;
            failed = data.numFailedTests;
            parsedJson = true;
          }
        }
      } catch {}

      if (!parsedJson) {
        // text fallback: vitest default reporter text also appears in stderr when json reporter not fully JSON?
        const passedMatch = combined.match(/(\d+)\s+passed/);
        if (passedMatch) passed = parseInt(passedMatch[1], 10);
        const failedMatch = combined.match(/(\d+)\s+failed/);
        if (failedMatch) failed = parseInt(failedMatch[1], 10);
        total = passed + failed;
        // if json reporter not producing JSON because of this setup, vitest text summary still gives counts
        if (total === 0) {
          const m = combined.match(/Test Files\s+\d+\s+passed/);
          if (m && combined.includes("Tests")) {
            const tm = combined.match(/Tests\s+(\d+)\s+passed/);
            if (tm) {
              passed = parseInt(tm[1], 10);
              total = passed;
            }
          }
        }
      }

      if (total === 0 && passed === 0 && failed === 0) {
        if (
          res.stdout.includes("No test files found") ||
          combined.includes("No test") ||
          (res.status === 0 && combined.includes("0"))
        ) {
          return {
            plugin: "typescript.vitest",
            status: "SKIPPED",
            observations: [{ message: "no tests found", severity: "info" }],
            metrics: {
              "typescript.vitest.test_count": 0,
              "vitest.test_count": 0,
              "vitest.passed": 0,
              "vitest.failed": 0,
            },
            reason: "no tests",
          };
        }
      }

      const status = failed > 0 ? "FAIL" : "PASS";

      return {
        plugin: "typescript.vitest",
        status,
        score: status === "PASS" ? 100 : 0,
        observations:
          obs.length > 0
            ? obs
            : res.status !== 0 && status === "FAIL"
              ? [{ message: combined.slice(0, 5000), severity: "error", ruleId: "vitest" }]
              : [],
        metrics: {
          "typescript.vitest.test_count": total || passed || 0,
          "vitest.test_count": total || passed || 0,
          "typescript.vitest.passed": passed,
          "vitest.passed": passed,
          "typescript.vitest.failed": failed,
          "vitest.failed": failed,
          "typescript.vitest.coverage_percent": null,
          "vitest.coverage_percent": null,
        },
        reason: status === "FAIL" ? `${failed} failed, ${passed} passed` : `${passed} passed`,
      };
    } catch (e: any) {
      return {
        plugin: "typescript.vitest",
        status: "ERROR",
        observations: [{ message: e.message, severity: "error" }],
        metrics: { "vitest.test_count": null },
        reason: "exception",
      };
    }
  },
};
