import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ENGINE_VERSION } from "./meta.js";
import { AGENTSMITH_STRATEGY_HASH } from "../agentsmith/strategy.js";
import type { AgentSmithProfile, GitHubPolicySource, PolicyCheck, ResolvedPolicy, WorkspaceLanguage } from "./types.js";

export const POLICY_LOCK_FILE = "matrixcore-policy.lock.json";
export const POLICY_BUNDLE_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_ASSETS = 128;
const SAFE_EXTENSIONS = new Set([".json", ".md", ".toml", ".yaml", ".yml", ".ini", ".cfg"]);

const assetSchema = z
  .object({
    path: z.string().min(1).max(500),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative().max(MAX_ASSET_BYTES),
    mediaType: z.enum(["application/json", "text/markdown", "text/plain", "application/toml", "application/yaml"]),
  })
  .strict();

const checkSchema = z
  .object({
    id: z.string().min(1),
    requiredVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    settings: z.record(z.unknown()).default({}),
  })
  .strict();

const modelProfileSchema = z
  .object({
    id: z.string().min(1),
    provider: z.literal("ollama"),
    model: z.string().min(1),
    contextTokens: z.number().int().min(1024).max(1_048_576),
    reviewCapability: z.enum(["small", "strong"]),
    requestedOutputTokens: z.number().int().min(128).max(131072),
    safetyReserveTokens: z.number().int().min(0).max(131072),
    tokenizer: z
      .object({
        kind: z.literal("conservative-ratio"),
        codeCharsPerToken: z.number().positive().max(8),
        proseCharsPerToken: z.number().positive().max(8),
      })
      .strict(),
    inference: z
      .object({
        temperature: z.number().min(0).max(2),
        thinking: z.boolean(),
        timeoutMs: z.number().int().min(1000).max(1_800_000),
      })
      .strict(),
  })
  .strict();

const agentSmithSchema = z
  .object({
    id: z.string().min(1),
    outputSchemaVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    provider: z.literal("ollama"),
    models: z.array(modelProfileSchema).min(1),
    defaultModels: z
      .object({
        candidate: z.string().min(1),
        scout: z.string().min(1).optional(),
        verifier: z.string().min(1).optional(),
      })
      .strict(),
    routing: z
      .object({
        inputContextFraction: z.number().min(0.3).max(0.9),
        enableHolistic: z.boolean(),
        enablePartitioned: z.boolean(),
        enableHybrid: z.boolean(),
      })
      .strict(),
    graph: z
      .object({
        defaultHops: z.literal(1),
        maxHops: z.union([z.literal(1), z.literal(2)]),
        maxInteractionNeighborsPerSymbol: z.number().int().min(1).max(64),
        enableHighRiskTwoHopExpansion: z.boolean(),
      })
      .strict(),
    partitioned: z
      .object({
        maxParallelUnits: z.number().int().min(1).max(256),
        maxRulesPerUnit: z.number().int().min(1).max(64),
        maxUnitsPerChangedSymbol: z.number().int().min(1).max(64),
        maxCandidateWorkItems: z.number().int().min(1).max(256).default(4),
        maxVerificationCandidates: z.number().int().min(1).max(256).default(4),
        maxCandidatesPerWorkItem: z.number().int().min(1).max(8).default(2),
        maxCandidateInputTokens: z.number().int().min(128).max(1_000_000).optional(),
        maxVerificationInputTokens: z.number().int().min(128).max(1_000_000).optional(),
        preferSemanticBoundaries: z.boolean(),
        hunkFallback: z.boolean(),
      })
      .strict(),
    holistic: z
      .object({ maxCandidates: z.number().int().min(1).max(256).default(60) })
      .strict()
      .default({ maxCandidates: 60 }),
    hybrid: z
      .object({
        maxHotspots: z.number().int().min(1).max(256).default(30),
        redundantDeepMode: z.boolean().default(false),
      })
      .strict()
      .default({ maxHotspots: 30, redundantDeepMode: false }),
    evidence: z
      .object({
        maxRequestsPerCandidate: z.number().int().min(0).max(64),
        maxParallelResolutions: z.number().int().min(1).max(128),
        maxSnippetLines: z.number().int().min(10).max(1000),
        maxRecordsPerRequest: z.number().int().min(1).max(32).default(3),
        maxRecordsPerCandidate: z.number().int().min(1).max(128).default(8),
      })
      .strict(),
    verification: z.object({ enabled: z.literal(true), publish: z.literal("verified-only") }).strict(),
    concurrency: z.number().int().min(1).max(16),
    maxDurationMs: z.number().int().min(1000).max(1_800_000).default(1_800_000),
    cache: z.boolean(),
    assetRoot: z.string().default("agentsmith"),
  })
  .strict();

export const githubPolicyManifestSchema = z
  .object({
    schemaVersion: z.literal(POLICY_BUNDLE_SCHEMA_VERSION),
    id: z.string().min(1),
    minEngineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    checks: z.array(checkSchema).min(1),
    agentSmith: agentSmithSchema,
    assets: z.array(assetSchema).max(MAX_ASSETS),
  })
  .strict()
  .superRefine((manifest, context) => {
    const checkIds = new Set<string>();
    manifest.checks.forEach((check, index) => {
      if (checkIds.has(check.id))
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "id"], message: "duplicate check id" });
      checkIds.add(check.id);
    });
    const assetPaths = new Set<string>();
    manifest.assets.forEach((asset, index) => {
      if (assetPaths.has(asset.path))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assets", index, "path"],
          message: "duplicate asset path",
        });
      assetPaths.add(asset.path);
    });
    const modelIds = new Set<string>();
    manifest.agentSmith.models.forEach((model, index) => {
      if (modelIds.has(model.id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agentSmith", "models", index, "id"],
          message: "duplicate model profile id",
        });
      modelIds.add(model.id);
      if (model.requestedOutputTokens + model.safetyReserveTokens >= model.contextTokens)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agentSmith", "models", index],
          message: "output and safety reserves must leave a positive input budget",
        });
    });
    for (const [role, modelId] of Object.entries(manifest.agentSmith.defaultModels))
      if (modelId && !modelIds.has(modelId))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agentSmith", "defaultModels", role],
          message: `unknown model profile: ${modelId}`,
        });
  });

export type GitHubPolicyManifest = z.infer<typeof githubPolicyManifestSchema>;

export interface GitHubPolicyLock {
  schemaVersion: 1;
  source: GitHubPolicySource;
  resolvedCommit: string;
  manifestHash: string;
  policyHash: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  summary: { policyId: string; checks: string[]; agentSmithProfile: string };
}

const KNOWN_CHECKS: Record<
  string,
  { language: WorkspaceLanguage | "sql"; tool: string; settings: z.ZodType<Record<string, unknown>> }
> = {
  "python.ruff": {
    language: "python",
    tool: "ruff",
    settings: z.object({ configAsset: z.string() }).strict(),
  },
  "python.ruff-format": {
    language: "python",
    tool: "ruff",
    settings: z.object({ configAsset: z.string() }).strict(),
  },
  "python.mypy": {
    language: "python",
    tool: "mypy",
    settings: z.object({ configAsset: z.string() }).strict(),
  },
  "python.xenon": {
    language: "python",
    tool: "xenon",
    settings: z
      .object({
        configAsset: z.string(),
        maxAbsolute: z.enum(["A", "B", "C", "D", "E", "F"]),
        maxModules: z.enum(["A", "B", "C", "D", "E", "F"]),
        maxAverage: z.enum(["A", "B", "C", "D", "E", "F"]),
        ignore: z.array(z.string()).default([]),
        exclude: z.array(z.string()).default([]),
      })
      .strict(),
  },
  "python.deptry": {
    language: "python",
    tool: "deptry",
    settings: z.object({ ignore: z.array(z.string().regex(/^DEP\d{3}$/)).default([]) }).strict(),
  },
  "typescript.tsc": {
    language: "typescript",
    tool: "tsc",
    settings: z.object({ configAsset: z.string() }).strict(),
  },
  "typescript.eslint": {
    language: "typescript",
    tool: "eslint",
    settings: z.object({ profile: z.literal("embedded-recommended"), maxWarnings: z.literal(0) }).strict(),
  },
  "sql.sqlfluff": {
    language: "sql",
    tool: "sqlfluff",
    settings: z.object({ configAsset: z.string() }).strict(),
  },
};

function sha(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function safeRelative(value: string): string {
  if (value.includes("\\")) throw new Error(`Policy asset path must use forward slashes: ${value}`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.startsWith("/") || normalized === ".")
    throw new Error(`Unsafe policy asset path: ${value}`);
  if (!SAFE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase()))
    throw new Error(`Executable or unsupported policy asset type: ${value}`);
  return normalized;
}

function validateAssetBytes(declaration: GitHubPolicyManifest["assets"][number], contents: Buffer) {
  const extension = path.posix.extname(declaration.path).toLowerCase();
  const expectedMedia =
    extension === ".json"
      ? ["application/json"]
      : extension === ".md"
        ? ["text/markdown", "text/plain"]
        : extension === ".toml"
          ? ["application/toml", "text/plain"]
          : extension === ".yaml" || extension === ".yml"
            ? ["application/yaml", "text/plain"]
            : ["text/plain"];
  if (!expectedMedia.includes(declaration.mediaType))
    throw new Error(`Policy asset media type ${declaration.mediaType} does not match ${declaration.path}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`Policy asset is not valid UTF-8: ${declaration.path}`);
  }
  if (extension === ".json")
    try {
      JSON.parse(text);
    } catch {
      throw new Error(`Policy JSON asset is invalid: ${declaration.path}`);
    }
}

function semverTuple(value: string): number[] {
  return value.split(".").map(Number);
}

function versionAtLeast(current: string, minimum: string): boolean {
  const left = semverTuple(current);
  const right = semverTuple(minimum);
  for (let index = 0; index < 3; index++) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function readLock(root: string): GitHubPolicyLock {
  const target = path.join(root, POLICY_LOCK_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new Error(`GitHub policy lock is missing or invalid. Run quality policy sync: ${target}`);
  }
  const lockSchema = z
    .object({
      schemaVersion: z.literal(1),
      source: z
        .object({
          source: z.literal("github"),
          repository: z.string(),
          ref: z.string(),
          manifest: z.string(),
        })
        .strict(),
      resolvedCommit: z.string().regex(/^[a-f0-9]{40}$/),
      manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
      policyHash: z.string().regex(/^[a-f0-9]{64}$/),
      files: z.array(
        z
          .object({
            path: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().nonnegative().max(MAX_ASSET_BYTES),
          })
          .strict(),
      ),
      summary: z.object({ policyId: z.string(), checks: z.array(z.string()), agentSmithProfile: z.string() }).strict(),
    })
    .strict();
  return lockSchema.parse(parsed) as GitHubPolicyLock;
}

function sameSource(left: GitHubPolicySource, right: GitHubPolicySource): boolean {
  return (
    left.source === right.source &&
    left.repository === right.repository &&
    left.ref === right.ref &&
    left.manifest === right.manifest
  );
}

export function policyCacheRoot(root: string): string {
  return path.join(root, ".quality", "policies");
}

function cacheDirectory(root: string, policyHash: string): string {
  return path.join(policyCacheRoot(root), policyHash);
}

function embeddedAsset(name: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../policy", name);
}

function safeDirectory(value: string): string {
  if (value.includes("\\")) throw new Error(`Policy directory must use forward slashes: ${value}`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../") || normalized.startsWith("/") || normalized === ".")
    throw new Error(`Unsafe policy directory: ${value}`);
  return normalized;
}

const REQUIRED_AGENT_ASSETS = [
  "agents/sub-agents/architecture-reviewer.md",
  "agents/sub-agents/perf-reviewer.md",
  "agents/sub-agents/bug-hunter.md",
  "agents/sub-agents/semantic-reviewer.md",
  "rules/registry.yaml",
] as const;

function validateAgentAssets(manifest: GitHubPolicyManifest, assets: Set<string>) {
  const root = safeDirectory(manifest.agentSmith.assetRoot);
  for (const relative of REQUIRED_AGENT_ASSETS) {
    const expected = `${root}/${relative}`;
    if (!assets.has(expected)) throw new Error(`GitHub policy is missing required AgentSmith asset: ${expected}`);
  }
}

function materializeCheck(
  entry: GitHubPolicyManifest["checks"][number],
  cache: string,
  assets: Set<string>,
): PolicyCheck {
  const known = KNOWN_CHECKS[entry.id];
  if (!known) throw new Error(`GitHub policy references unsupported check ${entry.id}; update MatrixCore`);
  const settings = known.settings.parse(entry.settings);
  const asset = (name: unknown) => {
    if (typeof name !== "string" || !assets.has(name))
      throw new Error(`${entry.id} references undeclared asset ${name}`);
    return path.join(cache, safeRelative(name));
  };
  let configAsset: string | undefined;
  let args: string[] = [];
  if ("configAsset" in settings) configAsset = asset(settings.configAsset);
  switch (entry.id) {
    case "python.ruff":
    case "python.ruff-format":
      args = ["--config", configAsset!];
      break;
    case "python.mypy":
      args = ["--config-file", configAsset!];
      break;
    case "python.xenon":
      args = [
        "--config-file",
        configAsset!,
        "--max-absolute",
        String(settings.maxAbsolute),
        "--max-modules",
        String(settings.maxModules),
        "--max-average",
        String(settings.maxAverage),
        ...(Array.isArray(settings.ignore) && settings.ignore.length ? ["--ignore", settings.ignore.join(",")] : []),
        ...(Array.isArray(settings.exclude) && settings.exclude.length
          ? ["--exclude", settings.exclude.join(",")]
          : []),
      ];
      break;
    case "python.deptry":
      args = [
        ...(Array.isArray(settings.ignore) && settings.ignore.length ? ["--ignore", settings.ignore.join(",")] : []),
        "--no-ansi",
        "--ignore-notebooks",
      ];
      break;
    case "typescript.tsc":
      args = [];
      break;
    case "typescript.eslint": {
      configAsset = embeddedAsset("typescript-eslint.mjs");
      args = ["--config", configAsset, "--max-warnings", "0"];
      break;
    }
    case "sql.sqlfluff":
      args = ["--ignore-local-config", "--config", configAsset!];
      break;
  }
  return {
    id: entry.id,
    language: known.language,
    tool: known.tool,
    requiredVersion: entry.requiredVersion,
    configAsset,
    configHash: configAsset ? sha(fs.readFileSync(configAsset)) : undefined,
    args,
    settings,
  };
}

function parseCached(root: string, source: GitHubPolicySource, lock: GitHubPolicyLock): ResolvedPolicy {
  if (!sameSource(source, lock.source))
    throw new Error(`GitHub policy source differs from ${POLICY_LOCK_FILE}; run quality policy sync`);
  const cache = cacheDirectory(root, lock.policyHash);
  const manifestPath = path.join(cache, "policy.json");
  if (!fs.existsSync(manifestPath))
    throw new Error(`Locked GitHub policy is not cached. Run quality policy sync --locked`);
  const raw = fs.readFileSync(manifestPath);
  if (sha(raw) !== lock.manifestHash)
    throw new Error(`Cached GitHub policy manifest hash mismatch; restore it with quality policy sync --locked`);
  const manifest = githubPolicyManifestSchema.parse(JSON.parse(raw.toString("utf8")));
  const assets = new Set<string>();
  const contentHashes: string[] = [];
  for (const declared of manifest.assets) {
    const relative = safeRelative(declared.path);
    const contents = fs.readFileSync(path.join(cache, relative));
    if (contents.length !== declared.size || sha(contents) !== declared.sha256)
      throw new Error(`Cached GitHub policy asset hash mismatch: ${relative}`);
    validateAssetBytes(declared, contents);
    assets.add(relative);
    contentHashes.push(`${relative}:${declared.sha256}`);
  }
  validateAgentAssets(manifest, assets);
  const calculated = sha(`${canonical(manifest)}\n${contentHashes.sort().join("\n")}`);
  if (calculated !== lock.policyHash) throw new Error(`Cached GitHub policy content does not match the lock`);
  if (!versionAtLeast(ENGINE_VERSION, manifest.minEngineVersion))
    throw new Error(
      `GitHub policy requires MatrixCore ${manifest.minEngineVersion} or newer; installed ${ENGINE_VERSION}`,
    );
  const lockedFiles = [...lock.files].sort((left, right) => left.path.localeCompare(right.path));
  const manifestFiles = manifest.assets
    .map((asset) => ({ path: asset.path, sha256: asset.sha256, size: asset.size }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (canonical(lockedFiles) !== canonical(manifestFiles))
    throw new Error(`GitHub policy lock asset inventory mismatch`);
  if (
    lock.summary.policyId !== manifest.id ||
    lock.summary.agentSmithProfile !== manifest.agentSmith.id ||
    canonical(lock.summary.checks) !== canonical(manifest.checks.map((check) => `${check.id}@${check.requiredVersion}`))
  )
    throw new Error(`GitHub policy lock summary mismatch`);
  const checks = manifest.checks.map((entry) => materializeCheck(entry, cache, assets));
  const agentRoot = path.join(cache, safeDirectory(manifest.agentSmith.assetRoot));
  const agentContentHashes = contentHashes.filter((entry) => entry.startsWith(`${manifest.agentSmith.assetRoot}/`));
  const agentSmith: AgentSmithProfile = {
    ...manifest.agentSmith,
    assetRoot: agentRoot,
    hash: sha(
      `${canonical(manifest.agentSmith)}\n${agentContentHashes.join("\n")}\nstrategy:${AGENTSMITH_STRATEGY_HASH}`,
    ),
  };
  return {
    schemaVersion: 1,
    provider: "github",
    profileId: manifest.id,
    policyHash: sha(`${calculated}\nstrategy:${AGENTSMITH_STRATEGY_HASH}`),
    checks,
    agentSmith,
    provenance: {
      source: "github",
      repository: source.repository,
      configuredRef: source.ref,
      resolvedCommit: lock.resolvedCommit,
      manifest: source.manifest,
      manifestHash: lock.manifestHash,
    },
  };
}

export function resolveCachedGitHubPolicy(root: string, source: GitHubPolicySource): ResolvedPolicy {
  return parseCached(root, source, readLock(root));
}

async function fetchBytes(url: string, limit: number, fetchImpl: typeof fetch): Promise<Buffer> {
  const parsed = new URL(url);
  if (!["api.github.com", "raw.githubusercontent.com"].includes(parsed.hostname) || parsed.protocol !== "https:")
    throw new Error(`Refusing non-GitHub policy URL: ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/vnd.github+json", "user-agent": `matrixcore/${ENGINE_VERSION}` },
    });
    if (!response.ok) throw new Error(`GitHub policy fetch failed: HTTP ${response.status} ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error(`GitHub policy response exceeds ${limit} bytes: ${url}`);
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCommit(source: GitHubPolicySource, fetchImpl: typeof fetch): Promise<string> {
  const body = await fetchBytes(
    `https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref)}`,
    MAX_MANIFEST_BYTES,
    fetchImpl,
  );
  const shaValue = (JSON.parse(body.toString("utf8")) as { sha?: string }).sha;
  if (!shaValue || !/^[a-f0-9]{40}$/.test(shaValue))
    throw new Error(`GitHub returned an invalid commit for ${source.repository}@${source.ref}`);
  return shaValue;
}

function rawUrl(source: GitHubPolicySource, commit: string, relative: string): string {
  const safe = safeRelative(relative);
  return `https://raw.githubusercontent.com/${source.repository}/${commit}/${safe.split("/").map(encodeURIComponent).join("/")}`;
}

function writeAtomic(target: string, contents: string | Buffer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, target);
}

export async function syncGitHubPolicy(opts: {
  root: string;
  source: GitHubPolicySource;
  locked?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ lock: GitHubPolicyLock; cacheHit: boolean; changes: string[]; policy: ResolvedPolicy }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const prior = (() => {
    try {
      return readLock(opts.root);
    } catch {
      return null;
    }
  })();
  if (opts.locked && !prior) throw new Error(`Cannot restore GitHub policy: ${POLICY_LOCK_FILE} is missing`);
  if (opts.locked && prior && !sameSource(opts.source, prior.source))
    throw new Error(`Configured GitHub policy source differs from ${POLICY_LOCK_FILE}`);
  const commit = opts.locked ? prior!.resolvedCommit : await resolveCommit(opts.source, fetchImpl);
  if (opts.locked && prior && fs.existsSync(cacheDirectory(opts.root, prior.policyHash))) {
    try {
      return { lock: prior, cacheHit: true, changes: [], policy: parseCached(opts.root, opts.source, prior) };
    } catch {
      fs.rmSync(cacheDirectory(opts.root, prior.policyHash), { recursive: true, force: true });
    }
  }
  const manifestBytes = await fetchBytes(
    rawUrl(opts.source, commit, opts.source.manifest),
    MAX_MANIFEST_BYTES,
    fetchImpl,
  );
  const manifestHash = sha(manifestBytes);
  if (opts.locked && manifestHash !== prior!.manifestHash)
    throw new Error(`Locked GitHub policy manifest hash mismatch`);
  const manifest = githubPolicyManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (!versionAtLeast(ENGINE_VERSION, manifest.minEngineVersion))
    throw new Error(
      `GitHub policy requires MatrixCore ${manifest.minEngineVersion} or newer; installed ${ENGINE_VERSION}`,
    );
  const seen = new Set<string>();
  let total = manifestBytes.length;
  const downloaded: Array<{ declaration: GitHubPolicyManifest["assets"][number]; contents: Buffer }> = [];
  for (const declaration of manifest.assets) {
    const relative = safeRelative(declaration.path);
    if (seen.has(relative)) throw new Error(`Duplicate GitHub policy asset: ${relative}`);
    seen.add(relative);
    const contents = await fetchBytes(rawUrl(opts.source, commit, relative), MAX_ASSET_BYTES, fetchImpl);
    total += contents.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error(`GitHub policy bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    if (contents.length !== declaration.size || sha(contents) !== declaration.sha256)
      throw new Error(`GitHub policy asset digest mismatch: ${relative}`);
    validateAssetBytes(declaration, contents);
    downloaded.push({ declaration, contents });
  }
  validateAgentAssets(manifest, seen);
  const policyHash = sha(
    `${canonical(manifest)}\n${manifest.assets
      .map((asset) => `${asset.path}:${asset.sha256}`)
      .sort()
      .join("\n")}`,
  );
  if (opts.locked && policyHash !== prior!.policyHash) throw new Error(`Locked GitHub policy content hash mismatch`);
  const target = cacheDirectory(opts.root, policyHash);
  const temporary = path.join(policyCacheRoot(opts.root), `.tmp-${crypto.randomUUID()}`);
  fs.mkdirSync(temporary, { recursive: true });
  try {
    fs.writeFileSync(path.join(temporary, "policy.json"), manifestBytes);
    for (const item of downloaded) {
      const destination = path.join(temporary, item.declaration.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, item.contents, { mode: 0o600 });
    }
    if (!fs.existsSync(target))
      try {
        fs.renameSync(temporary, target);
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
  const lock: GitHubPolicyLock = {
    schemaVersion: 1,
    source: opts.source,
    resolvedCommit: commit,
    manifestHash,
    policyHash,
    files: manifest.assets.map((asset) => ({ path: asset.path, sha256: asset.sha256, size: asset.size })),
    summary: {
      policyId: manifest.id,
      checks: manifest.checks.map((check) => `${check.id}@${check.requiredVersion}`),
      agentSmithProfile: manifest.agentSmith.id,
    },
  };
  const policy = parseCached(opts.root, opts.source, lock);
  if (!opts.locked) writeAtomic(path.join(opts.root, POLICY_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  const changes = prior
    ? [
        ...lock.summary.checks.filter((check) => !prior.summary.checks.includes(check)).map((check) => `+ ${check}`),
        ...prior.summary.checks.filter((check) => !lock.summary.checks.includes(check)).map((check) => `- ${check}`),
        ...(prior.summary.agentSmithProfile === lock.summary.agentSmithProfile
          ? []
          : [`AgentSmith: ${prior.summary.agentSmithProfile} -> ${lock.summary.agentSmithProfile}`]),
        ...lock.files
          .filter((file) => !prior.files.some((old) => old.path === file.path && old.sha256 === file.sha256))
          .map((file) => `${prior.files.some((old) => old.path === file.path) ? "~" : "+"} asset ${file.path}`),
        ...prior.files
          .filter((file) => !lock.files.some((current) => current.path === file.path))
          .map((file) => `- asset ${file.path}`),
      ]
    : lock.summary.checks.map((check) => `+ ${check}`);
  return { lock, cacheHit: false, changes, policy };
}

export function githubPolicyStatus(root: string, source: GitHubPolicySource) {
  try {
    const lock = readLock(root);
    const sourceMatches = sameSource(source, lock.source);
    const cached = fs.existsSync(cacheDirectory(root, lock.policyHash));
    let valid = false;
    let error: string | undefined;
    try {
      if (sourceMatches && cached) {
        parseCached(root, source, lock);
        valid = true;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return { configured: true, source, lock, sourceMatches, cached, valid, error, networkUsed: false };
  } catch (caught) {
    return {
      configured: true,
      source,
      lock: null,
      sourceMatches: false,
      cached: false,
      valid: false,
      error: caught instanceof Error ? caught.message : String(caught),
      networkUsed: false,
    };
  }
}
