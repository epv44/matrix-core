import { describe, expect, it } from "vitest";
import { aggregateFindings } from "../../src/agentsmith/scripts/aggregate-findings.js";
import type { ParsedVerdict } from "../../src/agentsmith/scripts/parse-verdict.js";

const approve: ParsedVerdict = { verdict: "APPROVE", summary: "ok", findings: [] };
const requestChanges: ParsedVerdict = {
  verdict: "REQUEST_CHANGES",
  summary: "fix",
  findings: [
    { severity: "warn", message: "dup", file: "a.ts", line: 1 },
    { severity: "blocker", message: "bug", file: "b.ts", line: 4 },
  ],
};
const risk: ParsedVerdict = {
  verdict: "RISK",
  summary: "risky",
  findings: [{ severity: "info", message: "dup", file: "a.ts", line: 1 }],
};

describe("aggregateFindings", () => {
  it("merges, dedupes, and sorts by severity", () => {
    const { findings } = aggregateFindings([approve, requestChanges, risk]);
    expect(findings.map((f) => f.message)).toEqual(["bug", "dup"]);
    expect(findings[0].severity).toBe("blocker");
  });

  it("fails when any verdict is not APPROVE", () => {
    expect(aggregateFindings([approve, approve]).status).toBe("PASS");
    expect(aggregateFindings([approve, requestChanges]).status).toBe("FAIL");
    expect(aggregateFindings([approve, risk]).status).toBe("FAIL");
  });

  it("returns empty findings for approve-only reviews", () => {
    const { status, findings } = aggregateFindings([approve]);
    expect(status).toBe("PASS");
    expect(findings).toEqual([]);
  });

  it("fails closed when an approve verdict still carries a finding", () => {
    expect(
      aggregateFindings([{ verdict: "APPROVE", summary: "contradictory", findings: requestChanges.findings }]).status,
    ).toBe("FAIL");
  });
});
