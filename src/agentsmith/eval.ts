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
import { collectEvalMetrics } from "./eval-metrics.js";
import { PlannerReviewProvider, RecordedReviewProvider } from "./eval-provider.js";

const CASE_SCHEMA_VERSION = 2;
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export type EvalMode =
  "holistic" | "partitioned-local" | "partitioned-evidence" | "partitioned-interactions" | "hybrid";
export type EvalReplayMode = "live" | "recorded" | "planner";

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
    expectedInspectionTargets: z
      .object({
        files: z.array(z.string()).default([]),
        symbols: z.array(z.string()).default([]),
        edges: z.array(z.string()).default([]),
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
    expectedInspectionTargets: { files: [], symbols: [], edges: [] },
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
  if (![2, 3].includes(trace.schemaVersion) || trace.traceId !== definition.sourceTraceId)
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

export function scoreInspectionTargets(
  execution: Awaited<ReturnType<typeof executeReviewEngine>>["execution"],
  expected: EvalCase["expectedInspectionTargets"],
) {
  const inspectedFiles = new Set(execution.workItems.flatMap((item) => item.code.map((snippet) => snippet.file)));
  const inspectedSymbols = new Set(
    execution.workItems.flatMap((item) =>
      [...item.primarySymbols, ...item.relatedSymbols].flatMap((symbol) => [
        symbol.name,
        symbol.qualifiedName,
        `${symbol.file}#${symbol.qualifiedName}`,
      ]),
    ),
  );
  const inspectedEdges = new Set(
    execution.workItems.flatMap((item) =>
      item.graphEdges.flatMap((edge) => [
        `${edge.source}->${edge.target ?? edge.targetText}`,
        `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`,
      ]),
    ),
  );
  const score = (targets: string[], inspected: Set<string>) => {
    const matched = targets.filter((target) => inspected.has(target));
    return {
      expected: targets.length,
      matched: matched.length,
      rate: targets.length ? matched.length / targets.length : null,
      missing: targets.filter((target) => !inspected.has(target)),
    };
  };
  return {
    files: score(expected.files, inspectedFiles),
    symbols: score(expected.symbols, inspectedSymbols),
    edges: score(expected.edges, inspectedEdges),
  };
}

function modeConfig(mode: EvalMode, config: NonNullable<ReturnType<typeof resolveConfig>["config"]["agentsmith"]>) {
  const cloned = structuredClone(config);
  cloned.cache = false;
  cloned.mode = mode === "holistic" ? "holistic" : mode === "hybrid" ? "hybrid" : "partitioned";
  return cloned;
}

function evaluationDiagnostics(execution: Awaited<ReturnType<typeof executeReviewEngine>>) {
  return {
    candidates: execution.execution.candidates,
    candidateCalls: execution.execution.candidateBatches.map((batch) => ({
      sourceId: batch.sourceId,
      candidateIds: batch.candidates.map((candidate) => candidate.id),
      inputTokens: batch.inputTokens,
      outputTokens: batch.outputTokens,
      completion: batch.completion,
      cacheStatus: batch.cacheStatus,
      diagnostics: batch.diagnostics,
      error: batch.error,
    })),
    verification: execution.execution.verification.map((item) => ({
      candidateId: item.candidateId,
      verdict: item.verdict,
      confidence: item.confidence,
      reasoningSummary: item.reasoningSummary,
      supportingEvidenceIds: item.supportingEvidenceIds,
      completion: item.completion,
      cacheStatus: item.cacheStatus,
      diagnostics: item.diagnostics,
    })),
    evidence: execution.execution.evidence,
    providerFailures: execution.execution.providerFailures ?? [],
    providerDiagnostics: execution.execution.providerDiagnostics ?? [],
    incompleteReasons: execution.result.incompleteReasons ?? [],
  };
}

export async function runEvalCases(opts: {
  root: string;
  slugs?: string[];
  modes?: EvalMode[];
  repeat?: number;
  provider?: ReviewProvider;
  replay?: EvalReplayMode;
}) {
  const slugs = opts.slugs?.length ? opts.slugs : listEvalCases(opts.root);
  if (!slugs.length) throw new Error("No AgentSmith eval cases found");
  const resolved = resolveConfig({ cwd: opts.root });
  const policy = resolvePolicyForConfig(resolved);
  const replay = opts.replay ?? "live";
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
          const config = modeConfig(mode, resolved.config.agentsmith!);
          const provider =
            opts.provider ??
            (replay === "recorded"
              ? new RecordedReviewProvider(trace)
              : replay === "planner"
                ? new PlannerReviewProvider(config)
                : new OllamaProvider(config));
          const execution = await executeReviewEngine({
            root: opts.root,
            version: trace.version,
            scope: trace.scope,
            config,
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
          const durationMs = Date.now() - started;
          const benchmark = collectEvalMetrics({
            scope: trace.scope,
            result: execution.result,
            execution: execution.execution,
            durationMs,
          });
          const findingMetrics = scoreFindings(execution.result.findings, definition.expectedFindings);
          const inspectionTargets = scoreInspectionTargets(execution.execution, definition.expectedInspectionTargets);
          results.push({
            mode,
            outcome: execution.result.outcome,
            findings: execution.result.findings,
            coverage: execution.result.coverage,
            durationMs,
            metrics: findingMetrics,
            benchmark,
            inspectionTargets,
            qualityEvaluable: definition.expectedFindings.length > 0 || benchmark.coverage.changedFiles.rate === 1,
            outcomeCorrect: execution.result.outcome === definition.expectedOutcome,
            promotedRejectedCandidates,
            inputTokens: execution.execution.inputTokens,
            outputTokens: execution.execution.outputTokens,
            diagnostics: evaluationDiagnostics(execution),
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
  const reportBase = { schemaVersion: 3, runId, createdAt: new Date().toISOString(), replay, modes, repeat, cases };
  const report = { ...reportBase, summary: summarizeEvalReport(reportBase) };
  const directory = path.join(opts.root, ".quality", "evals", "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    `# AgentSmith eval ${runId}`,
    "",
    `Replay: ${replay}`,
    "",
    ...cases.flatMap((item) => [
      `## ${item.id}`,
      "",
      ...item.results.map(
        (result) =>
          `- ${result.mode}: outcome ${result.outcome} (expected ${item.expectedOutcome}); precision ${result.qualityEvaluable ? result.metrics.precision.toFixed(3) : "N/A"}, recall ${result.qualityEvaluable ? result.metrics.recall.toFixed(3) : "N/A"}, F1 ${result.qualityEvaluable ? result.metrics.f1.toFixed(3) : "N/A"}; file coverage ${result.benchmark ? `${((result.benchmark.coverage.changedFiles.rate ?? 0) * 100).toFixed(1)}%` : "N/A"}; line coverage ${result.benchmark ? `${((result.benchmark.coverage.changedLines.rate ?? 0) * 100).toFixed(1)}%` : "N/A"}; adjudication ${result.benchmark ? `${((result.benchmark.candidates.adjudicationRate ?? 0) * 100).toFixed(1)}%` : "N/A"}; evidence relevance ${result.benchmark?.evidence.relevanceRate === null || !result.benchmark ? "N/A" : `${(result.benchmark.evidence.relevanceRate * 100).toFixed(1)}%`}; honest ${result.benchmark?.honesty.honest ?? false}; tokens ${result.inputTokens}/${result.outputTokens}; ${result.promotedRejectedCandidates.length} rejected-candidate promotion(s); ${result.errors.length} error(s)`,
      ),
      "",
    ]),
  ].join("\n");
  fs.writeFileSync(path.join(directory, "result.md"), `${markdown}\n`);
  return { ...report, directory, markdown };
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function numeric(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function summarizeEvalReport(report: { cases: Array<{ id: string; results: any[] }> }) {
  return report.cases.flatMap((evalCase) => {
    const modes = [...new Set(evalCase.results.map((result) => result.mode as string))];
    return modes.map((mode) => {
      const results = evalCase.results.filter((result) => result.mode === mode);
      const quality = results.filter((result) => result.qualityEvaluable);
      return {
        caseId: evalCase.id,
        mode,
        runs: results.length,
        precision: mean(numeric(quality.map((result) => result.metrics?.precision))),
        recall: mean(numeric(quality.map((result) => result.metrics?.recall))),
        f1: mean(numeric(quality.map((result) => result.metrics?.f1))),
        changedFileCoverage: mean(numeric(results.map((result) => result.benchmark?.coverage.changedFiles.rate))),
        changedLineCoverage: mean(numeric(results.map((result) => result.benchmark?.coverage.changedLines.rate))),
        candidateAdjudication: mean(numeric(results.map((result) => result.benchmark?.candidates.adjudicationRate))),
        evidenceRelevance: mean(numeric(results.map((result) => result.benchmark?.evidence.relevanceRate))),
        inspectionFileRecall: mean(numeric(results.map((result) => result.inspectionTargets?.files.rate))),
        inspectionSymbolRecall: mean(numeric(results.map((result) => result.inspectionTargets?.symbols.rate))),
        inspectionEdgeRecall: mean(numeric(results.map((result) => result.inspectionTargets?.edges.rate))),
        durationMs: mean(numeric(results.map((result) => result.durationMs))),
        inputTokens: mean(numeric(results.map((result) => result.inputTokens))),
        outputTokens: mean(numeric(results.map((result) => result.outputTokens))),
        honestRunRate: mean(results.map((result) => (result.benchmark?.honesty.honest ? 1 : 0))),
        errorRuns: results.filter((result) => result.errors?.length).length,
      };
    });
  });
}

export function compareEvalReports(
  baseline: { cases: Array<{ id: string; results: any[] }> },
  current: { cases: Array<{ id: string; results: any[] }> },
) {
  const before = new Map(summarizeEvalReport(baseline).map((item) => [`${item.caseId}:${item.mode}`, item]));
  return summarizeEvalReport(current).map((item) => {
    const prior = before.get(`${item.caseId}:${item.mode}`);
    const delta = (key: keyof typeof item) => {
      const left = prior?.[key];
      const right = item[key];
      return typeof left === "number" && typeof right === "number" ? right - left : null;
    };
    return {
      caseId: item.caseId,
      mode: item.mode,
      baselineFound: Boolean(prior),
      current: item,
      delta: {
        precision: delta("precision"),
        recall: delta("recall"),
        f1: delta("f1"),
        changedFileCoverage: delta("changedFileCoverage"),
        changedLineCoverage: delta("changedLineCoverage"),
        candidateAdjudication: delta("candidateAdjudication"),
        evidenceRelevance: delta("evidenceRelevance"),
        inspectionFileRecall: delta("inspectionFileRecall"),
        inspectionSymbolRecall: delta("inspectionSymbolRecall"),
        inspectionEdgeRecall: delta("inspectionEdgeRecall"),
        durationMs: delta("durationMs"),
        inputTokens: delta("inputTokens"),
        outputTokens: delta("outputTokens"),
        honestRunRate: delta("honestRunRate"),
      },
    };
  });
}
