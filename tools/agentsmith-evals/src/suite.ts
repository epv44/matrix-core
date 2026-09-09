import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../../../src/core/config-resolver.js";
import { resolvePolicyForConfig } from "../../../src/core/resolved-policy.js";
import { corpusHash, listEvalCases, readEvalCase, validateEvalCases } from "./case.js";
import {
  runEvalCases,
  validateEvalModelTarget,
  type EvalMode,
  type EvalModelTarget,
  type EvalProgressEvent,
  type EvalReplayMode,
} from "./eval.js";
import type { EvalStage } from "./stage-score.js";
import {
  applySuiteProgress,
  createSuiteRunStatus,
  finishSuiteRunStatus,
  suiteStatusDirectory,
  suiteStatusPath,
  writeSuiteRunStatus,
  type SuiteRunStatus,
} from "./suite-status.js";

export const CANONICAL_EVAL_MODES: EvalMode[] = [
  "holistic",
  "partitioned-local",
  "partitioned-evidence",
  "partitioned-interactions",
  "hybrid",
];

export const EVALUATION_SCHEMA_VERSION = 4;
export const METRIC_DEFINITION_VERSION = 4;

export const CANONICAL_EVAL_TIERS: Array<{
  tier: EvalReplayMode;
  repetitions: number;
  deterministic: boolean;
}> = [
  { tier: "stage", repetitions: 2, deterministic: true },
  { tier: "recorded", repetitions: 1, deterministic: true },
  { tier: "isolated", repetitions: 1, deterministic: false },
  { tier: "live", repetitions: 3, deterministic: false },
];

export type EvalExecutionStatus = "pass" | "fail" | "partial" | "unstable" | "incompatible" | "unavailable" | "error";
export type EvalSuiteOutputFormat = "text" | "json" | "html";

export function htmlCompanionJsonPath(htmlOutput: string): string {
  const extension = path.extname(htmlOutput);
  return extension ? `${htmlOutput.slice(0, -extension.length)}.json` : `${htmlOutput}.json`;
}

type CoverageMetricName =
  "changedFiles" | "changedSymbols" | "changedLines" | "localUnits" | "interactionUnits" | "workItems";
type CoverageMetricValue = { reviewed?: number; eligible?: number; rate?: number | null };

interface ResultLike {
  mode: string;
  tier?: string;
  iteration?: number;
  outcome?: string;
  /** Runtime completion state. This is not an eval verdict. */
  executionStatus?: string;
  /** Oracle-relative eval verdict. */
  evalStatus?: EvalExecutionStatus;
  /** Legacy pre-v3 field. */
  status?: string;
  candidateResolution?: "proven" | "disproven" | "unproven" | "missed" | null;
  reasonCode?: string | null;
  oracleSatisfied?: boolean | null;
  oracleResolutions?: Array<{
    oracleId: string;
    expectedDisposition: string;
    resolution: string;
    oracleSatisfied: boolean;
    reasonCode?: string | null;
  }>;
  outcomeCorrect?: boolean | null;
  qualityEvaluable?: boolean;
  findings?: unknown[];
  coverage?: unknown;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  metrics?: {
    truePositive?: number;
    falsePositive?: number;
    falseNegative?: number;
    precision?: number;
    recall?: number;
    f1?: number;
  };
  stage1?: {
    eligibleGold?: number;
    selectedGold?: number;
    candidateTruePositive?: number;
    candidateFalsePositive?: number;
    verifiedTruePositive?: number;
    verifiedFalsePositive?: number;
    attributions?: Record<string, number>;
  };
  contractShadow?: unknown;
  benchmark?: {
    coverage?: Partial<Record<CoverageMetricName, CoverageMetricValue>> & { globalScan?: string };
    candidates?: { generated?: number; adjudicated?: number; adjudicationRate?: number | null };
    evidence?: {
      requests?: number;
      validRequests?: number;
      requestValidityRate?: number | null;
      resolvedRecords?: number;
      relevantRecords?: number;
      relevanceRate?: number | null;
    };
    reliability?: {
      callsStarted?: number;
      providerFailures?: number;
      structuredRepairs?: number;
      errors?: number;
      timeout?: boolean;
    };
    efficiency?: { durationMs?: number; inputTokens?: number; outputTokens?: number; calls?: number };
    honesty?: { honest?: boolean };
  };
  stages?: Array<{
    stage?: string;
    evaluation?: string;
    causalStatus?: string;
    blockedBy?: string[];
    metrics?: Array<{ name?: string; value?: unknown; numerator?: number; denominator?: number; direction?: string }>;
    diagnostics?: string[];
    diagnosticOnly?: string[];
  }>;
  errors?: string[];
  incompatibilities?: string[];
  incompleteReasons?: Array<{ kind: string; id?: string; detail: string }>;
}

interface CaseLike {
  id: string;
  kind?: string;
  suite?: string;
  caseStatus?: string;
  contractFamily?: string;
  scored?: boolean;
  evaluationRole?: "scored" | "diagnostic";
  results: ResultLike[];
}

export interface EvalReportLike {
  replay: EvalReplayMode;
  cases: CaseLike[];
  [key: string]: unknown;
}

export interface SuiteMetric {
  value: number | null;
  numerator?: number;
  denominator?: number;
  direction: "higher" | "lower" | "exact";
}

type MetricValue = number | boolean;

function metricLeaves(value: unknown, prefix: string): Array<[string, MetricValue]> {
  if (typeof value === "number" && Number.isFinite(value)) return [[prefix, value]];
  if (typeof value === "boolean") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => metricLeaves(item, `${prefix}[${index}]`));
  return Object.entries(value).flatMap(([key, item]) => metricLeaves(item, prefix ? `${prefix}.${key}` : key));
}

function aggregateMetricLeaves(results: ResultLike[]): Record<string, SuiteMetric> {
  const values = new Map<string, MetricValue[]>();
  for (const result of results) {
    for (const [source, value] of Object.entries({
      metrics: result.metrics,
      stage1: result.stage1,
      coverage: result.coverage,
      benchmark: result.benchmark,
      contractShadow: result.contractShadow,
    })) {
      for (const [name, metric] of metricLeaves(value, source)) {
        const current = values.get(name) ?? [];
        current.push(metric);
        values.set(name, current);
      }
    }
    for (const stage of result.stages ?? []) {
      for (const metric of stage.metrics ?? []) {
        if (typeof metric.value !== "number" && typeof metric.value !== "boolean") continue;
        const name = `stages.${stage.stage ?? "unknown"}.${metric.name ?? "unnamed"}`;
        const current = values.get(name) ?? [];
        current.push(metric.value);
        values.set(name, current);
      }
    }
  }
  return Object.fromEntries(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, items]) => [
        name,
        meanMetric(items.map((item) => (typeof item === "boolean" ? (item ? 1 : 0) : item))),
      ]),
  );
}

export interface EvalSuiteBaseline {
  schemaVersion: 1 | 2 | 3 | 4;
  reportKind: "agentsmith-eval-suite-baseline";
  createdAt: string;
  suite?: string;
  modelTarget?: EvalModelTarget;
  corpusHash: string;
  configurationHash: string;
  metricCatalog: string[];
  topline: unknown;
  perCase: unknown;
  evidence: Array<{
    tier: EvalReplayMode;
    repetitions: number;
    deterministic: boolean;
    evalStatus?: EvalExecutionStatus;
    /** Legacy v1/v2 field. */
    status?: EvalExecutionStatus;
    reportHash: string;
  }>;
  evaluationSchemaVersion?: number;
  metricDefinitionVersion?: number;
  comparability?: SuiteComparability;
}

export interface SuiteComparability {
  baselineSchemaVersion: number | null;
  directlyComparable: string[];
  newMetrics: string[];
  redefinedMetrics: string[];
  nonComparableMetrics: string[];
  replacementMode: "observational-only";
}

function suiteComparability(baseline?: EvalSuiteBaseline | null): SuiteComparability {
  const baselineSchemaVersion = baseline?.schemaVersion ?? null;
  const newMetrics = [
    "topline.oracleResolutionAccuracy",
    "topline.oracleUnprovenRate",
    "topline.oracleMissRate",
    "topline.reliability.executionPartialRate",
    "case.*.oracleResolutions",
    "case.*.candidateResolution",
    "case.*.reasonCode",
    "stages.graph.microEdge*",
    "stages.graph.*Adjacency*",
    "stages.graph.*Degree*",
    "stages.planning.riskFactor*",
    "stages.planning.graphFactorCoverage",
    "stages.ranking.*",
    "stages.selection.*",
    "case.*.metrics.stages.graph.microEdge*",
    "case.*.metrics.stages.ranking.*",
    "case.*.metrics.stages.selection.*",
  ];
  const redefinedMetrics = [
    "topline.reliability.partialReviewRate (removed; replaced by executionPartialRate)",
    "case.*.status (split into evalStatus and executionStatus)",
    "stages.planning.riskRankOrderRecall",
    "stages.planning.riskMustOutrankAccuracy",
    "stages.planning.riskPriorityAssertionAccuracy",
    "stages.planning.selection*",
    "case.*.metrics.stages.planning.riskRankOrderRecall",
    "case.*.metrics.stages.planning.riskMustOutrankAccuracy",
    "case.*.metrics.stages.planning.riskPriorityAssertionAccuracy",
  ];
  return {
    baselineSchemaVersion,
    directlyComparable: [
      "topline.finding.precision",
      "topline.finding.recall",
      "topline.finding.f1",
      "topline.selectionRecall",
      "topline.candidateFindingRecall",
      "topline.candidateFindingPrecision",
      "topline.verifiedFindingRecall",
      "topline.verifiedFindingPrecision",
      "topline.efficiency.*",
      "topline.reliability.providerFailures",
      "topline.reliability.errors",
      "topline.reliability.timeouts",
      "case.*.topline finding/selection/candidate/verified/efficiency metrics",
    ],
    newMetrics,
    redefinedMetrics,
    nonComparableMetrics: [...newMetrics, ...redefinedMetrics],
    replacementMode: "observational-only",
  };
}

const statusPrecedence: EvalExecutionStatus[] = [
  "error",
  "unavailable",
  "incompatible",
  "unstable",
  "fail",
  "partial",
  "pass",
];

function reduceStatuses(statuses: EvalExecutionStatus[]): EvalExecutionStatus {
  return statusPrecedence.find((status) => statuses.includes(status)) ?? "unavailable";
}

function summarizeRuntimeStatus(results: ResultLike[]) {
  const states = results.map((result) => result.executionStatus ?? result.status ?? "unavailable");
  const precedence = ["error", "stale", "partial", "completed"];
  return precedence.find((state) => states.includes(state)) ?? "unavailable";
}

export function resultEvalStatus(result: ResultLike): EvalExecutionStatus {
  if (result.errors?.length || result.executionStatus === "error" || result.status === "error") return "error";
  if (result.executionStatus === "unavailable" || result.status === "unavailable") return "unavailable";
  if (result.incompatibilities?.length || result.stages?.some((stage) => stage.evaluation === "incompatible"))
    return "incompatible";
  if (result.evalStatus) return result.evalStatus;
  if (result.stages?.some((stage) => stage.causalStatus === "root-failure")) return "fail";
  if (result.stages?.some((stage) => stage.evaluation === "not-evaluable")) {
    const evaluatedStages = result.stages.filter((stage) => ["executed", "observed"].includes(stage.evaluation ?? ""));
    return evaluatedStages.length ? "partial" : "unavailable";
  }
  const snapshot = result.stages?.find((stage) => stage.stage === "snapshot");
  if (
    snapshot?.metrics?.some(
      (metric) => ["fileRecall", "filePrecision"].includes(metric.name ?? "") && metric.value !== 1,
    )
  )
    return "fail";
  if (result.qualityEvaluable && result.outcomeCorrect === false) return "fail";
  if (result.executionStatus === "partial" || result.status === "partial" || result.outcome === "incomplete") return "partial";
  const evaluatedStages = result.stages?.filter((stage) => ["executed", "observed"].includes(stage.evaluation ?? ""));
  const applicableStages = result.stages?.filter((stage) => stage.evaluation !== "not-applicable");
  if (applicableStages?.length && !evaluatedStages?.length) return "unavailable";
  return "pass";
}

/** @deprecated Pre-v3 name retained for readers of older integrations. */
export const resultExecutionStatus = resultEvalStatus;

function stableData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !["durationMs", "elapsedMs", "iteration", "wallMs", "providerMs"].includes(key) &&
          !/duration.*ms$/i.test(key) &&
          !key.endsWith("ProviderMs"),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableData(item)]),
  );
}

function stableResultValue(result: ResultLike): unknown {
  return {
    mode: result.mode,
    tier: result.tier,
    outcome: result.outcome,
    executionStatus: result.executionStatus ?? result.status,
    evalStatus: result.evalStatus,
    candidateResolution: result.candidateResolution,
    reasonCode: result.reasonCode,
    oracleSatisfied: result.oracleSatisfied,
    oracleResolutions: stableData(result.oracleResolutions),
    outcomeCorrect: result.outcomeCorrect,
    qualityEvaluable: result.qualityEvaluable,
    findings: result.findings,
    coverage: stableData(result.coverage),
    incompleteReasons: stableData(result.incompleteReasons),
    stages: result.stages?.map((stage) => ({
      stage: stage.stage,
      evaluation: stage.evaluation,
      causalStatus: stage.causalStatus,
      metrics: stage.metrics
        ?.filter((metric) => !["wallMs", "providerMs"].includes(metric.name ?? ""))
        .map((metric) => ({
          name: metric.name,
          value: stableData(metric.value),
          numerator: metric.numerator,
          denominator: metric.denominator,
          direction: metric.direction,
        })),
      diagnostics: stage.diagnostics,
      diagnosticOnly: stage.diagnosticOnly,
    })),
    errors: result.errors,
    incompatibilities: result.incompatibilities,
  };
}

export function resultSemanticFingerprint(result: ResultLike): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableResultValue(result)))
    .digest("hex");
}

function summarizeIncompleteReasons(results: ResultLike[]) {
  const reasons = results.flatMap((result) => result.incompleteReasons ?? []);
  const counts = new Map<string, number>();
  const details = new Map<string, { kind: string; id?: string; detail: string }>();
  for (const reason of reasons) {
    counts.set(reason.kind, (counts.get(reason.kind) ?? 0) + 1);
    details.set(`${reason.kind}:${reason.id ?? ""}:${reason.detail}`, reason);
  }
  return {
    counts: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    details: [...details.values()].sort((left, right) =>
      `${left.kind}:${left.id ?? ""}:${left.detail}`.localeCompare(`${right.kind}:${right.id ?? ""}:${right.detail}`),
    ),
  };
}

export function summarizeExecutionGroup(results: ResultLike[], deterministic: boolean) {
  const fingerprints = [...new Set(results.map(resultSemanticFingerprint))];
  const stable = !deterministic || fingerprints.length <= 1;
  const statuses = results.map(resultEvalStatus);
  const resultStatus = reduceStatuses(statuses);
  return {
    status: resultStatus === "pass" && !stable ? ("unstable" as const) : resultStatus,
    deterministic,
    stable,
    repetitions: results.length,
    fingerprints,
    runStatuses: statuses,
  };
}

export function summarizeEvalReportStatus(report: EvalReportLike, deterministic: boolean) {
  const cases = report.cases.map((evalCase) => {
    const modes = [...new Set(evalCase.results.map((result) => result.mode))];
    const modeStatuses = modes.map((mode) => ({
      mode,
      ...summarizeExecutionGroup(
        evalCase.results.filter((result) => result.mode === mode),
        deterministic,
      ),
    }));
    return {
      caseId: evalCase.id,
      evaluationRole: evalCase.scored === false ? ("diagnostic" as const) : ("scored" as const),
      status: reduceStatuses(modeStatuses.map((item) => item.status)),
      modes: modeStatuses,
    };
  });
  const scoredCases = cases.filter((item) => item.evaluationRole === "scored");
  const diagnosticCases = cases.filter((item) => item.evaluationRole === "diagnostic");
  return {
    status: scoredCases.length ? reduceStatuses(scoredCases.map((item) => item.status)) : ("unavailable" as const),
    diagnosticStatus: diagnosticCases.length
      ? reduceStatuses(diagnosticCases.map((item) => item.status))
      : ("unavailable" as const),
    cases,
  };
}

export function summarizeSuiteReports(reports: EvalReportLike[], tiers = CANONICAL_EVAL_TIERS) {
  const tierStatuses = reports.map((report) => {
    const configuration = tiers.find((item) => item.tier === report.replay);
    if (!configuration) throw new Error(`Unexpected eval tier: ${report.replay}`);
    return {
      tier: report.replay,
      repetitions: configuration.repetitions,
      deterministic: configuration.deterministic,
      ...summarizeEvalReportStatus(report, configuration.deterministic),
    };
  });
  return {
    status: tierStatuses.length ? reduceStatuses(tierStatuses.map((item) => item.status)) : ("unavailable" as const),
    diagnosticStatus: tierStatuses.length
      ? reduceStatuses(tierStatuses.map((item) => item.diagnosticStatus))
      : ("unavailable" as const),
    tiers: tierStatuses,
  };
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function ratioMetric(
  numerator: number,
  denominator: number,
  direction: SuiteMetric["direction"] = "higher",
): SuiteMetric {
  return { value: denominator ? numerator / denominator : null, numerator, denominator, direction };
}

function meanMetric(
  values: Array<number | null | undefined>,
  direction: SuiteMetric["direction"] = "higher",
): SuiteMetric {
  const present = finite(values);
  return {
    value: present.length ? present.reduce((total, value) => total + value, 0) / present.length : null,
    denominator: present.length,
    direction,
  };
}

function aggregateStageMetrics(results: ResultLike[]) {
  const names = new Map<
    string,
    {
      values: Array<number | boolean>;
      ratios: Array<{ numerator: number; denominator: number }>;
      direction: SuiteMetric["direction"];
    }
  >();
  for (const result of results)
    for (const stage of result.stages ?? [])
      for (const metric of stage.metrics ?? []) {
        if (metric.value === null || !["number", "boolean"].includes(typeof metric.value)) continue;
        const key = `${stage.stage}.${metric.name}`;
        const entry = names.get(key) ?? {
          values: [],
          ratios: [],
          direction: (metric.direction as SuiteMetric["direction"] | undefined) ?? "higher",
        };
        entry.values.push(metric.value as number | boolean);
        if (typeof metric.numerator === "number" && typeof metric.denominator === "number")
          entry.ratios.push({ numerator: metric.numerator, denominator: metric.denominator });
        names.set(key, entry);
      }
  return Object.fromEntries(
    [...names.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => [
        name,
        item.ratios.length === item.values.length && item.ratios.length > 0
          ? ratioMetric(
              sum(item.ratios.map((ratio) => ratio.numerator)),
              sum(item.ratios.map((ratio) => ratio.denominator)),
              item.direction,
            )
          : meanMetric(
              item.values.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value)),
              item.direction,
            ),
      ]),
  );
}

export function aggregateSuiteMetrics(results: ResultLike[]) {
  const quality = results.filter((result) => result.qualityEvaluable);
  const findingTruePositive = sum(quality.map((result) => result.metrics?.truePositive));
  const findingFalsePositive = sum(quality.map((result) => result.metrics?.falsePositive));
  const findingFalseNegative = sum(quality.map((result) => result.metrics?.falseNegative));
  const eligibleGold = sum(results.map((result) => result.stage1?.eligibleGold));
  const selectedGold = sum(results.map((result) => result.stage1?.selectedGold));
  const candidateTruePositive = sum(results.map((result) => result.stage1?.candidateTruePositive));
  const candidateFalsePositive = sum(results.map((result) => result.stage1?.candidateFalsePositive));
  const verifiedTruePositive = sum(results.map((result) => result.stage1?.verifiedTruePositive));
  const verifiedFalsePositive = sum(results.map((result) => result.stage1?.verifiedFalsePositive));
  const findingPrecision = ratioMetric(findingTruePositive, findingTruePositive + findingFalsePositive);
  const findingRecall = ratioMetric(findingTruePositive, findingTruePositive + findingFalseNegative);
  const f1Value =
    findingPrecision.value === null || findingRecall.value === null
      ? null
      : findingPrecision.value + findingRecall.value
        ? (2 * findingPrecision.value * findingRecall.value) / (findingPrecision.value + findingRecall.value)
        : 0;
  const coverageKeys: CoverageMetricName[] = [
    "changedFiles",
    "changedSymbols",
    "changedLines",
    "localUnits",
    "interactionUnits",
    "workItems",
  ];
  const coverage = Object.fromEntries(
    coverageKeys.map((key) => {
      const values = results.map((result) => result.benchmark?.coverage?.[key]);
      return [
        key,
        ratioMetric(sum(values.map((value) => value?.reviewed)), sum(values.map((value) => value?.eligible))),
      ];
    }),
  );
  const attributions = new Map<string, number>();
  for (const result of results)
    for (const [name, value] of Object.entries(result.stage1?.attributions ?? {}))
      attributions.set(name, (attributions.get(name) ?? 0) + value);
  const partialRuns = results.filter(
    (result) => (result.executionStatus ?? result.status) === "partial",
  ).length;
  const oracleRows = results.flatMap((result) => result.oracleResolutions ?? []);
  const resolutionAttributions = new Map<string, number>();
  for (const row of oracleRows) {
    if (!row.reasonCode) continue;
    resolutionAttributions.set(row.reasonCode, (resolutionAttributions.get(row.reasonCode) ?? 0) + 1);
  }
  const calls = sum(results.map((result) => result.benchmark?.reliability?.callsStarted));
  const inputTokens = sum(results.map((result) => result.inputTokens ?? result.benchmark?.efficiency?.inputTokens));
  const outputTokens = sum(results.map((result) => result.outputTokens ?? result.benchmark?.efficiency?.outputTokens));
  return {
    runs: results.length,
    metrics: aggregateMetricLeaves(results),
    statusCounts: Object.fromEntries(
      statusPrecedence.map((status) => [
        status,
        results.filter((result) => resultEvalStatus(result) === status).length,
      ]),
    ),
    finding: {
      precision: findingPrecision,
      recall: findingRecall,
      f1: { value: f1Value, direction: "higher" as const },
      truePositive: findingTruePositive,
      falsePositive: findingFalsePositive,
      falseNegative: findingFalseNegative,
    },
    selectionRecall: ratioMetric(selectedGold, eligibleGold),
    candidateFindingRecall: ratioMetric(candidateTruePositive, eligibleGold),
    candidateFindingPrecision: ratioMetric(candidateTruePositive, candidateTruePositive + candidateFalsePositive),
    verifiedFindingRecall: ratioMetric(verifiedTruePositive, eligibleGold),
    verifiedFindingPrecision: ratioMetric(verifiedTruePositive, verifiedTruePositive + verifiedFalsePositive),
    oracleResolutionAccuracy: ratioMetric(
      oracleRows.filter((row) => row.oracleSatisfied).length,
      oracleRows.length,
    ),
    oracleUnprovenRate: ratioMetric(
      oracleRows.filter((row) => row.resolution === "unproven").length,
      oracleRows.length,
      "lower",
    ),
    oracleMissRate: ratioMetric(
      oracleRows.filter((row) => row.resolution === "missed").length,
      oracleRows.length,
      "lower",
    ),
    coverage,
    reliability: {
      providerFailures: sum(results.map((result) => result.benchmark?.reliability?.providerFailures)),
      errors: sum(results.map((result) => result.benchmark?.reliability?.errors)),
      timeouts: results.filter((result) => result.benchmark?.reliability?.timeout).length,
      structuredRepairs: sum(results.map((result) => result.benchmark?.reliability?.structuredRepairs)),
      executionPartialRate: ratioMetric(partialRuns, results.length, "lower"),
      honestRunRate: ratioMetric(results.filter((result) => result.benchmark?.honesty?.honest).length, results.length),
    },
    efficiency: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      modelCalls: calls,
      meanLatencyMs: meanMetric(
        results.map((result) => result.durationMs),
        "lower",
      ),
    },
    evidence: {
      requestValidity: ratioMetric(
        sum(results.map((result) => result.benchmark?.evidence?.validRequests)),
        sum(results.map((result) => result.benchmark?.evidence?.requests)),
      ),
      relevance: meanMetric(results.map((result) => result.benchmark?.evidence?.relevanceRate)),
    },
    candidateAdjudication: meanMetric(results.map((result) => result.benchmark?.candidates?.adjudicationRate)),
    outcomeAccuracy: ratioMetric(
      results.filter((result) => result.outcomeCorrect === true).length,
      results.filter((result) => result.outcomeCorrect !== null && result.outcomeCorrect !== undefined).length,
    ),
    attributions: Object.fromEntries([...attributions.entries()].sort(([left], [right]) => left.localeCompare(right))),
    resolutionAttributions: Object.fromEntries(
      [...resolutionAttributions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
    stageMetrics: aggregateStageMetrics(results),
  };
}

export type PipelineMetricUnit = "rate" | "boolean-rate" | "count" | "milliseconds" | "tokens";
export type PipelineStageStatus = "pass" | "fail" | "partial" | "blocked" | "not-applicable" | "not-evaluable";

export interface PipelineStageDefinition {
  id: EvalStage;
  name: string;
  purpose: string;
  primaryMetrics: string[];
}

export interface PipelineMetricSummary {
  name: string;
  value: number | null;
  numerator?: number;
  denominator?: number;
  direction: "higher" | "lower" | "exact";
  unit: PipelineMetricUnit;
  aggregation: "ratio" | "mean" | "boolean-rate";
  runs: number;
  primary: boolean;
}

export interface PipelineStageSummary extends PipelineStageDefinition {
  status: PipelineStageStatus;
  runs: number;
  applicableRuns: number;
  evaluatedRuns: number;
  partialRuns: number;
  blockedRuns: number;
  notEvaluableRuns: number;
  notApplicableRuns: number;
  blockedBy: EvalStage[];
  diagnostics: string[];
  diagnosticOnly: string[];
  metrics: PipelineMetricSummary[];
}

export const PIPELINE_STAGE_DEFINITIONS: PipelineStageDefinition[] = [
  {
    id: "snapshot",
    name: "Snapshot",
    purpose: "Identify the changed repository surface and validate the frozen fixture.",
    primaryMetrics: ["fileRecall", "filePrecision", "fixtureValidated"],
  },
  {
    id: "graph",
    name: "Graph retrieval",
    purpose: "Resolve changed symbols, dependency edges, and reachable paths.",
    primaryMetrics: [
      "filesRecall",
      "symbolsRecall",
      "edgesRecall",
      "pathRecall",
      "microEdgeRecall",
      "microEdgePrecision",
      "macroAdjacencyRecall",
      "minimumNodeAdjacencyRecall",
      "neighborDegreeAccuracy",
      "exactResolutionRate.calls",
      "unresolvedTargetRate.calls",
    ],
  },
  {
    id: "planning",
    name: "Planning",
    purpose: "Choose the review route, construct candidate units, and calculate risk factors.",
    primaryMetrics: ["routeCorrect", "uniqueWorkItemRate", "candidateBudgetRespected", "graphFactorCoverage"],
  },
  {
    id: "ranking",
    name: "Ranking",
    purpose: "Assign risk scores and deterministically order eligible work items.",
    primaryMetrics: ["riskRankOrderRecall", "riskMustOutrankAccuracy", "riskPriorityAssertionAccuracy", "degreeOrderingAccuracy"],
  },
  {
    id: "selection",
    name: "Selection",
    purpose: "Select a bounded feasible subset without recomputing risk.",
    primaryMetrics: ["selectionExpectedRecall", "selectionConstrainedRunRecall", "selectionRequiredReservedRecall", "selectionRankOrderPreserved", "selectionRequiredKindRecall", "selectionWorkItemBudgetRespected", "selectionTokenBudgetRespected"],
  },
  {
    id: "projection",
    name: "Projection / context assembly",
    purpose: "Assemble relevant code context while respecting context and exclusion limits.",
    primaryMetrics: ["requiredSnippetRecall", "omittedCodeTokenRate", "forbiddenTokenRate"],
  },
  {
    id: "candidates",
    name: "Candidate generation",
    purpose: "Generate possible findings from the selected context.",
    primaryMetrics: ["expectedCandidateRecall", "candidateFindingRecall", "candidateFindingPrecision", "anchorValidity"],
  },
  {
    id: "evidence",
    name: "Evidence retrieval",
    purpose: "Retrieve the caller, consumer, definition, or implementation evidence required by a candidate.",
    primaryMetrics: ["resolutionStatusAccuracy", "requiredFileRecall", "requiredSymbolRecall", "requiredContentRecall"],
  },
  {
    id: "verification",
    name: "Verification",
    purpose: "Adjudicate candidates and publish only supported findings.",
    primaryMetrics: ["verification_accuracy", "citationRate", "grounding_validity", "grounding_specificity", "production_acceptance_accuracy", "verifiedFindingRecall", "verifiedFindingPrecision"],
  },
  {
    id: "aggregation",
    name: "Aggregation",
    purpose: "Convert verified findings into the final case outcome.",
    primaryMetrics: ["precision", "recall", "f1", "outcomeCorrect", "statusCorrect"],
  },
  {
    id: "reporting",
    name: "Reporting",
    purpose: "Render complete, internally consistent output with provenance.",
    primaryMetrics: ["requiredContent", "coverageConsistent", "provenanceComplete"],
  },
];

const booleanPipelineMetrics = new Set([
  "fixtureValidated",
  "routeCorrect",
  "candidateBudgetRespected",
  "selectionWorkItemBudgetRespected",
  "selectionTokenBudgetRespected",
  "snapshotReady",
  "coverageConsistent",
  "provenanceComplete",
]);
const ratePipelineMetrics = new Set([
  "requiredContent",
  "verification_accuracy",
  "grounding_validity",
  "grounding_specificity",
  "citation_contract_accuracy",
  "production_acceptance_accuracy",
  "changedFileOverlap",
  "changedRegionOverlap",
  "categoryCompatibility",
  "severityCompatibility",
  "triggeringValueRecall",
  "violatedInvariantTermRecall",
  "observableImpactTermRecall",
  "titleSimilarity",
  "anchorValidityDiagnostic",
  "evidenceRequestCompletenessDiagnostic",
  "evidenceRequestLocatorValidity",
  "evidenceRequestLocatorScopeValidity",
  "strictOracleOnlyRejection",
]);

function pipelineMetricUnit(name: string): PipelineMetricUnit {
  if (booleanPipelineMetrics.has(name)) return "boolean-rate";
  if (name === "wallMs" || name === "providerMs") return "milliseconds";
  if (ratePipelineMetrics.has(name) || /Recall|Precision|Rate|Accuracy|Correct|Validity|Specificity|^f1$|^precision$|^recall$/i.test(name)) return "rate";
  if (/token/i.test(name)) return "tokens";
  return "count";
}

function aggregatePipelineMetric(name: string, records: Array<{ value: number | boolean | null; numerator?: number; denominator?: number; direction?: string }>, primary: boolean): PipelineMetricSummary {
  const available = records.filter((record) => record.value !== null && record.value !== undefined);
  const direction = (records.find((record) => record.direction)?.direction as PipelineMetricSummary["direction"] | undefined) ?? "higher";
  const unit = pipelineMetricUnit(name);
  if (!available.length) return { name, value: null, direction, unit, aggregation: "mean", runs: 0, primary };
  const ratioRecords = available.filter((record) => typeof record.numerator === "number" && typeof record.denominator === "number");
  if (ratioRecords.length === available.length) {
    const numerator = ratioRecords.reduce((sum, record) => sum + (record.numerator ?? 0), 0);
    const denominator = ratioRecords.reduce((sum, record) => sum + (record.denominator ?? 0), 0);
    return { name, value: denominator ? numerator / denominator : null, numerator, denominator, direction, unit, aggregation: "ratio", runs: available.length, primary };
  }
  const values = available.map((record) => (typeof record.value === "boolean" ? (record.value ? 1 : 0) : record.value as number));
  const value = values.reduce((sum, item) => sum + item, 0) / values.length;
  return {
    name,
    value,
    ...(unit === "boolean-rate" ? { numerator: values.filter((item) => item === 1).length, denominator: values.length } : {}),
    direction,
    unit,
    aggregation: unit === "boolean-rate" ? "boolean-rate" : "mean",
    runs: available.length,
    primary,
  };
}

function pipelineStageStatus(rows: ResultLike["stages"]): PipelineStageStatus {
  const stages = rows ?? [];
  const applicable = stages.filter((stage) => stage.evaluation !== "not-applicable");
  if (!applicable.length) return "not-applicable";
  const evaluated = applicable.filter((stage) => stage.evaluation === "executed" || stage.evaluation === "observed");
  const failed = applicable.some((stage) => stage.causalStatus === "root-failure");
  const blocked = applicable.filter((stage) => stage.causalStatus === "downstream-blocked").length;
  const unavailable = applicable.filter((stage) => stage.evaluation === "not-evaluable" && stage.causalStatus !== "downstream-blocked").length;
  if (failed) return "fail";
  if (!evaluated.length && blocked) return "blocked";
  if (!evaluated.length && unavailable) return "not-evaluable";
  if (blocked || unavailable) return "partial";
  return "pass";
}

function aggregatePipelineStages(results: ResultLike[]): PipelineStageSummary[] {
  return PIPELINE_STAGE_DEFINITIONS.map((definition) => {
    const rows = results.map((result) => result.stages?.find((stage) => stage.stage === definition.id)).filter(Boolean) as NonNullable<ResultLike["stages"]>;
    const applicableRows = rows.filter((row) => row.evaluation !== "not-applicable");
    const applicableResults = results.filter(
      (result) => result.stages?.find((stage) => stage.stage === definition.id)?.evaluation !== "not-applicable",
    );
    const topline = aggregateSuiteMetrics(applicableResults);
    const metricNames = [...new Set(applicableRows.flatMap((row) => row.metrics?.map((metric) => metric.name).filter((name): name is string => Boolean(name)) ?? []))];
    const derived = new Map<string, SuiteMetric>();
    if (definition.id === "candidates" && applicableRows.length) {
      derived.set("candidateFindingRecall", topline.candidateFindingRecall);
      derived.set("candidateFindingPrecision", topline.candidateFindingPrecision);
    }
    if (definition.id === "verification" && applicableRows.length) {
      derived.set("verifiedFindingRecall", topline.verifiedFindingRecall);
      derived.set("verifiedFindingPrecision", topline.verifiedFindingPrecision);
    }
    const metrics = [...new Set([...metricNames, ...derived.keys()])]
      .map((name) => {
        const records = applicableRows
          .flatMap((row) => (row.metrics ?? []).filter((metric) => metric.name === name))
          .map((metric) => ({
            value: (metric.value as number | boolean | null | undefined) ?? null,
            numerator: metric.numerator,
            denominator: metric.denominator,
            direction: metric.direction,
          }));
        if (derived.has(name)) {
          const item = derived.get(name)!;
          return {
            name,
            value: item.value,
            numerator: item.numerator,
            denominator: item.denominator,
            direction: item.direction,
            unit: pipelineMetricUnit(name),
            aggregation: "ratio" as const,
            runs: applicableResults.length,
            primary: definition.primaryMetrics.includes(name),
          };
        }
        return aggregatePipelineMetric(name, records, definition.primaryMetrics.includes(name));
      })
      .sort((left, right) => Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name));
    const statuses = applicableRows.map((row) => pipelineStageStatus([row]));
    const blockedBy = [...new Set(applicableRows.flatMap((row) => row.blockedBy ?? []))].sort() as EvalStage[];
    return {
      ...definition,
      status: pipelineStageStatus(rows),
      runs: rows.length,
      applicableRuns: applicableRows.length,
      evaluatedRuns: applicableRows.filter((row) => row.evaluation === "executed" || row.evaluation === "observed").length,
      partialRuns: statuses.filter((item) => item === "partial").length,
      blockedRuns: statuses.filter((item) => item === "blocked").length,
      notEvaluableRuns: statuses.filter((item) => item === "not-evaluable").length,
      notApplicableRuns: rows.length - applicableRows.length,
      blockedBy,
      diagnostics: [...new Set(applicableRows.flatMap((row) => row.diagnostics ?? []))].sort(),
      diagnosticOnly: [...new Set(applicableRows.flatMap((row) => row.diagnosticOnly ?? []))].sort(),
      metrics,
    };
  });
}

export function aggregateSuiteReport(reports: EvalReportLike[], tiers = CANONICAL_EVAL_TIERS) {
  const status = summarizeSuiteReports(reports, tiers);
  const live = reports.find((report) => report.replay === "live");
  const activeResults = reports.flatMap((report) =>
    report.cases.filter((evalCase) => evalCase.scored !== false).flatMap((evalCase) => evalCase.results),
  );
  const activeLiveResults =
    live?.cases.filter((evalCase) => evalCase.scored !== false).flatMap((evalCase) => evalCase.results) ?? [];
  const caseIds = [...new Set(reports.flatMap((report) => report.cases.map((evalCase) => evalCase.id)))].sort();
  const perCase = caseIds.map((caseId) => {
    const exemplar = reports.flatMap((report) => report.cases).find((evalCase) => evalCase.id === caseId)!;
    const tierRows = reports.map((report) => {
      const evalCase = report.cases.find((candidate) => candidate.id === caseId);
      const tierStatus = status.tiers
        .find((item) => item.tier === report.replay)
        ?.cases.find((item) => item.caseId === caseId);
      return {
        tier: report.replay,
        status: tierStatus?.status ?? "unavailable",
        metrics: aggregateSuiteMetrics(evalCase?.results ?? []),
        modes: tierStatus?.modes ?? [],
      };
    });
    const liveResults = live?.cases.find((evalCase) => evalCase.id === caseId)?.results ?? [];
    const caseResults = reports.flatMap(
      (report) => report.cases.find((candidate) => candidate.id === caseId)?.results ?? [],
    );
    const displayResults = liveResults.length ? liveResults : caseResults;
    const primaryResult =
      displayResults.find((result) => result.oracleSatisfied === false) ??
      displayResults.find((result) => result.candidateResolution !== null && result.candidateResolution !== undefined) ??
      displayResults[0];
    const primaryOracle =
      primaryResult?.oracleResolutions?.find((item) => !item.oracleSatisfied) ??
      primaryResult?.oracleResolutions?.[0];
    const executionStates = displayResults.map((result) => result.executionStatus ?? result.status ?? "unavailable");
    const executionStatus = ["error", "stale", "partial", "completed"].find((candidate) =>
      executionStates.includes(candidate),
    ) ?? "unavailable";
    return {
      caseId,
      suite: exemplar.suite ?? null,
      kind: exemplar.kind ?? "benchmark",
      contractFamily: exemplar.contractFamily ?? caseId,
      evaluationRole: exemplar.scored === false ? ("diagnostic" as const) : ("scored" as const),
      evalStatus: reduceStatuses(tierRows.map((item) => item.status)),
      executionStatus,
      candidateResolution: primaryResult?.candidateResolution ?? primaryOracle?.resolution ?? null,
      expectedDisposition: primaryOracle?.expectedDisposition ?? null,
      oracleSatisfied:
        displayResults.some((result) => result.oracleSatisfied === false)
          ? false
          : displayResults.some((result) => result.oracleSatisfied === true)
            ? true
            : null,
      reasonCode: primaryResult?.reasonCode ?? primaryOracle?.reasonCode ?? null,
      oracleResolutions: displayResults.flatMap((result) => result.oracleResolutions ?? []),
      topline: aggregateSuiteMetrics(
        caseResults,
      ),
      liveTopline: aggregateSuiteMetrics(liveResults),
      incompleteReasons: summarizeIncompleteReasons(caseResults),
      tiers: tierRows,
    };
  });
  return {
    pipeline: { stages: aggregatePipelineStages(activeResults) },
    topline: aggregateSuiteMetrics(activeResults),
    liveTopline: aggregateSuiteMetrics(activeLiveResults),
    perCase,
    componentMatrix: perCase.filter((item) => item.suite === "component" && item.evaluationRole === "scored"),
    suites: Object.fromEntries(
      [...new Set(perCase.map((item) => item.suite).filter((suite): suite is string => Boolean(suite)))].sort().map((suite) => {
        const cases = perCase.filter((item) => item.suite === suite);
        return [
          suite,
          {
            cases: cases.length,
            evalStatus: cases.length ? reduceStatuses(cases.map((item) => item.evalStatus)) : "unavailable",
            evaluationRole: cases.every((item) => item.evaluationRole === "diagnostic") ? "diagnostic" : "scored",
          },
        ];
      }),
    ),
  };
}

function hashStable(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableData(value)))
    .digest("hex");
}

export function suiteConfigurationHash(configuration: unknown): string {
  return hashStable(configuration);
}

interface CompleteSuiteLike {
  schemaVersion: number;
  evaluationSchemaVersion?: number;
  metricDefinitionVersion?: number;
  comparability?: SuiteComparability;
  corpus: { activeHash: string };
  configuration: unknown;
  execution: {
    plannedRuns?: number;
    completedRuns?: number;
    tiers?: Array<{
      tier: EvalReplayMode;
      repetitions: number;
      deterministic: boolean;
      status: EvalExecutionStatus;
    }>;
  };
  evaluation?: {
    tiers: Array<{
      tier: EvalReplayMode;
      repetitions: number;
      deterministic: boolean;
      evalStatus?: EvalExecutionStatus;
      status?: EvalExecutionStatus;
    }>;
  };
  reports: EvalReportLike[];
  topline?: unknown;
  perCase?: unknown;
}

const baselineableStatuses = new Set<EvalExecutionStatus>(["pass", "fail", "partial"]);

function suiteTierStatuses(suite: CompleteSuiteLike) {
  return suite.evaluation?.tiers ?? suite.execution.tiers ?? [];
}

function tierEvalStatus(item: { evalStatus?: EvalExecutionStatus; status?: EvalExecutionStatus }) {
  return item.evalStatus ?? item.status ?? "unavailable";
}

function serializedEvaluation(status: ReturnType<typeof summarizeSuiteReports>) {
  return {
    evalStatus: status.status,
    diagnosticEvalStatus: status.diagnosticStatus,
    tiers: status.tiers.map(({ status: evalStatus, diagnosticStatus: diagnosticEvalStatus, ...tier }) => ({
      ...tier,
      evalStatus,
      diagnosticEvalStatus,
    })),
  };
}

function configuredSuiteModes(suite: CompleteSuiteLike): string[] {
  const configuration = suite.configuration as { modes?: unknown };
  return Array.isArray(configuration?.modes) && configuration.modes.every((mode): mode is string => typeof mode === "string")
    ? configuration.modes
    : CANONICAL_EVAL_MODES;
}

function completeSuiteErrors(suite: CompleteSuiteLike, tiers = CANONICAL_EVAL_TIERS): string[] {
  const errors: string[] = [];
  const modes = configuredSuiteModes(suite);
  if (suite.execution.plannedRuns !== suite.execution.completedRuns) errors.push("suite execution is incomplete");
  if (suite.reports.length !== tiers.length) errors.push("configured tier reports are incomplete");
  for (const expected of tiers) {
    const report = suite.reports.find((item) => item.replay === expected.tier) as
      (EvalReportLike & { repeat?: number; modes?: string[] }) | undefined;
    const status = suiteTierStatuses(suite).find((item) => item.tier === expected.tier);
    if (!report) {
      errors.push(`${expected.tier} report is missing`);
      continue;
    }
    if (report.repeat !== expected.repetitions) errors.push(`${expected.tier} repetition count is not canonical`);
    if (report.modes?.length !== modes.length || modes.some((mode) => !report.modes?.includes(mode)))
      errors.push(`${expected.tier} mode set does not match configuration`);
    if (!status) errors.push(`${expected.tier} execution status is missing`);
    else if (!baselineableStatuses.has(tierEvalStatus(status))) errors.push(`${expected.tier} eval status is not baselineable`);
    if (status && status.deterministic !== expected.deterministic)
      errors.push(`${expected.tier} deterministic metadata does not match`);
  }
  return errors;
}

export function validateSuiteBaselineEligibility(suite: CompleteSuiteLike, tiers = CANONICAL_EVAL_TIERS) {
  const errors = completeSuiteErrors(suite, tiers);
  return { eligible: errors.length === 0, errors };
}

export function createEvalSuiteBaseline(suite: CompleteSuiteLike, tiers = CANONICAL_EVAL_TIERS): EvalSuiteBaseline {
  const errors = validateSuiteBaselineEligibility(suite, tiers).errors;
  if (errors.length) throw new Error(`Cannot create AgentSmith suite baseline:\n${errors.join("\n")}`);
  return {
    schemaVersion: 4,
    reportKind: "agentsmith-eval-suite-baseline",
    createdAt: new Date().toISOString(),
    suite: typeof (suite as any).suite === "string" ? (suite as any).suite : undefined,
    modelTarget: (suite as any).modelTarget,
    corpusHash: suite.corpus.activeHash,
    configurationHash: suiteConfigurationHash(suite.configuration),
    metricCatalog: suiteMetricCatalog(suite),
    topline: suite.topline,
    perCase: suite.perCase,
    evidence: tiers.map((expected) => ({
      tier: expected.tier,
      repetitions: expected.repetitions,
      deterministic: expected.deterministic,
      evalStatus: tierEvalStatus(suiteTierStatuses(suite).find((item) => item.tier === expected.tier) ?? {}),
      reportHash: hashStable(suite.reports.find((report) => report.replay === expected.tier)),
    })),
    evaluationSchemaVersion: suite.evaluationSchemaVersion ?? EVALUATION_SCHEMA_VERSION,
    metricDefinitionVersion: suite.metricDefinitionVersion ?? METRIC_DEFINITION_VERSION,
    comparability: suite.comparability ?? suiteComparability(),
  };
}

export function validateEvalSuiteBaseline(
  input: { baseline: EvalSuiteBaseline; current: CompleteSuiteLike },
  tiers = CANONICAL_EVAL_TIERS,
) {
  const errors: string[] = [];
  const baseline = input.baseline;
  if (![1, 2, 3, 4].includes(baseline.schemaVersion) || baseline.reportKind !== "agentsmith-eval-suite-baseline")
    errors.push("baseline schema is incompatible");
  if (!/^[a-f0-9]{64}$/.test(baseline.corpusHash)) errors.push("baseline corpus hash is invalid");
  if (baseline.corpusHash !== input.current.corpus.activeHash)
    errors.push("baseline corpus hash does not match current corpus");
  if (baseline.suite !== undefined && baseline.suite !== (input.current as any).suite)
    errors.push("baseline suite does not match current suite");
  if (baseline.modelTarget !== undefined && baseline.modelTarget !== (input.current as any).modelTarget)
    errors.push("baseline model target does not match current model target");
  if (baseline.configurationHash !== suiteConfigurationHash(input.current.configuration))
    errors.push("baseline configuration does not match current suite");
  const currentCatalog = suiteMetricCatalog(input.current);
  if (!Array.isArray(baseline.metricCatalog) || baseline.metricCatalog.length === 0)
    errors.push("baseline metric catalog is missing");
  else if (
    JSON.stringify([...baseline.metricCatalog].sort()) !== JSON.stringify(currentCatalog) &&
    (baseline.evaluationSchemaVersion ?? 1) === (input.current.evaluationSchemaVersion ?? 1)
  ) errors.push("baseline metric catalog does not match current suite");
  for (const expected of tiers) {
    const evidence = baseline.evidence?.find((item) => item.tier === expected.tier);
    if (!evidence) {
      errors.push(`${expected.tier} baseline evidence is missing`);
      continue;
    }
    if (evidence.repetitions !== expected.repetitions || evidence.deterministic !== expected.deterministic)
      errors.push(`${expected.tier} baseline evidence is not canonical`);
    if (!baselineableStatuses.has(evidence.evalStatus ?? evidence.status ?? "unavailable"))
      errors.push(`${expected.tier} baseline evidence is not baselineable`);
    if (!/^[a-f0-9]{64}$/.test(evidence.reportHash)) errors.push(`${expected.tier} baseline report hash is invalid`);
  }
  return { ok: errors.length === 0, errors };
}

function metricValues(value: unknown, prefix = ""): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  if (typeof record.value === "number" && typeof record.direction === "string") return { [prefix]: record.value };
  return Object.assign(
    {},
    ...Object.entries(record).map(([key, item]) => metricValues(item, prefix ? `${prefix}.${key}` : key)),
  );
}

function suiteMetricCatalog(suite: CompleteSuiteLike): string[] {
  const names = new Set<string>();
  for (const name of Object.keys(metricValues(suite.topline))) names.add(`topline.${name}`);
  for (const item of Array.isArray(suite.perCase) ? suite.perCase : []) {
    const record = item as { caseId?: string; topline?: unknown };
    for (const name of Object.keys(metricValues(record.topline)))
      names.add(`case.${record.caseId ?? "unknown"}.${name}`);
  }
  return [...names].sort();
}

export function compareEvalSuiteBaseline(
  baseline: EvalSuiteBaseline,
  current: CompleteSuiteLike,
  tiers = CANONICAL_EVAL_TIERS,
) {
  const sameDefinitions =
    (baseline.evaluationSchemaVersion ?? 1) === (current.evaluationSchemaVersion ?? 1) &&
    (baseline.metricDefinitionVersion ?? 1) === (current.metricDefinitionVersion ?? 1);
  const unchangedMetric = (key: string) =>
    /^(finding\.|selectionRecall$|candidateFinding(?:Recall|Precision)$|verifiedFinding(?:Recall|Precision)$|coverage\.|efficiency\.|evidence\.|candidateAdjudication$)/.test(key);
  const compare = (before: unknown, after: unknown) => {
    const beforeValues = metricValues(before);
    const afterValues = metricValues(after);
    return Object.fromEntries(
      [...new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)])]
        .filter((key) => sameDefinitions || unchangedMetric(key))
        .sort().map((key) => [
        key,
        {
          baseline: beforeValues[key] ?? null,
          current: afterValues[key] ?? null,
          delta:
            typeof beforeValues[key] === "number" && typeof afterValues[key] === "number"
              ? afterValues[key] - beforeValues[key]
              : null,
        },
      ]),
    );
  };
  const baselineCases = new Map(
    (Array.isArray(baseline.perCase) ? baseline.perCase : []).map((item: any) => [item.caseId, item]),
  );
  const currentCases = Array.isArray(current.perCase) ? current.perCase : [];
  return {
    comparable: validateEvalSuiteBaseline({ baseline, current }, tiers).ok,
    definitionallyIdentical: sameDefinitions,
    metricComparability: current.comparability ?? suiteComparability(baseline),
    topline: compare(baseline.topline, current.topline),
    perCase: currentCases.map((item: any) => ({
      caseId: item.caseId,
      baselineFound: baselineCases.has(item.caseId),
      metrics: compare((baselineCases.get(item.caseId) as any)?.topline, item.topline),
    })),
  };
}

type EvalRunner = typeof runEvalCases;

export function registeredEvalSuites(root: string): string[] {
  const suites = new Set<string>();
  for (const slug of listEvalCases(root, true)) {
    const { definition } = readEvalCase(root, slug);
    if (definition.status === "active") suites.add(definition.suite);
  }
  return [...suites].sort();
}

/** Run exactly one registered suite with one explicit model strategy. */
export async function runEvalSuite(opts: {
  root: string;
  suite: string;
  modelTarget: EvalModelTarget;
  label?: string;
  output?: string;
  baseline?: EvalSuiteBaseline;
  baselineOutput?: string;
  provider?: Parameters<typeof validateEvalModelTarget>[0]["provider"];
  runner?: EvalRunner;
  onStart?: (status: SuiteRunStatus) => void | Promise<void>;
  onProgress?: (status: SuiteRunStatus, event: EvalProgressEvent) => void | Promise<void>;
  cancelRequested?: () => boolean;
}) {
  if (!opts.suite || opts.suite === "draft" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.suite))
    throw new Error(`Invalid AgentSmith suite ID: ${opts.suite || "<missing>"}`);
  const validation = validateEvalCases(opts.root, true);
  if (!validation.valid) {
    const failures = validation.cases
      .filter((item) => !item.valid)
      .flatMap((item) => item.findings.map((finding) => `${item.id}: ${finding}`));
    throw new Error(`AgentSmith eval corpus validation failed:\n${failures.join("\n")}`);
  }
  const allSlugs = listEvalCases(opts.root, true);
  const slugs = allSlugs.filter((slug) => {
    const { definition } = readEvalCase(opts.root, slug);
    return definition.status === "active" && definition.suite === opts.suite;
  });
  if (!slugs.length) {
    const registered = registeredEvalSuites(opts.root);
    throw new Error(
      `AgentSmith suite is not registered: ${opts.suite}. Registered suites: ${registered.join(", ") || "none"}`,
    );
  }

  // This check intentionally happens before the status directory or output path is created.
  const firstDefinition = readEvalCase(opts.root, slugs[0]).definition;
  if (!firstDefinition.source.fixture) throw new Error(`Eval case ${slugs[0]} has no frozen fixture`);
  const resolved = resolveConfig({
    cwd: path.resolve(opts.root, "evals", "agentsmith", slugs[0], firstDefinition.source.fixture.path),
  });
  resolvePolicyForConfig(resolved);
  const targetConfig = await validateEvalModelTarget({
    config: resolved.config.agentsmith!,
    target: opts.modelTarget,
    provider: opts.provider,
  });
  const mode: EvalMode = opts.modelTarget === "small" ? "partitioned-interactions" : "holistic";
  const tiers = [{ tier: "live" as const, repetitions: 1, deterministic: false }];
  const runner = opts.runner ?? runEvalCases;
  const suiteRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const statusFile = suiteStatusPath(opts.root, suiteRunId);
  const output = opts.output ? path.resolve(opts.root, opts.output) : path.join(suiteStatusDirectory(opts.root, suiteRunId), "result.json");
  let runStatus = createSuiteRunStatus({
    runId: suiteRunId,
    suite: opts.suite,
    modelTarget: opts.modelTarget,
    label: opts.label,
    caseCount: slugs.length,
    modes: [mode],
    tiers,
  });
  runStatus = { ...runStatus, output, baselineOutput: opts.baselineOutput ? path.resolve(opts.root, opts.baselineOutput) : null };
  writeSuiteRunStatus(statusFile, runStatus);
  await opts.onStart?.(runStatus);
  let reports: EvalReportLike[];
  try {
    reports = [
      await runner({
        root: opts.root,
        slugs,
        modes: [mode],
        repeat: 1,
        replay: "live",
        label: opts.label,
        allowDrafts: false,
        modelTarget: opts.modelTarget,
        provider: opts.provider,
        onProgress: async (event) => {
          if (opts.cancelRequested?.()) throw new Error("Suite cancelled");
          runStatus = applySuiteProgress(runStatus, event);
          writeSuiteRunStatus(statusFile, runStatus);
          await opts.onProgress?.(runStatus, event);
        },
      }),
    ];
  } catch (error) {
    const cancelled = opts.cancelRequested?.() === true;
    runStatus = finishSuiteRunStatus(runStatus, cancelled ? "cancelled" : "failed", {
      lastError: cancelled ? null : error instanceof Error ? error.message : String(error),
    });
    writeSuiteRunStatus(statusFile, runStatus);
    throw error;
  }
  const status = summarizeSuiteReports(reports, tiers);
  const aggregates = aggregateSuiteReport(reports, tiers);
  const suiteResults = reports.flatMap((report) =>
    report.cases.filter((evalCase) => evalCase.scored !== false).flatMap((evalCase) => evalCase.results),
  );
  const suiteBase = {
    schemaVersion: 4,
    evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    reportKind: "agentsmith-eval-suite" as const,
    suiteRunId,
    suite: opts.suite,
    modelTarget: opts.modelTarget,
    modelProfiles: targetConfig.model_profiles
      .filter((profile) => [targetConfig.models.candidate, targetConfig.models.verifier].includes(profile.id))
      .map((profile) => ({ id: profile.id, model: profile.model })),
    label: opts.label ?? null,
    createdAt: new Date().toISOString(),
    evalStatus: status.status,
    executionStatus: summarizeRuntimeStatus(suiteResults),
    diagnosticStatus: status.diagnosticStatus,
    validation,
    configuration: { suite: opts.suite, modelTarget: opts.modelTarget, modes: [mode], tiers },
    corpus: { active: slugs, drafts: [], activeCount: slugs.length, draftCount: 0, activeHash: corpusHash(opts.root, slugs), evaluatedHash: corpusHash(opts.root, slugs) },
    evaluation: serializedEvaluation(status),
    execution: {
      plannedRuns: slugs.length,
      completedRuns: reports[0].cases.reduce((sum, item) => sum + item.results.length, 0),
      status: summarizeRuntimeStatus(suiteResults),
    },
    ...aggregates,
    comparability: suiteComparability(opts.baseline),
    reports,
  };
  const baselineEligibility = validateSuiteBaselineEligibility(suiteBase, tiers);
  const baselineValidation = opts.baseline ? validateEvalSuiteBaseline({ baseline: opts.baseline, current: suiteBase }, tiers) : null;
  const comparison = opts.baseline ? compareEvalSuiteBaseline(opts.baseline, suiteBase, tiers) : null;
  const suite = {
    ...suiteBase,
    baselineEligible: baselineEligibility.eligible,
    baseline: opts.baseline ? { definition: opts.baseline, validation: baselineValidation } : null,
    comparison,
    hillClimb: comparison,
  };
  let baselineOutput: string | null = null;
  let baselineError: string | null = null;
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(suite, null, 2)}\n`);
    runStatus = finishSuiteRunStatus(runStatus, "completed", { output, baselineOutput, baselineError });
    writeSuiteRunStatus(statusFile, runStatus);
  } catch (error) {
    runStatus = finishSuiteRunStatus(runStatus, "failed", { lastError: error instanceof Error ? error.message : String(error) });
    writeSuiteRunStatus(statusFile, runStatus);
    throw error;
  }
  if (opts.baselineOutput) {
    try {
      const created = createEvalSuiteBaseline(suite, tiers);
      baselineOutput = path.resolve(opts.root, opts.baselineOutput);
      fs.mkdirSync(path.dirname(baselineOutput), { recursive: true });
      fs.writeFileSync(baselineOutput, `${JSON.stringify(created, null, 2)}\n`);
    } catch (error) {
      baselineError = error instanceof Error ? error.message : String(error);
    }
    runStatus = finishSuiteRunStatus(runStatus, "completed", { output, baselineOutput, baselineError });
    writeSuiteRunStatus(statusFile, runStatus);
  }
  return {
    ...suite,
    directory: suiteStatusDirectory(opts.root, suiteRunId),
    output,
    baselineOutput,
    baselineError,
    statusPath: statusFile,
    runStatus,
  };
}

export async function runCanonicalEvalSuite(opts: {
  root: string;
  label?: string;
  stages?: EvalStage[];
  output?: string;
  baseline?: EvalSuiteBaseline;
  baselineOutput?: string;
  runner?: EvalRunner;
  onStart?: (status: SuiteRunStatus) => void | Promise<void>;
  onProgress?: (status: SuiteRunStatus, event: EvalProgressEvent) => void | Promise<void>;
  cancelRequested?: () => boolean;
}) {
  const validation = validateEvalCases(opts.root, true);
  if (!validation.valid) {
    const failures = validation.cases
      .filter((item) => !item.valid)
      .flatMap((item) => item.findings.map((finding) => `${item.id}: ${finding}`));
    throw new Error(`AgentSmith eval corpus validation failed:\n${failures.join("\n")}`);
  }
  const slugs = listEvalCases(opts.root, true);
  if (!slugs.length) throw new Error("No AgentSmith eval cases found");
  const active = slugs.filter((slug) => readEvalCase(opts.root, slug).definition.status === "active");
  const drafts = slugs.filter((slug) => readEvalCase(opts.root, slug).definition.status === "draft");
  const runner = opts.runner ?? runEvalCases;
  const suiteRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const directory = suiteStatusDirectory(opts.root, suiteRunId);
  const statusFile = suiteStatusPath(opts.root, suiteRunId);
  const output = opts.output ? path.resolve(opts.root, opts.output) : path.join(directory, "result.json");
  let runStatus = createSuiteRunStatus({
    runId: suiteRunId,
    label: opts.label,
    caseCount: slugs.length,
    modes: CANONICAL_EVAL_MODES,
    tiers: CANONICAL_EVAL_TIERS,
  });
  runStatus = {
    ...runStatus,
    output,
    baselineOutput: opts.baselineOutput ? path.resolve(opts.root, opts.baselineOutput) : null,
  };
  writeSuiteRunStatus(statusFile, runStatus);
  await opts.onStart?.(runStatus);
  const reports = [];
  try {
    for (const configuration of CANONICAL_EVAL_TIERS) {
      if (opts.cancelRequested?.()) throw new Error("Suite cancelled");
      reports.push(
        await runner({
          root: opts.root,
          slugs,
          modes: CANONICAL_EVAL_MODES,
          repeat: configuration.repetitions,
          replay: configuration.tier,
          stages: opts.stages,
          label: opts.label,
          allowDrafts: true,
          onProgress: async (event) => {
            if (opts.cancelRequested?.()) throw new Error("Suite cancelled");
            runStatus = applySuiteProgress(runStatus, event);
            writeSuiteRunStatus(statusFile, runStatus);
            await opts.onProgress?.(runStatus, event);
          },
        }),
      );
    }
  } catch (error) {
    const cancelled = opts.cancelRequested?.() === true;
    runStatus = finishSuiteRunStatus(runStatus, cancelled ? "cancelled" : "failed", {
      lastError: cancelled ? null : error instanceof Error ? error.message : String(error),
    });
    writeSuiteRunStatus(statusFile, runStatus);
    throw error;
  }
  const status = summarizeSuiteReports(reports);
  const aggregates = aggregateSuiteReport(reports);
  const scoredResults = reports.flatMap((report) =>
    report.cases.filter((evalCase) => evalCase.scored !== false).flatMap((evalCase) => evalCase.results),
  );
  const activeRuns = reports.reduce(
    (sum, report) =>
      sum +
      report.cases
        .filter((evalCase) => evalCase.scored !== false)
        .reduce((count, evalCase) => count + evalCase.results.length, 0),
    0,
  );
  const diagnosticRuns = reports.reduce(
    (sum, report) =>
      sum +
      report.cases
        .filter((evalCase) => evalCase.scored === false)
        .reduce((count, evalCase) => count + evalCase.results.length, 0),
    0,
  );
  const suiteBase = {
    schemaVersion: 4,
    evaluationSchemaVersion: EVALUATION_SCHEMA_VERSION,
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    reportKind: "agentsmith-eval-suite" as const,
    suiteRunId,
    label: opts.label ?? null,
    createdAt: new Date().toISOString(),
    evalStatus: status.status,
    executionStatus: summarizeRuntimeStatus(scoredResults),
    diagnosticStatus: status.diagnosticStatus,
    validation,
    configuration: {
      modes: CANONICAL_EVAL_MODES,
      tiers: CANONICAL_EVAL_TIERS,
      drafts: "diagnostic-only" as const,
    },
    corpus: {
      active,
      drafts,
      activeCount: active.length,
      draftCount: drafts.length,
      activeHash: corpusHash(opts.root, active),
      evaluatedHash: corpusHash(opts.root, slugs),
    },
    execution: {
      status: summarizeRuntimeStatus(scoredResults),
      plannedRuns:
        slugs.length *
        CANONICAL_EVAL_MODES.length *
        CANONICAL_EVAL_TIERS.reduce((sum, item) => sum + item.repetitions, 0),
      completedRuns: activeRuns + diagnosticRuns,
      activeRuns,
      diagnosticRuns,
    },
    evaluation: serializedEvaluation(status),
    ...aggregates,
    comparability: suiteComparability(opts.baseline),
    reports,
  };
  const baselineEligibility = validateSuiteBaselineEligibility(suiteBase);
  const baselineValidation = opts.baseline
    ? validateEvalSuiteBaseline({ baseline: opts.baseline, current: suiteBase })
    : null;
  const comparison = opts.baseline ? compareEvalSuiteBaseline(opts.baseline, suiteBase) : null;
  const suite = {
    ...suiteBase,
    baselineEligible: baselineEligibility.eligible,
    baseline: opts.baseline ? { definition: opts.baseline, validation: baselineValidation } : null,
    comparison,
    hillClimb: comparison,
  };
  let baselineOutput: string | null = null;
  let baselineError: string | null = null;
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(suite, null, 2)}\n`);
    runStatus = finishSuiteRunStatus(runStatus, "completed", { output, baselineOutput, baselineError });
    writeSuiteRunStatus(statusFile, runStatus);
  } catch (error) {
    runStatus = finishSuiteRunStatus(runStatus, "failed", {
      lastError: error instanceof Error ? error.message : String(error),
    });
    writeSuiteRunStatus(statusFile, runStatus);
    throw error;
  }
  if (opts.baselineOutput) {
    try {
      const created = createEvalSuiteBaseline(suite);
      baselineOutput = path.resolve(opts.root, opts.baselineOutput);
      fs.mkdirSync(path.dirname(baselineOutput), { recursive: true });
      fs.writeFileSync(baselineOutput, `${JSON.stringify(created, null, 2)}\n`);
    } catch (error) {
      baselineError = error instanceof Error ? error.message : String(error);
    }
    runStatus = finishSuiteRunStatus(runStatus, "completed", { output, baselineOutput, baselineError });
    writeSuiteRunStatus(statusFile, runStatus);
  }
  return { ...suite, directory, output, baselineOutput, baselineError, statusPath: statusFile, runStatus };
}
