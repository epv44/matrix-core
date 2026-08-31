import { describe, expect, it } from "vitest";
import { compareEvalReports, summarizeEvalReport } from "../../tools/agentsmith-evals/src/eval.js";
import {
  CANONICAL_EVAL_MODES,
  CANONICAL_EVAL_TIERS,
  resultExecutionStatus,
  summarizeEvalReportStatus,
  summarizeExecutionGroup,
  summarizeSuiteReports,
} from "../../tools/agentsmith-evals/src/suite.js";

const passingResult = (overrides: Record<string, unknown> = {}) => ({
  mode: "partitioned-interactions",
  tier: "stage",
  iteration: 0,
  outcome: "clear",
  status: "completed",
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

  it("never promotes partial, incompatible, unavailable, or error runs", () => {
    expect(resultExecutionStatus(passingResult({ status: "partial" }))).toBe("partial");
    expect(resultExecutionStatus(passingResult({ incompatibilities: ["recording miss"] }))).toBe("incompatible");
    expect(
      resultExecutionStatus(
        passingResult({ stages: [{ stage: "planning", evaluation: "not-evaluable", metrics: [], diagnostics: [] }] }),
      ),
    ).toBe("unavailable");
    expect(resultExecutionStatus(passingResult({ errors: ["provider unavailable"] }))).toBe("error");
    expect(
      resultExecutionStatus(
        passingResult({
          stages: [{ stage: "evidence", evaluation: "executed", causalStatus: "downstream-blocked" }],
        }),
      ),
    ).toBe("fail");
    expect(
      resultExecutionStatus(
        passingResult({
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
            passingResult({ status: "partial", outcome: "incomplete", metrics: { precision: 0, recall: 0, f1: 0 } }),
          ],
        },
      ],
    };
    const reportStatus = summarizeEvalReportStatus(report, true);
    expect(reportStatus).toMatchObject({ status: "pass", diagnosticStatus: "partial" });
    expect(summarizeSuiteReports([report])).toMatchObject({ status: "pass", promotable: true });
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
});
