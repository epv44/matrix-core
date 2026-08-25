import { spawnSync } from "node:child_process";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";
import { verboseEnabled } from "../../core/verbose.js";
import { getCheckConfig } from "../common.js";

function runFormatCheck(
  root: string,
  targets: string[] | undefined,
  extra: string[],
  binary = "ruff",
): { files: string[]; error?: string } {
  const args = ["format", "--check", "--output-format", "json", ...(extra as string[]), ...(targets || ["."])];
  if (verboseEnabled()) {
    console.debug(`[matrix-core] ruff-format argv: ${binary} ${args.join(" ")}`);
  }
  const res = spawnSync(binary, args, { cwd: root, encoding: "utf8", timeout: 30000 });
  if (verboseEnabled()) {
    console.debug(
      `[matrix-core] ruff-format exit=${res.status} stdout=${(res.stdout || "").slice(0, 500)} stderr=${(res.stderr || "").slice(0, 500)}`,
    );
  }
  if (res.status === null && !res.stdout && !res.stderr)
    return { files: [], error: `ruff format check failed: ${(res.stderr || "").slice(0, 2000)}` };
  const files: string[] = [];
  try {
    const p = JSON.parse((res.stdout || "").trim());
    if (Array.isArray(p)) {
      for (const v of p) {
        const f = v.filename || v.path;
        if (f && !files.includes(f)) files.push(f);
      }
    }
  } catch {
    const out = (res.stdout || "") + "\n" + (res.stderr || "");
    for (const line of out.split("\n")) {
      const m1 = line.match(/^Would reformat:\s*(.+)$/);
      if (m1 && !files.includes(m1[1].trim())) files.push(m1[1].trim());
      const m2 = line.match(/^\s*-->\s*([^:]+):\d+:\d+/);
      if (m2 && !files.includes(m2[1].trim())) files.push(m2[1].trim());
    }
  }
  return { files };
}

function formatObservations(files: string[]): Observation[] {
  return files.map((file) => ({
    file,
    message: "file would be reformatted by ruff format",
    severity: "warn",
    ruleId: "ruff-format",
  }));
}

export const ruffFormatPlugin: QualityPlugin = {
  name: "python.ruff-format",
  pack: "python",
  aliases: ["ruff-format", "ruff_format", "ruffFormat"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("ruff") || caps.get("python.ruff");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "python.ruff-format",
        status: req ? "FAIL" : "SKIPPED",
        observations: [
          { message: "ruff executable not found (needed for format check)", severity: req ? "error" : "info" },
        ],
        metrics: {
          "python.ruff-format.unformatted": null,
          "ruff-format.unformatted": null,
          "python.ruff-format.new_unformatted": null,
          "ruff-format.new_unformatted": null,
        },
        reason: req ? "executable not found but required=true" : "executable not found, required=false",
      };
    }
    const extra =
      ctx.policyCheck?.args ??
      ((getCheckConfig(ctx, ["python.ruff-format", "ruff-format", "ruff_format"])?.args || []) as string[]);
    const binary = ctx.workspace?.toolEnvironment.binaries.ruff ?? "ruff";
    const pyChanged = (ctx.changedFiles || []).filter((f) => f.endsWith(".py"));

    if (!ctx.full) {
      if (pyChanged.length === 0)
        return {
          plugin: "python.ruff-format",
          status: "PASS",
          observations: [],
          metrics: {
            "python.ruff-format.unformatted": 0,
            "ruff-format.unformatted": 0,
            "python.ruff-format.new_unformatted": 0,
            "ruff-format.new_unformatted": 0,
          },
          score: 100,
          reason: "no python files changed",
        };
      const { files, error } = runFormatCheck(ctx.root, pyChanged, extra, binary);
      if (error)
        return {
          plugin: "python.ruff-format",
          status: "ERROR",
          observations: [{ message: error, severity: "error" }],
          metrics: { "python.ruff-format.unformatted": null, "ruff-format.unformatted": null },
          reason: "engine/plugin malfunction",
        };
      const count = files.length;
      const obs = formatObservations(files);
      return {
        plugin: "python.ruff-format",
        status: count > 0 ? "FAIL" : "PASS",
        score: count === 0 ? 100 : Math.max(0, 100 - count * 2),
        observations: obs,
        metrics: {
          "python.ruff-format.unformatted": count,
          "ruff-format.unformatted": count,
          "python.ruff-format.new_unformatted": count,
          "ruff-format.new_unformatted": count,
        },
        reason: count > 0 ? `${count} files would be reformatted` : undefined,
      };
    }

    const totalRes = runFormatCheck(ctx.root, undefined, extra, binary);
    if (totalRes.error)
      return {
        plugin: "python.ruff-format",
        status: "ERROR",
        observations: [{ message: totalRes.error, severity: "error" }],
        metrics: { "python.ruff-format.unformatted": null, "ruff-format.unformatted": null },
        reason: "engine/plugin malfunction",
      };
    const total = totalRes.files.length;
    let fresh = 0;
    let obs: Observation[] = ctx.policyCheck ? formatObservations(totalRes.files) : [];
    if (pyChanged.length > 0) {
      const freshRes = runFormatCheck(ctx.root, pyChanged, extra, binary);
      if (!freshRes.error) {
        fresh = freshRes.files.length;
        if (!ctx.policyCheck) obs = formatObservations(freshRes.files);
      }
    }
    const failed = ctx.policyCheck ? total > 0 : fresh > 0;
    const status = failed ? "FAIL" : "PASS";
    return {
      plugin: "python.ruff-format",
      status,
      score: fresh === 0 ? 100 : Math.max(0, 100 - fresh * 2),
      observations: obs,
      metrics: {
        "python.ruff-format.unformatted": total,
        "ruff-format.unformatted": total,
        "python.ruff-format.new_unformatted": fresh,
        "ruff-format.new_unformatted": fresh,
      },
      reason:
        status === "FAIL"
          ? ctx.policyCheck
            ? `${total} files would be reformatted`
            : `${fresh} changed files would be reformatted`
          : undefined,
    };
  },
};
