import { describe, expect, it } from "vitest";
import {
  aggregateStage1Metrics,
  classifyStage1Finding,
  scoreStage1Selection,
  serializeStage1Baseline,
  summarizeStage1Baseline,
  validateStage1Promotion,
  type Stage1Baseline,
  type Stage1EvalReport,
  type Stage1RunScore,
} from "../../tools/agentsmith-evals/src/stage-1.js";

const corpusHash = "b".repeat(64);

function selectionGold() {
  return {
    id: "consumer-contract",
    file: "src/consumer.ts",
    lineStart: 10,
    lineEnd: 11,
    discoveryClass: "L2" as const,
    requiredEvidence: [],
    symbols: [],
    description: "",
    rationale: "The consumer and producer contract must be inspected together.",
    smallModelExpected: true,
    minimumEvidence: [
      {
        file: "src/producer.ts",
        lineStart: 4,
        lineEnd: 8,
        symbol: "parseConfig",
        contains: ["return null"],
      },
      { file: "src/schema.ts", contains: ["Config | null"] },
    ],
  };
}

function workItem(id: string, code: Array<Record<string, unknown>>) {
  return {
    id,
    primarySymbols: [],
    relatedSymbols: [],
    graphEdges: [],
    code,
  } as any;
}

function runScore(values: Partial<Stage1RunScore> = {}): Stage1RunScore {
  return {
    eligibleGold: 1,
    selectedGold: 1,
    candidateTruePositive: 1,
    candidateFalsePositive: 0,
    verifiedTruePositive: 1,
    verifiedFalsePositive: 0,
    attributions: {
      "coverage-budget-failure": 0,
      "selection-miss": 0,
      "model-miss": 0,
      "verification-rejection": 0,
      found: 1,
    },
    gold: [],
    ...values,
  };
}

function report(options: {
  replay: "stage" | "live";
  repeat: 2 | 3;
  score?: Stage1RunScore;
  contractFamily?: string;
  errors?: string[];
  corpus?: string;
}): Stage1EvalReport {
  const score = options.score ?? runScore();
  return {
    schemaVersion: 7,
    corpusHash: options.corpus ?? corpusHash,
    replay: options.replay,
    modes: ["partitioned-interactions"],
    repeat: options.repeat,
    cases: [
      {
        id: "contract-case",
        contractFamily: options.contractFamily ?? "contract-family",
        results: Array.from({ length: options.repeat }, (_, iteration) => ({
          mode: "partitioned-interactions",
          iteration,
          status: "completed",
          outcome: "findings",
          durationMs: 10,
          inputTokens: 100,
          outputTokens: 20,
          errors: options.errors ?? [],
          benchmark: { reliability: { callsStarted: 2 } },
          stage1: structuredClone(score),
        })),
      },
    ],
  };
}

describe("Stage 1 selection and attribution", () => {
  it("requires the changed location and every minimum-evidence descriptor in one work item", () => {
    const gold = selectionGold();
    const split = scoreStage1Selection(gold, [
      workItem("changed", [
        { file: "src/consumer.ts", startLine: 8, endLine: 14, content: "const config = parseConfig(raw);" },
      ]),
      workItem("producer", [
        {
          file: "src/producer.ts",
          startLine: 4,
          endLine: 8,
          symbol: "parseConfig",
          content: "if (!raw) return null;",
        },
      ]),
      workItem("schema", [
        { file: "src/schema.ts", startLine: 1, endLine: 3, content: "export type Result = Config | null;" },
      ]),
    ]);

    expect(split).toMatchObject({
      selected: false,
      selectedWorkItemId: null,
      changedLocationCovered: true,
      minimumEvidenceCovered: false,
      missingEvidence: [0, 1],
    });

    const combined = scoreStage1Selection(gold, [
      workItem("interaction", [
        { file: "src/consumer.ts", startLine: 8, endLine: 14, content: "const config = parseConfig(raw);" },
        {
          file: "src/producer.ts",
          startLine: 4,
          endLine: 8,
          symbol: "parseConfig",
          content: "if (!raw) return null;",
        },
        { file: "src/schema.ts", startLine: 1, endLine: 3, content: "export type Result = Config | null;" },
      ]),
    ]);
    expect(combined).toMatchObject({
      selected: true,
      selectedWorkItemId: "interaction",
      changedLocationCovered: true,
      minimumEvidenceCovered: true,
      missingEvidence: [],
    });
  });

  it.each([
    [
      { coverageBudgetFailure: true, selected: false, candidateFound: false, verifiedFound: false },
      "coverage-budget-failure",
    ],
    [{ coverageBudgetFailure: false, selected: false, candidateFound: false, verifiedFound: false }, "selection-miss"],
    [{ coverageBudgetFailure: false, selected: true, candidateFound: false, verifiedFound: false }, "model-miss"],
    [
      { coverageBudgetFailure: false, selected: true, candidateFound: true, verifiedFound: false },
      "verification-rejection",
    ],
    [{ coverageBudgetFailure: false, selected: true, candidateFound: true, verifiedFound: true }, "found"],
  ] as const)("applies failure attribution precedence for %j", (input, expected) => {
    expect(classifyStage1Finding(input)).toBe(expected);
  });
});

describe("Stage 1 baseline metrics and promotion", () => {
  it("reports finding-weighted micro metrics and equally weighted contract-family macro metrics", () => {
    const dominant = runScore({
      eligibleGold: 3,
      selectedGold: 3,
      candidateTruePositive: 3,
      candidateFalsePositive: 1,
      verifiedTruePositive: 3,
    });
    const missed = runScore({
      eligibleGold: 1,
      selectedGold: 0,
      candidateTruePositive: 0,
      candidateFalsePositive: 1,
      verifiedTruePositive: 0,
      verifiedFalsePositive: 1,
      attributions: {
        "coverage-budget-failure": 0,
        "selection-miss": 1,
        "model-miss": 0,
        "verification-rejection": 0,
        found: 0,
      },
    });
    const first = report({ replay: "live", repeat: 3, score: dominant, contractFamily: "family-a" }).cases[0];
    const second = report({ replay: "live", repeat: 3, score: missed, contractFamily: "family-b" }).cases[0];
    second.results[0].status = "partial";
    second.results[0].outcome = "incomplete";
    const metrics = aggregateStage1Metrics({
      ...report({ replay: "live", repeat: 3 }),
      cases: [first, second],
    });

    expect(metrics.micro.selectionRecall).toBe(0.75);
    expect(metrics.micro.candidateFindingRecall).toBe(0.75);
    expect(metrics.micro.candidateFindingPrecision).toBe(0.6);
    expect(metrics.micro.verifiedFindingPrecision).toBe(0.75);
    expect(metrics.micro).toMatchObject({
      inputTokens: 600,
      outputTokens: 120,
      totalTokens: 720,
      modelCallCount: 12,
      latencyMeanMs: 10,
      latencyStdDevMs: 0,
      partialReviewRate: 1 / 6,
      runs: 6,
    });
    expect(metrics.contractFamilyMacro.selectionRecall).toBe(0.5);
    expect(metrics.contractFamilyMacro.candidateFindingPrecision).toBe(0.375);
    expect(metrics.contractFamilyMacro.verifiedFindingRecall).toBe(0.5);
    expect(metrics.contractFamilyMacro.verifiedFindingPrecision).toBe(0.5);
    expect(metrics.contractFamilyMacro.partialReviewRate).toBe(1 / 6);
    expect(Object.keys(metrics.byContractFamily)).toEqual(["family-a", "family-b"]);
  });

  it("builds and serializes a deterministic baseline", () => {
    const baseline = summarizeStage1Baseline(
      report({ replay: "stage", repeat: 2 }),
      report({ replay: "live", repeat: 3 }),
    );
    const reordered = {
      metrics: baseline.metrics,
      evidence: baseline.evidence,
      modes: baseline.modes,
      corpusHash: baseline.corpusHash,
      stage: baseline.stage,
      schemaVersion: baseline.schemaVersion,
    } as Stage1Baseline;

    expect(serializeStage1Baseline(reordered)).toBe(serializeStage1Baseline(baseline));
    expect(serializeStage1Baseline(baseline).endsWith("\n")).toBe(true);
    expect(baseline.evidence).toMatchObject({
      stageReplay: { repetitions: 2, deterministic: true },
      live: { repetitions: 3, harnessErrors: 0 },
    });
  });

  it("rejects baseline construction from mismatched corpora, wrong repetitions, errors, or missing run metrics", () => {
    const stage = report({ replay: "stage", repeat: 2 });
    const live = report({ replay: "live", repeat: 3 });

    expect(() => summarizeStage1Baseline(stage, { ...live, corpusHash: "c".repeat(64) })).toThrow(/corpus/i);
    expect(() => summarizeStage1Baseline(stage, { ...live, repeat: 2 })).toThrow(/exactly 3 repetitions/i);
    expect(() =>
      summarizeStage1Baseline(stage, report({ replay: "live", repeat: 3, errors: ["provider failed"] })),
    ).toThrow(/errors|incompatibilities/i);
    const missingMetrics = structuredClone(live);
    delete missingMetrics.cases[0].results[0].stage1;
    expect(() => summarizeStage1Baseline(stage, missingMetrics)).toThrow(/lacks Stage 1 metrics/i);
  });

  it("rejects nondeterministic stage replay evidence", () => {
    const stage = report({ replay: "stage", repeat: 2 });
    stage.cases[0].results[1].outputTokens += 1;
    expect(() => summarizeStage1Baseline(stage, report({ replay: "live", repeat: 3 }))).toThrow(/not deterministic/i);
  });

  it("allows promotion only for a complete baseline matching the current corpus", () => {
    const baseline = summarizeStage1Baseline(
      report({ replay: "stage", repeat: 2 }),
      report({ replay: "live", repeat: 3 }),
    );
    expect(validateStage1Promotion({ baseline, currentCorpusHash: corpusHash })).toEqual({ ok: true, errors: [] });

    const invalid = structuredClone(baseline);
    invalid.evidence.live.repetitions = 2 as 3;
    invalid.evidence.live.harnessErrors = 1 as 0;
    invalid.metrics.micro.selectionRecall = null;
    const validation = validateStage1Promotion({ baseline: invalid, currentCorpusHash: "d".repeat(64) });
    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/corpus hash does not match/);
    expect(validation.errors.join("\n")).toMatch(/three-repetition live evidence is missing/);
    expect(validation.errors.join("\n")).toMatch(/selectionRecall is missing or non-numeric/);
  });
});
