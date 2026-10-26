import { describe, expect, it } from "vitest";
import { renderEvalHtml } from "../../tools/agentsmith-evals/src/html-report.js";

describe("eval HTML renderer", () => {
  it("is deterministic and retains nested metrics and statuses", () => {
    const input = { run: { status: "PASS", metrics: { precision: { numerator: 2, denominator: 4, direction: "higher" } }, cases: [{ state: "PARTIAL" }] } };
    const html = renderEvalHtml(input);
    expect(html).toBe(renderEvalHtml(input));
    for (const title of ["Summary", "Pipeline", "Cases"]) expect(html).toContain(title);
    expect(html).not.toContain('id="comparison"');
    expect(html).not.toContain("Raw data");
    expect(html).not.toContain('id="raw"');
    expect(html).not.toContain("report-data");
    expect(html).toContain("PASS");
  });
  it("escapes displayed values and JSON script data", () => {
    const html = renderEvalHtml({ run: { status: "FAIL", note: `</script><img src=x onerror=alert(1)>` } });
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("report-data");
  });
  it("renders suite topline, suite rows, and every metric series", () => {
    const html = renderEvalHtml({
      run: {
        status: "pass",
        suite: "component",
        pipeline: {
          stages: [
            {
              id: "planning",
              name: "Planning",
              purpose: "Construct candidate work items and calculate risk factors.",
              status: "partial",
              runs: 2,
              applicableRuns: 2,
              evaluatedRuns: 1,
              partialRuns: 1,
              blockedRuns: 0,
              notEvaluableRuns: 0,
              notApplicableRuns: 0,
              blockedBy: [],
              diagnostics: ["optional target was not selected"],
              metrics: [
                {
                  name: "selectionExpectedRecall",
                  value: 0.625,
                  numerator: 5,
                  denominator: 8,
                  direction: "higher",
                  unit: "rate",
                  aggregation: "ratio",
                  runs: 1,
                  primary: true,
                },
              ],
            },
            {
              id: "verification",
              name: "Verification",
              purpose: "Adjudicate candidates and publish only supported findings.",
              status: "blocked",
              runs: 2,
              applicableRuns: 2,
              evaluatedRuns: 0,
              partialRuns: 0,
              blockedRuns: 2,
              notEvaluableRuns: 0,
              notApplicableRuns: 0,
              blockedBy: ["candidates"],
              diagnostics: [],
              metrics: [],
            },
          ],
        },
        topline: { metrics: { "coverage.changedFiles.rate": { value: 1 }, "reliability.calls": { value: 2 } } },
        perCase: [
          {
            caseId: "component-a",
            suite: "component",
            evalStatus: "partial",
            executionStatus: "completed",
            candidateResolution: "unproven",
            oracleSatisfied: false,
            reasonCode: "verifier-insufficient-evidence",
            topline: { metrics: { "coverage.changedFiles.rate": { value: 0.8 } } },
            tiers: [{ tier: "stage", status: "pass", metrics: { metrics: { "coverage.changedFiles.rate": { value: 1 } } } }],
          },
        ],
        componentMatrix: [],
      },
    });
    expect(html).toContain("component-a");
    expect(html).toContain("Planning");
    expect(html).toContain("Selection recall");
    expect(html).toContain("62.5%");
    expect(html).toContain("Verification");
    expect(html).toContain("BLOCKED");
    expect(html).toContain("Blocked by:");
    expect(html).toContain("verifier-insufficient-evidence");
    expect(html).toContain("UNPROVEN");
    expect(html).toContain("COMPLETED");
  });
  it("renders substantive diagnostic labels with explicit call denominators", () => {
    const html = renderEvalHtml({
      run: {
        status: "pass",
        pipeline: {
          stages: [
            {
              id: "candidates",
              name: "Candidate generation",
              purpose: "Generate candidates.",
              status: "pass",
              runs: 1,
              applicableRuns: 1,
              evaluatedRuns: 1,
              partialRuns: 0,
              blockedRuns: 0,
              notEvaluableRuns: 0,
              notApplicableRuns: 0,
              blockedBy: [],
              diagnostics: [],
              metrics: [
                {
                  name: "substantiveCompletedCallRecognition",
                  value: 0.75,
                  numerator: 3,
                  denominator: 4,
                  direction: "higher",
                  unit: "rate",
                  aggregation: "ratio",
                  runs: 1,
                  primary: false,
                },
              ],
            },
          ],
        },
      },
    });
    expect(html).toContain("Completed-call substantive recognition");
    expect(html).toContain("75.0%");
    expect(html).toContain("3/4");
  });
});
