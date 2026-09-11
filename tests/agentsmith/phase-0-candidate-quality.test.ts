import { describe, expect, it } from "vitest";
import { collectEvalMetrics } from "../../tools/agentsmith-evals/src/eval-metrics.js";
import { collectCandidateNearMissDiagnostics } from "../../tools/agentsmith-evals/src/candidate-diagnostics.js";
import { evalCaseSchema } from "../../tools/agentsmith-evals/src/case.js";
import { evaluateOracleResolutions, deriveEvalStatus } from "../../tools/agentsmith-evals/src/oracle-resolution.js";
import { evaluateStages } from "../../tools/agentsmith-evals/src/stage-score.js";
import { aggregateSuiteReport } from "../../tools/agentsmith-evals/src/suite.js";

const expected = {
  id: "null-contract",
  file: "src/consumer.ts",
  lineStart: 10,
  lineEnd: 12,
  category: "contract",
  severity: "high",
  titleContains: "null",
  expectedPresence: true,
  expectedVerdict: "verified",
  requiredEvidenceKinds: ["callers"],
  requiredReasoningTerms: ["null", "caller"],
  forbiddenReasoningTerms: [],
  rationale: "The consumer does not handle the producer's nullable result.",
} as const;

function definition(overrides: Record<string, unknown> = {}) {
  return {
    expectations: {
      candidates: { items: [expected] },
      verification: { candidates: [expected] },
      evidence: {
        requests: [
          {
            candidate: expected.id,
            kind: "callers",
            status: "satisfied",
            expectedFiles: ["src/producer.ts"],
            expectedSymbols: ["loadValue"],
            requiredContent: ["return null"],
            forbiddenFiles: [],
            forbiddenContent: [],
          },
        ],
      },
      aggregation: { outcome: "findings", findings: [] },
      ...overrides,
    },
  } as any;
}

function trace() {
  return {
    scope: {
      changedFiles: ["src/consumer.ts"],
      fileContents: { "src/consumer.ts": Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") },
      suppliedContext: {},
      diff: [
        "diff --git a/src/consumer.ts b/src/consumer.ts",
        "--- a/src/consumer.ts",
        "+++ b/src/consumer.ts",
        "@@ -10,1 +11,1 @@",
        "+changed",
      ].join("\n"),
      manifest: [],
    },
  } as any;
}

function execution(
  candidates: any[] = [],
  evidenceOutcomes: Record<string, unknown[]> = {},
  verification: any[] = [],
) {
  return {
    candidates,
    verification,
    evidence: {},
    evidenceOutcomes,
    workItems: [],
    projection: { code: [], audit: [] },
  } as any;
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    file: "src/consumer.ts",
    line: 11,
    endLine: 11,
    category: "contract",
    severity: "high",
    title: "Null result is passed to the caller",
    description: "The caller contract is violated when the producer returns null.",
    evidenceRequests: [{ kind: "callers", symbol: "loadValue", reason: "check caller contract" }],
    ...overrides,
  };
}

function candidateMetric(stages: ReturnType<typeof evaluateStages>, name: string) {
  return stages.find((stage) => stage.stage === "candidates")?.metrics.find((metric) => metric.name === name);
}

describe("Phase 0 candidate-quality measurement contracts", () => {
  it("keeps file, region, category, severity, and title matching strict for the oracle", () => {
    const nearMisses = [
      candidate({ file: "src/other.ts" }),
      candidate({ line: 30, endLine: 31 }),
      candidate({ category: "correctness" }),
      candidate({ severity: "medium" }),
      candidate({ title: "The producer returns a value" }),
    ];

    for (const nearMiss of nearMisses) {
      const audits = evaluateOracleResolutions({
        definition: definition(),
        execution: execution([nearMiss]),
        result: { status: "completed", findings: [], incompleteReasons: [] } as any,
      });
      expect(audits[0]).toMatchObject({
        resolution: "missed",
        oracleSatisfied: false,
        reasonCode: "candidate-miss",
      });
    }
  });

  it("calculates independent near-miss dimensions without using the strict oracle", () => {
    const diagnosticDefinition = definition({
      aggregation: {
        outcome: "findings",
        findings: [
          {
            id: expected.id,
            file: expected.file,
            lineStart: expected.lineStart,
            lineEnd: expected.lineEnd,
            category: expected.category,
            severity: expected.severity,
            titleContains: expected.titleContains,
            discoveryClass: "L1",
            requiredEvidence: [],
            symbols: [],
            description: "impact caller",
            rationale: "caller null",
          },
        ],
      },
    });
    const actual = candidate({
      severity: "medium",
      title: "Null result reaches the caller",
      description: "Trigger: producer returns null. Invariant: caller must handle nullable results. Impact: the caller sees a null impact.",
      evidenceRequests: [{ kind: "callers", symbol: "loadValue", reason: "check caller contract" }],
    });
    const diagnostics = collectCandidateNearMissDiagnostics({
      definition: diagnosticDefinition,
      scope: trace().scope,
      candidates: [actual] as any,
    });
    const value = (name: string) => diagnostics.metrics.find((metric) => metric.name === name)?.value;

    expect(value("changedFileOverlap")).toBe(1);
    expect(value("changedRegionOverlap")).toBe(1);
    // Category compatibility is independent from the intentionally mismatched severity.
    expect(value("categoryCompatibility")).toBe(1);
    expect(value("severityCompatibility")).toBe(0);
    expect(value("triggeringValueRecall")).toBe(1);
    expect(value("violatedInvariantTermRecall")).toBe(1);
    expect(value("observableImpactTermRecall")).toBe(1);
    expect(value("titleSimilarity")).toBe(0.25);
    expect(value("claimCompleteness")).toBe(1);
    expect(value("anchorValidityDiagnostic")).toBe(1);
    expect(value("anchorDistance")).toBe(1);
    expect(value("evidenceRequestCompletenessDiagnostic")).toBe(1);
    expect(value("evidenceRequestLocatorValidity")).toBe(1);
    expect(value("strictOracleOnlyRejection")).toBe(0);
  });

  it("does not let semantically relevant text bypass the strict candidate oracle", () => {
    const relevantButWrong = candidate({
      category: "correctness",
      severity: "medium",
      title: "Caller mishandles a null result",
      description: "The caller fails when the producer returns null.",
    });
    const stages = evaluateStages({
      definition: definition(),
      trace: trace(),
      execution: execution([relevantButWrong]),
      result: { findings: [], coverage: {}, outcome: "clear" } as any,
      tier: "live",
      hermetic: false,
    });

    expect(candidateMetric(stages, "expectedCandidateRecall")).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(candidateMetric(stages, "anchorValidity")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });

    const audits = evaluateOracleResolutions({
      definition: definition(),
      execution: execution([relevantButWrong]),
      result: { status: "completed", findings: [], incompleteReasons: [] } as any,
    });
    expect(audits[0].oracleSatisfied).toBe(false);
  });

  it("reports candidate evidence-request completeness separately from strict candidate recall", () => {
    const incomplete = candidate({ evidenceRequests: [] });
    const stages = evaluateStages({
      definition: definition(),
      trace: trace(),
      execution: execution([incomplete]),
      result: { findings: [], coverage: {}, outcome: "clear" } as any,
      tier: "live",
      hermetic: false,
    });

    expect(candidateMetric(stages, "expectedCandidateRecall")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
    expect(candidateMetric(stages, "evidenceRequestCompleteness")).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
  });

  it("counts locator-bearing requests as valid and empty requests as invalid", () => {
    const metrics = collectEvalMetrics({
      scope: { diff: "", changedFiles: [], fileContents: {} } as any,
      result: { status: "completed", outcome: "clear", coverage: { omissions: [] } } as any,
      execution: {
        workItems: [],
        candidates: [
          candidate({
            evidenceRequests: [
              { kind: "callers", symbol: "loadValue", reason: "valid symbol locator" },
              { kind: "implementation", reason: "missing locator" },
            ],
          }),
        ],
        evidence: {},
        verification: [],
        providerFailures: [],
        inputTokens: 0,
        outputTokens: 0,
      } as any,
      durationMs: 0,
    });

    expect(metrics.evidence).toMatchObject({
      requests: 2,
      validRequests: 1,
      requestValidityRate: 0.5,
    });
  });

  it("keeps missing and forbidden candidates out of positive recall", () => {
    const missing = evaluateStages({
      definition: definition(),
      trace: trace(),
      execution: execution(),
      result: { findings: [], coverage: {}, outcome: "clear" } as any,
      tier: "live",
      hermetic: false,
    });
    expect(candidateMetric(missing, "expectedCandidateRecall")).toMatchObject({ value: 0, numerator: 0, denominator: 1 });

    const negative = { ...expected, id: "forbidden", expectedPresence: false, expectedVerdict: "rejected" };
    const forbidden = evaluateStages({
      definition: { expectations: { candidates: { items: [negative] } } } as any,
      trace: trace(),
      execution: execution([candidate({ id: "forbidden" })]),
      result: { findings: [], coverage: {}, outcome: "clear" } as any,
      tier: "live",
      hermetic: false,
    });
    expect(candidateMetric(forbidden, "forbiddenCandidates")).toMatchObject({ value: 1 });
    expect(candidateMetric(forbidden, "expectedCandidateRecall")).toMatchObject({ value: null, numerator: 0, denominator: 0 });
  });

  it("rejects malformed candidate declarations instead of manufacturing a denominator", () => {
    expect(() =>
      evalCaseSchema.parse({
        schemaVersion: 9,
        id: "malformed-candidate",
        status: "active",
        kind: "benchmark",
        suite: "component",
        source: { traceId: "trace", traceSchemaVersion: 5, fixture: null, project: "test" },
        sanitization: {
          reviewed: true,
          absolutePathsRemoved: true,
          sensitiveContentReviewed: true,
          redistributable: true,
          sensitiveContentExemptions: [],
        },
        evaluationScope: { stages: ["candidates"] },
        groundTruth: { reviewed: true, reviewedBy: "test", reviewedAt: "2026-08-28T00:00:00.000Z", contractFamily: "test", exhaustiveCandidates: true },
        expectations: { candidates: { items: [{ ...expected, file: "" }] } },
      }),
    ).toThrow(/file/);
  });

  it("does not turn diagnostic text into a score or status change", () => {
    const pass = deriveEvalStatus({
      executionStatus: "completed",
      oracleResolutions: [],
      stages: [{ stage: "candidates", evaluation: "executed", causalStatus: "healthy", metrics: [], diagnostics: [] }],
    });
    const diagnosticOnly = deriveEvalStatus({
      executionStatus: "completed",
      oracleResolutions: [],
      stages: [
        {
          stage: "candidates",
          evaluation: "executed",
          causalStatus: "healthy",
          metrics: [],
          diagnostics: ["title similarity is low", "anchor distance is large"],
        },
      ],
    });
    expect(diagnosticOnly).toBe(pass);
  });

  it("keeps near-miss diagnostics non-causal when evaluating the full stage pipeline", () => {
    const nearMiss = candidate({
      severity: "medium",
      title: "Null result reaches the caller",
      description: "The caller sees a null impact.",
    });
    const stages = evaluateStages({
      definition: definition(),
      trace: trace(),
      execution: execution([nearMiss]),
      result: { findings: [], coverage: {}, outcome: "clear" } as any,
      tier: "live",
      hermetic: false,
    });
    const candidates = stages.find((stage) => stage.stage === "candidates")!;
    const evidence = stages.find((stage) => stage.stage === "evidence")!;

    // The candidate is intentionally a strict-oracle miss, but the diagnostic
    // explaining that miss must not manufacture a root failure or block later
    // stages.
    expect(candidates.causalStatus).toBe("healthy");
    expect(evidence.causalStatus).toBe("healthy");
    expect(candidateMetric(stages, "expectedCandidateRecall")).toMatchObject({
      value: 0,
      numerator: 0,
      denominator: 1,
    });
    const audits = evaluateOracleResolutions({
      definition: definition(),
      execution: execution([nearMiss]),
      result: { status: "completed", findings: [], incompleteReasons: [] } as any,
    });
    expect(audits[0]).toMatchObject({ resolution: "missed", oracleSatisfied: false, reasonCode: "candidate-miss" });
  });

  it("reports locator shape validity separately from frozen-snapshot scope resolution", () => {
    const metrics = collectCandidateNearMissDiagnostics({
      definition: definition(),
      scope: trace().scope,
      candidates: [
        candidate({
          evidenceRequests: [
            {
              kind: "implementation",
              locatorMode: "literal",
              pathHint: "src/consumer.ts",
              query: "line 11",
              reason: "resolves within the frozen snapshot",
            },
            {
              kind: "implementation",
              locatorMode: "literal",
              pathHint: "src/consumer.ts",
              query: "does-not-exist-anywhere",
              reason: "syntactically shaped but not resolvable",
            },
          ],
        }),
      ] as any,
    });
    const value = (name: string) => metrics.metrics.find((metric) => metric.name === name)?.value;

    // `evidenceRequestLocatorValidity` is the structural/shape metric; scope
    // resolution is reported independently rather than being folded into it.
    expect(value("evidenceRequestLocatorValidity")).toBe(1);
    expect(value("evidenceRequestLocatorScopeValidity")).toBe(0.5);
    // Locator diagnostics must not change strict candidate matching.
    const audits = evaluateOracleResolutions({
      definition: definition(),
      execution: execution([candidate()], {}, [{ candidateId: "candidate-1", verdict: "verified" }]),
      result: { status: "completed", findings: [candidate()], incompleteReasons: [] } as any,
    });
    expect(audits[0].oracleSatisfied).toBe(true);
  });

  it("pairs positive expectations with generated candidates one-to-one and deterministically", () => {
    const secondExpected = {
      ...expected,
      id: "second-null-contract",
      lineStart: 20,
      lineEnd: 22,
      titleContains: "separate null",
    };
    const diagnosticDefinition = definition({
      candidates: { items: [expected, secondExpected] },
      verification: { candidates: [expected, secondExpected] },
      aggregation: { outcome: "findings", findings: [] },
    });
    const onlyCandidate = candidate({ title: "Null result is passed to the caller" });
    const diagnostics = collectCandidateNearMissDiagnostics({
      definition: diagnosticDefinition,
      scope: trace().scope,
      candidates: [onlyCandidate] as any,
    });
    const repeated = collectCandidateNearMissDiagnostics({
      definition: diagnosticDefinition,
      scope: trace().scope,
      candidates: [onlyCandidate] as any,
    });
    const value = (name: string) => diagnostics.metrics.find((metric) => metric.name === name)?.value;

    // The single generated candidate may satisfy only the closest expected
    // item; it must not be reused for the second positive expectation.
    expect(value("changedFileOverlap")).toBe(0.5);
    expect(value("categoryCompatibility")).toBe(0.5);
    expect(value("severityCompatibility")).toBe(0.5);
    expect(value("strictOracleOnlyRejection")).toBe(0);
    expect(repeated.metrics).toEqual(diagnostics.metrics);

    const audits = evaluateOracleResolutions({
      definition: diagnosticDefinition,
      execution: execution([onlyCandidate], {}, [{ candidateId: "candidate-1", verdict: "verified" }]),
      result: { status: "completed", findings: [onlyCandidate], incompleteReasons: [] } as any,
    });
    expect(audits.filter((audit) => audit.oracleSatisfied)).toHaveLength(1);
    expect(audits.find((audit) => audit.oracleId === expected.id)?.oracleSatisfied).toBe(true);
    expect(audits.find((audit) => audit.oracleId === secondExpected.id)?.oracleSatisfied).toBe(false);
  });

  it("serializes the same scorecard deterministically and preserves N/A denominators", () => {
    const report = {
      replay: "stage" as const,
      cases: [
        {
          id: "candidate-case",
          suite: "component",
          scored: true,
          results: [
            {
              evalStatus: "pass",
              executionStatus: "completed",
              outcome: "clear",
              findings: [],
              stages: [
                {
                  stage: "candidates",
                  evaluation: "executed",
                  causalStatus: "healthy",
                  metrics: [{ name: "titleSimilarity", value: null, numerator: 0, denominator: 0, direction: "higher" }],
                  diagnostics: [],
                },
              ],
              errors: [],
              incompatibilities: [],
            },
          ],
        },
      ],
    } as any;
    const first = aggregateSuiteReport([report]);
    const second = aggregateSuiteReport([structuredClone(report)]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.pipeline.stages.find((stage) => stage.id === "candidates")?.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "titleSimilarity", value: null })]),
    );
    expect(first.pipeline.stages.find((stage) => stage.id === "candidates")?.metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "candidateFindingRecall", value: null, denominator: 0 })]),
    );
  });
});
