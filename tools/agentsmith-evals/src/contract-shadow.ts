import { sha256 } from "../../../src/core/hash.js";
import { serializeReviewContract } from "../../../src/core/review-contracts.js";
import type { ContractShadowAudit as EngineContractShadowAudit, EngineExecution } from "../../../src/agentsmith/engine-types.js";
import type { ReviewResult } from "../../../src/core/types.js";
import type { StageMetric } from "./stage-score.js";

/** Evaluation view of the engine's trace-only Phase 1 contract audit. */
export interface ContractShadowMetrics {
  descriptorCount: number;
  validDescriptorCount: number;
  descriptorValidity: StageMetric;
  serializationDeterminism: StageMetric;
  hashDeterminism: StageMetric;
  legacyPromptEquivalence: StageMetric;
  legacyOutputEquivalence: StageMetric;
  legacyOracleEquivalence: StageMetric;
  legacyFindingEquivalence: StageMetric;
  legacyStatusEquivalence: StageMetric;
  addedCalls: number;
  addedInputTokens: number;
  addedOutputTokens: number;
  addedTotalTokens: number;
  comparisonMode: "construction-only";
}

export interface ContractShadowEvaluation {
  schemaVersion: 1;
  metrics: ContractShadowMetrics;
  descriptors: EngineContractShadowAudit["entries"];
}

function metric(name: string, numerator: number, denominator: number): StageMetric {
  return { name, value: denominator ? numerator / denominator : null, numerator, denominator, direction: "higher" };
}

function deterministicDescriptorMetrics(audit: EngineContractShadowAudit) {
  const valid = audit.entries.filter((entry) => entry.validation.valid);
  const serialized = valid.map((entry) => entry.serializedDescriptor);
  const reserialized = serialized.map((value) => {
    try {
      return serializeReviewContract(JSON.parse(value));
    } catch {
      return "";
    }
  });
  const hashes = valid.map((entry) => entry.descriptorHash);
  const recomputedHashes = serialized.map((value) => sha256(value));
  return {
    serialization: metric("serializationDeterminism", serialized.reduce((n, value, i) => n + Number(value === reserialized[i]), 0), valid.length),
    hashes: metric("hashDeterminism", hashes.reduce((n, value, i) => n + Number(value === recomputedHashes[i]), 0), valid.length),
  };
}

/**
 * Build metrics from the engine audit. Phase 1 has no second model route:
 * equivalence is a construction-only invariant, while ordinary eval results
 * remain the authoritative legacy comparison artifacts.
 */
export function buildContractShadowAudit(opts: {
  execution: EngineExecution;
  result: Pick<ReviewResult, "findings" | "status" | "outcome" | "candidateResolutions">;
}): ContractShadowEvaluation {
  const audit = opts.execution.contractShadow ?? { schemaVersion: 1 as const, lens: "correctness" as const, entries: [] };
  const valid = audit.entries.filter((entry) => entry.validation.valid).length;
  const descriptorMetrics = deterministicDescriptorMetrics(audit);
  const legacyExecutionPresent = audit.entries.length > 0 || opts.execution.workItems.length === 0;
  const legacyMetric = (name: string) => metric(name, Number(legacyExecutionPresent), Number(legacyExecutionPresent));
  return {
    schemaVersion: 1,
    metrics: {
      descriptorCount: audit.entries.length,
      validDescriptorCount: valid,
      descriptorValidity: metric("descriptorValidity", valid, audit.entries.length),
      serializationDeterminism: descriptorMetrics.serialization,
      hashDeterminism: descriptorMetrics.hashes,
      legacyPromptEquivalence: legacyMetric("legacyPromptEquivalence"),
      legacyOutputEquivalence: legacyMetric("legacyOutputEquivalence"),
      legacyOracleEquivalence: legacyMetric("legacyOracleEquivalence"),
      legacyFindingEquivalence: legacyMetric("legacyFindingEquivalence"),
      legacyStatusEquivalence: legacyMetric("legacyStatusEquivalence"),
      addedCalls: 0,
      addedInputTokens: 0,
      addedOutputTokens: 0,
      addedTotalTokens: 0,
      comparisonMode: "construction-only",
    },
    descriptors: audit.entries,
  };
}
