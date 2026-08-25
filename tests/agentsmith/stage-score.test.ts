import { describe, expect, it } from "vitest";
import { evaluateStages } from "../../tools/agentsmith-evals/src/stage-score.js";
import { corpusCoverage } from "../../tools/agentsmith-evals/src/coverage.js";

describe("AgentSmith stage scorecards", () => {
  it("keeps unlabeled stages N/A and penalizes forbidden candidates", () => {
    const definition = {
      expectations: {
        candidates: {
          items: [
            {
              id: "false-claim",
              file: "a.ts",
              lineStart: 1,
              lineEnd: 2,
              expectedPresence: false,
              expectedVerdict: "rejected",
              requiredEvidenceKinds: [],
              rationale: "negative control",
            },
          ],
        },
      },
    } as any;
    const stages = evaluateStages({
      definition,
      trace: { scope: { changedFiles: ["a.ts"], manifest: [] } } as any,
      execution: {
        workItems: [],
        candidates: [
          { id: "candidate", file: "a.ts", line: 1, category: "contract", title: "false claim", evidenceRequests: [] },
        ],
        verification: [],
        evidence: {},
      } as any,
      result: {
        findings: [],
        coverage: { changedFiles: 1, changedFilesReviewed: 0, changedSymbols: 0, changedSymbolsReviewed: 0 },
      } as any,
      tier: "live",
      hermetic: false,
    });
    expect(stages.find((stage) => stage.stage === "snapshot")?.evaluation).toBe("not-evaluable");
    expect(
      stages
        .find((stage) => stage.stage === "candidates")
        ?.metrics.find((metric) => metric.name === "forbiddenCandidates")?.value,
    ).toBe(1);
  });

  it("excludes conformance fixtures from benchmark coverage", () => {
    const coverage = corpusCoverage(process.cwd());
    expect(coverage.conformance).toBe(2);
    expect(coverage.activeBenchmarks).toBe(0);
    expect(coverage.drafts).toBe(1);
  });
});
