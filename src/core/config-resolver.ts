import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { QualityConfig, ResolvedConfig, CheckCfg, StagesCfg, GateCfg, AgentSmithConfig } from "./types.js";
import { ALIAS_MAP } from "../packs/registry.js";
import { DEFAULT_FAST_CHECKS } from "./stages.js";
import { agentSmithConfigFromPolicy } from "./resolved-policy.js";
import { canonicalPath } from "./runtime.js";

const ProjectManifestSchema = z
  .object({
    version: z.literal(2),
    project: z.string().trim().min(1),
    application: z
      .object({
        sql: z
          .array(
            z
              .object({
                root: z.string().trim().min(1),
                dialect: z.string().trim().min(1),
                templater: z.enum(["raw", "jinja", "python", "placeholder"]),
                sources: z.array(z.enum(["files", "python"])).min(1),
              })
              .strict(),
          )
          .min(1)
          .optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        agentsmith: z.boolean(),
        mode: z.enum(["auto", "holistic", "partitioned", "hybrid"]).optional(),
        models: z
          .object({
            candidate: z.string().trim().min(1).optional(),
            scout: z.string().trim().min(1).optional(),
            verifier: z.string().trim().min(1).optional(),
          })
          .strict()
          .optional(),
        parallelism: z.number().int().min(1).max(16).optional(),
        maxDurationMs: z.number().int().min(1000).max(1_800_000).optional(),
      })
      .strict()
      .optional(),
    policy: z
      .object({
        source: z.literal("github"),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        ref: z.string().trim().min(1).max(200),
        manifest: z.string().trim().min(1).max(500).default("matrixcore/policy.json"),
      })
      .strict()
      .optional(),
  })
  .strict();

const DEFAULT_CONFIG: QualityConfig = {
  version: 1,
  checks: {
    ruff: { enabled: true, required: true },
    mypy: { enabled: true, required: false },
    pytest: { enabled: true, required: true },
    coverage: { enabled: true, required: false },
    "python.ruff": { enabled: true, required: true },
    "python.mypy": { enabled: true, required: false },
    "python.pytest": { enabled: true, required: true },
    "python.coverage": { enabled: true, required: false },
    "python.xenon": { enabled: true, required: true },
    "python.deptry": { enabled: true, required: true },
    "sql.sqlfluff": { enabled: true, required: true },
    "python.ruff-format": { enabled: true, required: false },
    "ruff-format": { enabled: true, required: false },
    "typescript.tsc": { enabled: true, required: false },
    "typescript.eslint": { enabled: true, required: false },
    "typescript.vitest": { enabled: true, required: false },
    "typescript.complexity": { enabled: false, required: false },
    "typescript.prettier": { enabled: true, required: false },
    prettier: { enabled: true, required: false },
    "go.golangci": { enabled: false, required: false },
    "go.vet": { enabled: false, required: false },
    "go.test": { enabled: false, required: false },
    "rust.fmt": { enabled: true, required: false },
    "rust.clippy": { enabled: true, required: false },
    "rust.test": { enabled: true, required: false },
    tsc: { enabled: true, required: false },
    eslint: { enabled: true, required: false },
    vitest: { enabled: true, required: false },
    typescript: { enabled: true, required: false },
    golangci: { enabled: false, required: false },
    "golangci-lint": { enabled: false, required: false },
    go: { enabled: false, required: false },
  },
  policies: {
    coverage: { metric: "pytest.coverage_percent", degradation_allowed: 0, absolute_min: 70 },
    ruff_violations: { metric: "ruff.new_violation_count", max: 0 },
    ruff_regression: { metric: "ruff.violation_count", max_increase_percent: 5 },
    mypy_errors: { metric: "mypy.error_count", max: 0 },
  },
  packs: {
    python: { enabled: true },
    typescript: { enabled: true },
    go: { enabled: false },
    rust: { enabled: true },
  },
  stages: {
    fast: { checks: DEFAULT_FAST_CHECKS },
  },
  gates: {
    after_tool: "prompt",
    after_run: "prompt",
    max_retries: 3,
    hook_timeout_ms: 2500,
  },
  agentsmith: {
    enabled: false,
    advisory: true,
    provider: "ollama",
    base_url: "http://127.0.0.1:11434",
    mode: "auto",
    model_profiles: [
      {
        id: "qwen35-9b-local",
        provider: "ollama",
        model: "qwen3.5:9b-q4_K_M",
        contextTokens: 8192,
        reviewCapability: "small",
        requestedOutputTokens: 1024,
        safetyReserveTokens: 1000,
        tokenizer: { kind: "conservative-ratio", codeCharsPerToken: 2, proseCharsPerToken: 3 },
        inference: { temperature: 0, thinking: false, timeoutMs: 120000 },
      },
    ],
    models: { candidate: "qwen35-9b-local", verifier: "qwen35-9b-local" },
    routing: {
      inputContextFraction: 0.7,
      enableHolistic: true,
      enablePartitioned: true,
      enableHybrid: true,
    },
    graph: {
      defaultHops: 1,
      maxHops: 2,
      maxInteractionNeighborsPerSymbol: 8,
      enableHighRiskTwoHopExpansion: true,
    },
    partitioned: {
      maxParallelUnits: 20,
      maxRulesPerUnit: 8,
      maxUnitsPerChangedSymbol: 6,
      maxCandidateWorkItems: 4,
      maxVerificationCandidates: 4,
      preferSemanticBoundaries: true,
      hunkFallback: true,
    },
    holistic: { maxCandidates: 60 },
    hybrid: { maxHotspots: 30, redundantDeepMode: false },
    evidence: { maxRequestsPerCandidate: 8, maxParallelResolutions: 20, maxSnippetLines: 160 },
    verification: { enabled: true, publish: "verified-only" },
    concurrency: 1,
    maxDurationMs: 180_000,
    cache: true,
  },
};

const CANDIDATE_NAMES = [
  "quality.yaml",
  ".quality.yaml",
  "quality.yml",
  ".quality.yml",
  "quality.json",
  ".quality.json",
];

function parseFile(filePath: string): QualityConfig | null {
  const raw = fs.readFileSync(filePath, "utf8");
  const obj: any = filePath.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
  if (obj?.version === 1)
    throw new Error(
      `MatrixCore manifest v1 is no longer supported: ${filePath}. Migrate to: version: 2, project: <name>, review: { agentsmith: <boolean> }`,
    );
  const parsed = ProjectManifestSchema.safeParse(obj);
  if (!parsed.success)
    throw new Error(
      `Invalid MatrixCore v2 manifest ${filePath}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`,
    );
  const reviewEnabled = parsed.data.review?.agentsmith ?? false;
  return {
    version: 2,
    project: parsed.data.project,
    application: parsed.data.application,
    review: {
      agentsmith: reviewEnabled,
      mode: parsed.data.review?.mode,
      models: parsed.data.review?.models,
      parallelism: parsed.data.review?.parallelism,
      maxDurationMs: parsed.data.review?.maxDurationMs,
    },
    policySource: parsed.data.policy,
    checks: {},
    policies: {},
    agentsmith: agentSmithConfigFromPolicy(reviewEnabled),
  };
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
      if (cfg)
        return {
          config: normalizeConfig(cfg),
          configPath: fs.realpathSync(abs),
          configRoot: canonicalPath(path.dirname(abs)),
          isDefault: false,
        };
    }
    throw new Error(`Config flag file not found or invalid: ${abs}`);
  }
  let cur = cwd;
  while (true) {
    const found = findInDir(cur);
    if (found) {
      const cfg = parseFile(found);
      if (cfg)
        return {
          config: normalizeConfig(cfg),
          configPath: fs.realpathSync(found),
          configRoot: canonicalPath(path.dirname(found)),
          isDefault: false,
        };
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
      if (cfg)
        return {
          config: normalizeConfig(cfg),
          configPath: fs.realpathSync(found),
          configRoot: canonicalPath(path.dirname(found)),
          isDefault: false,
        };
    }
  }
  return { config: DEFAULT_CONFIG, configPath: null, configRoot: canonicalPath(gitRoot || cwd), isDefault: true };
}

function normalizeConfig(cfg: QualityConfig): QualityConfig {
  if (cfg.version === 2) return cfg;
  const mergedChecks: Record<string, CheckCfg> = { ...DEFAULT_CONFIG.checks, ...cfg.checks };
  const checks: Record<string, CheckCfg> = { ...mergedChecks };
  for (const [alias, canonical] of Object.entries(ALIAS_MAP)) {
    if (mergedChecks[alias] && !cfg.checks[canonical]) checks[canonical] = mergedChecks[alias];
    if (mergedChecks[canonical] && !cfg.checks[alias]) checks[alias] = mergedChecks[canonical];
  }
  const packs = { ...DEFAULT_CONFIG.packs, ...(cfg.packs || {}) };
  for (const [pack, packCfg] of Object.entries(packs)) {
    if (packCfg.enabled === false) {
      for (const key of Object.keys(checks)) {
        if (key.startsWith(pack + ".")) {
          checks[key] = { ...checks[key], enabled: false };
        }
      }
      for (const [alias, canonical] of Object.entries(ALIAS_MAP)) {
        if (canonical.startsWith(pack + ".")) {
          if (checks[alias]) checks[alias] = { ...checks[alias], enabled: false };
          if (checks[canonical]) checks[canonical] = { ...checks[canonical], enabled: false };
        }
      }
      if (pack === "go") {
        for (const k of ["go", "golangci", "golangci-lint", "govet", "gotest", "go vet", "go test"]) {
          if (checks[k]) checks[k] = { ...checks[k], enabled: false };
        }
      }
    }
  }
  const stages: StagesCfg = {
    fast: {
      checks:
        cfg.stages?.fast?.checks && cfg.stages.fast.checks.length > 0 ? cfg.stages.fast.checks : DEFAULT_FAST_CHECKS,
    },
  };
  const gates: GateCfg = { ...DEFAULT_CONFIG.gates, ...(cfg.gates || {}) };
  const agentsmith: AgentSmithConfig = {
    ...DEFAULT_CONFIG.agentsmith!,
    ...(cfg.agentsmith || {}),
    models: { ...DEFAULT_CONFIG.agentsmith!.models, ...(cfg.agentsmith?.models || {}) },
    routing: { ...DEFAULT_CONFIG.agentsmith!.routing, ...(cfg.agentsmith?.routing || {}) },
    graph: { ...DEFAULT_CONFIG.agentsmith!.graph, ...(cfg.agentsmith?.graph || {}) },
    partitioned: { ...DEFAULT_CONFIG.agentsmith!.partitioned, ...(cfg.agentsmith?.partitioned || {}) },
    holistic: { ...DEFAULT_CONFIG.agentsmith!.holistic, ...(cfg.agentsmith?.holistic || {}) },
    hybrid: { ...DEFAULT_CONFIG.agentsmith!.hybrid, ...(cfg.agentsmith?.hybrid || {}) },
    evidence: { ...DEFAULT_CONFIG.agentsmith!.evidence, ...(cfg.agentsmith?.evidence || {}) },
    verification: { ...DEFAULT_CONFIG.agentsmith!.verification, ...(cfg.agentsmith?.verification || {}) },
    concurrency: cfg.review?.parallelism ?? cfg.agentsmith?.concurrency ?? DEFAULT_CONFIG.agentsmith!.concurrency,
    maxDurationMs:
      cfg.review?.maxDurationMs ?? cfg.agentsmith?.maxDurationMs ?? DEFAULT_CONFIG.agentsmith!.maxDurationMs,
  };
  return {
    ...cfg,
    checks,
    packs,
    policies: cfg.policies,
    version: cfg.version,
    plugins: cfg.plugins,
    stages,
    gates,
    agentsmith,
  };
}

export function getDefaultConfig(): QualityConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
