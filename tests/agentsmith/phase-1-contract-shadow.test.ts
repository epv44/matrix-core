import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { buildContractShadowAudit } from "../../tools/agentsmith-evals/src/contract-shadow.js";
import type { EngineExecution, ReviewWorkItem } from "../../src/agentsmith/engine-types.js";

function workItem(): ReviewWorkItem {
  return {
    id: "unit-1",
    kind: "local",
    primarySymbols: [{ file: "src/a.ts", name: "run", qualifiedName: "run", kind: "function", startLine: 2, endLine: 4, provider: "test" }],
    relatedSymbols: [], code: [{ id: "snippet", file: "src/a.ts", startLine: 2, endLine: 4, content: "return value", changed: true, score: 1, reason: "changed", estimatedTokens: 12 }],
    graphEdges: [], rules: [], estimatedTokens: 12,
    rankFactors: { edgeRisk: 0, changedEndpoints: 0, productionSurface: 0, changedLines: 3, graphDegree: 0 },
  };
}

function execution(items: ReviewWorkItem[] = [workItem()], contractShadow?: EngineExecution["contractShadow"]): EngineExecution {
  return {
    graphSnapshot: { state: "READY", schemaVersion: 1, workspaceHash: "workspace", snapshotHash: "snapshot", indexedCommit: null, providerVersions: {}, completedAt: null, fileCount: 1 },
    mode: "partitioned", reviewPath: "generic", route: {} as never, modelProfiles: {} as never,
    projection: {} as never, workItems: items, candidateBatches: [], candidates: [], evidence: {}, verification: [], candidateResolutions: [], coverage: {} as never, errors: [], inputTokens: 10, outputTokens: 5,
    contractShadow,
  };
}

describe("Phase 1 contract-shadow evaluation", () => {
  it("constructs valid descriptors and records zero observational cost", () => {
    const audit = buildContractShadowAudit({ execution: execution([workItem()], { schemaVersion: 1, lens: "correctness", entries: [{ sourceWorkItemId: "unit-1", taskId: "task-1", descriptorHash: sha256('{"a":1}'), serializedDescriptor: '{"a":1}', validation: { valid: true }, legacyInputFingerprint: "input" }] }), result: { findings: [], status: "completed", outcome: "clear", candidateResolutions: [] } });
    expect(audit.metrics).toMatchObject({ descriptorCount: 1, validDescriptorCount: 1, addedCalls: 0, addedInputTokens: 0, addedOutputTokens: 0, addedTotalTokens: 0 });
    expect(audit.metrics.descriptorValidity.value).toBe(1);
    expect(audit.descriptors[0].descriptorHash).toBe(sha256(audit.descriptors[0].serializedDescriptor));
  });

  it("is deterministic for byte-identical work-item inputs", () => {
    const shadow = { schemaVersion: 1 as const, lens: "correctness" as const, entries: [{ sourceWorkItemId: "unit-1", taskId: "task-1", descriptorHash: sha256('{"a":1}'), serializedDescriptor: '{"a":1}', validation: { valid: true as const }, legacyInputFingerprint: "input" }] };
    const first = buildContractShadowAudit({ execution: execution([workItem()], shadow), result: { findings: [], status: "completed", outcome: "clear", candidateResolutions: [] } });
    const second = buildContractShadowAudit({ execution: execution([workItem()], shadow), result: { findings: [], status: "completed", outcome: "clear", candidateResolutions: [] } });
    expect(second).toEqual(first);
  });

  it("reports invalid descriptors without changing the legacy run status", () => {
    const audit = buildContractShadowAudit({ execution: execution([workItem()], { schemaVersion: 1, lens: "correctness", entries: [{ sourceWorkItemId: "unit-1", taskId: "", descriptorHash: "", serializedDescriptor: "", validation: { valid: false, error: "bad range" }, legacyInputFingerprint: "input" }] }), result: { findings: [], status: "partial", outcome: "incomplete", candidateResolutions: [] } });
    expect(audit.metrics.validDescriptorCount).toBe(0);
    expect(audit.metrics.legacyStatusEquivalence.value).toBe(1);
    expect(audit.metrics.addedTotalTokens).toBe(0);
  });
});
