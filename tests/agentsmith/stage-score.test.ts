import { describe, expect, it } from "vitest";
import { evaluateStages } from "../../tools/agentsmith-evals/src/stage-score.js";
import { corpusCoverage } from "../../tools/agentsmith-evals/src/coverage.js";

describe("AgentSmith stage scorecards", () => {
  it("attributes a present graph target and a missing planner selection to different stages", () => {
    const definition = {
      expectations: {
        graph: {
          files: ["src/api.ts"],
          symbols: ["src/api.ts#Contract"],
          edges: ["src/view.ts:render->src/api.ts:Contract:reads-type"],
          forbiddenFiles: [],
          forbiddenSymbols: [],
          forbiddenEdges: [],
          paths: [
            {
              from: "src/view.ts:render",
              to: "src/api.ts:Contract",
              maxHops: 1,
              edgeKinds: ["reads-type"],
            },
          ],
        },
        planning: {
          files: ["src/api.ts"],
          symbols: ["src/api.ts#Contract"],
          edges: [],
          forbiddenFiles: [],
          forbiddenSymbols: [],
          forbiddenEdges: [],
          paths: [],
        },
      },
    } as any;
    const stages = evaluateStages({
      definition,
      trace: { scope: { changedFiles: ["src/view.ts"], manifest: [] } } as any,
      execution: {
        graphManifest: {
          changedSymbols: [],
          nodes: [{ file: "src/api.ts", name: "Contract", qualifiedName: "Contract" }],
          edges: [
            {
              source: "src/view.ts:render",
              target: "src/api.ts:Contract",
              targetText: "Contract",
              kind: "reads-type",
              confidence: "exact",
            },
          ],
          selectedNodeKeys: [],
          omittedNodeKeys: [],
        },
        workItems: [],
        projection: { code: [], audit: [] },
        candidates: [],
        verification: [],
        evidence: {},
        route: { mode: "partitioned" },
      } as any,
      result: { findings: [], coverage: { candidateTokensEstimated: 0, candidateTokenBudget: 1 } } as any,
      tier: "stage",
      hermetic: true,
    });
    const value = (stage: string, metric: string) =>
      stages.find((item) => item.stage === stage)?.metrics.find((item) => item.name === metric)?.value;
    expect(value("graph", "filesRecall")).toBe(1);
    expect(value("graph", "pathRecall")).toBe(1);
    expect(value("graph", "labeledExactEdgeRate")).toBe(1);
    expect(value("planning", "filesRecall")).toBe(0);
  });

  it("derives tracked addition-only files as modified from the diff", () => {
    const stages = evaluateStages({
      definition: { expectations: { snapshot: { files: [{ path: "a.ts", changeKind: "modified" }] } } } as any,
      trace: {
        scope: {
          changedFiles: ["a.ts"],
          manifest: [{ path: "a.ts", changeKind: "added" }],
          diff: "diff --git a/a.ts b/a.ts\nindex 111..222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n keep\n+added",
        },
      } as any,
      execution: {
        workItems: [],
        projection: { code: [], audit: [] },
        candidates: [],
        verification: [],
        evidence: {},
      } as any,
      result: { findings: [], coverage: {} } as any,
      tier: "stage",
      hermetic: true,
    });
    expect(stages.find((stage) => stage.stage === "snapshot")?.metrics[0].value).toBe(1);
  });

  it("scores projection content separately from forbidden noise", () => {
    const stages = evaluateStages({
      definition: {
        expectations: {
          projection: {
            requiredSnippets: [{ file: "src/view.ts", contains: ["cash_snapshot"] }],
            forbiddenFiles: ["package-lock.json"],
            forbiddenContent: [],
          },
        },
      } as any,
      trace: { scope: { changedFiles: ["src/view.ts"], manifest: [] } } as any,
      execution: {
        projection: {
          code: [
            { id: "right", file: "src/view.ts", startLine: 1, endLine: 2, content: "cash_snapshot" },
            { id: "noise", file: "package-lock.json", startLine: 1, endLine: 2, content: "lock" },
          ],
          audit: [],
        },
        workItems: [],
        candidates: [],
        verification: [],
        evidence: {},
      } as any,
      result: { findings: [], coverage: {} } as any,
      tier: "stage",
      hermetic: true,
    });
    const projection = stages.find((stage) => stage.stage === "projection")!;
    expect(projection.metrics.find((item) => item.name === "requiredSnippetRecall")?.value).toBe(1);
    expect(projection.metrics.find((item) => item.name === "forbiddenFiles")?.value).toBe(1);
  });

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

  it("isolates downstream evidence from an ordinary candidate miss and scores rendered Markdown", () => {
    const expected = {
      id: "cash-source",
      file: "view.ts",
      lineStart: 9,
      lineEnd: 9,
      expectedPresence: true,
      expectedVerdict: "verified",
      requiredEvidenceKinds: ["implementation"],
      requiredReasoningTerms: ["cash_snapshot"],
      forbiddenReasoningTerms: [],
      rationale: "contract",
    };
    const golden = {
      id: "golden-cash-source",
      file: "view.ts",
      line: 9,
      severity: "low",
      category: "contract",
      title: "cash source",
      description: "cash_snapshot",
      evidenceRequests: [{ kind: "implementation", reason: "contract" }],
    };
    const stages = evaluateStages({
      definition: {
        expectations: {
          candidates: { items: [expected] },
          evidence: {
            requests: [
              {
                candidate: "cash-source",
                kind: "implementation",
                status: "satisfied",
                expectedFiles: ["service.py"],
                forbiddenFiles: [],
                expectedSymbols: [],
                requiredContent: ["cash_snapshot"],
                forbiddenContent: [],
              },
            ],
          },
          reporting: { requiredSections: ["cash_snapshot"] },
        },
      } as any,
      trace: { scope: { changedFiles: ["view.ts"], manifest: [], diff: "" } } as any,
      candidateExecution: { candidates: [], coverage: {} } as any,
      execution: {
        workItems: [],
        candidates: [golden],
        evidence: { "golden-cash-source": [] },
        evidenceOutcomes: {
          "golden-cash-source": [
            {
              request: { kind: "implementation" },
              status: "satisfied",
              records: [{ file: "service.py", snippet: "value_source = 'cash_snapshot'" }],
            },
          ],
        },
        verification: [],
        graphSnapshot: { schemaVersion: 1, providerVersions: { ts: "1" } },
        modelProfiles: { candidate: {}, verifier: {} },
        projection: { code: [], audit: [] },
        coverage: {},
      } as any,
      result: {
        findings: [],
        coverage: { changedFiles: 1, changedFilesReviewed: 1, changedSymbols: 1, changedSymbolsReviewed: 1 },
      } as any,
      tier: "isolated",
      hermetic: true,
      reportMarkdown: "No relevant rendered section",
    });
    expect(stages.find((stage) => stage.stage === "candidates")?.causalStatus).toBe("root-failure");
    expect(stages.find((stage) => stage.stage === "evidence")?.causalStatus).toBe("healthy");
    expect(stages.find((stage) => stage.stage === "evidence")?.blockedBy).toBeUndefined();
    expect(
      stages.find((stage) => stage.stage === "evidence")?.metrics.find((metric) => metric.name === "requiredFileRecall")
        ?.value,
    ).toBe(1);
    expect(
      stages.find((stage) => stage.stage === "reporting")?.metrics.find((metric) => metric.name === "requiredContent")
        ?.value,
    ).toBe(0);
  });

  it("splits verifier output into validity, specificity, contract, and acceptance metrics", () => {
    const expected = {
      id: "cash-source",
      file: "view.ts",
      lineStart: 9,
      lineEnd: 9,
      expectedPresence: true,
      expectedVerdict: "verified",
      requiredEvidenceKinds: ["implementation"],
      requiredReasoningTerms: [],
      forbiddenReasoningTerms: [],
      rationale: "contract",
    };
    const golden = {
      id: "golden-cash-source",
      file: "view.ts",
      line: 9,
      severity: "low",
      category: "contract",
      title: "cash source",
      description: "cash_snapshot",
      evidenceRequests: [{ kind: "implementation", reason: "contract" }],
    };
    const candidateId = "golden-cash-source";
    const make = (verification: Record<string, unknown>) =>
      evaluateStages({
        definition: { expectations: { verification: { candidates: [expected] } } } as any,
        trace: { scope: { changedFiles: ["view.ts"], manifest: [], diff: "" } } as any,
        execution: {
          workItems: [],
          candidates: [golden],
          evidence: { [candidateId]: [{ id: "e-1" }, { id: "e-2" }] },
          evidenceOutcomes: {
            [candidateId]: [{ request: { kind: "implementation" }, status: "satisfied", packedRecordIds: ["e-1"] }],
          },
          verification: [{ candidateId, ...verification }],
          graphSnapshot: { schemaVersion: 1, providerVersions: { ts: "1" } },
          modelProfiles: { candidate: {}, verifier: {} },
          projection: { code: [], audit: [] },
          coverage: {},
        } as any,
        result: { findings: [], coverage: {} } as any,
        tier: "isolated",
        hermetic: true,
      });
    const value = (stages: ReturnType<typeof evaluateStages>, metric: string) =>
      stages.find((stage) => stage.stage === "verification")?.metrics.find((item) => item.name === metric)?.value;

    const clean = make({
      verdict: "verified",
      supportingEvidenceIds: ["e-1"],
      rawVerdict: "verified",
      rawSupportingEvidenceIds: ["[e-1]"],
    });
    expect(value(clean, "verification_accuracy")).toBe(1);
    expect(value(clean, "grounding_validity")).toBe(1);
    expect(value(clean, "grounding_specificity")).toBe(1);
    expect(value(clean, "citation_contract_accuracy")).toBe(0);
    expect(value(clean, "production_acceptance_accuracy")).toBe(1);
    expect(
      clean
        .find((stage) => stage.stage === "verification")
        ?.diagnostics.some((d) => d.startsWith("citation_contract_failure")),
    ).toBe(true);

    const hallucinated = make({
      verdict: "insufficient_evidence",
      supportingEvidenceIds: [],
      rawVerdict: "verified",
      rawSupportingEvidenceIds: ["[nope]"],
    });
    expect(value(hallucinated, "verification_accuracy")).toBe(1);
    expect(value(hallucinated, "grounding_validity")).toBe(0);
    expect(value(hallucinated, "grounding_specificity")).toBeNull();
    expect(
      hallucinated
        .find((stage) => stage.stage === "verification")
        ?.diagnostics.some((d) => d.startsWith("hallucinated_grounding")),
    ).toBe(true);
  });

  it("excludes conformance fixtures from benchmark coverage", () => {
    const coverage = corpusCoverage(process.cwd());
    expect(coverage.conformance).toBe(2);
    expect(coverage.activeBenchmarks).toBe(2);
    expect(coverage.activeComponents).toBe(2);
    expect(coverage.drafts).toBe(1);
  });
});
