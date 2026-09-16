import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { QualityConfig, ResolvedConfig } from "./types.js";
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
                templater_options: z.record(z.string(), z.string()).optional(),
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

const CANDIDATE_NAMES = [
  "quality.yaml",
  ".quality.yaml",
  "quality.yml",
  ".quality.yml",
  "quality.json",
  ".quality.json",
];

function runtimeConfig(manifest?: z.infer<typeof ProjectManifestSchema>): QualityConfig {
  const reviewEnabled = manifest?.review?.agentsmith ?? false;
  return {
    version: 2,
    project: manifest?.project,
    application: manifest?.application,
    review: {
      agentsmith: reviewEnabled,
      mode: manifest?.review?.mode,
      models: manifest?.review?.models,
      parallelism: manifest?.review?.parallelism,
      maxDurationMs: manifest?.review?.maxDurationMs,
    },
    policySource: manifest?.policy,
    checks: {},
    policies: {},
    agentsmith: agentSmithConfigFromPolicy(reviewEnabled),
  };
}

function parseFile(filePath: string): QualityConfig {
  const raw = fs.readFileSync(filePath, "utf8");
  const obj: unknown = filePath.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
  if ((obj as { version?: unknown } | null)?.version === 1)
    throw new Error(
      `MatrixCore manifest v1 is no longer supported: ${filePath}. Migrate to: version: 2, project: <name>, review: { agentsmith: <boolean> }`,
    );
  const parsed = ProjectManifestSchema.safeParse(obj);
  if (!parsed.success)
    throw new Error(
      `Invalid MatrixCore v2 manifest ${filePath}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`,
    );
  return runtimeConfig(parsed.data);
}

function findInDir(dir: string): string | null {
  for (const name of CANDIDATE_NAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function findGitRoot(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function configured(file: string): ResolvedConfig {
  return {
    config: parseFile(file),
    configPath: fs.realpathSync(file),
    configRoot: canonicalPath(path.dirname(file)),
    isDefault: false,
  };
}

export function resolveConfig(opts: { configFlag?: string; cwd?: string; root?: string }): ResolvedConfig {
  const cwd = path.resolve(opts.cwd || opts.root || process.cwd());
  if (opts.configFlag) {
    const absolute = path.isAbsolute(opts.configFlag) ? opts.configFlag : path.resolve(cwd, opts.configFlag);
    if (fs.existsSync(absolute)) return configured(absolute);
    throw new Error(`Config flag file not found or invalid: ${absolute}`);
  }

  let current = cwd;
  while (true) {
    const found = findInDir(current);
    if (found) return configured(found);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const found = findInDir(gitRoot);
    if (found) return configured(found);
  }
  return {
    config: runtimeConfig(),
    configPath: null,
    configRoot: canonicalPath(gitRoot || cwd),
    isDefault: true,
  };
}
