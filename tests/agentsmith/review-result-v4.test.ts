import { describe, expect, it } from "vitest";
import { hasUnresolvedCandidateResolutions, isReviewApproval, noReviewResult } from "../../src/core/reviewer.js";
import type { ReviewResult } from "../../src/core/types.js";

function completedResult(): ReviewResult {
  return {
    schemaVersion: 4,
    version: "v4",
    status: "completed",
    outcome: "clear",
    mode: "partitioned",
    reviewPath: "generic",
    findings: [],
    coverage: {
      changedFiles: 1,
      changedFilesReviewed: 1,
      changedSymbols: 1,
      changedSymbolsReviewed: 1,
      localUnitsGenerated: 1,
      localUnitsReviewed: 1,
      interactionUnitsGenerated: 0,
      interactionUnitsReviewed: 0,
      dependencyEdgesIdentified: 0,
      dependencyEdgesEligible: 0,
      dependencyEdgesReviewed: 0,
      evidenceRequests: 0,
      evidenceResolved: 0,
      evidenceGaps: 0,
      globalScan: "none",
      omissions: [],
    },
    summary: "No verified findings.",
    timestamp: "2026-09-04T00:00:00.000Z",
    reviewer: "AgentSmith",
    candidateResolutions: [],
  };
}

describe("ReviewResult v4 approval semantics", () => {
  it("requires completed execution, a clear outcome, and no unresolved candidates", () => {
    const review = completedResult();
    expect(isReviewApproval(review)).toBe(true);

    review.outcome = "incomplete";
    review.candidateResolutions = [
      {
        candidateId: "candidate-1",
        resolution: "unproven",
        reasonCode: "verifier-insufficient-evidence",
        detail: "The verifier abstained.",
        sourceWorkItemIds: ["unit-1"],
        sourceReviewers: [],
        evidence: { requestOutcomes: [], resolvedRecordIds: [], packedRecordIds: [] },
        verifier: {
          verdict: "insufficient_evidence",
          confidence: 0.5,
          supportingEvidenceIds: [],
          failureKinds: [],
        },
      },
    ];

    expect(review.status).toBe("completed");
    expect(hasUnresolvedCandidateResolutions(review)).toBe(true);
    expect(isReviewApproval(review)).toBe(false);
  });

  it("emits native v4 unavailable results", () => {
    expect(noReviewResult("v4")).toMatchObject({
      schemaVersion: 4,
      status: "error",
      outcome: "incomplete",
      candidateResolutions: [],
    });
  });

  it("never treats conservatively adapted v3 evidence as approval", () => {
    const review = { ...completedResult(), migratedFromSchemaVersion: 3 as const };
    expect(isReviewApproval(review)).toBe(false);
  });
});
