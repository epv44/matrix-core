import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { ReviewFinding } from "../core/types.js";
import { resolveConfig } from "../core/config-resolver.js";
import { resolvePolicyForConfig } from "../core/resolved-policy.js";
import { OllamaProvider, type ReviewProvider } from "./provider.js";
import { executeReviewEngine } from "./engine.js";
import { readAgentSmithTrace, type AgentSmithTrace } from "./trace.js";

const CASE_SCHEMA_VERSION = 2;
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type EvalMode =
  "holistic" | "partitioned-local" | "partitioned-evidence" | "partitioned-interactions" | "hybrid";

const expectedFindingSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  category: z.enum(["correctness", "security", "performance", "contract"]).optional(),
  discoveryClass: z.enum(["L0", "L1", "L2", "L3"]),
  requiredEvidence: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  graphDistance: z.number().int().min(0).max(3).optional(),
  description: z.string().default(""),
  rationale: z.string().default(""),
});
const evalCaseSchema = z
  .object({
    schemaVersion: z.literal(CASE_SCHEMA_VERSION),
    id: z.string().min(1),
    sourceTraceId: z.string().min(1),
    expectedOutcome: z.enum(["clear", "findings"]),
    expectedFindings: z.array(expectedFindingSchema).default([]),
    originalCandidates: z
      .array(
        z.object({
          candidateId: z.string(),
          label: z.enum(["unreviewed", "accepted", "rejected"]),
          rationale: z.string().default(""),
        }),
      )
      .default([]),
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
    value.expectedFindings.forEach((finding, index) => {
      if (finding.lineEnd < finding.lineStart)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expectedFindings", index, "lineEnd"],
          message: "lineEnd must be >= lineStart",
        });
    });
    const derived = value.expectedFindings.length ? "findings" : "clear";
    if (value.expectedOutcome !== derived)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedOutcome"],
        message: `expectedOutcome must be ${derived}`,
      });
  });
export type EvalCase = z.infer<typeof evalCaseSchema>;

function caseDirectory(root: string, slug: string) {
  if (!slugPattern.test(slug)) throw new Error(`Invalid eval case slug: ${slug}`);
  return path.join(root, "evals", "agentsmith", slug);
}
function initialCase(trace: AgentSmithTrace, slug: string): EvalCase {
  const expectedFindings = trace.result.findings.map((finding, index) => ({
    id: `expected-${index + 1}`,
    file: finding.file,
    lineStart: finding.line,
    lineEnd: finding.endLine ?? finding.line,
    severity: finding.severity,
    category: finding.category,
    discoveryClass: "L0" as const,
    requiredEvidence: finding.evidence.map((record) => record.id),
    symbols: [],
    description: finding.description,
    rationale: "REVIEW_REQUIRED",
  }));
  return {
    schemaVersion: 2,
    id: slug,
    sourceTraceId: trace.traceId,
    expectedOutcome: expectedFindings.length ? "findings" : "clear",
    expectedFindings,
    originalCandidates: (trace.execution?.candidates ?? []).map((candidate) => ({
      candidateId: candidate.id,
      label: "unreviewed",
      rationale: "",
    })),
    narrative: { summary: "", trueCodeFlow: "", references: [] },
    tags: [],
  };
}
export function curateTrace(root: string, traceId: string, slug: string) {
  const trace = readAgentSmithTrace(root, traceId);
  const directory = caseDirectory(root, slug);
  if (fs.existsSync(directory)) throw new Error(`Eval case already exists: ${directory}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "input.json"), `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(directory, "case.yaml"),
    yaml.dump(initialCase(trace, slug), { noRefs: true, sortKeys: false, lineWidth: 120 }),
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    directory,
    warning:
      "Review input.json and case.yaml for proprietary code, prompts, credentials, and personal data before committing.",
  };
}
export function readEvalCase(root: string, slug: string): { definition: EvalCase; trace: AgentSmithTrace } {
  const directory = caseDirectory(root, slug);
  const definition = evalCaseSchema.parse(yaml.load(fs.readFileSync(path.join(directory, "case.yaml"), "utf8")));
  if (definition.id !== slug) throw new Error(`Eval case id must match directory name: ${slug}`);
  const trace = JSON.parse(fs.readFileSync(path.join(directory, "input.json"), "utf8")) as AgentSmithTrace;
  if (trace.schemaVersion !== 2 || trace.traceId !== definition.sourceTraceId)
    throw new Error(`Eval case ${slug} references an incompatible trace`);
  return { definition, trace };
}
export function listEvalCases(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, "evals", "agentsmith"), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && fs.existsSync(path.join(root, "evals", "agentsmith", entry.name, "case.yaml")),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
function findingMatches(actual: ReviewFinding, expected: EvalCase["expectedFindings"][number]) {
  if (actual.file !== expected.file || actual.line < expected.lineStart || actual.line > expected.lineEnd) return false;
  if (expected.category && actual.category !== expected.category) return false;
  return expected.requiredEvidence.every((anchor) =>
    actual.evidence.some((record) => record.id === anchor || record.snippet.includes(anchor)),
  );
}
export function scoreFindings(actual: ReviewFinding[], expected: EvalCase["expectedFindings"]) {
  const unmatched = new Set(actual.map((_, index) => index));
  const matched: Array<{ expectedId: string; actualFindingId: string; discoveryClass: string }> = [];
  for (const gold of expected) {
    const index = [...unmatched].find((candidate) => findingMatches(actual[candidate], gold));
    if (index === undefined) continue;
    unmatched.delete(index);
    matched.push({ expectedId: gold.id, actualFindingId: actual[index].id, discoveryClass: gold.discoveryClass });
  }
  const truePositive = matched.length;
  const falsePositive = unmatched.size;
  const falseNegative = expected.length - truePositive;
  const precision =
    truePositive + falsePositive === 0 ? (expected.length ? 0 : 1) : truePositive / (truePositive + falsePositive);
  const recall = expected.length ? truePositive / expected.length : 1;
  const byClass = Object.fromEntries(
    ["L0", "L1", "L2", "L3"].map((level) => {
      const relevant = expected.filter((finding) => finding.discoveryClass === level);
      const found = matched.filter((item) => item.discoveryClass === level).length;
      return [level, { expected: relevant.length, found, recall: relevant.length ? found / relevant.length : 1 }];
    }),
  );
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    byClass,
    matched,
    unmatchedActualFindingIds: [...unmatched].map((index) => actual[index].id),
  };
}

function modeConfig(mode: EvalMode, config: NonNullable<ReturnType<typeof resolveConfig>["config"]["agentsmith"]>) {
  const cloned = structuredClone(config);
  cloned.cache = false;
  cloned.mode = mode === "holistic" ? "holistic" : mode === "hybrid" ? "hybrid" : "partitioned";
  return cloned;
}

export async function runEvalCases(opts: {
  root: string;
  slugs?: string[];
  modes?: EvalMode[];
  repeat?: number;
  provider?: ReviewProvider;
}) {
  const slugs = opts.slugs?.length ? opts.slugs : listEvalCases(opts.root);
  if (!slugs.length) throw new Error("No AgentSmith eval cases found");
  const resolved = resolveConfig({ cwd: opts.root });
  const policy = resolvePolicyForConfig(resolved);
  const provider = opts.provider ?? new OllamaProvider(resolved.config.agentsmith!);
  const modes = opts.modes?.length
    ? opts.modes
    : (["holistic", "partitioned-local", "partitioned-evidence", "partitioned-interactions", "hybrid"] as EvalMode[]);
  const repeat = Math.max(1, opts.repeat ?? 1);
  const cases = [];
  for (const slug of slugs) {
    const { definition, trace } = readEvalCase(opts.root, slug);
    const results = [];
    for (let iteration = 0; iteration < repeat; iteration++)
      for (const mode of modes) {
        const started = Date.now();
        try {
          const execution = await executeReviewEngine({
            root: opts.root,
            version: trace.version,
            scope: trace.scope,
            config: modeConfig(mode, resolved.config.agentsmith!),
            provider,
            profileHash: policy.agentSmith.hash,
            assetRoot: policy.agentSmith.assetRoot,
            deterministicReport: trace.deterministicReport,
            enforceWorkspaceVersion: false,
            variant: {
              includeInteractions: !["partitioned-local", "partitioned-evidence"].includes(mode),
              resolveEvidence: mode !== "partitioned-local",
            },
          });
          const promotedRejectedCandidates = definition.originalCandidates
            .filter(
              (candidate) =>
                candidate.label === "rejected" &&
                execution.result.findings.some((finding) => finding.id === candidate.candidateId),
            )
            .map((candidate) => candidate.candidateId);
          results.push({
            mode,
            outcome: execution.result.outcome,
            findings: execution.result.findings,
            coverage: execution.result.coverage,
            durationMs: Date.now() - started,
            metrics: scoreFindings(execution.result.findings, definition.expectedFindings),
            outcomeCorrect: execution.result.outcome === definition.expectedOutcome,
            promotedRejectedCandidates,
            inputTokens: execution.execution.inputTokens,
            outputTokens: execution.execution.outputTokens,
            errors: execution.result.errors ?? [],
          });
        } catch (error) {
          results.push({
            mode,
            outcome: "incomplete" as const,
            findings: [],
            durationMs: Date.now() - started,
            metrics: scoreFindings([], definition.expectedFindings),
            outcomeCorrect: false,
            promotedRejectedCandidates: [],
            inputTokens: 0,
            outputTokens: 0,
            errors: [error instanceof Error ? error.message : String(error)],
          });
        }
      }
    cases.push({ id: slug, expectedOutcome: definition.expectedOutcome, results });
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const report = { schemaVersion: 2, runId, createdAt: new Date().toISOString(), modes, repeat, cases };
  const directory = path.join(opts.root, ".quality", "evals", "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    `# AgentSmith eval ${runId}`,
    "",
    ...cases.flatMap((item) => [
      `## ${item.id}`,
      "",
      ...item.results.map(
        (result) =>
          `- ${result.mode}: outcome ${result.outcome} (expected ${item.expectedOutcome}); precision ${result.metrics.precision.toFixed(3)}, recall ${result.metrics.recall.toFixed(3)}, F1 ${result.metrics.f1.toFixed(3)}; tokens ${result.inputTokens}/${result.outputTokens}; ${result.promotedRejectedCandidates.length} rejected-candidate promotion(s); ${result.errors.length} error(s)`,
      ),
      "",
    ]),
  ].join("\n");
  fs.writeFileSync(path.join(directory, "result.md"), `${markdown}\n`);
  return { ...report, directory, markdown };
}
