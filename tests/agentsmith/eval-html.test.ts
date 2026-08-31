import { describe, expect, it } from "vitest";
import { renderEvalHtml } from "../../tools/agentsmith-evals/src/html-report.js";

describe("eval HTML renderer", () => {
  it("is deterministic and retains nested metrics and statuses", () => {
    const input = { run: { status: "PASS", metrics: { precision: { numerator: 2, denominator: 4, direction: "higher" } }, cases: [{ state: "PARTIAL" }] } };
    const html = renderEvalHtml(input);
    expect(html).toBe(renderEvalHtml(input));
    for (const title of ["Overview", "Suites", "Component Matrix", "Case Detail", "Tier/Mode comparison", "Pipeline stages", "Graph/Risk", "Finding Lifecycle", "Gaps", "Hill-climb", "Raw data"]) expect(html).toContain(title);
    expect(html).toContain("metrics.precision.numerator");
    expect(html).toContain("PARTIAL");
  });
  it("escapes displayed values and JSON script data", () => {
    const html = renderEvalHtml({ run: { status: "FAIL", note: `</script><img src=x onerror=alert(1)>` } });
    expect(html).not.toContain("</script><img");
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).toContain("&lt;/script&gt;");
  });
});
