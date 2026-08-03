import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { QualityConfig, ResolvedConfig, CheckCfg } from "./types.js";

const CheckCfgSchema = z.object({
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  args: z.array(z.string()).optional(),
});

const PolicySchema = z.object({
  metric: z.string(),
  degradation_allowed: z.number().optional(),
  max_increase_percent: z.number().optional(),
  max: z.number().optional(),
  absolute_min: z.number().optional(),
});

const ConfigSchema = z.object({
  version: z.number().default(1),
  checks: z.record(CheckCfgSchema).default({}),
  policies: z.record(PolicySchema).default({}),
  plugins: z.array(z.string()).optional(),
});

const DEFAULT_CONFIG: QualityConfig = {
  version: 1,
  checks: {
    ruff: { enabled: true, required: true },
    mypy: { enabled: true, required: false },
    pytest: { enabled: true, required: true },
    coverage: { enabled: true, required: false },
  },
  policies: {
    coverage: { metric: "pytest.coverage_percent", degradation_allowed: 0, absolute_min: 70 },
    ruff_violations: { metric: "ruff.violation_count", max: 0, max_increase_percent: 5 },
    mypy_errors: { metric: "mypy.error_count", max: 0 },
  },
};

const CANDIDATE_NAMES = ["quality.yaml", ".quality.yaml", "quality.yml", ".quality.yml", "quality.json", ".quality.json"];

function parseFile(filePath: string): QualityConfig | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    let obj: any;
    if (filePath.endsWith(".json")) {
      obj = JSON.parse(raw);
    } else {
      obj = yaml.load(raw);
    }
    const parsed = ConfigSchema.parse(obj);
    return {
      version: parsed.version,
      checks: parsed.checks as Record<string, CheckCfg>,
      policies: parsed.policies as any,
      plugins: parsed.plugins,
    };
  } catch {
    return null;
  }
}

function findInDir(dir: string): string | null {
  for (const name of CANDIDATE_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function findGitRoot(start: string): string | null {
  let cur = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function resolveConfig(opts: { configFlag?: string; cwd?: string; root?: string }): ResolvedConfig {
  const cwd = path.resolve(opts.cwd || opts.root || process.cwd());

  if (opts.configFlag) {
    const abs = path.isAbsolute(opts.configFlag) ? opts.configFlag : path.resolve(cwd, opts.configFlag);
    if (fs.existsSync(abs)) {
      const cfg = parseFile(abs);
      if (cfg) return { config: cfg, configPath: abs, configRoot: path.dirname(abs), isDefault: false };
    }
    throw new Error(`Config flag file not found or invalid: ${abs}`);
  }

  let cur = cwd;
  while (true) {
    const found = findInDir(cur);
    if (found) {
      const cfg = parseFile(found);
      if (cfg) return { config: cfg, configPath: found, configRoot: path.dirname(found), isDefault: false };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const found = findInDir(gitRoot);
    if (found) {
      const cfg = parseFile(found);
      if (cfg) return { config: cfg, configPath: found, configRoot: path.dirname(found), isDefault: false };
    }
  }

  return { config: DEFAULT_CONFIG, configPath: null, configRoot: gitRoot || cwd, isDefault: true };
}

export function getDefaultConfig(): QualityConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
