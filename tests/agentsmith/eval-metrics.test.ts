import { describe, expect, it } from "vitest";
import { collectEvalMetrics, collectTraceMetrics } from "../../src/agentsmith/eval-metrics.js";

describe("AgentSmith eval benchmark metrics", () => {
  it("measures inspected changed lines, candidate omissions, evidence relevance, and honesty", () => {
    const metrics = collectEvalMetrics({
      scope: {
        diff: ["diff --git a/a.ts b/a.ts", "+++ b/a.ts", "@@ -1,4 +1,4 @@", "+one", "+two", "+three", "+four"].join(
          "\n",
        ),
      } as any,
      result: {
        status: "completed",
        outcome: "clear",
        errors: [],
        coverage: {
          changedFiles: 2,
          changedFilesReviewed: 1,
          changedSymbols: 2,
          changedSymbolsReviewed: 1,
          localUnitsGenerated: 2,
          localUnitsReviewed: 1,
          interactionUnitsGenerated: 1,
          interactionUnitsReviewed: 0,
          evidenceGaps: 0,
          globalScan: "none",
          callsStarted: 2,
          callsCompleted: 1,
          callsCancelled: 1,
          timeout: true,
          omissions: [
            { kind: "work-item", id: "local:a", reason: "lower-ranked" },
            { kind: "candidate", id: "candidate-1", reason: "timeout" },
          ],
        },
      } as any,
      execution: {
        workItems: [
          {
            id: "local:a",
            code: [{ file: "a.ts", startLine: 1, endLine: 2 }],
          },
        ],
        candidates: [
          {
            id: "candidate-1",
            severity: "high",
            evidenceRequests: [{ pathHint: "wanted.ts" }],
          },
        ],
        evidence: {
          "candidate-1": [
            { id: "primary", file: "a.ts", snippet: "primary" },
            { id: "irrelevant", file: "other.ts", snippet: "unrelated" },
          ],
        },
        verification: [],
        providerFailures: [{}],
        inputTokens: 1000,
        outputTokens: 50,
      } as any,
      durationMs: 2000,
    });

    expect(metrics.coverage.changedLines).toMatchObject({ eligible: 4, reviewed: 2, rate: 0.5 });
    expect(metrics.coverage.workItems.duplicateRows).toBe(1);
    expect(metrics.candidates).toMatchObject({ generated: 1, adjudicated: 0, omitted: 1, omittedHighSeverity: 1 });
    expect(metrics.evidence).toMatchObject({ requests: 1, resolvedRecords: 1, relevantRecords: 0, relevanceRate: 0 });
    expect(metrics.reliability).toMatchObject({ providerFailures: 1, timeout: true });
    expect(metrics.efficiency.reviewedChangedLinesPerSecond).toBe(1);
    expect(metrics.honesty).toMatchObject({
      clearWithUnreviewedFiles: true,
      completedWithCandidateOmissions: true,
      zeroGapsWithUnsupportedEvidence: true,
      honest: false,
    });
  });

  it("rejects legacy traces without replayable execution data", () => {
    expect(() => collectTraceMetrics({ traceId: "legacy" } as any)).toThrow(/does not contain/);
  });
});
