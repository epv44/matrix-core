import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { z } from "zod";
import type { AgentSmithTrace } from "../../../src/agentsmith/trace.js";
import type { CandidateFinding } from "../../../src/core/types.js";
import { listAgentSmithTraces, readAgentSmithTrace, readTraceSourceManifest } from "../../../src/agentsmith/trace.js";
import {
  captureSourceSnapshot,
  materializeSourceManifest,
  sourceManifestHash,
  type SourceSnapshotManifest,
} from "../../../src/agentsmith/source-snapshot.js";
import { computeWorkspaceVersion } from "../../../src/core/version.js";
import { sha256 } from "../../../src/core/hash.js";

export const EVAL_CASE_SCHEMA_VERSION = 7;
export const STAGE_REPLAY_SCHEMA_VERSION = 1;
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const discoveryClassSchema = z.enum(["L0", "L1", "L2", "L3"]);
const categorySchema = z.enum(["correctness", "security", "performance", "contract"]);
const severitySchema = z.enum(["critical", "high", "medium", "low"]);
const verdictSchema = z.enum(["verified", "likely", "rejected", "insufficient_evidence"]);
const suiteSchema = z.enum(["component", "conformance", "draft"]);
const evidenceKindSchema = z.enum([
  "definition",
  "callers",
  "callees",
  "type",
  "implementation",
  "usage",
  "config",
  "test",
  "schema",
  "search",
]);

const goldenCandidateSchema = z.object({
  id: z.string().min(1),
  sourceWorkItemIds: z.array(z.string()).default([]),
  sourceReviewers: z
    .array(z.enum(["architecture-reviewer", "perf-reviewer", "bug-hunter", "semantic-reviewer"]))
    .default([]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  severity: severitySchema,
  category: categorySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().optional(),
  primarySymbol: z.string().optional(),
  ruleId: z.string().optional(),
  evidenceRequests: z.array(
    z.object({
      kind: evidenceKindSchema,
      locatorMode: z.enum(["symbol", "literal"]).optional(),
      symbol: z.string().optional(),
      pathHint: z.string().optional(),
      query: z.string().optional(),
      reason: z.string().min(1),
    }),
  ),
  candidateConfidence: z.number().min(0).max(1),
});

const stageReplayArtifactSchema = z.object({
  schemaVersion: z.literal(STAGE_REPLAY_SCHEMA_VERSION),
  caseId: z.string().min(1),
  fixtureDigest: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed: z.literal(true),
  contractEvidence: z.array(z.object({ path: z.string().min(1), content: z.string().min(1) })).default([]),
  goldenCandidates: z.array(goldenCandidateSchema).min(1),
});

export interface StageReplayArtifact {
  schemaVersion: 1;
  caseId: string;
  fixtureDigest: string;
  reviewed: true;
  contractEvidence: Array<{ path: string; content: string }>;
  goldenCandidates: CandidateFinding[];
}

export const minimumEvidenceSchema = z
  .object({
    file: z.string().min(1),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    symbol: z.string().trim().min(1).optional(),
    contains: z.array(z.string().trim().min(1)).min(1),
  })
  .refine(
    (value) => value.lineStart === undefined || value.lineEnd === undefined || value.lineEnd >= value.lineStart,
    { path: ["lineEnd"], message: "lineEnd must be >= lineStart" },
  );

export const expectedFindingSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  severity: severitySchema.optional(),
  category: categorySchema.optional(),
  titleContains: z.string().optional(),
  discoveryClass: discoveryClassSchema,
  requiredEvidence: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  graphDistance: z.number().int().min(0).max(3).optional(),
  description: z.string().default(""),
  rationale: z.string().min(1),
  smallModelExpected: z.boolean().optional(),
  minimumEvidence: z.array(minimumEvidenceSchema).optional(),
});

const expectedCandidateSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  category: categorySchema.optional(),
  severity: severitySchema.optional(),
  titleContains: z.string().optional(),
  expectedPresence: z.boolean().default(true),
  expectedVerdict: verdictSchema,
  requiredEvidenceKinds: z.array(evidenceKindSchema).default([]),
  requiredReasoningTerms: z.array(z.string().min(1)).default([]),
  forbiddenReasoningTerms: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
});

const targetSchema = z.object({
  files: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  edges: z.array(z.string()).default([]),
  forbiddenFiles: z.array(z.string()).default([]),
  forbiddenSymbols: z.array(z.string()).default([]),
  forbiddenEdges: z.array(z.string()).default([]),
  paths: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        maxHops: z.number().int().positive().max(6),
        edgeKinds: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
});

const optionalTargetSchema = z.object({
  files: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  edges: z.array(z.string()).default([]),
});

const snippetExpectationSchema = z.object({
  file: z.string().min(1),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  contains: z.array(z.string().min(1)).default([]),
});

const evidenceExpectationSchema = z.object({
  candidate: z.string().min(1),
  kind: evidenceKindSchema,
  status: z.enum(["satisfied", "partial", "unresolved", "skipped"]),
  expectedFiles: z.array(z.string()).default([]),
  forbiddenFiles: z.array(z.string()).default([]),
  expectedSymbols: z.array(z.string()).default([]),
  requiredContent: z.array(z.string()).default([]),
  forbiddenContent: z.array(z.string()).default([]),
});

const sensitivePatternIdSchema = z.enum(["aws-access-key", "private-key", "credential-assignment"]);
const sensitiveContentExemptionSchema = z.object({
  path: z.string().min(1),
  patternId: sensitivePatternIdSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rationale: z.string().min(1),
});

export const evalCaseSchema = z
  .object({
    schemaVersion: z.union([z.literal(5), z.literal(6), z.literal(EVAL_CASE_SCHEMA_VERSION)]),
    id: z.string().min(1),
    status: z.enum(["draft", "active"]),
    kind: z.enum(["benchmark", "conformance"]).default("benchmark"),
    suite: suiteSchema.default("component"),
    source: z.object({
      traceId: z.string().min(1),
      traceSchemaVersion: z.number().int().min(2).max(5),
      repositoryFingerprint: z.string().nullable().default(null),
      fixture: z
        .object({
          path: z.string().min(1),
          manifestPath: z.string().min(1),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .nullable()
        .default(null),
      project: z.string().default(""),
    }),
    sanitization: z.object({
      reviewed: z.boolean(),
      absolutePathsRemoved: z.boolean(),
      sensitiveContentReviewed: z.boolean(),
      redistributable: z.boolean(),
      sensitiveContentExemptions: z.array(sensitiveContentExemptionSchema).default([]),
    }),
    groundTruth: z
      .object({
        reviewed: z.boolean(),
        reviewedBy: z.string().min(1),
        reviewedAt: z.string().datetime(),
        contractFamily: z.string().min(1),
        exhaustiveCandidates: z.boolean(),
      })
      .optional(),
    stageReplay: z
      .object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        reviewed: z.literal(true),
      })
      .optional(),
    expectations: z
      .object({
        snapshot: z
          .object({
            files: z.array(z.object({ path: z.string(), changeKind: z.string().optional() })).default([]),
          })
          .optional(),
        graph: targetSchema.optional(),
        projection: z
          .object({
            requiredSnippets: z.array(snippetExpectationSchema).default([]),
            forbiddenFiles: z.array(z.string()).default([]),
            forbiddenContent: z.array(z.string()).default([]),
          })
          .optional(),
        planning: targetSchema
          .extend({
            route: z.enum(["holistic", "partitioned", "hybrid"]).optional(),
            optionalTargets: optionalTargetSchema.default({ files: [], symbols: [], edges: [] }),
          })
          .optional(),
        candidates: z.object({ items: z.array(expectedCandidateSchema).default([]) }).optional(),
        evidence: z.object({ requests: z.array(evidenceExpectationSchema).default([]) }).optional(),
        verification: z.object({ candidates: z.array(expectedCandidateSchema).default([]) }).optional(),
        aggregation: z
          .object({
            status: z.enum(["completed", "partial", "error"]).optional(),
            outcome: z.enum(["clear", "findings", "incomplete"]).optional(),
            findings: z.array(expectedFindingSchema).default([]),
          })
          .optional(),
        reporting: z.object({ requiredSections: z.array(z.string()).default([]) }).optional(),
      })
      .default({}),
    narrative: z
      .object({
        summary: z.string().default(""),
        trueCodeFlow: z.string().default(""),
        references: z.array(z.string()).default([]),
      })
      .default({}),
    tags: z.array(z.string()).default([]),
  })
  .superRefine((value, context) => {
    const ranges = [
      ...(value.expectations.aggregation?.findings ?? []),
      ...(value.expectations.candidates?.items ?? []),
      ...(value.expectations.verification?.candidates ?? []),
    ];
    ranges.forEach((item, index) => {
      if (item.lineEnd < item.lineStart)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectations", index, "lineEnd"],
          message: "lineEnd must be >= lineStart",
        });
    });
    value.expectations.projection?.requiredSnippets.forEach((item, index) => {
      if (item.lineStart && item.lineEnd && item.lineEnd < item.lineStart)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectations", "projection", "requiredSnippets", index, "lineEnd"],
          message: "lineEnd must be >= lineStart",
        });
    });
    const normalizedCasePath = (candidate: string) => {
      const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "");
      return (
        candidate.length > 0 &&
        normalized === candidate &&
        !path.isAbsolute(candidate) &&
        !normalized.split("/").includes("..") &&
        !normalized.split("/").includes("")
      );
    };
    value.expectations.aggregation?.findings.forEach((finding, findingIndex) => {
      if (value.schemaVersion === 7 && value.status === "active" && value.kind === "benchmark") {
        if (finding.smallModelExpected === undefined)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["expectations", "aggregation", "findings", findingIndex, "smallModelExpected"],
            message: "active schema-v7 benchmark findings require smallModelExpected",
          });
        if (!finding.minimumEvidence?.length)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["expectations", "aggregation", "findings", findingIndex, "minimumEvidence"],
            message: "active schema-v7 benchmark findings require minimum evidence",
          });
      }
      if (value.schemaVersion !== 7) return;
      if (!normalizedCasePath(finding.file))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectations", "aggregation", "findings", findingIndex, "file"],
          message: "finding file must be a normalized case-relative path",
        });
      finding.minimumEvidence?.forEach((evidence, evidenceIndex) => {
        const evidencePath = [
          "expectations",
          "aggregation",
          "findings",
          findingIndex,
          "minimumEvidence",
          evidenceIndex,
        ];
        if (!normalizedCasePath(evidence.file))
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...evidencePath, "file"],
            message: "minimum-evidence file must be a normalized case-relative path",
          });
        if (evidence.lineStart !== undefined && evidence.lineEnd !== undefined && evidence.lineEnd < evidence.lineStart)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...evidencePath, "lineEnd"],
            message: "lineEnd must be >= lineStart",
          });
      });
    });
    const exemptionKeys = new Set<string>();
    value.sanitization.sensitiveContentExemptions.forEach((item, index) => {
      const normalized = item.path.replaceAll("\\", "/").replace(/^\.\//, "");
      if (normalized !== item.path || path.isAbsolute(item.path) || normalized.split("/").includes(".."))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sanitization", "sensitiveContentExemptions", index, "path"],
          message: "exemption path must be a normalized case-relative path",
        });
      const key = `${item.path}:${item.patternId}`;
      if (exemptionKeys.has(key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sanitization", "sensitiveContentExemptions", index],
          message: "duplicate sensitive-content exemption",
        });
      exemptionKeys.add(key);
    });
    if (value.status === "active") {
      if (!Object.keys(value.expectations).length)
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectations"], message: "active case needs labels" });
      for (const [key, approved] of Object.entries({
        reviewed: value.sanitization.reviewed,
        absolutePathsRemoved: value.sanitization.absolutePathsRemoved,
        sensitiveContentReviewed: value.sanitization.sensitiveContentReviewed,
        redistributable: value.sanitization.redistributable,
      }))
        if (!approved)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sanitization", key],
            message: "active cases require completed sanitization",
          });
      if (!value.source.fixture)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source", "fixture"],
          message: "active cases require a verified frozen fixture",
        });
      if (value.schemaVersion >= 6 && !value.groundTruth?.reviewed)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groundTruth", "reviewed"],
          message: "active schema-v6+ cases require reviewed ground truth",
        });
    }
  });

export type EvalCase = z.infer<typeof evalCaseSchema>;

export function caseDirectory(root: string, slug: string): string {
  if (!slugPattern.test(slug)) throw new Error(`Invalid eval case slug: ${slug}`);
  return path.join(root, "evals", "agentsmith", slug);
}

function replaceRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.split(root).join("<repo>");
  if (Array.isArray(value)) return value.map((item) => replaceRoot(item, root));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRoot(item, root)]));
  return value;
}

export function sanitizeTrace(trace: AgentSmithTrace, root: string): AgentSmithTrace {
  return replaceRoot(structuredClone(trace), path.resolve(root)) as AgentSmithTrace;
}

export function initialCase(trace: AgentSmithTrace, slug: string, project = ""): EvalCase {
  return {
    schemaVersion: EVAL_CASE_SCHEMA_VERSION,
    id: slug,
    status: "draft",
    kind: "benchmark",
    suite: "component",
    source: {
      traceId: trace.traceId,
      traceSchemaVersion: trace.schemaVersion,
      repositoryFingerprint: trace.version,
      fixture: null,
      project,
    },
    sanitization: {
      reviewed: false,
      absolutePathsRemoved: true,
      sensitiveContentReviewed: false,
      redistributable: false,
      sensitiveContentExemptions: [],
    },
    groundTruth: undefined,
    stageReplay: undefined,
    expectations: {},
    narrative: { summary: "", trueCodeFlow: "", references: [] },
    tags: [],
  };
}

function writeCaseDefinition(directory: string, definition: EvalCase): void {
  fs.writeFileSync(
    path.join(directory, "case.yaml"),
    yaml.dump(definition, { noRefs: true, sortKeys: false, lineWidth: 120 }),
    { encoding: "utf8", mode: 0o600 },
  );
}

function installFixture(
  directory: string,
  definition: EvalCase,
  sourceRoot: string,
  manifest: SourceSnapshotManifest,
): void {
  const fixtureRoot = path.join(directory, "fixture", "repo");
  materializeSourceManifest(sourceRoot, manifest, fixtureRoot);
  const marker = ".matrixcore-ignore";
  const markerContents = "\n";
  if (!manifest.entries.some((entry) => entry.path === marker))
    fs.writeFileSync(path.join(fixtureRoot, marker), markerContents, { mode: 0o644 });
  const fixtureManifest: SourceSnapshotManifest = {
    ...manifest,
    entries: manifest.entries.some((entry) => entry.path === marker)
      ? manifest.entries
      : [
          ...manifest.entries,
          {
            path: marker,
            type: "file",
            sha256: sha256(markerContents),
            size: Buffer.byteLength(markerContents),
            executable: false,
          } as const,
        ].sort((left, right) => left.path.localeCompare(right.path)),
  };
  fs.mkdirSync(path.join(directory, "fixture"), { recursive: true });
  fs.writeFileSync(path.join(directory, "fixture", ".matrixcore-ignore"), "", { mode: 0o600 });
  const manifestPath = path.join(directory, "fixture-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(fixtureManifest, null, 2)}\n`, { mode: 0o600 });
  definition.source.fixture = {
    path: "fixture/repo",
    manifestPath: "fixture-manifest.json",
    digest: sourceManifestHash(fixtureManifest),
  };
}

function containedPath(parent: string, relative: string, label: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} must be a relative path`);
  const parentPath = path.resolve(parent);
  const target = path.resolve(parentPath, relative);
  if (target === parentPath || !target.startsWith(`${parentPath}${path.sep}`))
    throw new Error(`${label} escapes its eval case directory`);
  return target;
}

function validateManifestShape(value: unknown): SourceSnapshotManifest {
  const entry = z.object({
    path: z.string().min(1),
    type: z.enum(["file", "symlink"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
    executable: z.boolean(),
    linkTarget: z.string().optional(),
  });
  return z
    .object({
      schemaVersion: z.literal(1),
      repositoryFingerprint: z.string(),
      gitHead: z.string().nullable(),
      entries: z.array(entry),
      deletedPaths: z.array(z.string()),
    })
    .parse(value) as SourceSnapshotManifest;
}

function fixtureTreeEntries(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if ([".venv", "node_modules", ".mypy_cache", ".ruff_cache"].includes(item.name)) continue;
      if (
        relative === ".git" ||
        relative.startsWith(".git/") ||
        relative === ".quality" ||
        relative.startsWith(".quality/")
      )
        throw new Error(`Fixture contains runtime state: ${relative}`);
      if (item.isDirectory()) visit(absolute);
      else found.push(relative);
    }
  };
  visit(root);
  return found.sort();
}

function safeManifestPath(root: string, relative: string): string {
  const normalized = relative.split("/").join(path.sep);
  return containedPath(root, normalized, `Fixture entry ${relative}`);
}

export interface ValidatedFixture {
  directory: string;
  root: string;
  manifest: SourceSnapshotManifest;
  digest: string;
}

export function validateCaseFixture(root: string, slug: string): ValidatedFixture {
  const directory = caseDirectory(root, slug);
  const { definition, trace, fixtureRoot } = readEvalCase(root, slug);
  if (!definition.source.fixture || !fixtureRoot) throw new Error(`Eval case ${slug} has no frozen fixture`);
  const manifestPath = containedPath(directory, definition.source.fixture.manifestPath, "Fixture manifest path");
  const manifest = validateManifestShape(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const digest = sourceManifestHash(manifest);
  if (digest !== definition.source.fixture.digest)
    throw new Error(`Eval case ${slug} fixture manifest digest mismatch`);
  if (
    manifest.repositoryFingerprint !== definition.source.repositoryFingerprint ||
    manifest.repositoryFingerprint !== trace.version
  )
    throw new Error(`Eval case ${slug} fixture fingerprint does not match its trace`);
  if (!fs.statSync(fixtureRoot).isDirectory()) throw new Error(`Eval case ${slug} fixture root is not a directory`);

  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    const normalized = entry.path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized !== entry.path || paths.has(entry.path))
      throw new Error(`Eval case ${slug} has an invalid or duplicate fixture entry: ${entry.path}`);
    paths.add(entry.path);
    if (
      entry.path === ".git" ||
      entry.path.startsWith(".git/") ||
      entry.path === ".quality" ||
      entry.path.startsWith(".quality/")
    )
      throw new Error(`Eval case ${slug} fixture contains runtime state: ${entry.path}`);
    const absolute = safeManifestPath(fixtureRoot, entry.path);
    const stat = fs.lstatSync(absolute);
    if (entry.type === "symlink") {
      if (!stat.isSymbolicLink()) throw new Error(`Eval case ${slug} fixture type mismatch: ${entry.path}`);
      const target = fs.readlinkSync(absolute);
      if (target !== entry.linkTarget || sha256(target) !== entry.sha256 || Buffer.byteLength(target) !== entry.size)
        throw new Error(`Eval case ${slug} fixture symlink mismatch: ${entry.path}`);
      const resolved = path.resolve(path.dirname(absolute), target);
      if (path.isAbsolute(target) || (resolved !== fixtureRoot && !resolved.startsWith(`${fixtureRoot}${path.sep}`)))
        throw new Error(`Eval case ${slug} fixture has an unsafe symlink: ${entry.path}`);
    } else {
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Eval case ${slug} fixture type mismatch: ${entry.path}`);
      const contents = fs.readFileSync(absolute);
      if (sha256(contents) !== entry.sha256 || contents.length !== entry.size)
        throw new Error(`Eval case ${slug} fixture content mismatch: ${entry.path}`);
      if (Boolean(stat.mode & 0o111) !== entry.executable)
        throw new Error(`Eval case ${slug} fixture mode mismatch: ${entry.path}`);
    }
  }
  const actual = fixtureTreeEntries(fixtureRoot);
  const expected = [...paths].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Eval case ${slug} fixture tree differs from its manifest`);
  for (const deleted of manifest.deletedPaths)
    if (fs.existsSync(safeManifestPath(fixtureRoot, deleted)))
      throw new Error(`Eval case ${slug} deleted path exists in fixture: ${deleted}`);

  const deletedFiles = new Set(
    Array.isArray(trace.scope.deletedFiles)
      ? trace.scope.deletedFiles
      : Object.keys((trace.scope.deletedFiles ?? {}) as Record<string, unknown>),
  );
  for (const changed of trace.scope.changedFiles) {
    const absolute = safeManifestPath(fixtureRoot, changed);
    if (deletedFiles.has(changed)) {
      if (fs.existsSync(absolute)) throw new Error(`Eval case ${slug} deleted changed file exists: ${changed}`);
      if (!(changed in trace.scope.fileContents))
        throw new Error(`Eval case ${slug} lacks deleted-file preimage: ${changed}`);
    } else {
      if (!paths.has(changed)) throw new Error(`Eval case ${slug} fixture lacks changed file: ${changed}`);
      if (fs.readFileSync(absolute, "utf8") !== trace.scope.fileContents[changed])
        throw new Error(`Eval case ${slug} changed-file bytes differ from its trace: ${changed}`);
    }
  }
  for (const [contextPath, contents] of Object.entries(trace.scope.suppliedContext))
    if (paths.has(contextPath) && fs.readFileSync(safeManifestPath(fixtureRoot, contextPath), "utf8") !== contents)
      throw new Error(`Eval case ${slug} supplied context differs from its fixture: ${contextPath}`);
  return { directory, root: fixtureRoot, manifest, digest };
}

export function materializeEvalRun(
  root: string,
  slug: string,
): { root: string; fixtureDigest: string; cleanup: () => void } {
  const fixture = validateCaseFixture(root, slug);
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), `matrixcore-eval-${slug}-`));
  try {
    for (const entry of fixture.manifest.entries) {
      const source = safeManifestPath(fixture.root, entry.path);
      const target = safeManifestPath(runRoot, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (entry.type === "symlink") fs.symlinkSync(entry.linkTarget!, target);
      else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (entry.type === "file") fs.chmodSync(target, entry.executable ? 0o755 : 0o644);
    }
    if (!fs.existsSync(path.join(runRoot, "package.json")))
      fs.writeFileSync(
        path.join(runRoot, "package.json"),
        `${JSON.stringify({ name: "matrixcore-eval-replay", private: true, type: "module" }, null, 2)}\n`,
        { mode: 0o644 },
      );
    const initialized = spawnSync("git", ["init", "-q"], { cwd: runRoot, encoding: "utf8" });
    if (initialized.status !== 0) throw new Error(`Could not initialize replay repository: ${initialized.stderr}`);
    const staged = spawnSync("git", ["add", "-A"], { cwd: runRoot, encoding: "utf8" });
    if (staged.status !== 0) throw new Error(`Could not stage replay repository: ${staged.stderr}`);
    return {
      root: runRoot,
      fixtureDigest: fixture.digest,
      cleanup: () => fs.rmSync(runRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
}

export function curateTrace(opts: {
  root: string;
  traceId: string;
  slug: string;
  repo?: string;
  traceRoot?: string;
  project?: string;
}) {
  const traceRoot = path.resolve(opts.traceRoot ?? opts.root);
  const trace = readAgentSmithTrace(traceRoot, opts.traceId);
  const directory = caseDirectory(opts.root, opts.slug);
  if (fs.existsSync(directory)) throw new Error(`Eval case already exists: ${directory}`);
  const repo = opts.repo ? path.resolve(opts.repo) : undefined;
  if (repo && computeWorkspaceVersion(repo) !== trace.version)
    throw new Error("Frozen repository does not match the trace workspace version");
  fs.mkdirSync(directory, { recursive: true });
  try {
    const definition = initialCase(trace, opts.slug, opts.project);
    if (trace.sourceSnapshot?.complete && trace.sourceSnapshot.portable) {
      const manifest = readTraceSourceManifest(traceRoot, trace.traceId);
      if (sourceManifestHash(manifest) !== trace.sourceSnapshot.manifestHash)
        throw new Error("Trace source manifest digest does not match trace metadata");
      installFixture(directory, definition, traceRoot, manifest);
    } else if (repo) {
      const captured = captureSourceSnapshot(repo, trace.version);
      if (!captured.complete || !captured.portable)
        throw new Error(`Frozen repository cannot be curated: ${captured.warnings.join("; ")}`);
      installFixture(directory, definition, repo, captured.manifest);
    }
    fs.writeFileSync(
      path.join(directory, "input.json"),
      `${JSON.stringify(sanitizeTrace(trace, traceRoot), null, 2)}\n`,
      { mode: 0o600 },
    );
    writeCaseDefinition(directory, definition);
    if (definition.source.fixture) validateCaseFixture(opts.root, opts.slug);
    return {
      directory,
      status: "draft",
      fixture: Boolean(definition.source.fixture),
      warning: "Label and review sanitization before activating this case.",
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function attachFixture(opts: { root: string; slug: string; repo: string }): void {
  const directory = caseDirectory(opts.root, opts.slug);
  const { definition, trace } = readEvalCase(opts.root, opts.slug);
  if (definition.source.fixture) throw new Error(`Eval case already has a fixture: ${opts.slug}`);
  const repo = path.resolve(opts.repo);
  if (computeWorkspaceVersion(repo) !== trace.version)
    throw new Error("Frozen repository does not match the trace workspace version");
  const captured = captureSourceSnapshot(repo, trace.version);
  if (!captured.complete || !captured.portable)
    throw new Error(`Frozen repository cannot be attached: ${captured.warnings.join("; ")}`);
  try {
    installFixture(directory, definition, repo, captured.manifest);
    writeCaseDefinition(directory, definition);
    validateCaseFixture(opts.root, opts.slug);
  } catch (error) {
    fs.rmSync(path.join(directory, "fixture"), { recursive: true, force: true });
    fs.rmSync(path.join(directory, "fixture-manifest.json"), { force: true });
    definition.source.fixture = null;
    writeCaseDefinition(directory, definition);
    throw error;
  }
}

export function readEvalCase(
  root: string,
  slug: string,
): { definition: EvalCase; trace: AgentSmithTrace; fixtureRoot: string | null } {
  const directory = caseDirectory(root, slug);
  const definition = evalCaseSchema.parse(yaml.load(fs.readFileSync(path.join(directory, "case.yaml"), "utf8")));
  if (definition.id !== slug) throw new Error(`Eval case id must match directory name: ${slug}`);
  const trace = JSON.parse(fs.readFileSync(path.join(directory, "input.json"), "utf8")) as AgentSmithTrace;
  if (![2, 3, 4, 5].includes(trace.schemaVersion) || trace.traceId !== definition.source.traceId)
    throw new Error(`Eval case ${slug} references an incompatible trace`);
  if (definition.source.traceSchemaVersion !== trace.schemaVersion)
    throw new Error(`Eval case ${slug} trace schema metadata does not match its input`);
  if (definition.source.repositoryFingerprint !== trace.version)
    throw new Error(`Eval case ${slug} repository fingerprint does not match its trace`);
  const fixtureRoot = definition.source.fixture
    ? containedPath(directory, definition.source.fixture.path, "Fixture path")
    : null;
  return { definition, trace, fixtureRoot };
}

export function readStageReplay(root: string, slug: string, definitionInput?: EvalCase): StageReplayArtifact {
  const directory = caseDirectory(root, slug);
  const definition =
    definitionInput ?? evalCaseSchema.parse(yaml.load(fs.readFileSync(path.join(directory, "case.yaml"), "utf8")));
  if (!definition.stageReplay) throw new Error(`Eval case ${slug} has no isolated stage replay artifact`);
  const artifactPath = containedPath(directory, definition.stageReplay.path, "Stage replay path");
  const bytes = fs.readFileSync(artifactPath);
  if (sha256(bytes) !== definition.stageReplay.sha256)
    throw new Error(`Eval case ${slug} stage replay digest mismatch`);
  const artifact = stageReplayArtifactSchema.parse(JSON.parse(bytes.toString("utf8"))) as StageReplayArtifact;
  if (artifact.caseId !== slug) throw new Error(`Eval case ${slug} stage replay case id mismatch`);
  if (artifact.fixtureDigest !== definition.source.fixture?.digest)
    throw new Error(`Eval case ${slug} stage replay fixture digest mismatch`);
  return artifact;
}

export function listEvalCases(root: string, includeDrafts = false): string[] {
  try {
    return fs
      .readdirSync(path.join(root, "evals", "agentsmith"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((slug) => {
        try {
          if (!fs.existsSync(path.join(root, "evals", "agentsmith", slug, "case.yaml"))) return false;
          return includeDrafts || readEvalCase(root, slug).definition.status === "active";
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

const sensitivePatterns = [
  { id: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/ },
  { id: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "credential-assignment", regex: /(?:token|password|secret|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i },
] as const;

export function validateEvalCases(root: string, includeDrafts = true) {
  const cases = listEvalCases(root, includeDrafts);
  const results = cases.map((slug) => {
    try {
      const { definition } = readEvalCase(root, slug);
      if (definition.source.fixture) validateCaseFixture(root, slug);
      else if (definition.status === "active") throw new Error(`Active eval case ${slug} has no frozen fixture`);
      if (definition.stageReplay) readStageReplay(root, slug, definition);
      const directory = caseDirectory(root, slug);
      const files = repositoryFilesForScan(directory);
      const exemptions = new Map(
        definition.sanitization.sensitiveContentExemptions.map((item) => [`${item.path}:${item.patternId}`, item]),
      );
      const usedExemptions = new Set<string>();
      const findings = files.flatMap((file) => {
        const text = fs.readFileSync(file, "utf8");
        const relative = path.relative(directory, file).split(path.sep).join("/");
        const digest = sha256(fs.readFileSync(file));
        return sensitivePatterns
          .filter((pattern) => pattern.regex.test(text))
          .flatMap((pattern) => {
            const key = `${relative}:${pattern.id}`;
            const exemption = exemptions.get(key);
            if (exemption?.sha256 === digest) {
              usedExemptions.add(key);
              return [];
            }
            return [`${path.relative(root, file)} matched ${pattern.id}`];
          });
      });
      for (const [key, exemption] of exemptions)
        if (!usedExemptions.has(key))
          findings.push(`${path.join("evals", "agentsmith", slug, exemption.path)} has a stale or unused exemption`);
      return { id: slug, status: definition.status, valid: findings.length === 0, findings };
    } catch (error) {
      return {
        id: slug,
        status: "invalid",
        valid: false,
        findings: [error instanceof Error ? error.message : String(error)],
      };
    }
  });
  return { valid: results.every((item) => item.valid), cases: results };
}

function repositoryFilesForScan(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if ([".venv", "node_modules", ".mypy_cache", ".ruff_cache"].includes(entry.name)) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && fs.statSync(target).size <= 10 * 1024 * 1024) files.push(target);
    }
  };
  visit(directory);
  return files;
}

export function corpusHash(root: string, slugs: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const slug of [...slugs].sort()) {
    const directory = caseDirectory(root, slug);
    hash.update(slug);
    hash.update(fs.readFileSync(path.join(directory, "case.yaml")));
    hash.update(fs.readFileSync(path.join(directory, "input.json")));
    const { definition } = readEvalCase(root, slug);
    if (definition.stageReplay)
      hash.update(fs.readFileSync(containedPath(directory, definition.stageReplay.path, "Stage replay path")));
    const fixture = validateCaseFixture(root, slug);
    hash.update(fs.readFileSync(path.join(directory, "fixture-manifest.json")));
    hash.update(fixture.digest);
  }
  return hash.digest("hex");
}

export function inventory(root: string) {
  const cases = listEvalCases(root, true).map((slug) => {
    const { definition, trace } = readEvalCase(root, slug);
    return {
      id: slug,
      status: definition.status,
      kind: definition.kind,
      suite: definition.suite,
      traceId: trace.traceId,
      traceSchemaVersion: trace.schemaVersion,
      fixture: Boolean(definition.source.fixture),
      fixtureDigest: definition.source.fixture?.digest ?? null,
      replayEligible: definition.status === "active" && Boolean(definition.source.fixture),
      labeledStages: Object.keys(definition.expectations),
      outcome: definition.expectations.aggregation?.outcome ?? null,
      findings: definition.expectations.aggregation?.findings.length ?? null,
      tags: definition.tags,
    };
  });
  const curatedTraceIds = new Set(cases.map((item) => item.traceId));
  const traces = listAgentSmithTraces(root).map((trace) => ({
    traceId: trace.traceId,
    createdAt: trace.createdAt,
    schemaVersion: trace.schemaVersion,
    status: trace.result.status,
    outcome: trace.result.outcome,
    files: trace.result.coverage.changedFiles,
    findings: trace.result.findings.length,
    evidenceGaps: trace.result.coverage.evidenceGaps,
    sourceSnapshot: trace.sourceSnapshot
      ? {
          complete: trace.sourceSnapshot.complete,
          portable: trace.sourceSnapshot.portable,
          manifestHash: trace.sourceSnapshot.manifestHash,
        }
      : null,
    curated: curatedTraceIds.has(trace.traceId),
  }));
  return {
    cases,
    traces,
    totals: {
      active: cases.filter((item) => item.status === "active").length,
      draft: cases.filter((item) => item.status === "draft").length,
      benchmark: cases.filter((item) => item.kind === "benchmark").length,
      conformance: cases.filter((item) => item.kind === "conformance").length,
      component: cases.filter((item) => item.suite === "component").length,
      suites: Object.fromEntries(
        ["component", "conformance", "draft"].map((suite) => [
          suite,
          cases.filter((item) => item.suite === suite).length,
        ]),
      ),
      retainedTraces: traces.length,
      uncuratedTraces: traces.filter((item) => !item.curated).length,
    },
  };
}
