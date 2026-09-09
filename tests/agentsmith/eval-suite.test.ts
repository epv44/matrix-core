import { describe, expect, it } from "vitest";
import { compareEvalReports, summarizeEvalReport } from "../../tools/agentsmith-evals/src/eval.js";
import {
  CANONICAL_EVAL_MODES,
  CANONICAL_EVAL_TIERS,
  aggregateSuiteReport,
  aggregateSuiteMetrics,
  compareEvalSuiteBaseline,
  createEvalSuiteBaseline,
  htmlCompanionJsonPath,
  resultEvalStatus,
  resultExecutionStatus,
  summarizeEvalReportStatus,
  summarizeExecutionGroup,
  summarizeSuiteReports,
  validateSuiteBaselineEligibility,
  validateEvalSuiteBaseline,
} from "../../tools/agentsmith-evals/src/suite.js";
import {
  applySuiteProgress,
  createSuiteRunStatus,
  finishSuiteRunStatus,
  findLatestSuiteStatus,
  readSuiteRunStatus,
  suiteStatusPath,
  writeSuiteRunStatus,
} from "../../tools/agentsmith-evals/src/suite-status.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const passingResult = (overrides: Record<string, unknown> = {}) => ({
  mode: "partitioned-interactions",
  tier: "stage",
  iteration: 0,
  outcome: "clear",
  executionStatus: "completed",
  evalStatus: "pass",
  qualityEvaluable: false,
  outcomeCorrect: null,
  findings: [],
  coverage: { changedFiles: 1, changedFilesReviewed: 1 },
  stages: [
    {
      stage: "planning",
      evaluation: "executed",
      causalStatus: "healthy",
      metrics: [{ name: "fileRecall", value: 1, numerator: 1, denominator: 1, direction: "higher" }],
      diagnostics: [],
    },
  ],
  errors: [],
  incompatibilities: [],
  metrics: { precision: 1, recall: 1, f1: 1 },
  ...overrides,
});

describe("canonical AgentSmith eval suite", () => {
  it("expands the exact mode, tier, and repetition matrix", () => {
    expect(CANONICAL_EVAL_MODES).toEqual([
      "holistic",
      "partitioned-local",
      "partitioned-evidence",
      "partitioned-interactions",
      "hybrid",
    ]);
    expect(CANONICAL_EVAL_TIERS).toEqual([
      { tier: "stage", repetitions: 2, deterministic: true },
      { tier: "recorded", repetitions: 1, deterministic: true },
      { tier: "isolated", repetitions: 1, deterministic: false },
      { tier: "live", repetitions: 3, deterministic: false },
    ]);
  });

  it("requires deterministic repetitions to pass and remain stable", () => {
    const repeated = [passingResult(), passingResult({ iteration: 1 })];
    expect(summarizeExecutionGroup(repeated, true)).toMatchObject({ status: "pass", stable: true });

    const changed = [passingResult(), passingResult({ iteration: 1, outcome: "findings" })];
    expect(summarizeExecutionGroup(changed, true)).toMatchObject({ status: "unstable", stable: false });
  });

  it("separates eval status from execution state and ignores intentional N/A stages", () => {
    expect(resultEvalStatus(passingResult())).toBe("pass");
    expect(resultExecutionStatus(passingResult({ evalStatus: "partial", executionStatus: "completed" }))).toBe("partial");
    expect(resultExecutionStatus(passingResult({ incompatibilities: ["recording miss"] }))).toBe("incompatible");
    expect(
      resultExecutionStatus(
        passingResult({ evalStatus: undefined, stages: [{ stage: "planning", evaluation: "not-evaluable", metrics: [], diagnostics: [] }] }),
      ),
    ).toBe("unavailable");
    expect(resultExecutionStatus(passingResult({ errors: ["provider unavailable"] }))).toBe("error");
    expect(resultExecutionStatus(passingResult({ evalStatus: undefined, stages: [{ stage: "evidence", evaluation: "executed", causalStatus: "downstream-blocked" }] }))).toBe("pass");
    expect(
      resultExecutionStatus(
        passingResult({
          evalStatus: undefined,
          stages: [
            { stage: "planning", evaluation: "executed", causalStatus: "healthy" },
            { stage: "evidence", evaluation: "not-evaluable" },
          ],
        }),
      ),
    ).toBe("partial");
    expect(
      resultExecutionStatus(
        passingResult({
          evalStatus: undefined,
          stages: [
            { stage: "planning", evaluation: "executed", causalStatus: "healthy" },
            { stage: "ranking", evaluation: "not-applicable" },
          ],
        }),
      ),
    ).toBe("pass");
    expect(
      resultExecutionStatus(
        passingResult({
          evalStatus: undefined,
          stages: [
            { stage: "candidates", evaluation: "executed", causalStatus: "root-failure" },
            { stage: "evidence", evaluation: "not-evaluable", causalStatus: "downstream-blocked" },
          ],
        }),
      ),
    ).toBe("fail");
    expect(
      resultExecutionStatus(
        passingResult({
          evalStatus: undefined,
          stages: [
            {
              stage: "snapshot",
              evaluation: "observed",
              causalStatus: "healthy",
              metrics: [{ name: "fileRecall", value: 0.5 }],
            },
          ],
        }),
      ),
    ).toBe("fail");
  });

  it("keeps draft diagnostics out of scored status, aggregates, and comparisons", () => {
    const report = {
      replay: "stage" as const,
      cases: [
        { id: "active", scored: true, results: [passingResult()] },
        {
          id: "draft",
          scored: false,
          results: [
            passingResult({ executionStatus: "partial", evalStatus: "partial", outcome: "incomplete", metrics: { precision: 0, recall: 0, f1: 0 } }),
          ],
        },
      ],
    };
    const reportStatus = summarizeEvalReportStatus(report, true);
    expect(reportStatus).toMatchObject({ status: "pass", diagnosticStatus: "partial" });
    expect(summarizeSuiteReports([report])).toMatchObject({ status: "pass" });
    expect(summarizeSuiteReports([report])).not.toHaveProperty("promotable");
    expect(summarizeEvalReport(report)).toHaveLength(1);

    const comparison = compareEvalReports(
      { corpusHash: "same", cases: report.cases },
      {
        corpusHash: "same",
        cases: report.cases.map((evalCase) =>
          evalCase.id === "draft"
            ? { ...evalCase, results: [passingResult({ metrics: { precision: 0.5, recall: 0.5, f1: 0.5 } })] }
            : evalCase,
        ),
      },
    );
    expect(comparison.map((item) => item.caseId)).toEqual(["active"]);
  });

  it("builds active-only topline and structured per-case metrics", () => {
    const active = passingResult({
      tier: "live",
      qualityEvaluable: true,
      outcomeCorrect: true,
      metrics: { truePositive: 1, falsePositive: 1, falseNegative: 0, precision: 0.5, recall: 1, f1: 2 / 3 },
      stage1: {
        eligibleGold: 1,
        selectedGold: 1,
        candidateTruePositive: 1,
        candidateFalsePositive: 1,
        verifiedTruePositive: 1,
        verifiedFalsePositive: 1,
        attributions: { found: 1 },
      },
      inputTokens: 100,
      outputTokens: 20,
      durationMs: 50,
      benchmark: {
        coverage: { changedFiles: { reviewed: 1, eligible: 2, rate: 0.5 } },
        candidates: { adjudicationRate: 0.5 },
        evidence: { requests: 1, validRequests: 1, relevanceRate: 1 },
        reliability: { callsStarted: 2, providerFailures: 0, errors: 0, structuredRepairs: 0, timeout: false },
        honesty: { honest: true },
      },
    });
    const draft = passingResult({
      tier: "live",
      qualityEvaluable: false,
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    const report = {
      replay: "live" as const,
      cases: [
        { id: "active", suite: "component", scored: true, results: [active] },
        { id: "draft", suite: "component", scored: false, results: [draft] },
      ],
    };
    const aggregate = aggregateSuiteReport([report]);
    expect(aggregate.topline).toMatchObject({
      runs: 1,
      selectionRecall: { value: 1, numerator: 1, denominator: 1 },
      finding: { precision: { value: 0.5 }, recall: { value: 1 } },
      efficiency: { inputTokens: 100, outputTokens: 20, totalTokens: 120, modelCalls: 2 },
    });
    expect(aggregate.perCase).toHaveLength(2);
    expect(aggregate.componentMatrix.map((item) => item.caseId)).toEqual(["active"]);
      expect(aggregate.pipeline.stages.map((item) => item.id)).toEqual([
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
    ]);
    expect(aggregate.pipeline.stages.find((item) => item.id === "planning")?.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fileRecall", value: 1, primary: false })]),
    );
  });

  it("retains quality scores and partial reasons in observational aggregates", () => {
    const partial = passingResult({
      executionStatus: "partial",
      evalStatus: "partial",
      qualityEvaluable: true,
      metrics: { truePositive: 1, falsePositive: 2, falseNegative: 3, precision: 1 / 3, recall: 0.25, f1: 0.2857 },
      incompleteReasons: [{ kind: "insufficient-evidence", id: "finding-1", detail: "caller evidence was missing" }],
    });
    const metrics = aggregateSuiteMetrics([partial]);
    expect(metrics.finding).toMatchObject({ truePositive: 1, falsePositive: 2, falseNegative: 3, recall: { value: 0.25 } });
    expect(metrics.reliability.executionPartialRate).toMatchObject({ value: 1, numerator: 1, denominator: 1 });

    const aggregate = aggregateSuiteReport([
      { replay: "live", cases: [{ id: "partial", suite: "component", results: [partial] }] },
    ]);
    expect(aggregate.perCase[0].incompleteReasons).toEqual({
      counts: { "insufficient-evidence": 1 },
      details: [{ kind: "insufficient-evidence", id: "finding-1", detail: "caller evidence was missing" }],
    });
  });

  it("aggregates ratio stage metrics by numerator and denominator", () => {
    const make = (numerator: number, denominator: number) => passingResult({
      stages: [{
        stage: "graph",
        evaluation: "executed",
        causalStatus: "healthy",
        metrics: [{ name: "microEdgeRecall", value: denominator ? numerator / denominator : null, numerator, denominator, direction: "higher" }],
        diagnostics: [],
      }],
    });
    const aggregate = aggregateSuiteReport([
      { replay: "live", cases: [{ id: "a", suite: "component", results: [make(1, 1)] }] },
      { replay: "live", cases: [{ id: "a", suite: "component", results: [make(0, 100)] }] },
    ] as any);
    expect(aggregate.pipeline.stages.find((stage) => stage.id === "graph")?.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "microEdgeRecall", value: 1 / 101, numerator: 1, denominator: 101 })]),
    );
  });

  it("excludes N/A cases from derived candidate-stage recall", () => {
    const applicable = passingResult({
      stage1: { eligibleGold: 1, selectedGold: 1, candidateTruePositive: 1, candidateFalsePositive: 0 },
      stages: [{ stage: "candidates", evaluation: "executed", causalStatus: "healthy", metrics: [], diagnostics: [] }],
    });
    const notApplicable = passingResult({
      stage1: { eligibleGold: 100, selectedGold: 0, candidateTruePositive: 0, candidateFalsePositive: 0 },
      stages: [{ stage: "candidates", evaluation: "not-applicable", metrics: [], diagnostics: [] }],
    });
    const aggregate = aggregateSuiteReport([
      {
        replay: "live",
        cases: [
          { id: "applicable", suite: "component", results: [applicable] },
          { id: "not-applicable", suite: "component", results: [notApplicable] },
        ],
      },
    ] as any);
    expect(aggregate.pipeline.stages.find((stage) => stage.id === "candidates")?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "candidateFindingRecall", value: 1, numerator: 1, denominator: 1 }),
      ]),
    );
  });

  it("creates observational baselines from complete pass, fail, or partial suites", () => {
    const reports = CANONICAL_EVAL_TIERS.map((configuration) => ({
      replay: configuration.tier,
      repeat: configuration.repetitions,
      modes: CANONICAL_EVAL_MODES,
      cases: [],
    }));
    const current = {
      schemaVersion: 1,
      corpus: { activeHash: "a".repeat(64) },
      configuration: { modes: CANONICAL_EVAL_MODES, tiers: CANONICAL_EVAL_TIERS, drafts: "diagnostic-only" },
      execution: {
        plannedRuns: 0,
        completedRuns: 0,
        tiers: CANONICAL_EVAL_TIERS.map((configuration) => ({ ...configuration, status: "pass" as const })),
      },
      reports,
      topline: { finding: { recall: { value: 0.5, direction: "higher" } } },
      perCase: [],
    };
    const baseline = createEvalSuiteBaseline(current);
    expect(baseline.metricCatalog).toContain("topline.finding.recall");
    expect(validateEvalSuiteBaseline({ baseline, current })).toEqual({ ok: true, errors: [] });
    expect(compareEvalSuiteBaseline(baseline, current)).toMatchObject({ comparable: true });
    expect(baseline).not.toHaveProperty("promotable");
    const partialCurrent = {
      ...current,
      execution: {
        ...current.execution,
        tiers: current.execution.tiers.map((item) => ({ ...item, status: "partial" as const })),
      },
    };
    expect(validateSuiteBaselineEligibility(partialCurrent).eligible).toBe(true);
    const partialBaseline = createEvalSuiteBaseline(partialCurrent);
    expect(partialBaseline.schemaVersion).toBe(4);
    expect(partialBaseline.evidence.every((item) => item.evalStatus === "partial")).toBe(true);
    expect(() => createEvalSuiteBaseline({
      ...current,
      execution: { ...current.execution, tiers: current.execution.tiers.map((item) => ({ ...item, status: "error" as const })) },
    })).toThrow(/not baselineable/);
    expect(validateEvalSuiteBaseline({ baseline: { ...baseline, metricCatalog: [] }, current }).ok).toBe(false);
  });

  it("uses the configured mode set for a one-mode suite baseline", () => {
    const current = {
      schemaVersion: 1,
      corpus: { activeHash: "b".repeat(64) },
      configuration: { modes: ["partitioned-interactions"], tiers: [{ tier: "live", repetitions: 1, deterministic: false }] },
      execution: { plannedRuns: 1, completedRuns: 1, tiers: [{ tier: "live" as const, repetitions: 1, deterministic: false, status: "partial" as const }] },
      reports: [{ replay: "live" as const, repeat: 1, modes: ["partitioned-interactions"], cases: [] }],
      topline: { finding: { recall: { value: 0.125, direction: "higher" } } },
      perCase: [],
    };
    expect(validateSuiteBaselineEligibility(current, [{ tier: "live", repetitions: 1, deterministic: false }])).toEqual({ eligible: true, errors: [] });
    expect(createEvalSuiteBaseline(current, [{ tier: "live", repetitions: 1, deterministic: false }]).evidence[0].evalStatus).toBe("partial");
  });

  it("derives the companion JSON path for HTML output", () => {
    expect(htmlCompanionJsonPath("/tmp/report.html")).toBe("/tmp/report.json");
    expect(htmlCompanionJsonPath("/tmp/report")).toBe("/tmp/report.json");
  });

  it("persists and reduces live suite progress", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentsmith-status-"));
    const status = createSuiteRunStatus({
      runId: "run-1",
      caseCount: 2,
      modes: ["holistic", "hybrid"],
      tiers: [{ tier: "stage", repetitions: 1, deterministic: true }],
    });
    expect(status.plannedRuns).toBe(4);
    const progressed = applySuiteProgress(status, {
      tier: "stage",
      caseId: "case-a",
      mode: "holistic",
      iteration: 0,
      status: "completed",
      durationMs: 20,
      inputTokens: 10,
      outputTokens: 5,
      modelCalls: 1,
    });
    expect(progressed).toMatchObject({ completedRuns: 1, remainingRuns: 3, current: { caseId: "case-a" } });
    const file = suiteStatusPath(root, "run-1");
    writeSuiteRunStatus(file, finishSuiteRunStatus(progressed, "completed"));
    expect(readSuiteRunStatus(file).state).toBe("completed");
    expect(findLatestSuiteStatus(root)?.status.runId).toBe("run-1");
  });
});
