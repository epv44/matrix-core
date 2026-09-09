import { describe, expect, it } from "vitest";
import { materializeCachedReview, runReview } from "../../src/agentsmith/scripts/run-review.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import type { ReviewResult } from "../../src/core/types.js";
import { emptyReviewCoverage, noReviewResult } from "../../src/core/reviewer.js";

const coverage = {
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
  globalScan: "none" as const,
  omissions: [],
};

describe("runReview v4", () => {
  it("builds unavailable reviews from the shared result factories", () => {
    expect(
      emptyReviewCoverage({
        changedFiles: ["a.ts", "b.ts"],
        omissions: [{ kind: "file", id: "b.ts", reason: "generated" }],
      }),
    ).toMatchObject({ changedFiles: 2, changedFilesReviewed: 0, omissions: [{ id: "b.ts" }] });
    expect(noReviewResult("v", "error", { message: "offline", errors: ["offline"] })).toMatchObject({
      version: "v",
      status: "error",
      summary: "offline",
      errors: ["offline"],
      coverage: { changedFiles: 0 },
    });
  });

  it("rebinds a v4 cache entry to current identity", () => {
    const cached: ReviewResult = {
      schemaVersion: 4,
      version: "old",
      status: "completed",
      outcome: "clear",
      mode: "partitioned",
      reviewPath: "generic",
      findings: [],
      coverage,
      summary: "No verified findings.",
      timestamp: "old",
      reviewer: "AgentSmith",
      candidateResolutions: [],
    };
    expect(materializeCachedReview(cached, { version: "current", timestamp: "now", scopeId: "scope" })).toMatchObject({
      schemaVersion: 4,
      version: "current",
      timestamp: "now",
      scopeId: "scope",
      cacheHit: true,
    });
  });

  it("persists an incomplete v4 result when the provider is unavailable", async () => {
    const unavailable: ReviewProvider = {
      health: async () => ({ ok: false, models: [], error: "provider offline" }),
      invoke: async () => {
        throw new Error("provider offline");
      },
    };
    const result = await runReview({ cwd: process.cwd(), version: "v2" }, { provider: unavailable });
    expect(result).toMatchObject({ schemaVersion: 4, status: "error", outcome: "incomplete", findings: [] });
    expect(result.errors?.[0]).toMatch(/provider/i);
  });
});
