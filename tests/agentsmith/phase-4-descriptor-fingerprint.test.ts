import { describe, expect, it } from "vitest";
import { isFreshDescriptorCacheEntry } from "../../src/agentsmith/engine.js";
import { deterministicReviewDescriptorFingerprint, serializeReviewContract } from "../../src/core/review-contracts.js";
import { buildContractShadowAudit } from "../../tools/agentsmith-evals/src/contract-shadow.js";

describe("Phase 4 descriptor fingerprints", () => {
  const descriptor = {
    stage: "candidates",
    model: {
      id: "small",
      model: "small:latest",
      contextTokens: 8192,
      requestedOutputTokens: 512,
      inference: { temperature: 0, thinking: false },
    },
    descriptor: {
      snapshotId: "snapshot-a",
      taskId: "task-a",
      route: "partitioned-interactions",
      outputContractVersion: "candidate-result/v1",
      budget: { inputTokens: 100, outputTokens: 512, modelCalls: 1, contextExpansions: 0 },
    },
  };

  it("is stable for equivalent object key order", () => {
    const reordered = {
      descriptor: { ...descriptor.descriptor },
      model: { ...descriptor.model },
      stage: descriptor.stage,
    };
    expect(serializeReviewContract(reordered)).toBe(serializeReviewContract(descriptor));
    expect(deterministicReviewDescriptorFingerprint(reordered)).toBe(
      deterministicReviewDescriptorFingerprint(descriptor),
    );
  });

  it("changes when any dispatch identity input changes", () => {
    const inputs = [
      { ...descriptor, stage: "verification" },
      { ...descriptor, model: { ...descriptor.model, model: "different" } },
      { ...descriptor, descriptor: { ...descriptor.descriptor, snapshotId: "snapshot-b" } },
      { ...descriptor, descriptor: { ...descriptor.descriptor, outputContractVersion: "candidate-result/v2" } },
      { ...descriptor, descriptor: { ...descriptor.descriptor, budget: { ...descriptor.descriptor.budget, inputTokens: 101 } } },
    ];
    const fingerprint = deterministicReviewDescriptorFingerprint(descriptor);
    for (const input of inputs) expect(deterministicReviewDescriptorFingerprint(input)).not.toBe(fingerprint);
  });

  it("returns a full SHA-256 identity", () => {
    expect(deterministicReviewDescriptorFingerprint(descriptor)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts only a versioned cache envelope with the exact descriptor fingerprint", () => {
    const fingerprint = deterministicReviewDescriptorFingerprint(descriptor);
    const cached = { schemaVersion: 1 as const, descriptorFingerprint: fingerprint, value: { answer: "cached" } };
    expect(isFreshDescriptorCacheEntry<{ answer: string }>(cached, fingerprint)).toBe(true);
    expect(isFreshDescriptorCacheEntry(cached, `${fingerprint.slice(0, -1)}0`)).toBe(false);
    expect(isFreshDescriptorCacheEntry({ ...cached, schemaVersion: 0 }, fingerprint)).toBe(false);
    expect(isFreshDescriptorCacheEntry({ descriptorFingerprint: fingerprint, value: cached.value }, fingerprint)).toBe(false);
    expect(isFreshDescriptorCacheEntry({ ...cached, value: undefined }, fingerprint)).toBe(false);
  });

  it("reports fingerprint validity independently from descriptor validity", () => {
    const validEntry = {
      sourceWorkItemId: "work-a",
      taskId: "task-a",
      descriptorHash: "hash",
      descriptorFingerprint: deterministicReviewDescriptorFingerprint(descriptor),
      serializedDescriptor: JSON.stringify({ taskId: "task-a" }),
      validation: { valid: true as const },
      legacyInputFingerprint: "legacy-input",
    };
    const audit = buildContractShadowAudit({
      execution: {
        workItems: [],
        contractShadow: { schemaVersion: 1, lens: "correctness", entries: [validEntry] },
      } as never,
      result: { findings: [], status: "completed", outcome: "no-findings", candidateResolutions: [] },
    });
    expect(audit.metrics.descriptorValidity.value).toBe(1);
    expect(audit.metrics.descriptorFingerprintValidity.value).toBe(1);
  });
});
