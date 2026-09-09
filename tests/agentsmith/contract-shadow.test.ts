import { describe, expect, it } from "vitest";
import { buildContractShadowAudit } from "../../tools/agentsmith-evals/src/contract-shadow.js";
import type { EngineExecution } from "../../src/agentsmith/engine-types.js";

function execution(entries: NonNullable<EngineExecution["contractShadow"]>["entries"]): EngineExecution {
  return {
    contractShadow: { schemaVersion: 1, lens: "correctness", entries },
    workItems: entries.map((entry) => ({ id: entry.sourceWorkItemId } as EngineExecution["workItems"][number])),
  } as EngineExecution;
}

describe("contract shadow evaluation", () => {
  it("uses the engine audit and verifies descriptor serialization and hashes", () => {
    const serialized = '{"a":1,"b":{"c":2}}';
    const audit = buildContractShadowAudit({
      execution: execution([
        {
          sourceWorkItemId: "local:a",
          taskId: "task-a",
          descriptorHash: "",
          serializedDescriptor: serialized,
          validation: { valid: true },
          legacyInputFingerprint: "input",
        },
      ]),
      result: { findings: [], status: "completed", outcome: "clear", candidateResolutions: [] },
    });
    expect(audit.metrics.descriptorCount).toBe(1);
    expect(audit.metrics.descriptorValidity.value).toBe(1);
    expect(audit.metrics.serializationDeterminism.value).toBe(1);
    expect(audit.metrics.hashDeterminism.value).toBe(0);
    expect(audit.metrics.addedCalls).toBe(0);
    expect(audit.metrics.comparisonMode).toBe("construction-only");
  });

  it("does not turn invalid descriptors into an execution failure", () => {
    const audit = buildContractShadowAudit({
      execution: execution([
        {
          sourceWorkItemId: "local:a",
          taskId: "",
          descriptorHash: "",
          serializedDescriptor: "",
          validation: { valid: false, error: "bad range" },
          legacyInputFingerprint: "input",
        },
      ]),
      result: { findings: [], status: "partial", outcome: "incomplete", candidateResolutions: [] },
    });
    expect(audit.metrics.descriptorValidity.value).toBe(0);
    expect(audit.metrics.legacyStatusEquivalence.value).toBe(1);
    expect(audit.descriptors[0].validation).toEqual({ valid: false, error: "bad range" });
  });
});
