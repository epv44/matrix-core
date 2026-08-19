import { spawnSync } from "node:child_process";
import path from "node:path";
import type { QualityPlugin } from "../interface.js";
import type { PluginResult, Capability, RunCtx, Observation } from "../../core/types.js";

const SUPPORTED_EXT = [".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".md", ".html", ".vue", ".yml", ".yaml"];

function tryPrettier(
  root: string,
  files: string[] | undefined,
  extra: string[],
): { files: string[]; status: number | null } {
  const targets = files && files.length > 0 ? files : ["."];
  const args = [...extra, "--check", ...targets];
  const local = path.join(root, "node_modules", ".bin", "prettier");
  const candidates: Array<[string, string[]]> = [
    [local, args],
    ["prettier", args],
    ["npx", ["--no-install", "prettier", ...args]],
  ];
  for (const [bin, a] of candidates) {
    try {
      const res = spawnSync(bin, a, { cwd: root, encoding: "utf8", timeout: 60000 });
      if (res.error) continue;
      if (res.status !== null) {
        const out = (res.stdout || "") + "\n" + (res.stderr || "");
        const flagged = new Set<string>();
        for (const line of out.split("\n")) {
          if (!line.startsWith("[warn] ")) continue;
          const f = line.slice("[warn] ".length).trim();
          if (!f || f.includes("Code style") || f.includes("Run Prettier") || f.includes("Forgot to run Prettier"))
            continue;
          flagged.add(f);
        }
        return { files: [...flagged], status: res.status };
      }
    } catch {}
  }
  return { files: [], status: null };
}

function toObs(files: string[]): Observation[] {
  return files.map((f) => ({
    file: f,
    message: "file not formatted (prettier --check)",
    severity: "warn",
    ruleId: "prettier",
  }));
}

export const prettierPlugin: QualityPlugin = {
  name: "typescript.prettier",
  pack: "typescript",
  aliases: ["prettier"],
  async run(ctx: RunCtx, caps: Map<string, Capability>): Promise<PluginResult> {
    const cap = caps.get("prettier") || caps.get("typescript.prettier");
    if (!cap || !cap.found) {
      const req = cap?.required ?? false;
      return {
        plugin: "typescript.prettier",
        status: req ? "FAIL" : "SKIPPED",
        observations: [{ message: "prettier not found", severity: req ? "error" : "info" }],
        metrics: {
          "typescript.prettier.unformatted": null,
          "prettier.unformatted": null,
          "typescript.prettier.new_unformatted": null,
          "prettier.new_unformatted": null,
        },
        reason: req ? "prettier not found but required=true" : "prettier not found, required=false",
      };
    }
    const cfg = ctx.config?.checks?.["typescript.prettier"] || ctx.config?.checks?.["prettier"];
    const extra = (cfg?.args || []) as string[];
    const tsChanged = (ctx.changedFiles || []).filter((f) => SUPPORTED_EXT.some((ext) => f.endsWith(ext)));

    if (!ctx.full) {
      if (tsChanged.length === 0)
        return {
          plugin: "typescript.prettier",
          status: "PASS",
          observations: [],
          metrics: {
            "typescript.prettier.unformatted": 0,
            "prettier.unformatted": 0,
            "typescript.prettier.new_unformatted": 0,
            "prettier.new_unformatted": 0,
          },
          score: 100,
          reason: "no supported files changed",
        };
      const { files, status } = tryPrettier(ctx.root, tsChanged, extra);
      if (status === null)
        return {
          plugin: "typescript.prettier",
          status: "SKIPPED",
          observations: [{ message: "prettier not runnable, skipping", severity: "info" }],
          metrics: { "typescript.prettier.unformatted": null, "prettier.unformatted": null },
          reason: "not runnable",
        };
      const count = files.length;
      return {
        plugin: "typescript.prettier",
        status: count > 0 ? "FAIL" : "PASS",
        score: count === 0 ? 100 : Math.max(0, 100 - count * 2),
        observations: toObs(files),
        metrics: {
          "typescript.prettier.unformatted": count,
          "prettier.unformatted": count,
          "typescript.prettier.new_unformatted": count,
          "prettier.new_unformatted": count,
        },
        reason: count > 0 ? `${count} files not formatted` : undefined,
      };
    }

    const totalRes = tryPrettier(ctx.root, undefined, extra);
    if (totalRes.status === null)
      return {
        plugin: "typescript.prettier",
        status: "SKIPPED",
        observations: [{ message: "prettier not runnable, skipping", severity: "info" }],
        metrics: { "typescript.prettier.unformatted": null, "prettier.unformatted": null },
        reason: "not runnable",
      };
    const total = totalRes.files.length;
    let fresh = 0;
    let obs: Observation[] = [];
    if (tsChanged.length > 0) {
      const freshRes = tryPrettier(ctx.root, tsChanged, extra);
      if (freshRes.status !== null) {
        fresh = freshRes.files.length;
        obs = toObs(freshRes.files);
      }
    }
    const status = fresh > 0 ? "FAIL" : "PASS";
    return {
      plugin: "typescript.prettier",
      status,
      score: fresh === 0 ? 100 : Math.max(0, 100 - fresh * 2),
      observations: obs,
      metrics: {
        "typescript.prettier.unformatted": total,
        "prettier.unformatted": total,
        "typescript.prettier.new_unformatted": fresh,
        "prettier.new_unformatted": fresh,
      },
      reason: status === "FAIL" ? `${fresh} changed files not formatted` : undefined,
    };
  },
};
