import { suiteConfigurationHash } from "./suite.js";

type Metric = { value?: number | null; numerator?: number; denominator?: number };
type ReportArtifact = {
  schemaVersion?: number;
  reportKind?: string;
  evaluationSchemaVersion?: number;
  metricDefinitionVersion?: number;
  suite?: string;
  modelTarget?: string;
  corpusHash?: string;
  configurationHash?: string;
  metricCatalog?: string[];
  evidence?: Array<{ evalStatus?: string; status?: string; reportHash?: string }>;
  corpus?: { activeHash?: string };
  configuration?: unknown;
  execution?: { plannedRuns?: number; completedRuns?: number };
  topline?: {
    selectionRecall?: Metric;
    finding?: { recall?: Metric; precision?: Metric };
    oracleResolutionAccuracy?: Metric;
    reliability?: {
      executionPartialRate?: Metric;
      providerFailures?: number;
      errors?: number;
      timeouts?: number;
    };
    efficiency?: { totalTokens?: number };
  };
};

function artifactCompatibilityErrors(baseline: ReportArtifact, current: ReportArtifact): string[] {
  const errors: string[] = [];
  if (baseline.schemaVersion !== 4 || baseline.reportKind !== "agentsmith-eval-suite-baseline")
    errors.push("baseline must be an AgentSmith suite baseline with schema version 4");
  if (current.schemaVersion !== 4 || current.reportKind !== "agentsmith-eval-suite")
    errors.push("current artifact must be an AgentSmith suite report with schema version 4");
  if (baseline.evaluationSchemaVersion !== 4 || current.evaluationSchemaVersion !== 4)
    errors.push("evaluation schema version 4 is required");
  if (baseline.metricDefinitionVersion !== 4 || current.metricDefinitionVersion !== 4)
    errors.push("metric definition version 4 is required");
  if (!baseline.suite || baseline.suite !== current.suite) errors.push("suite identity does not match");
  if (!baseline.modelTarget || baseline.modelTarget !== current.modelTarget)
    errors.push("model target does not match");
  if (!baseline.corpusHash || baseline.corpusHash !== current.corpus?.activeHash)
    errors.push("corpus hash does not match");
  if (!baseline.configurationHash || baseline.configurationHash !== suiteConfigurationHash(current.configuration))
    errors.push("configuration hash does not match");
  if (!baseline.metricCatalog?.length) errors.push("baseline metric catalog is missing");
  if (
    !baseline.evidence?.length ||
    baseline.evidence.some(
      (item) =>
        !["pass", "fail", "partial"].includes(item.evalStatus ?? item.status ?? "") ||
        !/^[a-f0-9]{64}$/.test(item.reportHash ?? ""),
    )
  )
    errors.push("baseline evidence is missing or invalid");
  if (
    typeof current.execution?.plannedRuns !== "number" ||
    current.execution.plannedRuns !== current.execution.completedRuns
  )
    errors.push("current suite execution is incomplete");
  return errors;
}

export const REVIEW_PROMOTION_THRESHOLDS = {
  selectionRecallRegression: 0.01,
  findingRecallRegression: 0.02,
  findingPrecisionRegression: 0.02,
  tokenIncrease: 0.15,
  oracleResolutionRegression: 0,
} as const;

export interface PromotionCheck {
  id: string;
  ok: boolean;
  baseline: number | null;
  current: number | null;
  limit: string;
  detail: string;
}

function value(metric: Metric | undefined): number | null {
  return typeof metric?.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
}

function regressionCheck(
  id: string,
  baseline: number | null,
  current: number | null,
  allowedRegression: number,
): PromotionCheck {
  const ok = baseline !== null && current !== null && current >= baseline - allowedRegression;
  return {
    id,
    ok,
    baseline,
    current,
    limit: `regression <= ${(allowedRegression * 100).toFixed(0)} percentage point(s)`,
    detail: ok ? "within threshold" : baseline === null || current === null ? "required metric is unavailable" : "regression exceeds threshold",
  };
}

export function evaluateReviewPromotion(baseline: ReportArtifact, current: ReportArtifact) {
  const before = baseline.topline;
  const after = current.topline;
  const baselineTokens = before?.efficiency?.totalTokens ?? null;
  const currentTokens = after?.efficiency?.totalTokens ?? null;
  const tokenRatio =
    typeof baselineTokens === "number" && baselineTokens > 0 && typeof currentTokens === "number"
      ? (currentTokens - baselineTokens) / baselineTokens
      : null;
  const reliability = after?.reliability;
  const executionFailures =
    (reliability?.providerFailures ?? 0) +
    (reliability?.errors ?? 0) +
    (reliability?.timeouts ?? 0) +
    (reliability?.executionPartialRate?.numerator ?? 0);
  const compatibilityErrors = artifactCompatibilityErrors(baseline, current);
  const checks: PromotionCheck[] = [
    {
      id: "artifact-compatibility",
      ok: compatibilityErrors.length === 0,
      baseline: baseline.schemaVersion ?? null,
      current: current.schemaVersion ?? null,
      limit: "matching schema-v3 suite, model, corpus, configuration, and complete baseline evidence",
      detail: compatibilityErrors.length ? compatibilityErrors.join("; ") : "artifacts are compatible",
    },
    regressionCheck(
      "selection-recall",
      value(before?.selectionRecall),
      value(after?.selectionRecall),
      REVIEW_PROMOTION_THRESHOLDS.selectionRecallRegression,
    ),
    regressionCheck(
      "finding-recall",
      value(before?.finding?.recall),
      value(after?.finding?.recall),
      REVIEW_PROMOTION_THRESHOLDS.findingRecallRegression,
    ),
    regressionCheck(
      "finding-precision",
      value(before?.finding?.precision),
      value(after?.finding?.precision),
      REVIEW_PROMOTION_THRESHOLDS.findingPrecisionRegression,
    ),
    regressionCheck(
      "oracle-resolution-accuracy",
      value(before?.oracleResolutionAccuracy),
      value(after?.oracleResolutionAccuracy),
      REVIEW_PROMOTION_THRESHOLDS.oracleResolutionRegression,
    ),
    {
      id: "token-usage",
      ok: tokenRatio !== null && tokenRatio <= REVIEW_PROMOTION_THRESHOLDS.tokenIncrease,
      baseline: baselineTokens,
      current: currentTokens,
      limit: `increase <= ${Math.round(REVIEW_PROMOTION_THRESHOLDS.tokenIncrease * 100)}%`,
      detail: tokenRatio === null ? "required token metric is unavailable" : `observed increase ${(tokenRatio * 100).toFixed(1)}%`,
    },
    {
      id: "execution-integrity",
      ok: executionFailures === 0,
      baseline: 0,
      current: executionFailures,
      limit: "no provider failures, harness errors, timeouts, or execution-partial runs",
      detail: executionFailures === 0 ? "all scheduled work completed" : `${executionFailures} execution-integrity blocker(s)`,
    },
  ];
  return {
    stage: 4,
    evaluationSchemaVersion: current.evaluationSchemaVersion ?? null,
    metricDefinitionVersion: current.metricDefinitionVersion ?? null,
    thresholds: REVIEW_PROMOTION_THRESHOLDS,
    ok: checks.every((check) => check.ok),
    checks,
  };
}
