import { describe, expect, it } from "vitest";
import {
  deterministicReviewUnitId,
  serializeReviewContract,
  validateCandidateReviewOutput,
  validateReviewTask,
  type ReviewUnit,
} from "../../src/core/review-contracts.js";

const unitWithoutId: Omit<ReviewUnit, "id"> = {
  kind: "local",
  changedSymbols: [{ file: "src/a.ts", name: "run", startLine: 2, endLine: 8 }],
  changedRanges: [{ file: "src/a.ts", startLine: 4, endLine: 5 }],
  context: [{ file: "src/a.ts", startLine: 1, endLine: 10, reason: "declaration" }],
  riskScore: 0.75,
  riskReasons: ["public API"],
  estimatedTokens: 100,
};
const unit = { id: "unit-a", ...unitWithoutId } as ReviewUnit;
const files = ["src/a.ts", "src/caller.ts", "src/consumer.ts"];

// These values deliberately model the Phase 1 descriptor vocabulary. They are
// passed as unknown at the boundary so the tests also verify runtime schemas.
const task = {
  taskId: "task-a",
  taskVersion: "review-task/v1",
  unit,
  lens: "correctness",
  lensVersion: "1",
  snapshotId: "snapshot-a",
  question: "Does run preserve the public API contract for null input?",
  changedRanges: [{ file: "src/a.ts", startLine: 4, endLine: 5 }],
  contextRefs: [{ file: "src/a.ts", startLine: 1, endLine: 10, reason: "declaration" }],
  allowedEvidenceLocators: [
    { id: "loc-caller", kind: "caller", file: "src/caller.ts", symbol: "useRun" },
    { id: "loc-consumer", kind: "consumer", file: "src/consumer.ts", symbol: "renderResult" },
  ],
  tokenBudget: 200,
  outputTokenBudget: 100,
  modelCallBudget: 1,
  expansionBudget: 1,
  outputContractVersion: "candidate-result/v1",
};

const finding = {
  id: "finding-a",
  file: "src/a.ts",
  startLine: 4,
  endLine: 5,
  title: "Null input violates the public contract",
  triggeringValue: "null",
  violatedInvariant: "run must preserve the null-input contract",
  impact: "Callers receive an invalid result",
  evidenceNeeds: [{ locatorId: "loc-caller", kind: "caller", reason: "confirm caller expectation" }],
  evidence: ["src/caller.ts:useRun"],
  confidence: 0.9,
  category: "correctness",
};

function validOutput(overrides: Record<string, unknown> = {}) {
  return {
    status: "finding",
    findings: [finding],
    evidenceNeeds: finding.evidenceNeeds,
    contextRequests: [],
    ...overrides,
  };
}

describe("Phase 1 review contracts", () => {
  it("serializes equivalent contracts canonically and produces deterministic unit IDs", () => {
    const reordered = {
      riskReasons: unitWithoutId.riskReasons,
      estimatedTokens: unitWithoutId.estimatedTokens,
      context: unitWithoutId.context,
      changedRanges: unitWithoutId.changedRanges,
      changedSymbols: unitWithoutId.changedSymbols,
      riskScore: unitWithoutId.riskScore,
      kind: unitWithoutId.kind,
    };
    expect(serializeReviewContract({ z: 1, a: { y: 2, x: 1 } } as never)).toBe(
      '{"a":{"x":1,"y":2},"z":1}',
    );
    expect(serializeReviewContract(task as never)).toBe(serializeReviewContract({ ...task } as never));
    expect(deterministicReviewUnitId(unitWithoutId)).toMatch(/^unit-[a-f0-9]{16}$/);
    expect(deterministicReviewUnitId(unitWithoutId)).toBe(deterministicReviewUnitId(reordered as Omit<ReviewUnit, "id">));
  });

  it("accepts a valid bounded ReviewTask descriptor", () => {
    expect(validateReviewTask(task, { existingFiles: files, knownSymbols: ["run"] })).toMatchObject({
      snapshotId: "snapshot-a",
      outputContractVersion: "candidate-result/v1",
    });
  });

  it("accepts finding, no_finding, and insufficient_context as distinct states", () => {
    expect(validateCandidateReviewOutput(validOutput(), { existingFiles: files }).status).toBe("finding");
    expect(validateCandidateReviewOutput({ status: "no_finding", findings: [], evidenceNeeds: [], contextRequests: [] }).status).toBe("no_finding");
    expect(validateCandidateReviewOutput({
      status: "insufficient_context",
      findings: [],
      evidenceNeeds: [{ locatorId: "loc-caller", kind: "caller", reason: "caller contract is missing" }],
      contextRequests: [{ file: "src/caller.ts", symbol: "useRun", reason: "caller contract is missing" }],
    }).status).toBe("insufficient_context");
  });

  it("requires finding anchor, trigger, invariant, impact, and typed evidence needs", () => {
    for (const field of ["file", "startLine", "triggeringValue", "violatedInvariant", "impact", "evidenceNeeds"]) {
      const invalid = { ...finding } as Record<string, unknown>;
      delete invalid[field];
      expect(() => validateCandidateReviewOutput(validOutput({ findings: [invalid] }))).toThrow();
    }
    expect(validateCandidateReviewOutput(validOutput(), { existingFiles: files }).findings[0]).toMatchObject({
      triggeringValue: "null",
      violatedInvariant: expect.any(String),
      evidenceNeeds: [{ locatorId: "loc-caller" }],
    });
  });

  it("accepts only typed evidence needs that use allowed, in-scope locators", () => {
    expect(validateCandidateReviewOutput(validOutput(), {
      existingFiles: files,
      allowedEvidenceLocators: task.allowedEvidenceLocators,
    } as never)).toBeTruthy();
    for (const evidenceNeed of [
      { locatorId: "unknown", kind: "caller", reason: "missing" },
      { locatorId: "loc-caller", kind: "unsupported", reason: "wrong kind" },
      { locatorId: "loc-caller", kind: "caller", file: "../secret", reason: "escape" },
    ]) {
      expect(() => validateCandidateReviewOutput(validOutput({ evidenceNeeds: [evidenceNeed] }), {
        existingFiles: files,
        allowedEvidenceLocators: task.allowedEvidenceLocators,
      } as never)).toThrow();
    }
  });

  it("rejects out-of-workspace references, invalid ranges, enums, and budgets", () => {
    expect(() => validateReviewTask({ ...task, unit: { ...unit, changedRanges: [{ file: "../secret", startLine: 2, endLine: 1 }] } })).toThrow();
    expect(() => validateReviewTask({ ...task, lens: "unknown" })).toThrow();
    expect(() => validateReviewTask({ ...task, tokenBudget: 99 })).toThrow(/tokenBudget/);
    expect(() => validateReviewTask({ ...task, outputTokenBudget: 0 })).toThrow();
    expect(() => validateReviewTask({ ...task, modelCallBudget: 0 })).toThrow();
    expect(() => validateReviewTask(task, { existingFiles: ["src/other.ts"] })).toThrow(/nonexistent/);
    expect(() => validateReviewTask(task, { knownSymbols: ["other"] })).toThrow(/unknown symbol/);
    expect(() => validateCandidateReviewOutput(validOutput({ status: "unknown" }))).toThrow();
    expect(() => validateCandidateReviewOutput(validOutput({
      contextRequests: [{ file: "../secret", reason: "out of scope" }],
    }), { existingFiles: files })).toThrow();
  });

  it("rejects mutually incompatible candidate states", () => {
    expect(() => validateCandidateReviewOutput(validOutput({ status: "no_finding" }))).toThrow();
    expect(() => validateCandidateReviewOutput({
      status: "no_finding",
      findings: [],
      evidenceNeeds: [],
      contextRequests: [],
      approval: true,
    })).toThrow();
    expect(() => validateCandidateReviewOutput(validOutput({ status: "insufficient_context", evidenceNeeds: [] }))).toThrow();
    expect(() => validateCandidateReviewOutput({ status: "finding", findings: [], evidenceNeeds: [], contextRequests: [] })).toThrow();
    expect(() => validateCandidateReviewOutput({ status: "no_finding", findings: [finding], evidenceNeeds: [], contextRequests: [] })).toThrow();
  });

  it("rejects malformed and extra fields at every contract boundary", () => {
    expect(() => validateReviewTask({ ...task, extra: true })).toThrow();
    expect(() => validateReviewTask({ ...task, unit: { ...unit, extra: true } })).toThrow();
    expect(() => validateCandidateReviewOutput({ ...validOutput(), extra: true })).toThrow();
    expect(() => validateCandidateReviewOutput(validOutput({ findings: [{ ...finding, extra: true }] }))).toThrow();
    expect(() => validateCandidateReviewOutput(validOutput({ evidenceNeeds: [{ ...finding.evidenceNeeds[0], extra: true }] }))).toThrow();
  });
});
