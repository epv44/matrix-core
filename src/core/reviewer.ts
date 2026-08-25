import type { ReviewCoverage, ReviewResult, ReviewStatus } from "./types.js";

export const AGENT_SMITH = "AgentSmith";

export interface Reviewer {
  readonly name: string;
  review(input: { version: string; cwd: string }): Promise<ReviewResult>;
}

export interface ReviewerRegistry {
  get(name: string): Reviewer | undefined;
  set(reviewer: Reviewer): void;
  list(): string[];
}

const reviewers = new Map<string, Reviewer>();

export const reviewerRegistry: ReviewerRegistry = {
  get: (name) => reviewers.get(name),
  set: (reviewer) => {
    reviewers.set(reviewer.name, reviewer);
  },
  list: () => [...reviewers.keys()],
};

export function emptyReviewCoverage(scope?: {
  changedFiles?: readonly unknown[];
  omissions?: ReadonlyArray<{ kind: string; id: string; reason: string }>;
}): ReviewCoverage {
  return {
    changedFiles: scope?.changedFiles?.length ?? 0,
    changedFilesReviewed: 0,
    changedSymbols: 0,
    changedSymbolsReviewed: 0,
    localUnitsGenerated: 0,
    localUnitsReviewed: 0,
    interactionUnitsGenerated: 0,
    interactionUnitsReviewed: 0,
    dependencyEdgesIdentified: 0,
    dependencyEdgesEligible: 0,
    dependencyEdgesReviewed: 0,
    evidenceRequests: 0,
    evidenceRequestsAttempted: 0,
    evidenceRequestsSatisfied: 0,
    evidenceRequestsPartiallySatisfied: 0,
    evidenceRequestsUnresolved: 0,
    evidenceRequestsSkipped: 0,
    evidenceRecordsResolved: 0,
    evidenceRecordsPacked: 0,
    evidenceResolved: 0,
    evidenceGaps: 0,
    globalScan: "none",
    omissions: (scope?.omissions ?? []).map((item) => ({ kind: item.kind, id: item.id, reason: item.reason })),
  };
}

export function noReviewResult(
  version: string,
  status: ReviewStatus = "error",
  options: { message?: string; errors?: string[] } = {},
): ReviewResult {
  return {
    schemaVersion: 3,
    version,
    status,
    outcome: "incomplete",
    mode: "partitioned",
    reviewPath: "generic",
    findings: [],
    coverage: emptyReviewCoverage(),
    summary: options.message ?? "Review unavailable.",
    timestamp: new Date().toISOString(),
    reviewer: AGENT_SMITH,
    errors: options.errors,
  };
}
