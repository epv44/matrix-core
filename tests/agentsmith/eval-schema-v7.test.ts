import { describe, expect, it } from "vitest";
import {
  EVAL_CASE_SCHEMA_VERSION,
  evalCaseSchema,
  expectedFindingSchema,
  minimumEvidenceSchema,
} from "../../tools/agentsmith-evals/src/case.js";

const digest = "a".repeat(64);

function activeCase(schemaVersion: 5 | 6 | 7, finding: Record<string, unknown>) {
  return {
    schemaVersion,
    id: `schema-v${schemaVersion}`,
    status: "active",
    kind: "benchmark",
    suite: "component",
    source: {
      traceId: "trace-1",
      traceSchemaVersion: 5,
      repositoryFingerprint: "workspace-1",
      fixture: { path: "fixture/repo", manifestPath: "fixture-manifest.json", digest },
      project: "schema-test",
    },
    sanitization: {
      reviewed: true,
      absolutePathsRemoved: true,
      sensitiveContentReviewed: true,
      redistributable: true,
      sensitiveContentExemptions: [],
    },
    groundTruth: {
      reviewed: true,
      reviewedBy: "test-suite",
      reviewedAt: "2026-08-28T00:00:00.000Z",
      contractFamily: "schema-v7",
      exhaustiveCandidates: true,
    },
    expectations: { aggregation: { outcome: "findings", findings: [finding] } },
    narrative: { summary: "", trueCodeFlow: "", references: [] },
    tags: [],
  };
}

function legacyFinding() {
  return {
    id: "contract-mismatch",
    file: "src/consumer.ts",
    lineStart: 12,
    lineEnd: 13,
    severity: "high",
    category: "contract",
    discoveryClass: "L2",
    requiredEvidence: ["parseConfig"],
    symbols: ["loadConfig"],
    description: "The consumer assumes the old return contract.",
    rationale: "Requires the changed consumer and producer contract.",
  };
}

describe("AgentSmith eval schema v7", () => {
  it("accepts reviewed v7 gold findings with explicit small-model and minimum-evidence labels", () => {
    expect(EVAL_CASE_SCHEMA_VERSION).toBe(7);
    const parsed = evalCaseSchema.parse(
      activeCase(7, {
        ...legacyFinding(),
        smallModelExpected: true,
        minimumEvidence: [
          {
            file: "src/producer.ts",
            lineStart: 4,
            lineEnd: 8,
            symbol: "parseConfig",
            contains: ["return null"],
          },
        ],
      }),
    );

    expect(parsed.expectations.aggregation?.findings[0]).toMatchObject({
      smallModelExpected: true,
      minimumEvidence: [{ file: "src/producer.ts", symbol: "parseConfig", contains: ["return null"] }],
    });
  });

  it.each([5, 6] as const)("continues to read active schema-v%s cases without v7-only labels", (version) => {
    const parsed = evalCaseSchema.parse(activeCase(version, legacyFinding()));
    expect(parsed.schemaVersion).toBe(version);
    expect(parsed.expectations.aggregation?.findings).toHaveLength(1);
  });

  it("rejects active v7 benchmark gold findings without an explicit discovery expectation", () => {
    const finding = {
      ...legacyFinding(),
      minimumEvidence: [{ file: "src/producer.ts", contains: ["return null"] }],
    };
    expect(() => evalCaseSchema.parse(activeCase(7, finding))).toThrow(/smallModelExpected/);
  });

  it("rejects active v7 benchmark gold findings without minimum evidence", () => {
    const finding = { ...legacyFinding(), smallModelExpected: true, minimumEvidence: [] };
    expect(() => evalCaseSchema.parse(activeCase(7, finding))).toThrow(/minimumEvidence/);
  });

  it("validates minimum-evidence ranges and requires at least one text anchor", () => {
    expect(() =>
      minimumEvidenceSchema.parse({ file: "src/producer.ts", lineStart: 8, lineEnd: 4, contains: ["contract"] }),
    ).toThrow(/lineEnd/);
    expect(() => minimumEvidenceSchema.parse({ file: "src/producer.ts", contains: [] })).toThrow(/contains/);
  });

  it("rejects v7 findings with malformed minimum evidence through the exported finding schema", () => {
    expect(() =>
      expectedFindingSchema.parse({
        ...legacyFinding(),
        smallModelExpected: true,
        minimumEvidence: [{ file: "", contains: ["contract"] }],
      }),
    ).toThrow(/file/);
  });
});
