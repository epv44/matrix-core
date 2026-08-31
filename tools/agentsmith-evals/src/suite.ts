import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { corpusHash, listEvalCases, readEvalCase, validateEvalCases } from "./case.js";
import { runEvalCases, type EvalMode, type EvalReplayMode } from "./eval.js";
import type { EvalStage } from "./stage-score.js";

export const CANONICAL_EVAL_MODES: EvalMode[] = [
  "holistic",
  "partitioned-local",
  "partitioned-evidence",
  "partitioned-interactions",
  "hybrid",
];

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

interface ResultLike {
  mode: string;
  tier?: string;
  iteration?: number;
  outcome?: string;
  status?: string;
  outcomeCorrect?: boolean | null;
  qualityEvaluable?: boolean;
  findings?: unknown[];
  coverage?: unknown;
  stages?: Array<{
    stage?: string;
    evaluation?: string;
    causalStatus?: string;
    metrics?: Array<{ name?: string; value?: unknown; numerator?: number; denominator?: number; direction?: string }>;
    diagnostics?: string[];
  }>;
  errors?: string[];
  incompatibilities?: string[];
}

interface CaseLike {
  id: string;
  scored?: boolean;
  evaluationRole?: "scored" | "diagnostic";
  results: ResultLike[];
}

export interface EvalReportLike {
  replay: EvalReplayMode;
  cases: CaseLike[];
  [key: string]: unknown;
}

const statusPrecedence: EvalExecutionStatus[] = [
  "error",
  "unavailable",
  "incompatible",
  "partial",
  "unstable",
  "fail",
  "pass",
];

function reduceStatuses(statuses: EvalExecutionStatus[]): EvalExecutionStatus {
  return statusPrecedence.find((status) => statuses.includes(status)) ?? "unavailable";
}

export function resultExecutionStatus(result: ResultLike): EvalExecutionStatus {
  if (result.errors?.length || result.status === "error") return "error";
  if (result.status === "unavailable") return "unavailable";
  if (result.incompatibilities?.length || result.stages?.some((stage) => stage.evaluation === "incompatible"))
    return "incompatible";
  if (result.status === "partial" || result.outcome === "incomplete") return "partial";
  if (result.stages?.some((stage) => stage.evaluation === "not-evaluable")) return "unavailable";
  if (result.stages?.some((stage) => ["root-failure", "downstream-blocked"].includes(stage.causalStatus ?? "")))
    return "fail";
  const snapshot = result.stages?.find((stage) => stage.stage === "snapshot");
  if (
    snapshot?.metrics?.some(
      (metric) => ["fileRecall", "filePrecision"].includes(metric.name ?? "") && metric.value !== 1,
    )
  )
    return "fail";
  if (result.qualityEvaluable && result.outcomeCorrect === false) return "fail";
  const evaluatedStages = result.stages?.filter((stage) => ["executed", "observed"].includes(stage.evaluation ?? ""));
  if (result.stages?.length && !evaluatedStages?.length) return "unavailable";
  return "pass";
}

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
    status: result.status,
    outcomeCorrect: result.outcomeCorrect,
    qualityEvaluable: result.qualityEvaluable,
    findings: result.findings,
    coverage: stableData(result.coverage),
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

export function summarizeExecutionGroup(results: ResultLike[], deterministic: boolean) {
  const fingerprints = [...new Set(results.map(resultSemanticFingerprint))];
  const stable = !deterministic || fingerprints.length <= 1;
  const statuses = results.map(resultExecutionStatus);
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
    promotable: tierStatuses.length > 0 && tierStatuses.every((item) => item.status === "pass"),
    tiers: tierStatuses,
  };
}

type EvalRunner = typeof runEvalCases;

export async function runCanonicalEvalSuite(opts: {
  root: string;
  label?: string;
  stages?: EvalStage[];
  output?: string;
  runner?: EvalRunner;
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
  const reports = [];
  for (const configuration of CANONICAL_EVAL_TIERS) {
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
      }),
    );
  }
  const suiteRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const status = summarizeSuiteReports(reports);
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
  const suite = {
    schemaVersion: 1,
    reportKind: "agentsmith-eval-suite" as const,
    suiteRunId,
    label: opts.label ?? null,
    createdAt: new Date().toISOString(),
    status: status.status,
    diagnosticStatus: status.diagnosticStatus,
    promotable: status.promotable,
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
      ...status,
      plannedRuns:
        slugs.length *
        CANONICAL_EVAL_MODES.length *
        CANONICAL_EVAL_TIERS.reduce((sum, item) => sum + item.repetitions, 0),
      completedRuns: activeRuns + diagnosticRuns,
      activeRuns,
      diagnosticRuns,
    },
    reports,
  };
  const directory = path.join(opts.root, ".quality", "evals", "suites", suiteRunId);
  const output = opts.output ? path.resolve(opts.root, opts.output) : path.join(directory, "result.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(suite, null, 2)}\n`);
  return { ...suite, directory, output };
}
