import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatAgentSmithReview } from "../../src/agentsmith/report.js";
import { writeResult } from "../../src/agentsmith/scripts/run-review.js";
import type { ReviewResult } from "../../src/core/types.js";

const result: ReviewResult = {
  schemaVersion: 2,
  version: "workspace-v2",
  status: "completed",
  outcome: "findings",
  mode: "hybrid",
  findings: [
    {
      id: "finding-1",
      file: "src/a.ts",
      line: 4,
      severity: "high",
      category: "correctness",
      title: "Incorrect fallback",
      description: "The changed branch returns the wrong value.",
      suggestion: "Return the validated value.",
      confidence: "verified",
      sourceWorkItemIds: ["interaction:1"],
      evidence: [
        {
          id: "e-1",
          requestKind: "implementation",
          file: "src/a.ts",
          startLine: 3,
          endLine: 5,
          snippet: "return fallback",
          relation: "changed-anchor",
        },
      ],
    },
  ],
  coverage: {
    changedFiles: 2,
    changedFilesReviewed: 2,
    changedSymbols: 3,
    changedSymbolsReviewed: 3,
    localUnitsGenerated: 3,
    localUnitsReviewed: 3,
    interactionUnitsGenerated: 2,
    interactionUnitsReviewed: 2,
    dependencyEdgesIdentified: 4,
    dependencyEdgesEligible: 3,
    dependencyEdgesReviewed: 3,
    evidenceRequests: 1,
    evidenceResolved: 1,
    evidenceGaps: 0,
    globalScan: "compact",
    omissions: [],
  },
  summary: "1 verified finding.",
  timestamp: "2026-08-17T00:00:00.000Z",
  reviewer: "AgentSmith",
  candidates: { generated: 3, verified: 1, likely: 1, rejected: 1, insufficientEvidence: 0 },
};

describe("AgentSmith v2 Markdown report", () => {
  it("shows verified findings and measurable coverage", () => {
    const markdown = formatAgentSmithReview(result, { gateStatus: "PASS" });
    expect(markdown).toContain("1 verified finding");
    expect(markdown).toContain("Changed symbols");
    expect(markdown).toContain("compact");
    expect(markdown).toContain("Likely (not published)");
    expect(markdown).not.toContain("approved");
  });

  it("labels bounded reviews without presenting them as global approval", () => {
    const markdown = formatAgentSmithReview({
      ...result,
      findings: [],
      outcome: "clear",
      coverage: {
        ...result.coverage,
        selection: "bounded",
        omissions: [{ kind: "work-item", id: "local:2", reason: "lower-ranked" }],
      },
    });
    expect(markdown).toContain("Bounded risk-ranked review completed");
    expect(markdown).toContain("Selection:** bounded");
    expect(markdown).toContain("lower-ranked");
  });

  it("persists matching YAML and Markdown artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix report v2 "));
    try {
      writeResult(root, result, "PASS");
      expect(fs.readFileSync(path.join(root, ".quality/review-result.yaml"), "utf8")).toContain("schemaVersion: 2");
      expect(fs.readFileSync(path.join(root, ".quality/review-result.md"), "utf8")).toContain("Verified findings");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not represent incomplete empty results as clear", () => {
    const markdown = formatAgentSmithReview({
      ...result,
      status: "partial",
      outcome: "incomplete",
      findings: [],
      errors: ["unit failed"],
    });
    expect(markdown).toContain("Review incomplete");
    expect(markdown).toContain("unit failed");
  });
});
