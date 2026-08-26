import { describe, expect, it } from "vitest";
import { parseVerdict, verdictToStatus } from "../../src/agentsmith/scripts/parse-verdict.js";

describe("parseVerdict", () => {
  it("parses a plain JSON verdict", () => {
    const parsed = parseVerdict('{"verdict":"APPROVE","summary":"ok","findings":[]}');
    expect(parsed.verdict).toBe("APPROVE");
    expect(parsed.summary).toBe("ok");
    expect(parsed.findings).toEqual([]);
  });

  it("parses a fenced JSON block", () => {
    const parsed = parseVerdict(
      'Here is the result:\n```json\n{"verdict":"REQUEST_CHANGES","summary":"fix","findings":[{"severity":"critical","message":"x","file":"a.ts","line":3}]}\n```\n',
    );
    expect(parsed.verdict).toBe("REQUEST_CHANGES");
    expect(parsed.findings[0]).toMatchObject({ severity: "blocker", message: "x", file: "a.ts", line: 3 });
  });

  it("normalizes severities and verdicts", () => {
    const parsed = parseVerdict(
      JSON.stringify({
        verdict: "risk",
        findings: [
          { severity: "error", message: "a" },
          { severity: "major", message: "b" },
          { severity: "minor", message: "c" },
          { severity: "weird", message: "d" },
        ],
      }),
    );
    expect(parsed.verdict).toBe("RISK");
    expect(parsed.findings.map((f) => f.severity)).toEqual(["blocker", "warn", "info", "warn"]);
  });

  it("never approves a response that contains findings", () => {
    const parsed = parseVerdict(
      "verdict: APPROVE\nsummary: contradictory\nfindings:\n  - severity: warn\n    message: investigate this",
    );
    expect(parsed.verdict).toBe("RISK");
    expect(parsed.findings).toHaveLength(1);
  });

  it("preserves evidence, impact, and recommendation", () => {
    const parsed = parseVerdict(
      "verdict: RISK\nfindings:\n  - severity: warn\n    message: defect\n    domain: correctness\n    evidence: return null\n    impact: caller crashes\n    recommendation: return a result object",
    );
    expect(parsed.findings[0]).toMatchObject({
      evidence: "return null",
      impact: "caller crashes",
      recommendation: "return a result object",
      domain: "correctness",
    });
  });

  it("defaults an unknown verdict to REQUEST_CHANGES", () => {
    const parsed = parseVerdict('{"findings":[]}');
    expect(parsed.verdict).toBe("REQUEST_CHANGES");
  });

  it("throws when no JSON is present", () => {
    expect(() => parseVerdict("no structured output here")).toThrow(/no JSON object/);
  });

  it("maps verdicts to review status", () => {
    expect(verdictToStatus("APPROVE")).toBe("PASS");
    expect(verdictToStatus("REQUEST_CHANGES")).toBe("FAIL");
    expect(verdictToStatus("RISK")).toBe("FAIL");
  });
});
