import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Capability, Observation, PluginResult, RunCtx } from "../../core/types.js";
import type { QualityPlugin } from "../interface.js";
import { verboseEnabled } from "../../core/verbose.js";

function withoutDeptryConfig(value: string) {
  const lines = value.split(/\r?\n/);
  const out: string[] = [];
  let excluded = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1]?.trim();
    if (header) excluded = header === "tool.deptry" || header.startsWith("tool.deptry.");
    if (!excluded) out.push(line);
  }
  return out.join("\n");
}

function pythonSupported(binary: string) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
  const match = `${result.stdout ?? ""}${result.stderr ?? ""}`.match(/Python\s+(\d+)\.(\d+)/);
  return !!match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10));
}

export const deptryPlugin: QualityPlugin = {
  name: "python.deptry",
  pack: "python",
  aliases: ["deptry"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("deptry") ?? caps.get("python.deptry");
    const environment = ctx.workspace?.toolEnvironment;
    const binary = environment?.binaries.deptry;
    const python = environment?.binaries.python;
    if (!cap?.found || !binary || !python)
      return {
        plugin: "python.deptry",
        status: "FAIL",
        observations: [
          { message: "deptry and Python must exist in the designated virtual environment", severity: "error" },
        ],
        metrics: { "python.deptry.dep004_count": null },
        reason: "required workspace tool missing",
      };
    if (!pythonSupported(python))
      return {
        plugin: "python.deptry",
        status: "FAIL",
        observations: [{ message: "deptry 0.25.1 requires Python 3.10 or newer", severity: "error" }],
        metrics: { "python.deptry.dep004_count": null },
        reason: "unsupported Python environment",
      };
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "matrixcore-deptry-"));
    const report = path.join(temporary, "report.json");
    try {
      const pyproject = path.join(ctx.root, "pyproject.toml");
      const sanitized = path.join(temporary, "pyproject.toml");
      fs.writeFileSync(
        sanitized,
        fs.existsSync(pyproject)
          ? withoutDeptryConfig(fs.readFileSync(pyproject, "utf8"))
          : '[project]\nname = "matrixcore-consumer"\nversion = "0"\ndependencies = []\n',
      );
      const dependencyFiles = (ctx.workspace?.dependencyFiles ?? []).map((file) => path.resolve(ctx.configRoot, file));
      const runtime = dependencyFiles.filter((file) => path.basename(file) === "requirements.txt");
      const development = dependencyFiles.filter((file) => /requirements-dev\.txt$|dev-requirements\.txt$/.test(file));
      const args = [ctx.workspace?.sourceRoot ?? ctx.root, ...(ctx.policyCheck?.args ?? []), "--config", sanitized];
      if (runtime.length > 0) args.push("--requirements-files", runtime.join(","));
      if (development.length > 0) args.push("--requirements-files-dev", development.join(","));
      args.push("--json-output", report);
      if (verboseEnabled()) {
        console.debug(`[matrix-core] deptry argv: ${binary} ${args.join(" ")}`);
      }
      const run = spawnSync(binary, args, { cwd: ctx.root, encoding: "utf8", timeout: 60000 });
      if (verboseEnabled()) {
        console.debug(
          `[matrix-core] deptry exit=${run.status} stdout=${(run.stdout || "").slice(0, 500)} stderr=${(run.stderr || "").slice(0, 500)}`,
        );
      }
      let parsed: any[] = [];
      if (fs.existsSync(report)) {
        try {
          const value = JSON.parse(fs.readFileSync(report, "utf8"));
          if (Array.isArray(value)) parsed = value;
        } catch {
          return {
            plugin: "python.deptry",
            status: "ERROR",
            observations: [{ message: "deptry produced malformed JSON output", severity: "error" }],
            metrics: { "python.deptry.dep004_count": null },
            reason: "malformed deptry output",
          };
        }
      }
      const dep004 = parsed.filter((finding) => finding?.error?.code === "DEP004");
      const observations: Observation[] = dep004.map((finding) => ({
        file: finding.location?.file,
        line: finding.location?.line ?? undefined,
        col: finding.location?.column ?? undefined,
        message: finding.error?.message ?? "Runtime import is declared as a development dependency",
        severity: "error",
        ruleId: "DEP004",
      }));
      if ((run.error || run.status === null || (run.status !== 0 && parsed.length === 0)) && observations.length === 0)
        return {
          plugin: "python.deptry",
          status: "ERROR",
          observations: [{ message: run.error?.message ?? run.stderr ?? "deptry execution failed", severity: "error" }],
          metrics: { "python.deptry.dep004_count": null },
          reason: "deptry execution failed",
        };
      return {
        plugin: "python.deptry",
        status: observations.length > 0 ? "FAIL" : "PASS",
        observations,
        metrics: { "python.deptry.dep004_count": observations.length },
        score: observations.length > 0 ? 0 : 100,
        reason:
          observations.length > 0
            ? `${observations.length} runtime dependencies declared as development-only`
            : undefined,
      };
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
};
