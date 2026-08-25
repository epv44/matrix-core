import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReviewFinding } from "../../../src/core/types.js";
import { resolveConfig } from "../../../src/core/config-resolver.js";
import { resolvePolicyForConfig } from "../../../src/core/resolved-policy.js";
import { ENGINE_VERSION } from "../../../src/core/meta.js";
import { OllamaProvider, type ReviewProvider } from "../../../src/agentsmith/provider.js";
import { executeReviewEngine } from "../../../src/agentsmith/engine.js";
import { AGENTSMITH_STRATEGY_HASH } from "../../../src/agentsmith/strategy.js";
import { collectEvalMetrics } from "./eval-metrics.js";
import { PlannerReviewProvider, RecordedReviewProvider } from "./eval-provider.js";
import { corpusHash, listEvalCases, materializeEvalRun, readEvalCase, type EvalCase } from "./case.js";
import { evaluateStages, formatStageScorecard, type EvalStage } from "./stage-score.js";

export type EvalMode =
  "holistic" | "partitioned-local" | "partitioned-evidence" | "partitioned-interactions" | "hybrid";
export type EvalReplayMode = "live" | "recorded" | "stage";
type ExpectedFinding = NonNullable<EvalCase["expectations"]["aggregation"]>["findings"][number];
type InspectionTargets = { files: string[]; symbols: string[]; edges: string[] };

function findingMatches(actual: ReviewFinding, expected: ExpectedFinding) {
  if (actual.file !== expected.file || actual.line < expected.lineStart || actual.line > expected.lineEnd) return false;
  if (expected.category && actual.category !== expected.category) return false;
  return expected.requiredEvidence.every((anchor) =>
    actual.evidence.some((record) => record.id === anchor || record.snippet.includes(anchor)),
  );
}
export function scoreFindings(actual: ReviewFinding[], expected: ExpectedFinding[]) {
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
  expected: InspectionTargets,
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
  stages?: EvalStage[];
  label?: string;
}) {
  const slugs = opts.slugs?.length ? opts.slugs : listEvalCases(opts.root);
  if (!slugs.length) throw new Error("No AgentSmith eval cases found");
  const replay = opts.replay ?? "live";
  const modes = opts.modes?.length ? opts.modes : (["partitioned-interactions"] as EvalMode[]);
  const repeat = Math.max(1, opts.repeat ?? 1);
  const cases = [];
  for (const slug of slugs) {
    const { definition, trace } = readEvalCase(opts.root, slug);
    if (definition.status !== "active") throw new Error(`Eval case ${slug} is draft and cannot be replayed`);
    if (!definition.source.fixture) throw new Error(`Eval case ${slug} has no frozen fixture`);
    const expectedFindings = definition.expectations.aggregation?.findings ?? [];
    const expectedOutcome = definition.expectations.aggregation?.outcome ?? null;
    const expectedCandidates =
      definition.expectations.verification?.candidates ?? definition.expectations.candidates?.items ?? [];
    const rejectedCandidates = expectedCandidates.filter((candidate) => candidate.expectedVerdict !== "verified");
    const results = [];
    for (let iteration = 0; iteration < repeat; iteration++)
      for (const mode of modes) {
        const started = Date.now();
        let cleanup: (() => void) | undefined;
        try {
          const replayWorkspace = materializeEvalRun(opts.root, slug);
          cleanup = replayWorkspace.cleanup;
          const resolved = resolveConfig({ cwd: replayWorkspace.root });
          const policy = resolvePolicyForConfig(resolved);
          const config = modeConfig(mode, resolved.config.agentsmith!);
          const provider =
            opts.provider ??
            (replay === "recorded"
              ? new RecordedReviewProvider(trace)
              : replay === "stage"
                ? new PlannerReviewProvider(config)
                : new OllamaProvider(config));
          const execution = await executeReviewEngine({
            root: replayWorkspace.root,
            version: trace.version,
            scope: { ...trace.scope, root: replayWorkspace.root },
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
          const promotedRejectedCandidates = rejectedCandidates
            .filter((candidate) =>
              execution.result.findings.some(
                (finding) =>
                  finding.file === candidate.file &&
                  finding.line >= candidate.lineStart &&
                  finding.line <= candidate.lineEnd &&
                  (!candidate.category || finding.category === candidate.category),
              ),
            )
            .map((candidate) => candidate.id);
          const durationMs = Date.now() - started;
          const benchmark = collectEvalMetrics({
            scope: trace.scope,
            result: execution.result,
            execution: execution.execution,
            durationMs,
          });
          const findingMetrics = scoreFindings(execution.result.findings, expectedFindings);
          const inspectionTargets = scoreInspectionTargets(
            execution.execution,
            definition.expectations.planning ?? definition.expectations.graph ?? { files: [], symbols: [], edges: [] },
          );
          let stages = evaluateStages({
            definition,
            trace,
            execution: execution.execution,
            result: execution.result,
            tier: replay,
            hermetic: true,
            selected: opts.stages,
          });
          const recordedMisses =
            replay === "recorded"
              ? (execution.result.errors ?? []).filter((message) => /Recorded replay miss/.test(message))
              : [];
          if (recordedMisses.length) {
            const dependentStages = new Set<EvalStage>([
              "candidates",
              "evidence",
              "verification",
              "aggregation",
              "reporting",
            ]);
            stages = stages.map((stage) =>
              dependentStages.has(stage.stage)
                ? { ...stage, evaluation: "incompatible" as const, metrics: [], diagnostics: recordedMisses }
                : stage,
            );
          }
          results.push({
            mode,
            tier: replay,
            iteration,
            outcome: execution.result.outcome,
            findings: execution.result.findings,
            coverage: execution.result.coverage,
            durationMs,
            metrics: findingMetrics,
            benchmark,
            inspectionTargets,
            stages,
            qualityEvaluable:
              replay !== "stage" && !recordedMisses.length && Boolean(definition.expectations.aggregation),
            outcomeCorrect:
              replay !== "stage" && !recordedMisses.length && expectedOutcome
                ? execution.result.outcome === expectedOutcome
                : null,
            promotedRejectedCandidates,
            inputTokens: execution.execution.inputTokens,
            outputTokens: execution.execution.outputTokens,
            diagnostics: evaluationDiagnostics(execution),
            errors: recordedMisses.length ? [] : (execution.result.errors ?? []),
            incompatibilities: recordedMisses,
            provenance: {
              fixtureDigest: replayWorkspace.fixtureDigest,
              traceSchemaVersion: trace.schemaVersion,
              evaluatorVersion: ENGINE_VERSION,
              policyHash: policy.policyHash,
              agentSmithProfileHash: policy.agentSmith.hash,
              strategyHash: AGENTSMITH_STRATEGY_HASH,
              graphSchemaVersion: execution.execution.graphSnapshot.schemaVersion,
              graphProviderVersions: execution.execution.graphSnapshot.providerVersions,
              models: config.model_profiles.map((profile) => ({ id: profile.id, model: profile.model })),
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const incompatible = replay === "recorded" && /Recorded replay miss/.test(message);
          results.push({
            mode,
            tier: replay,
            iteration,
            outcome: "incomplete" as const,
            findings: [],
            durationMs: Date.now() - started,
            metrics: scoreFindings([], expectedFindings),
            stages: (
              opts.stages ?? [
                "snapshot",
                "graph",
                "planning",
                "candidates",
                "evidence",
                "verification",
                "aggregation",
                "reporting",
              ]
            ).map((stage) => ({
              stage,
              evaluation: incompatible ? ("incompatible" as const) : ("not-evaluable" as const),
              metrics: [],
              diagnostics: [message],
            })),
            qualityEvaluable: false,
            outcomeCorrect: null,
            promotedRejectedCandidates: [],
            inputTokens: 0,
            outputTokens: 0,
            errors: incompatible ? [] : [message],
            incompatibilities: incompatible ? [message] : [],
          });
        } finally {
          cleanup?.();
        }
      }
    cases.push({
      id: slug,
      kind: definition.kind,
      expectedOutcome,
      results,
    });
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const reportBase = {
    schemaVersion: 5,
    runId,
    label: opts.label ?? null,
    createdAt: new Date().toISOString(),
    corpusHash: corpusHash(opts.root, slugs),
    replay,
    modes,
    repeat,
    cases,
  };
  const report = { ...reportBase, summary: summarizeEvalReport(reportBase) };
  const directory = path.join(opts.root, ".quality", "evals", "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    `# AgentSmith eval ${runId}`,
    "",
    `Replay: ${replay}`,
    `Corpus: ${report.corpusHash}`,
    "",
    ...cases.flatMap((item) => [
      `## ${item.id}`,
      "",
      ...item.results.flatMap((result) => [
        `### ${result.mode} · iteration ${result.iteration + 1}`,
        "",
        `Outcome: ${result.outcome}${result.qualityEvaluable ? ` (expected ${item.expectedOutcome ?? "N/A"})` : " (diagnostic only)"}; F1 ${result.qualityEvaluable ? result.metrics.f1.toFixed(3) : "N/A"}; tokens ${result.inputTokens}/${result.outputTokens}; ${result.promotedRejectedCandidates.length} rejected-candidate promotion(s); ${result.errors.length} harness error(s).`,
        "",
        ...formatStageScorecard(result.stages),
        "",
      ]),
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

function standardDeviation(values: number[]): number | null {
  if (!values.length) return null;
  const average = mean(values)!;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function summarizeStages(results: any[]) {
  const keys = new Set<string>();
  for (const result of results)
    for (const stage of result.stages ?? [])
      for (const metric of stage.metrics ?? [])
        if (typeof metric.value === "number") keys.add(`${stage.stage}.${metric.name}`);
  return Object.fromEntries(
    [...keys].sort().map((key) => {
      const [stageName, ...metricParts] = key.split(".");
      const metricName = metricParts.join(".");
      const values = numeric(
        results.flatMap((result) =>
          (result.stages ?? [])
            .filter((stage: any) => stage.stage === stageName)
            .flatMap((stage: any) =>
              stage.metrics.filter((metric: any) => metric.name === metricName).map((metric: any) => metric.value),
            ),
        ),
      );
      return [key, { mean: mean(values), standardDeviation: standardDeviation(values), runs: values.length }];
    }),
  );
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
        incompatibleRuns: results.filter((result) => result.incompatibilities?.length).length,
        outcomeAgreement:
          results.length > 0
            ? Math.max(
                ...[...new Set(results.map((result) => result.outcome))].map(
                  (outcome) => results.filter((result) => result.outcome === outcome).length / results.length,
                ),
              )
            : null,
        stageMetrics: summarizeStages(results),
      };
    });
  });
}

export function compareEvalReports(
  baseline: { corpusHash?: string; cases: Array<{ id: string; results: any[] }> },
  current: { corpusHash?: string; cases: Array<{ id: string; results: any[] }> },
) {
  if (baseline.corpusHash && current.corpusHash && baseline.corpusHash !== current.corpusHash)
    throw new Error("Eval reports use different corpus hashes and cannot be compared");
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
        outcomeAgreement: delta("outcomeAgreement"),
        stageMetrics: Object.fromEntries(
          Object.entries(item.stageMetrics ?? {}).map(([key, value]: [string, any]) => {
            const beforeValue = (prior as any)?.stageMetrics?.[key]?.mean;
            return [
              key,
              typeof beforeValue === "number" && typeof value.mean === "number" ? value.mean - beforeValue : null,
            ];
          }),
        ),
      },
    };
  });
}
