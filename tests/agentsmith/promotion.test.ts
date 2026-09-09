import { describe, expect, it } from "vitest";
import { evaluateReviewPromotion } from "../../tools/agentsmith-evals/src/promotion.js";
import { suiteConfigurationHash } from "../../tools/agentsmith-evals/src/suite.js";

const configuration = {
  suite: "component",
  modelTarget: "small",
  modes: ["partitioned-interactions"],
  tiers: [{ tier: "live", repetitions: 1, deterministic: false }],
};
const corpusHash = "a".repeat(64);

function topline(overrides: Record<string, unknown> = {}) {
  return {
    selectionRecall: { value: 0.9 },
    finding: { recall: { value: 0.8 }, precision: { value: 0.85 } },
    oracleResolutionAccuracy: { value: 0.75 },
    reliability: {
      executionPartialRate: { value: 0, numerator: 0, denominator: 10 },
      providerFailures: 0,
      errors: 0,
      timeouts: 0,
    },
    efficiency: { totalTokens: 1000 },
    ...overrides,
  };
}

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    reportKind: "agentsmith-eval-suite-baseline",
    evaluationSchemaVersion: 4,
    metricDefinitionVersion: 4,
    suite: "component",
    modelTarget: "small",
    corpusHash,
    configurationHash: suiteConfigurationHash(configuration),
    metricCatalog: ["topline.selectionRecall"],
    evidence: [{ evalStatus: "fail", reportHash: "b".repeat(64) }],
    topline: topline(),
    ...overrides,
  };
}

function current(toplineOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    reportKind: "agentsmith-eval-suite",
    evaluationSchemaVersion: 4,
    metricDefinitionVersion: 4,
    suite: "component",
    modelTarget: "small",
    corpus: { activeHash: corpusHash },
    configuration,
    execution: { plannedRuns: 10, completedRuns: 10 },
    topline: topline(toplineOverrides),
    ...overrides,
  };
}

describe("review promotion thresholds", () => {
  it("passes within explicit quality and cost tolerances", () => {
    const result = evaluateReviewPromotion(
      baseline(),
      current({
        selectionRecall: { value: 0.89 },
        finding: { recall: { value: 0.78 }, precision: { value: 0.83 } },
        oracleResolutionAccuracy: { value: 0.75 },
        efficiency: { totalTokens: 1150 },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks actual partial execution even when quality metrics pass", () => {
    const result = evaluateReviewPromotion(
      baseline(),
      current({
        reliability: {
          executionPartialRate: { value: 0.1, numerator: 1, denominator: 10 },
          providerFailures: 0,
          errors: 0,
          timeouts: 0,
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "execution-integrity")).toMatchObject({ ok: false });
  });

  it("does not use aggregate PASS as a promotion criterion", () => {
    expect(evaluateReviewPromotion(baseline(), current({}, { evalStatus: "partial" })).ok).toBe(true);
  });

  it("rejects unrelated or incompatible artifacts before comparing metrics", () => {
    const result = evaluateReviewPromotion(
      baseline(),
      current({}, { evaluationSchemaVersion: 999, corpus: { activeHash: "c".repeat(64) } }),
    );
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "artifact-compatibility")).toMatchObject({ ok: false });
  });
});
