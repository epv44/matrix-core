import { describe, expect, it } from "vitest";
import { buildShadowComparison, escalationSignals } from "../../src/agentsmith/shadow.js";
import type { ReviewResult } from "../../src/core/types.js";

const result = (id: string, status: ReviewResult["status"] = "completed"): ReviewResult => ({
  schemaVersion: 3, version: "v", status, outcome: status === "partial" ? "incomplete" : "findings", mode: "partitioned", reviewPath: "generic",
  findings: [{ id, file: "src/a.ts", line: 1, severity: "high", category: "correctness", title: "bug", description: "bug", confidence: "verified", evidence: [], sourceWorkItemIds: [], sourceReviewers: [] }],
  coverage: { callsStarted: 2, tokenBudgetOmissions: status === "partial" ? 1 : 0, timeoutOmissions: 0, omissions: [] },
  summary: "x", timestamp: "now", reviewer: "test", candidates: { generated: 1, verified: 1, likely: 0, rejected: 0, insufficientEvidence: 0 },
  runtime: { models: {} as never, inputTokens: 10, outputTokens: 5, concurrency: 1 },
});

describe("shadow comparison", () => {
  it("compares findings and resource deltas deterministically", () => {
    expect(buildShadowComparison(result("old"), result("new"))).toMatchObject({ deltas: { findings: 0, inputTokens: 0, calls: 0 }, findingIdsAdded: ["new"], findingIdsRemoved: ["old"] });
  });
  it("emits escalation signals for incomplete bounded runs", () => {
    expect(escalationSignals(result("x", "partial"))).toEqual(["partial-execution", "budget-exhausted"]);
  });
});
