import { describe, expect, it } from "vitest";
import { evalCaseSchema } from "../../tools/agentsmith-evals/src/case.js";
import { evaluateStages, scorePlanningRiskRanking } from "../../tools/agentsmith-evals/src/stage-score.js";
import { corpusCoverage } from "../../tools/agentsmith-evals/src/coverage.js";

describe("AgentSmith stage scorecards", () => {
  const unit = (id: string, priority: number, edgeRisk = 0) =>
    ({
      id,
      kind: "local",
      priority,
      primarySymbols: [{ file: `${id}.ts`, name: id, qualifiedName: id }],
      relatedSymbols: [],
      graphEdges: edgeRisk
        ? [{ source: `${id}.ts:${id}`, target: "repo.ts:Repository", targetText: "Repository", kind: "references" }]
        : [],
      code: [],
      rules: [],
      estimatedTokens: 100,
      rankFactors: { edgeRisk, changedEndpoints: 1, productionSurface: 1, changedLines: 1, graphDegree: edgeRisk ? 1 : 0 },
    }) as any;

  it("scores structural risk ordering without consulting selection budgets", () => {
    const player = unit("Player", 230, 100);
    const sibling = unit("Sibling", 120);
    const expectation = {
      ordered: ["Player", "Sibling"],
      mustOutrank: [{ higher: "Player", lower: "Sibling" }],
      expectedEdges: [{ source: "Player.ts:Player", target: "repo.ts:Repository", kind: "references" }],
      units: [{ id: "Player", minPriority: 200, factors: { edgeRisk: 80 } }],
    } as any;
    const full = scorePlanningRiskRanking(expectation, [sibling, player]);
    expect(full.ordered).toBe(1);
    expect(full.mustOutrank).toBe(1);
    expect(full.expectedEdges).toBe(1);
    expect(full.priorityAssertions).toBe(1);
    // A smaller selection budget is intentionally not an input to ranking.
    expect(scorePlanningRiskRanking(expectation, [player, sibling]).rankedIds).toEqual(full.rankedIds);
  });

  it("scores selected units and hard selection budgets independently", () => {
    const player = unit("Player", 230, 100);
    const sibling = unit("Sibling", 120);
    const definition = {
      expectations: {
        planning: {
          files: [], symbols: [], edges: [], forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [], paths: [],
          selection: { maxWorkItems: 2, maxTokens: 250, selected: ["Player"], requiredKinds: ["local"] },
        },
      },
    } as any;
    const stages = evaluateStages({
      definition,
      trace: { scope: { changedFiles: [], manifest: [] } } as any,
      execution: {
        workItems: [player],
        projection: { code: [], audit: [] },
        candidates: [], verification: [], evidence: {},
        route: { mode: "partitioned" },
      } as any,
      result: { findings: [], coverage: { candidateTokensEstimated: 200, candidateTokenBudget: 250 } } as any,
      tier: "stage", hermetic: true, planningWorkItems: [player, sibling],
    });
    const selection = stages.find((stage) => stage.stage === "selection")!;
    expect(selection.metrics.find((metric) => metric.name === "selectionExpectedRecall")?.value).toBe(1);
    expect(selection.metrics.find((metric) => metric.name === "selectionWorkItemBudgetRespected")?.value).toBe(true);
    expect(selection.metrics.find((metric) => metric.name === "selectionTokenBudgetRespected")?.value).toBe(true);
  });

  it("scores canonical graph adjacency and exact degree factors", () => {
    const definition = {
      expectations: {
        graph: {
          files: [], symbols: [], edges: ["a.ts:A->b.ts:B:calls", "a.ts:A->c.ts:C:references"],
          forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [], paths: [],
          graphScope: { exhaustiveNodes: ["a.ts:A"], highDegreeThreshold: 2 },
          adjacency: [{ node: "a.ts:A", expectedNeighbors: ["b.ts:B", "c.ts:C"], exhaustive: true }],
          graphFactors: [{ node: "a.ts:A", fanIn: 0, fanOut: 2, neighborDegree: 2, directedIncidentDegree: 2 }],
        },
      },
    } as any;
    const stages = evaluateStages({
      definition,
      trace: { scope: { changedFiles: [], manifest: [] } } as any,
      execution: {
        graphManifest: {
          changedSymbols: [],
          nodes: [],
          edges: [
            { source: "a.ts:A", target: "b.ts:B", targetText: "B", kind: "calls", confidence: "exact" },
            { source: "a.ts:A", target: "b.ts:B", targetText: "B", kind: "calls", confidence: "syntactic" },
            { source: "a.ts:A", target: "c.ts:C", targetText: "C", kind: "references", confidence: "exact" },
          ],
          selectedNodeKeys: [], omittedNodeKeys: [],
        },
        route: { mode: "partitioned" },
        workItems: [], projection: { code: [], audit: [] }, candidates: [], verification: [], evidence: {},
      } as any,
      result: { findings: [], coverage: { candidateTokensEstimated: 0, candidateTokenBudget: 1 } } as any,
      tier: "stage", hermetic: true,
    });
    const graph = stages.find((stage) => stage.stage === "graph")!;
    const value = (name: string) => graph.metrics.find((item) => item.name === name)?.value;
    expect(value("microEdgeRecall")).toBe(1);
    expect(value("microEdgePrecision")).toBe(1);
    expect(value("macroAdjacencyRecall")).toBe(1);
    expect(value("minimumNodeAdjacencyRecall")).toBe(1);
    expect(value("fanInAccuracy")).toBe(1);
    expect(value("fanOutAccuracy")).toBe(1);
    expect(value("neighborDegreeAccuracy")).toBe(1);
    expect(value("directedIncidentDegreeAccuracy")).toBe(1);
    expect(value("highDegreeNodeRecall")).toBe(1);
  });

  it("does not attribute an upstream graph failure to isolated Planning, Ranking, or Selection", () => {
    const definition = {
      expectations: {
        graph: {
          files: [], symbols: [], edges: ["missing.ts:M->target.ts:T:calls"],
          forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [], paths: [],
        },
        planning: {
          files: [], symbols: [], edges: [], forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [],
          paths: [], route: "partitioned",
          riskRanking: { ordered: ["M"], mustOutrank: [], expectedEdges: [], units: [] },
          selection: { maxWorkItems: 1, maxTokens: 1000, selected: ["M"], requiredKinds: ["local"] },
        },
      },
    } as any;
    const workItem = unit("M", 1);
    const stages = evaluateStages({
      definition,
      trace: { scope: { changedFiles: [], manifest: [] } } as any,
      execution: {
        graphManifest: { changedSymbols: [], nodes: [], edges: [], selectedNodeKeys: [], omittedNodeKeys: [] },
        route: { mode: "partitioned" },
        workItems: [workItem],
        plannerManifest: [{ id: "M", kind: "local", priority: 1, files: ["M.ts"], symbols: ["M"], edges: [], rankFactors: workItem.rankFactors }],
        projection: { code: [], audit: [] }, candidates: [], verification: [], evidence: {},
      } as any,
      result: { findings: [], coverage: { candidateTokensEstimated: 0, candidateTokenBudget: 1000 } } as any,
      tier: "isolated", hermetic: true,
    });
    expect(stages.find((stage) => stage.stage === "graph")?.causalStatus).toBe("root-failure");
    expect(stages.find((stage) => stage.stage === "planning")?.causalStatus).toBe("healthy");
    expect(stages.find((stage) => stage.stage === "ranking")?.causalStatus).toBe("healthy");
    expect(stages.find((stage) => stage.stage === "selection")?.causalStatus).toBe("healthy");
  });

  it("reports graph completeness as N/A when no exhaustive graph scope is labeled", () => {
    const stages = evaluateStages({
      definition: {
        expectations: {
          graph: {
            files: [], symbols: [], edges: ["a.ts:A->b.ts:B:calls"],
            forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [], paths: [],
          },
        },
      } as any,
      trace: { scope: { changedFiles: [], manifest: [] } } as any,
      execution: {
        graphManifest: {
          changedSymbols: [], nodes: [],
          edges: [{ source: "a.ts:A", target: "b.ts:B", targetText: "B", kind: "calls", confidence: "exact" }],
          selectedNodeKeys: [], omittedNodeKeys: [],
        },
        workItems: [], projection: { code: [], audit: [] }, candidates: [], verification: [], evidence: {},
      } as any,
      result: { findings: [], coverage: {} } as any,
      tier: "live", hermetic: false,
    });
    const graph = stages.find((stage) => stage.stage === "graph")!;
    expect(graph.metrics.find((item) => item.name === "microEdgeRecall")?.value).toBeNull();
    expect(graph.metrics.find((item) => item.name === "microEdgePrecision")?.value).toBeNull();
  });

  it("rejects malformed risk-ranking assertions", () => {
    const base = {
      schemaVersion: 7,
      id: "risk-schema",
      status: "draft",
      kind: "benchmark",
      source: { traceId: "trace", traceSchemaVersion: 5, fixture: null },
      sanitization: { reviewed: false, absolutePathsRemoved: true, sensitiveContentReviewed: false, redistributable: false },
      expectations: {
        planning: {
          files: [], symbols: [], edges: [], forbiddenFiles: [], forbiddenSymbols: [], forbiddenEdges: [],
          riskRanking: { ordered: ["Player"], mustOutrank: [{ higher: "", lower: "Sibling" }] },
        },
      },
    };
    expect(() => evalCaseSchema.parse(base)).toThrow(/higher/);
  });

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
    expect(stages.find((stage) => stage.stage === "snapshot")?.evaluation).toBe("not-applicable");
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
    const make = (verification?: Record<string, unknown>) =>
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
          verification: verification ? [{ candidateId, ...verification }] : [],
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

    const missing = make();
    expect(value(missing, "verification_accuracy")).toBe(0);
    expect(missing.find((stage) => stage.stage === "verification")?.causalStatus).toBe("root-failure");
  });

  it("excludes conformance fixtures from benchmark coverage", () => {
    const coverage = corpusCoverage(process.cwd());
    expect(coverage.conformance).toBe(2);
    expect(coverage.activeBenchmarks).toBe(11);
    expect(coverage.activeComponents).toBe(11);
    expect(coverage.drafts).toBe(1);
  });
});
