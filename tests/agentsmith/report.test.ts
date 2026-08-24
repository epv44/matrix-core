import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatAgentSmithReview } from "../../src/agentsmith/report.js";
import { writeResult } from "../../src/agentsmith/scripts/run-review.js";
import type { ReviewResult } from "../../src/core/types.js";

const result: ReviewResult = {
  schemaVersion: 3,
  version: "workspace-v2",
  status: "completed",
  outcome: "findings",
  mode: "hybrid",
  reviewPath: "generic",
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
      sourceReviewers: [],
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
    configuredParallelism: 4,
    effectiveParallelism: 2,
    deadlineMs: 600_000,
    elapsedMs: 45_000,
    cacheHits: 2,
    cacheMisses: 1,
    structuredRepairs: 1,
    candidateProviderMs: 12_000,
    verificationProviderMs: 8_000,
    scoutProviderMs: 2_000,
  },
  summary: "1 verified finding.",
  timestamp: "2026-08-17T00:00:00.000Z",
  reviewer: "AgentSmith",
  candidates: {
    generated: 3,
    shortlisted: 2,
    adjudicated: 2,
    omitted: 1,
    verified: 1,
    likely: 1,
    rejected: 1,
    insufficientEvidence: 0,
  },
  profileHash: "internal-profile-hash",
  strategyHash: "internal-strategy-hash",
  traceId: "internal-trace-id",
};

describe("AgentSmith Markdown report", () => {
  it("shows verified findings and measurable coverage", () => {
    const markdown = formatAgentSmithReview(result, { gateStatus: "PASS" });
    expect(markdown).toBe(`## AgentSmith Review

**Outcome:** 1 verified finding pending human triage (advisory).
**Deterministic gate:** PASS.
**Review status:** completed.
**Review path:** generic.
**Candidate mode:** hybrid.

### AgentSmith Summary

1 verified finding.

### Verified Findings

| ID | Severity | Category | Location | Finding | Evidence | Suggestion | Reported by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| finding-1 | high | correctness | src/a.ts:4 | Incorrect fallback: The changed branch returns the wrong value. | src/a.ts:3-5 | Return the validated value. | generic engine |

### Candidate Verification

| Generated | Shortlisted | Adjudicated | Omitted | Verified | Likely | Rejected | Insufficient evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 2 | 2 | 1 | 1 | 1 | 1 | 0 |

### Coverage

| Surface | Reviewed | Eligible/total |
| --- | --- | --- |
| Changed files | 2 | 2 |
| Changed symbols | 3 | 3 |
| Local units | 3 | 3 |
| Interaction units | 2 | 2 |
| Dependency edges | 3 | 3/4 eligible/identified |
| Evidence | 1 | 1 requests; 0 gaps |
| Global scan | compact | — |

AgentSmith is advisory. Select verified finding IDs explicitly before running \`quality_fix\`; MatrixCore does not apply fixes automatically.`);
    expect(markdown).not.toMatch(
      /internal-|Profile hash|Strategy hash|Review version|Execution bounds|provider time|Cache hits|trace/i,
    );
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
    expect(markdown).toContain("Outside the selected risk-ranked scope | 1");
    expect(markdown).not.toContain("local:2");
    expect(markdown).not.toContain("lower-ranked");
  });

  it("renders the exact specialist report hierarchy and reviewer attribution", () => {
    const markdown = formatAgentSmithReview({
      ...result,
      reviewPath: "specialist",
      findings: [{ ...result.findings[0], sourceReviewers: ["architecture-reviewer", "bug-hunter"] }],
      specialists: [
        {
          reviewer: "architecture-reviewer",
          status: "completed",
          summary: "The ownership boundary was reviewed.",
          candidates: [
            {
              id: "finding-1",
              title: "Incorrect fallback",
              file: "src/a.ts",
              line: 4,
              severity: "high",
              disposition: "verified",
              reasoning: "The caller contract proves the failure.",
            },
          ],
        },
        {
          reviewer: "perf-reviewer",
          status: "completed",
          summary: "No concrete performance defect was found.",
          candidates: [],
        },
        {
          reviewer: "bug-hunter",
          status: "completed",
          summary: "The fallback failure was identified.",
          candidates: [],
        },
        {
          reviewer: "semantic-reviewer",
          status: "completed",
          summary: "Declared and runtime contracts were compared.",
          candidates: [],
        },
      ],
    });
    expect(markdown.match(/^#{2,5} .+$/gm)).toEqual([
      "## AgentSmith Review",
      "### AgentSmith Summary",
      "### Specialist Reviews",
      "#### Architecture Reviewer",
      "##### Summary",
      "##### Candidate Outcomes",
      "#### Performance Reviewer",
      "##### Summary",
      "##### Candidate Outcomes",
      "#### Correctness Reviewer",
      "##### Summary",
      "##### Candidate Outcomes",
      "#### Semantic Reviewer",
      "##### Summary",
      "##### Candidate Outcomes",
      "### Verified Findings",
      "### Candidate Verification",
      "### Coverage",
    ]);
    expect(markdown).toContain("architecture-reviewer, bug-hunter");
    expect(markdown).toContain("The ownership boundary was reviewed.");
  });

  it("persists matching YAML and Markdown artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix report v2 "));
    try {
      writeResult(root, result, "PASS");
      expect(fs.readFileSync(path.join(root, ".quality/review-result.yaml"), "utf8")).toContain("schemaVersion: 3");
      const markdown = fs.readFileSync(path.join(root, ".quality/review-result.md"), "utf8");
      expect(markdown).toBe(
        formatAgentSmithReview(result, { gateStatus: "PASS", artifact: ".quality/review-result.md" }),
      );
      expect(markdown).not.toContain("internal-profile-hash");
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
      coverage: {
        ...result.coverage,
        timeout: {
          deadlineMs: 180_000,
          elapsedMs: 180_001,
          callsStarted: 2,
          callsCompleted: 1,
          callsCancelled: 1,
        },
        omissions: [
          { kind: "candidate", id: "candidate-secret", reason: "timeout" },
          { kind: "work-item", id: "work-secret", reason: "token-budget" },
        ],
      },
      incompleteReasons: [
        { kind: "timeout", detail: "Review exceeded its 180000ms deadline." },
        {
          kind: "unadjudicated-candidate",
          id: "candidate-secret",
          detail: "High-severity candidate was not adjudicated.",
        },
      ],
      errors: ["provider raw stack and endpoint details"],
    });
    expect(markdown).toContain("Review incomplete");
    expect(markdown).toContain("Candidate verification did not complete | 1");
    expect(markdown).toContain("Outside the review token budget | 1");
    expect(markdown).toContain("Review deadline reached | 1");
    expect(markdown).toContain("Review infrastructure errors | 1");
    expect(markdown).not.toMatch(/candidate-secret|work-secret|raw stack|180000ms|180001/);
  });

  it("renders disabled reviews without internal metadata", () => {
    expect(formatAgentSmithReview(null, { gateStatus: "PASS" })).toBe(`## AgentSmith Review

**Outcome:** Review disabled.
**Deterministic gate:** PASS.`);
  });
});
