import { describe, expect, it } from "vitest";
import {
  deterministicReviewUnitId,
  serializeReviewContract,
  validateCandidateReviewOutput,
  validateReviewTask,
  type ReviewUnit,
} from "../../src/core/review-contracts.js";

const unit: Omit<ReviewUnit, "id"> = {
  kind: "local",
  changedSymbols: [{ file: "src/a.ts", name: "run", startLine: 2, endLine: 8 }],
  changedRanges: [{ file: "src/a.ts", startLine: 4, endLine: 5 }],
  context: [{ file: "src/a.ts", startLine: 1, endLine: 10, reason: "declaration" }],
  riskScore: 0.75,
  riskReasons: ["public API"],
  estimatedTokens: 100,
};

describe("review contracts", () => {
  it("serializes and identifies equivalent contracts deterministically", () => {
    const first = { id: "x", ...unit } as ReviewUnit;
    const second = { ...unit, id: "x" } as ReviewUnit;
    expect(serializeReviewContract(first)).toBe(serializeReviewContract(second));
    expect(deterministicReviewUnitId(unit)).toMatch(/^unit-[a-f0-9]{16}$/);
  });

  it("rejects out-of-workspace paths, invalid ranges, and insufficient budgets", () => {
    expect(() => validateReviewTask({ unit: { id: "x", ...unit, changedRanges: [{ file: "../secret", startLine: 2, endLine: 1 }] }, lens: "correctness", snapshotId: "s", tokenBudget: 100, expansionBudget: 0, outputContractVersion: "1" })).toThrow();
    expect(() => validateReviewTask({ unit: { id: "x", ...unit }, lens: "correctness", snapshotId: "s", tokenBudget: 99, expansionBudget: 0, outputContractVersion: "1" })).toThrow(/tokenBudget/);
    expect(() => validateReviewTask({ unit: { id: "x", ...unit }, lens: "correctness", snapshotId: "s", tokenBudget: 100, expansionBudget: 0, outputContractVersion: "1" }, { existingFiles: ["src/other.ts"] })).toThrow(/nonexistent/);
  });

  it("validates bounded candidate output and insufficient context status", () => {
    expect(validateCandidateReviewOutput({ status: "insufficient_context", findings: [], contextRequests: [{ file: "src/a.ts", reason: "caller" }] }, { existingFiles: ["src/a.ts"] }).status).toBe("insufficient_context");
    expect(() => validateCandidateReviewOutput({ status: "complete", findings: [{ id: "f", file: "src/a.ts", startLine: 4, title: "bug", impact: "impact", evidence: [], confidence: 0.5, category: "correctness" }], contextRequests: [] })).toThrow();
    expect(() => validateCandidateReviewOutput({ status: "complete", findings: [{ id: "f", file: "src/missing.ts", startLine: 4, title: "bug", impact: "impact", evidence: ["x"], confidence: 0.5, category: "correctness" }], contextRequests: [] }, { existingFiles: ["src/a.ts"] })).toThrow(/nonexistent/);
  });
});
