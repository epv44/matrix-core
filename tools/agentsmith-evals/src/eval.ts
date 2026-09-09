import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentSmithConfig, ModelProfile, ReviewFinding } from "../../../src/core/types.js";
import { resolveConfig } from "../../../src/core/config-resolver.js";
import { resolvePolicyForConfig } from "../../../src/core/resolved-policy.js";
import { ENGINE_VERSION } from "../../../src/core/meta.js";
import { OllamaProvider, type ReviewProvider } from "../../../src/agentsmith/provider.js";
import { executeReviewEngine } from "../../../src/agentsmith/engine.js";
import { repositoryGraph } from "../../../src/core/graph/index.js";
import { emptyReviewCoverage } from "../../../src/core/reviewer.js";
import { loadStructuredRules } from "../../../src/agentsmith/rules.js";
import {
  buildCandidateProjection,
  buildProjection,
  buildWorkItems,
  rankWorkItems,
  routeReview,
  selectWorkItems,
} from "../../../src/agentsmith/projection.js";
import type { EngineExecution } from "../../../src/agentsmith/engine-types.js";
import { formatAgentSmithReview } from "../../../src/agentsmith/report.js";
import { AGENTSMITH_STRATEGY_HASH } from "../../../src/agentsmith/strategy.js";
import { collectEvalMetrics } from "./eval-metrics.js";
import { PlannerReviewProvider, RecordedReviewProvider } from "./eval-provider.js";
import { corpusHash, listEvalCases, materializeEvalRun, readEvalCase, readStageReplay } from "./case.js";
import { evaluateStages, formatStageScorecard, type EvalStage } from "./stage-score.js";
import { findingMatches, type ExpectedFinding } from "./matching.js";
import { aggregateStage1Metrics, scoreStage1Run } from "./stage-1.js";
import { deriveEvalStatus, evaluateOracleResolutions } from "./oracle-resolution.js";
import { evaluationStages } from "./case.js";

export type EvalMode =
  "holistic" | "partitioned-local" | "partitioned-evidence" | "partitioned-interactions" | "hybrid";
export type EvalReplayMode = "live" | "recorded" | "stage" | "isolated";
export type EvalModelTarget = "small" | "large";
type InspectionTargets = { files: string[]; symbols: string[]; edges: string[] };
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

export function configureEvalModelTarget(config: AgentSmithConfig, target: EvalModelTarget): AgentSmithConfig {
  const capability = target === "small" ? "small" : "strong";
  const candidates = config.model_profiles.filter((profile) => profile.reviewCapability === capability);
  const candidate = candidates.find((profile) => profile.id === config.models.candidate) ?? candidates[0];
  const verifier = candidates.find((profile) => profile.id === config.models.verifier) ?? candidates[1] ?? candidate;
  if (!candidate || !verifier)
    throw new Error(`AgentSmith ${target} model profile is not configured in the locked policy`);
  return {
    ...config,
    models: {
      ...config.models,
      candidate: candidate.id,
      verifier: verifier.id,
      ...(target === "small" ? { scout: undefined } : {}),
    },
  };
}

export interface EvalCoverageBudgetInput {
  coverage: {
    timeout?: unknown;
    omissions: Array<{ reason: string }>;
  };
  errors: string[];
  providerFailures?: unknown[];
  incompleteReasons?: Array<{ kind: string }>;
}

/** Partial execution is not itself a budget failure; preserve the root cause. */
export function isCoverageBudgetFailure(input: EvalCoverageBudgetInput): boolean {
  return (
    Boolean(input.coverage.timeout) ||
    input.errors.length > 0 ||
    (input.providerFailures?.length ?? 0) > 0 ||
    input.coverage.omissions.some((omission) => ["token-budget", "timeout", "provider-failure"].includes(omission.reason)) ||
    (input.incompleteReasons ?? []).some((reason) =>
      ["unfinished-work-item", "unadjudicated-candidate", "material-omission", "evidence-packing-budget"].includes(reason.kind),
    )
  );
}

function requiredProfiles(config: AgentSmithConfig): ModelProfile[] {
  const profiles = new Map(config.model_profiles.map((profile) => [profile.id, profile]));
  return [config.models.candidate, config.models.verifier]
    .filter((id): id is string => Boolean(id))
    .map((id) => profiles.get(id))
    .filter((profile): profile is ModelProfile => Boolean(profile));
}

export async function validateEvalModelTarget(opts: {
  config: AgentSmithConfig;
  target: EvalModelTarget;
  provider?: ReviewProvider;
}): Promise<AgentSmithConfig> {
  const config = configureEvalModelTarget(opts.config, opts.target);
  const missingProfile = requiredProfiles(config).length < 1;
  if (missingProfile) throw new Error(`AgentSmith ${opts.target} model profile is not configured in the locked policy`);
  const provider = opts.provider ?? new OllamaProvider(config);
  const health = await provider.health();
  if (!health.ok) throw new Error(`AgentSmith ${opts.target} provider unavailable: ${health.error ?? "health check failed"}`);
  const installed = new Set<string>(health.models);
  const missingModels = [...new Set(requiredProfiles(config).map((profile) => profile.model))].filter(
    (model) => ![...installed].some((found) => found === model || found.startsWith(`${model}:`)),
  );
  if (missingModels.length)
    throw new Error(`AgentSmith ${opts.target} model not installed: ${missingModels.join(", ")}`);
  return config;
}

function modeConfig(mode: EvalMode, config: NonNullable<ReturnType<typeof resolveConfig>["config"]["agentsmith"]>) {
  const cloned = structuredClone(config);
  cloned.cache = false;
  cloned.mode = mode === "holistic" ? "holistic" : mode === "hybrid" ? "hybrid" : "partitioned";
  return cloned;
}

type EvaluationResultView = {
  findings: ReviewFinding[];
  outcome: "clear" | "findings" | "incomplete" | null;
  status: "completed" | "partial" | "error" | "stale";
  coverage: ReturnType<typeof emptyReviewCoverage>;
  errors?: string[];
  incompleteReasons?: Array<{ kind: string; id?: string; detail: string }>;
};

/** Build deterministic pipeline stages without health checks or model calls. */
async function prepareDeterministicEvaluation(opts: {
  root: string;
  scope: Awaited<ReturnType<typeof readEvalCase>>["trace"]["scope"];
  config: NonNullable<ReturnType<typeof resolveConfig>["config"]["agentsmith"]>;
  assetRoot?: string;
  deterministicReport?: string;
  mode: EvalMode;
}): Promise<{ execution: EngineExecution; result: EvaluationResultView }> {
  const candidateProfile = opts.config.model_profiles.find((profile) => profile.id === opts.config.models.candidate) ?? opts.config.model_profiles[0];
  const verifierProfile = opts.config.model_profiles.find((profile) => profile.id === opts.config.models.verifier) ?? candidateProfile;
  if (!candidateProfile || !verifierProfile) throw new Error("AgentSmith model profiles are not configured");
  const graph = await repositoryGraph(opts.root).getContext(opts.scope, Number.MAX_SAFE_INTEGER, opts.config.graph);
  const rules = loadStructuredRules(opts.assetRoot);
  const full = buildProjection({
    scope: opts.scope,
    graph,
    profile: candidateProfile,
    rules,
    kind: "full",
    deterministicReport: opts.deterministicReport,
  });
  const compact = buildProjection({
    scope: opts.scope,
    graph,
    profile: candidateProfile,
    rules,
    kind: "compact",
    deterministicReport: opts.deterministicReport,
  });
  const route = routeReview({
    requestedMode: opts.config.mode,
    candidate: candidateProfile,
    routing: opts.config.routing,
    full,
    compact,
  });
  const workItems = route.mode === "holistic"
    ? []
    : buildWorkItems({
        projection: full,
        graph,
        profile: candidateProfile,
        policy: opts.config.partitioned,
        rules,
        inputBudgetTokens: route.candidateBudget.inputBudgetTokens,
        maxInteractionNeighborsPerSymbol: opts.config.graph.maxInteractionNeighborsPerSymbol,
      });
  const eligible = opts.mode === "partitioned-local" || opts.mode === "partitioned-evidence"
    ? workItems.filter((item) => item.kind === "local")
    : workItems;
  const ranked = rankWorkItems(eligible);
  const candidateBudget = opts.config.partitioned.maxCandidateInputTokens ?? Math.floor(route.candidateBudget.inputBudgetTokens * 2);
  const selection = route.mode === "holistic"
    ? { selected: ranked, omitted: [], tokenOmitted: [], estimatedTokens: 0 }
    : selectWorkItems(ranked, opts.config.partitioned.maxCandidateWorkItems ?? 4, candidateBudget);
  const selected = selection.selected;
  const candidateProjection = route.mode === "holistic" ? full : buildCandidateProjection(full, selected, candidateProfile);
  const selectedIds = new Set(selected.map((item) => item.id));
  const tokenOmittedIds = new Set(selection.tokenOmitted.map((item) => item.id));
  const plannerManifest = ranked.map((item) => ({
    id: item.id,
    kind: item.kind,
    rank: item.rank,
    priority: item.priority ?? 0,
    estimatedTokens: item.estimatedTokens,
    selected: selectedIds.has(item.id),
    tokenOmitted: tokenOmittedIds.has(item.id),
    files: [...new Set(item.code.map((snippet) => snippet.file))],
    symbols: [...new Set([...item.primarySymbols, ...item.relatedSymbols].map((symbol) => `${symbol.file}#${symbol.qualifiedName}`))],
    edges: item.graphEdges.map((edge) => `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`),
    changedRegions: item.changedRegions,
    promptVisibleRanges: item.promptVisibleRanges,
    rankFactors: item.rankFactors,
    selectionReason: item.selectionReason,
  }));
  const coverage = {
    ...emptyReviewCoverage(opts.scope),
    selection: selection.omitted.length ? ("bounded" as const) : ("full" as const),
    changedSymbols: graph.changedSymbols.length,
    localUnitsGenerated: ranked.filter((item) => item.kind === "local").length,
    interactionUnitsGenerated: ranked.filter((item) => item.kind === "interaction").length,
    candidateTokenBudget: candidateBudget,
    candidateTokensEstimated: selection.estimatedTokens,
    selectedWorkItems: selected.length,
    omittedWorkItems: selection.omitted.length,
    tokenBudgetOmissions: selection.tokenOmitted.length,
    omissions: selection.omitted.map((item) => ({ kind: "work-item", id: item.id, reason: tokenOmittedIds.has(item.id) ? "token-budget" : "lower-ranked" })),
  };
  const execution = {
    rankingConfig: { maxDegreeBoost: 20, degreeCap: 16 },
    graphSnapshot: graph.snapshot,
    graphManifest: {
      changedSymbols: graph.changedSymbols,
      nodes: graph.nodes.map((node) => node.symbol),
      edges: graph.edges,
      selectedNodeKeys: graph.selectedNodeKeys,
      omittedNodeKeys: graph.omittedNodeKeys,
    },
    mode: route.mode,
    reviewPath: "generic" as const,
    route,
    modelProfiles: { candidate: candidateProfile, verifier: verifierProfile },
    projection: candidateProjection,
    sourceProjection: full,
    candidateProjection,
    compactProjection: compact,
    workItems: selected,
    candidateBatches: [],
    candidates: [],
    evidence: {},
    evidenceOutcomes: {},
    verification: [],
    candidateResolutions: [],
    coverage,
    errors: [],
    inputTokens: 0,
    outputTokens: 0,
    plannerManifest,
    stageTimingsMs: {},
  } satisfies EngineExecution;
  return { execution, result: { findings: [], outcome: null, status: "completed", coverage } };
}

function evaluationDiagnostics(execution: { execution: EngineExecution; result: { incompleteReasons?: unknown[] } }) {
  return {
    graphManifest: execution.execution.graphManifest,
    projection: {
      sourceCode: (execution.execution.sourceProjection ?? execution.execution.projection).code,
      candidateCode: (execution.execution.candidateProjection ?? execution.execution.projection).code,
      audit: (execution.execution.candidateProjection ?? execution.execution.projection).audit,
      omissions: (execution.execution.candidateProjection ?? execution.execution.projection).omissions,
      dependencySummary: (execution.execution.candidateProjection ?? execution.execution.projection).dependencySummary,
    },
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
    evidenceOutcomes: execution.execution.evidenceOutcomes,
    plannerManifest: execution.execution.plannerManifest ?? [],
    providerFailures: execution.execution.providerFailures ?? [],
    providerDiagnostics: execution.execution.providerDiagnostics ?? [],
    incompleteReasons: execution.result.incompleteReasons ?? [],
  };
}

export interface EvalProgressEvent {
  tier: EvalReplayMode;
  caseId: string;
  mode: EvalMode;
  iteration: number;
  status: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
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
  allowDrafts?: boolean;
  modelTarget?: EvalModelTarget;
  onProgress?: (event: EvalProgressEvent) => void | Promise<void>;
}) {
  const slugs = opts.slugs?.length ? opts.slugs : listEvalCases(opts.root);
  if (!slugs.length) throw new Error("No AgentSmith eval cases found");
  const definitions = new Map(slugs.map((slug) => [slug, readEvalCase(opts.root, slug)]));
  const activeSlugs = slugs.filter((slug) => definitions.get(slug)!.definition.status === "active");
  const draftSlugs = slugs.filter((slug) => definitions.get(slug)!.definition.status === "draft");
  if (draftSlugs.length && !opts.allowDrafts)
    throw new Error(`Eval case ${draftSlugs[0]} is draft and cannot be replayed`);
  const replay = opts.replay ?? "live";
  const modes = opts.modes?.length ? opts.modes : (["partitioned-interactions"] as EvalMode[]);
  const repeat = Math.max(1, opts.repeat ?? 1);
  const cases = [];
  for (const slug of slugs) {
    const { definition, trace } = definitions.get(slug)!;
    const scored = definition.status === "active";
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
          if (!definition.source.fixture) throw new Error(`Eval case ${slug} has no frozen fixture`);
          const replayWorkspace = materializeEvalRun(opts.root, slug);
          cleanup = replayWorkspace.cleanup;
          const resolved = resolveConfig({ cwd: replayWorkspace.root });
          const policy = resolvePolicyForConfig(resolved);
          const targetConfig = opts.modelTarget
            ? configureEvalModelTarget(resolved.config.agentsmith!, opts.modelTarget)
            : resolved.config.agentsmith!;
          const config = modeConfig(mode, targetConfig);
          const stageReplay = replay === "isolated" ? readStageReplay(opts.root, slug, definition) : undefined;
          const componentInputs = stageReplay?.componentInputs;
          const declaredStages = evaluationStages(definition);
          const selectedStages = (opts.stages?.length
            ? declaredStages.filter((stage) => opts.stages!.includes(stage))
            : declaredStages) as EvalStage[];
          const deterministicOnly =
            selectedStages.length > 0 &&
            selectedStages.every((stage) =>
              ["snapshot", "graph", "planning", "ranking", "selection", "projection"].includes(stage),
            );
          const replayScope = {
            ...trace.scope,
            root: replayWorkspace.root,
            suppliedContext: {
              ...trace.scope.suppliedContext,
              ...Object.fromEntries((stageReplay?.contractEvidence ?? []).map((item) => [item.path, item.content])),
            },
          };
          const provider =
            opts.provider ??
            (replay === "recorded"
              ? new RecordedReviewProvider(trace)
              : replay === "stage"
                ? new PlannerReviewProvider(config)
                : new OllamaProvider(config));
          const execute = (seedCandidates?: ReturnType<typeof readStageReplay>["goldenCandidates"]) =>
            executeReviewEngine({
              root: replayWorkspace.root,
              version: trace.version,
              scope: replayScope,
              config,
              provider,
              profileHash: policy.agentSmith.hash,
              assetRoot: policy.agentSmith.assetRoot,
              deterministicReport: trace.deterministicReport,
              enforceWorkspaceVersion: false,
              variant: {
                includeInteractions: !["partitioned-local", "partitioned-evidence"].includes(mode),
                resolveEvidence: mode !== "partitioned-local",
                ...(seedCandidates ? { seedCandidates } : {}),
              },
            });
          const candidateExecution = replay === "isolated" && !deterministicOnly ? await execute() : undefined;
          const execution = deterministicOnly
            ? await prepareDeterministicEvaluation({
                root: replayWorkspace.root,
                scope: replayScope,
                config,
                assetRoot: policy.agentSmith.assetRoot,
                deterministicReport: trace.deterministicReport,
                mode,
              })
            : await execute(stageReplay?.goldenCandidates);
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
          const benchmark = deterministicOnly
            ? undefined
            : collectEvalMetrics({
                scope: trace.scope,
                result: execution.result as Awaited<ReturnType<typeof executeReviewEngine>>["result"],
                execution: execution.execution,
                durationMs,
              });
          const findingMetrics = scoreFindings(execution.result.findings, expectedFindings);
          const coverageBudgetFailure = isCoverageBudgetFailure({
            coverage: execution.result.coverage,
            errors: execution.execution.errors,
            providerFailures: execution.execution.providerFailures,
            incompleteReasons: execution.result.incompleteReasons,
          });
          const stage1 = scoreStage1Run({
            goldFindings: expectedFindings,
            workItems: execution.execution.workItems,
            candidates: execution.execution.candidates,
            verifiedFindings: execution.result.findings,
            coverageBudgetFailure,
          });
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
            candidateExecution: candidateExecution?.execution,
            graphManifest: componentInputs?.graphManifest as typeof execution.execution.graphManifest,
            planningWorkItems: (componentInputs?.planningWorkItems as typeof execution.execution.plannerManifest) ?? execution.execution.plannerManifest,
            rankingWorkItems: (componentInputs?.rankingWorkItems as typeof execution.execution.plannerManifest) ?? execution.execution.plannerManifest,
            selectionInput: componentInputs?.selection,
            reportMarkdown: deterministicOnly
              ? undefined
              : formatAgentSmithReview(execution.result as Awaited<ReturnType<typeof executeReviewEngine>>["result"]),
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
          const executionStatus = execution.result.status;
          const oracleResolutions = deterministicOnly
            ? []
            : evaluateOracleResolutions({
                definition,
                execution: execution.execution,
                result: execution.result as Awaited<ReturnType<typeof executeReviewEngine>>["result"],
                stage1,
              });
          const primaryResolution =
            oracleResolutions.find((item) => !item.oracleSatisfied) ??
            oracleResolutions.find((item) => item.expectedDisposition === "proven") ??
            oracleResolutions[0] ??
            null;
          const evalStatus = deriveEvalStatus({
            executionStatus,
            oracleResolutions,
            stages,
            errors: recordedMisses.length ? [] : execution.result.errors,
            incompatibilities: recordedMisses,
          });
          results.push({
            mode,
            tier: replay,
            iteration,
            outcome: execution.result.outcome ?? "not-applicable",
            executionStatus,
            evalStatus,
            candidateResolution: primaryResolution?.resolution ?? null,
            reasonCode: primaryResolution?.reasonCode ?? null,
            oracleSatisfied: oracleResolutions.length ? oracleResolutions.every((item) => item.oracleSatisfied) : null,
            oracleResolutions,
            findings: execution.result.findings,
            coverage: execution.result.coverage,
            incompleteReasons: execution.result.incompleteReasons ?? [],
            durationMs,
            metrics: findingMetrics,
            stage1,
            benchmark,
            inspectionTargets,
            stages,
            qualityEvaluable:
              scored && replay !== "stage" && !recordedMisses.length && Boolean(definition.expectations.aggregation),
            outcomeCorrect:
              !deterministicOnly && replay !== "stage" && !recordedMisses.length && expectedOutcome
                ? execution.result.outcome === expectedOutcome
                : null,
            promotedRejectedCandidates,
            inputTokens: execution.execution.inputTokens,
            outputTokens: execution.execution.outputTokens,
            diagnostics: evaluationDiagnostics(execution),
            errors: recordedMisses.length ? [] : (execution.result.errors ?? []),
            incompatibilities: recordedMisses,
            evaluationRole: scored ? ("scored" as const) : ("diagnostic" as const),
            provenance: {
              fixtureDigest: replayWorkspace.fixtureDigest,
              traceSchemaVersion: trace.schemaVersion,
              evaluatorVersion: ENGINE_VERSION,
              policyHash: policy.policyHash,
              agentSmithProfileHash: policy.agentSmith.hash,
              strategyHash: AGENTSMITH_STRATEGY_HASH,
              graphSchemaVersion: execution.execution.graphSnapshot.schemaVersion,
              graphProviderVersions: execution.execution.graphSnapshot.providerVersions,
              rankingConfig: execution.execution.rankingConfig ?? null,
              stageReplaySha256: definition.stageReplay?.sha256 ?? null,
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
            executionStatus: "error" as const,
            evalStatus: incompatible ? ("incompatible" as const) : ("error" as const),
            candidateResolution: null,
            reasonCode: incompatible ? null : ("unknown" as const),
            oracleSatisfied: null,
            oracleResolutions: [],
            findings: [],
            durationMs: Date.now() - started,
            metrics: scoreFindings([], expectedFindings),
            stages: (
              opts.stages ?? [
                "snapshot",
                "graph",
                "planning",
                "ranking",
                "selection",
                "projection",
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
            incompleteReasons: [],
            evaluationRole: scored ? ("scored" as const) : ("diagnostic" as const),
          });
        } finally {
          cleanup?.();
        }
        const completed = results[results.length - 1] as any;
        if (completed) {
          await opts.onProgress?.({
            tier: replay,
            caseId: slug,
            mode,
            iteration,
            status: completed.evalStatus,
            durationMs: completed.durationMs,
            inputTokens: completed.inputTokens,
            outputTokens: completed.outputTokens,
            modelCalls: completed.benchmark?.efficiency?.calls ?? completed.benchmark?.reliability?.callsStarted ?? 0,
          });
        }
      }
    cases.push({
      id: slug,
      kind: definition.kind,
      suite: definition.suite,
      caseStatus: definition.status,
      scored,
      evaluationRole: scored ? ("scored" as const) : ("diagnostic" as const),
      contractFamily: definition.groundTruth?.contractFamily ?? definition.id,
      expectedOutcome,
      results,
    });
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const reportBase = {
    schemaVersion: 8,
    runId,
    label: opts.label ?? null,
    createdAt: new Date().toISOString(),
    corpusHash: corpusHash(opts.root, activeSlugs),
    evaluatedCorpusHash: corpusHash(opts.root, slugs),
    corpus: {
      active: activeSlugs,
      drafts: draftSlugs,
      activeCount: activeSlugs.length,
      draftCount: draftSlugs.length,
    },
    replay,
    modes,
    repeat,
    cases,
  };
  const report = {
    ...reportBase,
    summary: summarizeEvalReport(reportBase),
    stage1Summary: aggregateStage1Metrics({ ...reportBase, cases: cases.filter((item) => item.scored) }),
  };
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
            .filter((stage: any) => stage.stage === stageName && stage.causalStatus !== "downstream-blocked")
            .flatMap((stage: any) =>
              stage.metrics.filter((metric: any) => metric.name === metricName).map((metric: any) => metric.value),
            ),
        ),
      );
      return [key, { mean: mean(values), standardDeviation: standardDeviation(values), runs: values.length }];
    }),
  );
}

export function summarizeEvalReport(report: { cases: Array<{ id: string; scored?: boolean; results: any[] }> }) {
  return report.cases
    .filter((evalCase) => evalCase.scored !== false)
    .flatMap((evalCase) => {
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
  baseline: { corpusHash?: string; cases: Array<{ id: string; scored?: boolean; results: any[] }> },
  current: { corpusHash?: string; cases: Array<{ id: string; scored?: boolean; results: any[] }> },
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
