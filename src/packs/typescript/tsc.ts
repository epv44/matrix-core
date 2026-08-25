import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import path from "node:path";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
import { verboseEnabled } from "../../core/verbose.js";
import { childProcessEnv } from "../../core/process-env.js";
import { getCheckConfig } from "../common.js";

function tryTsc(
  root: string,
  args: string[],
  designated?: string,
): { stdout: string; stderr: string; status: number | null } {
  const local = designated ?? path.join(root, "node_modules", ".bin", "tsc");
  const candidates: Array<[string, string[]]> = [[local, args]];
  for (const [bin, a] of candidates) {
    if (verboseEnabled()) {
      console.debug(`[matrix-core] tsc argv: ${bin} ${a.join(" ")}`);
    }
    try {
      const res = spawnSync(bin, a, { cwd: root, encoding: "utf8", timeout: 60000, env: childProcessEnv() });
      if (verboseEnabled()) {
        console.debug(
          `[matrix-core] tsc exit=${res.status} stdout=${(res.stdout || "").slice(0, 500)} stderr=${(res.stderr || "").slice(0, 500)}`,
        );
      }
      if (res.error) {
        const error = res.error as NodeJS.ErrnoException;
        return { stdout: res.stdout || "", stderr: `${error.code ?? "spawn"}: ${error.message}`, status: null };
      }
      if (res.status !== null) return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
    } catch {}
  }
  return { stdout: "", stderr: "tsc not found", status: null };
}

function parseTscOutput(out: string): Observation[] {
  const obs: Observation[] = [];
  const re1 = /^(.*?)\((\d+),(\d+)\): error TS(\d+): (.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(out))) {
    obs.push({
      file: m[1],
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
      message: m[5],
      severity: "error",
      ruleId: `TS${m[4]}`,
    });
  }
  if (obs.length === 0) {
    const lines = out.split("\n");
    const re2 = /^(.*):(\d+):(\d+)\s*-\s*error\s*TS(\d+):\s*(.*)$/;
    for (const line of lines) {
      const mm = line.match(re2);
      if (mm)
        obs.push({
          file: mm[1],
          line: parseInt(mm[2], 10),
          col: parseInt(mm[3], 10),
          message: mm[5],
          severity: "error",
          ruleId: `TS${mm[4]}`,
        });
    }
  }
  return obs;
}

export const tscPlugin: QualityPlugin = {
  name: "typescript.tsc",
  pack: "typescript",
  aliases: ["tsc", "typescript"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("typescript") || caps.get("typescript.tsc") || caps.get("tsc");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "typescript.tsc",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "tsc not found/parse error but required flag", severity: req ? "error" : "info" }],
        metrics: { "typescript.error_count": null, "typescript.tsc.error_count": null, "tsc.error_count": null },
        reason: req ? "tsc not found but required=true" : "tsc not found, required=false or not detected",
      };
    }

    if (!ctx.full && ctx.changedFiles) {
      const hasTs = ctx.changedFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
      if (!hasTs) {
        return {
          plugin: "typescript.tsc",
          status: "PASS",
          observations: [],
          metrics: { "typescript.error_count": 0, "typescript.tsc.error_count": 0, "tsc.error_count": 0 },
          score: 100,
          reason: "no ts files changed",
        };
      }
    }

    const cfg = getCheckConfig(ctx, ["typescript.tsc", "tsc", "typescript"]);
    const extraArgs = ctx.policyCheck?.args ?? ((cfg?.args || ["--noEmit"]) as string[]);

    try {
      const res = tryTsc(ctx.root, extraArgs, ctx.workspace?.toolEnvironment.binaries.tsc);
      if (res.status === null) {
        return {
          plugin: "typescript.tsc",
          status: "ERROR",
          observations: [{ message: `tsc exec failed: ${res.stderr}`, severity: "error" }],
          metrics: { "typescript.error_count": null, "tsc.error_count": null },
          reason: "exec failed",
        };
      }
      const combined = res.stdout + "\n" + res.stderr;
      const obs = parseTscOutput(combined);
      const count = obs.length;
      return {
        plugin: "typescript.tsc",
        status: count > 0 ? "FAIL" : "PASS",
        score: count === 0 ? 100 : Math.max(0, 100 - count * 2),
        observations: obs,
        metrics: { "typescript.error_count": count, "typescript.tsc.error_count": count, "tsc.error_count": count },
        reason: count > 0 ? `${count} typescript errors` : undefined,
      };
    } catch (e: any) {
      return {
        plugin: "typescript.tsc",
        status: "ERROR",
        observations: [{ message: e.message, severity: "error" }],
        metrics: { "typescript.error_count": null },
        reason: "exception",
      };
    }
  },
};
