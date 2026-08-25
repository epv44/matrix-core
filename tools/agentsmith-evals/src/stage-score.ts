import type { ReviewFinding, ReviewResult } from "../../../src/core/types.js";
import type { EngineExecution } from "../../../src/agentsmith/engine-types.js";
import type { AgentSmithTrace } from "../../../src/agentsmith/trace.js";
import type { EvalCase } from "./case.js";

export type EvalStage =
  "snapshot" | "graph" | "planning" | "candidates" | "evidence" | "verification" | "aggregation" | "reporting";

export interface StageMetric {
  name: string;
  value: number | boolean | null;
  numerator?: number;
  denominator?: number;
  direction: "higher" | "lower" | "exact";
}

export interface StageEvaluation {
  stage: EvalStage;
  evaluation: "executed" | "observed" | "incompatible" | "not-evaluable";
  metrics: StageMetric[];
  diagnostics: string[];
}

const ratio = (numerator: number, denominator: number) => (denominator ? numerator / denominator : null);
const metric = (
  name: string,
  numerator: number,
  denominator: number,
  direction: StageMetric["direction"] = "higher",
): StageMetric => ({ name, numerator, denominator, value: ratio(numerator, denominator), direction });

function inspected(execution: EngineExecution) {
  return {
    files: new Set(execution.workItems.flatMap((item) => item.code.map((snippet) => snippet.file))),
    symbols: new Set(
      execution.workItems.flatMap((item) =>
        [...item.primarySymbols, ...item.relatedSymbols].flatMap((symbol) => [
          symbol.name,
          symbol.qualifiedName,
          `${symbol.file}#${symbol.qualifiedName}`,
        ]),
      ),
    ),
    edges: new Set(
      execution.workItems.flatMap((item) =>
        item.graphEdges.flatMap((edge) => [
          `${edge.source}->${edge.target ?? edge.targetText}`,
          `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`,
        ]),
      ),
    ),
  };
}

function targetMetrics(targets: { files: string[]; symbols: string[]; edges: string[] }, execution: EngineExecution) {
  const actual = inspected(execution);
  return (["files", "symbols", "edges"] as const).map((kind) => {
    const matched = targets[kind].filter((target) => actual[kind].has(target));
    return {
      metric: metric(`${kind}Recall`, matched.length, targets[kind].length),
      missing: targets[kind].filter((target) => !actual[kind].has(target)),
    };
  });
}

type CandidateExpectation = NonNullable<EvalCase["expectations"]["candidates"]>["items"][number];

function candidateMatches(
  actual: { file: string; line: number; endLine?: number; category: string; title: string },
  expected: CandidateExpectation,
) {
  const end = actual.endLine ?? actual.line;
  if (actual.file !== expected.file || end < expected.lineStart || actual.line > expected.lineEnd) return false;
  if (expected.category && actual.category !== expected.category) return false;
  return !expected.titleContains || actual.title.toLowerCase().includes(expected.titleContains.toLowerCase());
}

function findingMatches(
  actual: ReviewFinding,
  expected: NonNullable<EvalCase["expectations"]["aggregation"]>["findings"][number],
) {
  if (actual.file !== expected.file || actual.line < expected.lineStart || actual.line > expected.lineEnd) return false;
  return !expected.category || actual.category === expected.category;
}

function candidateExpectations(definition: EvalCase): CandidateExpectation[] {
  return definition.expectations.verification?.candidates ?? definition.expectations.candidates?.items ?? [];
}

export function evaluateStages(opts: {
  definition: EvalCase;
  trace: AgentSmithTrace;
  execution: EngineExecution;
  result: ReviewResult;
  tier: "stage" | "recorded" | "live";
  hermetic: boolean;
  selected?: EvalStage[];
}): StageEvaluation[] {
  const { definition, trace, execution, result } = opts;
  const chosen = new Set<EvalStage>(
    opts.selected ?? [
      "snapshot",
      "graph",
      "planning",
      "candidates",
      "evidence",
      "verification",
      "aggregation",
      "reporting",
    ],
  );
  const evaluation = (stage: EvalStage) => {
    if (stage === "snapshot") return "observed" as const;
    if (opts.tier === "stage" && ["graph", "planning"].includes(stage))
      return opts.hermetic ? ("executed" as const) : ("observed" as const);
    return "executed" as const;
  };
  const values: StageEvaluation[] = [];
  const push = (value: StageEvaluation) => {
    if (chosen.has(value.stage)) values.push(value);
  };

  const snapshot = definition.expectations.snapshot;
  if (!snapshot) push({ stage: "snapshot", evaluation: "not-evaluable", metrics: [], diagnostics: ["no labels"] });
  else {
    const actual = new Map(trace.scope.manifest.map((item) => [item.path, item.changeKind]));
    const matched = snapshot.files.filter(
      (item) => actual.get(item.path) && (!item.changeKind || actual.get(item.path) === item.changeKind),
    );
    push({
      stage: "snapshot",
      evaluation: evaluation("snapshot"),
      metrics: [metric("fileRecall", matched.length, snapshot.files.length)],
      diagnostics: snapshot.files.filter((item) => !matched.includes(item)).map((item) => `missing ${item.path}`),
    });
  }

  for (const stage of ["graph", "planning"] as const) {
    const targets = definition.expectations[stage];
    if (!targets) {
      push({ stage, evaluation: "not-evaluable", metrics: [], diagnostics: ["no labels"] });
      continue;
    }
    const scored = targetMetrics(targets, execution);
    const metrics = scored.map((item) => item.metric);
    const diagnostics = scored.flatMap((item) => item.missing.map((target) => `missing ${target}`));
    if (stage === "planning" && "route" in targets && targets.route)
      metrics.push({ name: "routeCorrect", value: execution.route.mode === targets.route, direction: "exact" });
    if (stage === "planning") {
      const unique = new Set(execution.workItems.map((item) => item.id)).size;
      metrics.push(metric("uniqueWorkItemRate", unique, execution.workItems.length));
      metrics.push({
        name: "candidateBudgetRespected",
        value: (result.coverage.candidateTokensEstimated ?? 0) <= (result.coverage.candidateTokenBudget ?? Infinity),
        direction: "exact",
      });
    }
    push({ stage, evaluation: evaluation(stage), metrics, diagnostics });
  }

  const expectedCandidates = candidateExpectations(definition);
  if (opts.tier === "stage" || !definition.expectations.candidates) {
    push({
      stage: "candidates",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "stage tier does not invoke candidate models" : "no labels"],
    });
  } else {
    const desired = expectedCandidates.filter((expected) => expected.expectedPresence);
    const forbidden = expectedCandidates.filter((expected) => !expected.expectedPresence);
    const matched = desired.filter((expected) =>
      execution.candidates.some((actual) => candidateMatches(actual, expected)),
    );
    const generatedForbidden = forbidden.filter((expected) =>
      execution.candidates.some((actual) => candidateMatches(actual, expected)),
    );
    const anchored = execution.candidates.filter((candidate) =>
      trace.scope.changedFiles.includes(candidate.file),
    ).length;
    const requestsComplete = desired.filter((expected) => {
      const actual = execution.candidates.find((candidate) => candidateMatches(candidate, expected));
      return expected.requiredEvidenceKinds.every((kind) =>
        actual?.evidenceRequests.some((request) => request.kind === kind),
      );
    }).length;
    push({
      stage: "candidates",
      evaluation: evaluation("candidates"),
      metrics: [
        metric("expectedCandidateRecall", matched.length, desired.length),
        { name: "forbiddenCandidates", value: generatedForbidden.length, direction: "lower" },
        metric("anchorValidity", anchored, execution.candidates.length),
        metric("evidenceRequestCompleteness", requestsComplete, desired.length),
      ],
      diagnostics: [
        ...desired.filter((item) => !matched.includes(item)).map((item) => `missing ${item.id}`),
        ...generatedForbidden.map((item) => `forbidden candidate ${item.id}`),
      ],
    });
  }

  const evidenceLabels = definition.expectations.evidence?.requests;
  if (opts.tier === "stage" || !evidenceLabels) {
    push({
      stage: "evidence",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "no candidates in deterministic stage tier" : "no labels"],
    });
  } else {
    let statusMatches = 0;
    let expectedFiles = 0;
    let matchedFiles = 0;
    let forbiddenFiles = 0;
    const diagnostics: string[] = [];
    for (const label of evidenceLabels) {
      const candidateLabel = expectedCandidates.find((item) => item.id === label.candidate);
      const candidate = candidateLabel
        ? execution.candidates.find((item) => candidateMatches(item, candidateLabel))
        : execution.candidates.find((item) => item.id === label.candidate);
      const outcomes = candidate ? (execution.evidenceOutcomes?.[candidate.id] ?? []) : [];
      const outcome = outcomes.find((item) => item.request.kind === label.kind);
      if (outcome?.status === label.status) statusMatches += 1;
      const files = new Set(outcome?.records.map((record) => record.file) ?? []);
      expectedFiles += label.expectedFiles.length;
      matchedFiles += label.expectedFiles.filter((file) => files.has(file)).length;
      forbiddenFiles += label.forbiddenFiles.filter((file) => files.has(file)).length;
      if (!outcome) diagnostics.push(`missing ${label.candidate}:${label.kind}`);
    }
    push({
      stage: "evidence",
      evaluation: evaluation("evidence"),
      metrics: [
        metric("resolutionStatusAccuracy", statusMatches, evidenceLabels.length),
        metric("requiredFileRecall", matchedFiles, expectedFiles),
        { name: "forbiddenRecords", value: forbiddenFiles, direction: "lower" },
      ],
      diagnostics,
    });
  }

  const verificationLabels = definition.expectations.verification?.candidates;
  if (opts.tier === "stage" || !verificationLabels) {
    push({
      stage: "verification",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "stage tier does not invoke verifier models" : "no labels"],
    });
  } else {
    let verdictMatches = 0;
    let falseVerified = 0;
    let cited = 0;
    const diagnostics: string[] = [];
    const applicable = verificationLabels.filter(
      (expected) =>
        expected.expectedPresence || execution.candidates.some((candidate) => candidateMatches(candidate, expected)),
    );
    for (const expected of applicable) {
      const candidate = execution.candidates.find((item) => candidateMatches(item, expected));
      const verdict = candidate && execution.verification.find((item) => item.candidateId === candidate.id);
      if (verdict?.verdict === expected.expectedVerdict) verdictMatches += 1;
      if (expected.expectedVerdict !== "verified" && verdict?.verdict === "verified") falseVerified += 1;
      if (verdict?.supportingEvidenceIds.length) cited += 1;
      if (!verdict) diagnostics.push(`unadjudicated ${expected.id}`);
    }
    push({
      stage: "verification",
      evaluation: evaluation("verification"),
      metrics: [
        metric("verdictAccuracy", verdictMatches, applicable.length),
        { name: "falseVerifications", value: falseVerified, direction: "lower" },
        metric("citationRate", cited, applicable.length),
      ],
      diagnostics,
    });
  }

  const aggregation = definition.expectations.aggregation;
  if (opts.tier === "stage" || !aggregation) {
    push({
      stage: "aggregation",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "model-dependent inputs are not available in stage tier" : "no labels"],
    });
  } else {
    const unmatched = new Set(result.findings.map((_, index) => index));
    let truePositive = 0;
    for (const expected of aggregation.findings) {
      const index = [...unmatched].find((candidate) => findingMatches(result.findings[candidate], expected));
      if (index === undefined) continue;
      unmatched.delete(index);
      truePositive += 1;
    }
    const precision = ratio(truePositive, truePositive + unmatched.size) ?? (aggregation.findings.length ? 0 : 1);
    const recall = ratio(truePositive, aggregation.findings.length) ?? 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    push({
      stage: "aggregation",
      evaluation: evaluation("aggregation"),
      metrics: [
        { name: "precision", value: precision, direction: "higher" },
        { name: "recall", value: recall, direction: "higher" },
        { name: "f1", value: f1, direction: "higher" },
        {
          name: "outcomeCorrect",
          value: aggregation.outcome ? result.outcome === aggregation.outcome : null,
          direction: "exact",
        },
        {
          name: "statusCorrect",
          value: aggregation.status ? result.status === aggregation.status : null,
          direction: "exact",
        },
      ],
      diagnostics: [],
    });
  }

  const reporting = definition.expectations.reporting;
  if (!reporting) push({ stage: "reporting", evaluation: "not-evaluable", metrics: [], diagnostics: ["no labels"] });
  else {
    const serialized = JSON.stringify(result);
    const matched = reporting.requiredSections.filter((section) => serialized.includes(section));
    const coverageConsistent =
      result.coverage.changedFilesReviewed <= result.coverage.changedFiles &&
      result.coverage.changedSymbolsReviewed <= result.coverage.changedSymbols;
    push({
      stage: "reporting",
      evaluation: evaluation("reporting"),
      metrics: [
        metric("requiredContent", matched.length, reporting.requiredSections.length),
        { name: "coverageConsistent", value: coverageConsistent, direction: "exact" },
      ],
      diagnostics: reporting.requiredSections
        .filter((item) => !matched.includes(item))
        .map((item) => `missing ${item}`),
    });
  }
  const timingKey: Record<EvalStage, keyof NonNullable<EngineExecution["stageTimingsMs"]>> = {
    snapshot: "snapshot",
    graph: "graph",
    planning: "planning",
    candidates: "candidateGeneration",
    evidence: "evidence",
    verification: "verification",
    aggregation: "aggregation",
    reporting: "reporting",
  };
  for (const stage of values) {
    const wallMs = execution.stageTimingsMs?.[timingKey[stage.stage]];
    stage.metrics.push({ name: "wallMs", value: wallMs ?? null, direction: "lower" });
    if (stage.stage === "candidates")
      stage.metrics.push({
        name: "providerMs",
        value: result.coverage.candidateProviderMs ?? null,
        direction: "lower",
      });
    if (stage.stage === "verification")
      stage.metrics.push({
        name: "providerMs",
        value: result.coverage.verificationProviderMs ?? null,
        direction: "lower",
      });
  }
  return values;
}

function display(value: number | boolean | null): string {
  if (value === null) return "N/A";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function formatStageScorecard(stages: StageEvaluation[]): string[] {
  return [
    "| Stage | Evaluation | Metrics | Diagnostics |",
    "|---|---|---|---|",
    ...stages.map(
      (stage) =>
        `| ${stage.stage} | ${stage.evaluation} | ${stage.metrics.map((item) => `${item.name}=${display(item.value)}`).join(", ") || "N/A"} | ${stage.diagnostics.join("; ") || "—"} |`,
    ),
  ];
}
