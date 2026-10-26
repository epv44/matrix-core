import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSmithConfig, PolicyCheck, ResolvedConfig, ResolvedPolicy } from "./types.js";
import { loadSpecialists } from "../agentsmith/registry.js";
import { loadStructuredRules } from "../agentsmith/rules.js";
import { resolveCachedGitHubPolicy } from "./github-policy.js";
import { AGENTSMITH_STRATEGY_HASH, AGENTSMITH_STRATEGY_VERSION } from "../agentsmith/strategy.js";
import { sha256 } from "./hash.js";

export interface PolicyProvider {
  resolve(): ResolvedPolicy;
}

function sha(value: string | Buffer) {
  return sha256(value);
}

function asset(name: string) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../policy", name);
  if (!fs.existsSync(candidate)) throw new Error(`MatrixCore policy asset missing: ${candidate}`);
  return candidate;
}

export class EmbeddedPolicyProvider implements PolicyProvider {
  resolve(): ResolvedPolicy {
    const ruff = asset("python-ruff.toml");
    const mypy = asset("python-mypy.ini");
    const xenon = asset("python-xenon.yml");
    const eslint = asset("typescript-eslint.mjs");
    const typescript = asset("typescript-quality.json");
    const sqlfluff = asset("sqlfluff.cfg");
    const sqlExtractor = asset("python-sql-extract.py.txt");
    const checks: PolicyCheck[] = [
      {
        id: "python.ruff",
        language: "python",
        tool: "ruff",
        requiredVersion: "0.16.1",
        configAsset: ruff,
        configHash: sha(fs.readFileSync(ruff)),
        args: ["--config", ruff],
      },
      {
        id: "python.ruff-format",
        language: "python",
        tool: "ruff",
        requiredVersion: "0.16.1",
        configAsset: ruff,
        configHash: sha(fs.readFileSync(ruff)),
        args: ["--config", ruff],
      },
      {
        id: "python.mypy",
        language: "python",
        tool: "mypy",
        requiredVersion: "2.3.0",
        configAsset: mypy,
        configHash: sha(fs.readFileSync(mypy)),
        args: ["--config-file", mypy],
      },
      {
        id: "python.xenon",
        language: "python",
        tool: "xenon",
        requiredVersion: "0.9.3",
        configAsset: xenon,
        configHash: sha(fs.readFileSync(xenon)),
        args: [
          "--config-file",
          xenon,
          "--max-absolute",
          "B",
          "--max-modules",
          "B",
          "--max-average",
          "A",
          "--ignore",
          "tests,test,.venv,venv,__pycache__",
          "--exclude",
          "test_*.py,*_test.py",
        ],
      },
      {
        id: "python.deptry",
        language: "python",
        tool: "deptry",
        requiredVersion: "0.25.1",
        args: ["--ignore", "DEP001,DEP002,DEP003,DEP005", "--no-ansi", "--ignore-notebooks"],
      },
      {
        id: "typescript.tsc",
        language: "typescript",
        tool: "tsc",
        requiredVersion: "5.9.3",
        configAsset: typescript,
        configHash: sha(fs.readFileSync(typescript)),
        args: [],
      },
      {
        id: "typescript.eslint",
        language: "typescript",
        tool: "eslint",
        requiredVersion: "9.39.5",
        configAsset: eslint,
        configHash: sha(fs.readFileSync(eslint)),
        args: ["--config", eslint, "--max-warnings", "0"],
      },
      {
        id: "sql.sqlfluff",
        language: "sql",
        tool: "sqlfluff",
        requiredVersion: "4.2.2",
        configAsset: sqlfluff,
        configHash: sha(Buffer.concat([fs.readFileSync(sqlfluff), fs.readFileSync(sqlExtractor)])),
        args: ["--ignore-local-config", "--config", sqlfluff],
      },
    ];
    const agentAssets = {
      specialists: loadSpecialists(),
      structuredRules: loadStructuredRules(),
    };
    const agent = {
      id: "agentsmith.unified.v4",
      outputSchemaVersion: AGENTSMITH_STRATEGY_VERSION,
      provider: "ollama",
      models: [
        {
          id: "qwen35-9b-local",
          provider: "ollama" as const,
          model: "qwen3.5:9b-q4_K_M",
          contextTokens: 8192,
          reviewCapability: "small" as const,
          requestedOutputTokens: 4096,
          safetyReserveTokens: 1000,
          tokenizer: { kind: "conservative-ratio" as const, codeCharsPerToken: 2, proseCharsPerToken: 3 },
          inference: { temperature: 0, thinking: false, timeoutMs: 300000 },
        },
        {
          id: "qwen35-9b-verifier-local",
          provider: "ollama" as const,
          model: "qwen3.5:9b-q4_K_M",
          contextTokens: 8192,
          reviewCapability: "small" as const,
          requestedOutputTokens: 512,
          safetyReserveTokens: 1000,
          tokenizer: { kind: "conservative-ratio" as const, codeCharsPerToken: 2, proseCharsPerToken: 3 },
          inference: { temperature: 0, thinking: false, timeoutMs: 300000 },
        },
        {
          id: "qwen35-122b-local",
          provider: "ollama" as const,
          model: "qwen3.5:122b-a10b",
          contextTokens: 131072,
          reviewCapability: "strong" as const,
          requestedOutputTokens: 4096,
          safetyReserveTokens: 4096,
          tokenizer: { kind: "conservative-ratio" as const, codeCharsPerToken: 2, proseCharsPerToken: 3 },
          inference: { temperature: 0, thinking: false, timeoutMs: 600000 },
        },
        {
          id: "qwen35-122b-scout-local",
          provider: "ollama" as const,
          model: "qwen3.5:122b-a10b",
          contextTokens: 131072,
          reviewCapability: "strong" as const,
          requestedOutputTokens: 1024,
          safetyReserveTokens: 4096,
          tokenizer: { kind: "conservative-ratio" as const, codeCharsPerToken: 2, proseCharsPerToken: 3 },
          inference: { temperature: 0, thinking: false, timeoutMs: 180000 },
        },
      ],
      defaultModels: { candidate: "qwen35-9b-local", verifier: "qwen35-9b-verifier-local" },
      routing: { inputContextFraction: 0.7, enableHolistic: true, enablePartitioned: true, enableHybrid: true },
      graph: {
        defaultHops: 1 as const,
        maxHops: 2 as const,
        maxInteractionNeighborsPerSymbol: 8,
        enableHighRiskTwoHopExpansion: true,
      },
      partitioned: {
        maxParallelUnits: 20,
        maxRulesPerUnit: 4,
        maxUnitsPerChangedSymbol: 6,
        maxCandidateWorkItems: 4,
        maxVerificationCandidates: 4,
        maxCandidatesPerWorkItem: 2,
        preferSemanticBoundaries: true,
        hunkFallback: true,
      },
      holistic: { maxCandidates: 60 },
      hybrid: { maxHotspots: 30, redundantDeepMode: false },
      evidence: {
        maxRequestsPerCandidate: 8,
        maxParallelResolutions: 20,
        maxSnippetLines: 160,
        maxRecordsPerRequest: 3,
        maxRecordsPerCandidate: 8,
      },
      verification: { enabled: true, publish: "verified-only" as const },
      concurrency: 1,
      maxDurationMs: 1_800_000,
      cache: true,
    };
    const agentSmith = {
      ...agent,
      hash: sha(JSON.stringify({ agent, agentAssets, strategyHash: AGENTSMITH_STRATEGY_HASH })),
    };
    const body = {
      schemaVersion: 1 as const,
      provider: "embedded",
      profileId: "matrixcore.default.v2",
      checks,
      agentSmith,
    };
    const portable = {
      ...body,
      checks: checks.map((check) => ({
        ...check,
        configAsset: check.configAsset ? path.basename(check.configAsset) : undefined,
        args: check.args.map((arg) => (check.configAsset && arg === check.configAsset ? path.basename(arg) : arg)),
      })),
    };
    return { ...body, policyHash: sha(JSON.stringify(portable)), provenance: { source: "embedded" as const } };
  }
}

export class GitHubPolicyProvider implements PolicyProvider {
  constructor(
    private readonly root: string,
    private readonly source: NonNullable<ResolvedConfig["config"]["policySource"]>,
  ) {}

  resolve(): ResolvedPolicy {
    return resolveCachedGitHubPolicy(this.root, this.source);
  }
}

export function resolvePolicy(provider: PolicyProvider = new EmbeddedPolicyProvider()) {
  return provider.resolve();
}

export function resolvePolicyForConfig(resolved: ResolvedConfig): ResolvedPolicy {
  const source = resolved.config.policySource;
  const policy = source ? resolvePolicy(new GitHubPolicyProvider(resolved.configRoot, source)) : resolvePolicy();
  const reviewEnabled = resolved.config.review?.agentsmith ?? false;
  const runtime = agentSmithConfigFromPolicy(reviewEnabled, policy);
  runtime.mode = resolved.config.review?.mode ?? "auto";
  runtime.models = { ...runtime.models, ...(resolved.config.review?.models ?? {}) };
  if (resolved.config.review?.parallelism !== undefined) runtime.concurrency = resolved.config.review.parallelism;
  if (resolved.config.review?.maxDurationMs !== undefined) runtime.maxDurationMs = resolved.config.review.maxDurationMs;
  const profiles = new Map(runtime.model_profiles.map((profile) => [profile.id, profile]));
  for (const [role, id] of Object.entries(runtime.models))
    if (id && !profiles.has(id))
      throw new Error(`Review ${role} model profile is not approved by the locked policy: ${id}`);
  const scout = runtime.models.scout ? profiles.get(runtime.models.scout) : undefined;
  if (scout && scout.reviewCapability !== "strong")
    throw new Error(`Review scout profile must have strong capability: ${scout.id}`);
  resolved.config.agentsmith = runtime;
  resolved.policy = policy;
  return policy;
}

export function agentSmithConfigFromPolicy(enabled: boolean, policy = resolvePolicy()): AgentSmithConfig {
  const profile = policy.agentSmith;
  const configuredProvider = process.env.MATRIXCORE_AGENTSMITH_PROVIDER;
  if (configuredProvider !== undefined && configuredProvider !== "ollama" && configuredProvider !== "vllm")
    throw new Error(`Unsupported AgentSmith provider: ${configuredProvider}`);
  const policyProvider = profile.provider;
  if (policyProvider !== "ollama" && policyProvider !== "vllm")
    throw new Error(`Unsupported AgentSmith policy provider: ${policyProvider}`);
  const provider = configuredProvider ?? policyProvider;
  const modelProfiles = profile.models.map((modelProfile) =>
    provider === "vllm" ? { ...modelProfile, provider: "vllm" as const } : modelProfile,
  );
  return {
    enabled,
    advisory: true,
    provider,
    base_url:
      provider === "vllm"
        ? process.env.MATRIXCORE_VLLM_URL ?? "http://127.0.0.1:8000/v1"
        : process.env.MATRIXCORE_OLLAMA_URL ?? "http://127.0.0.1:11434",
    mode: "auto",
    model_profiles: modelProfiles,
    models: profile.defaultModels,
    routing: profile.routing,
    graph: profile.graph,
    partitioned: profile.partitioned,
    holistic: profile.holistic,
    hybrid: profile.hybrid,
    evidence: profile.evidence,
    verification: profile.verification,
    concurrency: profile.concurrency,
    maxDurationMs: profile.maxDurationMs,
    cache: profile.cache,
  };
}
