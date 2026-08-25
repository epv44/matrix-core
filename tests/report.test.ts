import { describe, it, expect } from "vitest";
import { formatReport, formatDoctorReport, formatVerificationSection } from "../src/core/report.js";
import type { PluginResult, Capability, ResolvedConfig, BaselineData } from "../src/core/types.js";

const cfg: ResolvedConfig = {
  config: { version: 2, checks: {}, policies: {} },
  configPath: "/p/quality.yaml",
  configRoot: "/p",
  isDefault: false,
  workspaceHash: "workspace-hash",
};

const evalOk = { passed: true, failures: [] as string[], warnings: [] as string[] };

function result(plugin: string, status: PluginResult["status"], over: Partial<PluginResult> = {}): PluginResult {
  return { plugin, status, observations: [], metrics: {}, ...over };
}

function capability(name: string, found: boolean, required = false): Capability {
  return { name, found, required };
}

describe("formatReport", () => {
  it("renders full-mode header, central hashes, and a PASSED result", () => {
    const report = formatReport({
      results: [result("python.ruff", "PASS")],
      capabilities: [capability("node", true)],
      config: cfg,
      baseline: null,
      metrics: { "ruff.violation_count": 0 },
      evaluation: evalOk,
    });
    expect(report).toContain("=== Quality Engine Report (full) ===");
    expect(report).toContain("Result: PASSED");
    expect(report).toContain("ruff.violation_count: 0");
    expect(report).toContain("Workspace hash: workspace-hash");
    expect(report).not.toContain("baseline");
    expect(report).toContain("✓ Plugin: python.ruff Status: PASS");
  });

  it("renders changed-mode header", () => {
    const report = formatReport({
      results: [],
      capabilities: [],
      config: cfg,
      baseline: null,
      metrics: {},
      evaluation: evalOk,
      changedMode: true,
    });
    expect(report).toContain("=== Quality Engine Report (changed) ===");
  });

  it("FAIL result fails the gate and counts errors", () => {
    const report = formatReport({
      results: [
        result("python.ruff", "FAIL", { reason: "2 violations" }),
        result("python.mypy", "ERROR", { reason: "engine malfunction" }),
      ],
      capabilities: [],
      config: cfg,
      baseline: null,
      metrics: {},
      evaluation: evalOk,
    });
    expect(report).toContain("Result: FAILED (1 FAIL, 1 ERROR)");
    expect(report).toContain("✗ Plugin: python.ruff Status: FAIL (2 violations)");
  });

  it("lists policy failures and fails the gate", () => {
    const report = formatReport({
      results: [],
      capabilities: [],
      config: cfg,
      baseline: null,
      metrics: {},
      evaluation: { passed: false, failures: ["coverage degraded from 80 -> 60"], warnings: [] },
    });
    expect(report).toContain("Policy Failures:");
    expect(report).toContain("coverage degraded from 80 -> 60");
    expect(report).toContain("Result: FAILED");
  });

  it("renders observations with location and rule id and truncates over 20", () => {
    const observations = Array.from({ length: 25 }, (_, i) => ({
      file: `a${i}.py`,
      line: i + 1,
      message: `m${i}`,
      severity: "warn" as const,
      ruleId: "ruff",
    }));
    const report = formatReport({
      results: [result("python.ruff", "FAIL", { observations })],
      capabilities: [],
      config: cfg,
      baseline: null,
      metrics: {},
      evaluation: evalOk,
    });
    expect(report).toContain("- [warn] a0.py:1 m0 (ruff)");
    expect(report).toContain("... 5 more");
  });

  it("does not expose legacy baseline state", () => {
    const baseline: BaselineData = { version: 1, timestamp: "2026-01-01T00:00:00Z", metrics: {} };
    const report = formatReport({
      results: [],
      capabilities: [],
      config: cfg,
      baseline,
      metrics: {},
      evaluation: evalOk,
    });
    expect(report).not.toContain("Baseline:");
  });

  it("warns when evaluation produced warnings", () => {
    const report = formatReport({
      results: [],
      capabilities: [],
      config: cfg,
      baseline: null,
      metrics: {},
      evaluation: { passed: true, failures: [], warnings: ["ruff unavailable"] },
    });
    expect(report).toContain("Warnings:");
    expect(report).toContain("! ruff unavailable");
  });
});

describe("formatDoctorReport", () => {
  it("passes when all required capabilities are found and groups by pack", () => {
    const report = formatDoctorReport({
      capabilities: [capability("python:.:ruff", true, true), capability("typescript:frontend:tsc", true, true)],
      config: cfg,
      baselineExists: false,
      baselinePath: "/p/.quality/baseline.json",
      gitRepo: true,
    });
    expect(report).toContain("=== Quality Doctor ===");
    expect(report).toContain("Git repo: yes");
    expect(report).toContain("[python]");
    expect(report).toContain("[typescript]");
    expect(report).not.toContain("Baseline:");
    expect(report).toContain("Doctor: PASSED (all required capabilities found)");
  });

  it("fails and lists missing required capabilities", () => {
    const report = formatDoctorReport({
      capabilities: [capability("python:.:ruff", false, true)],
      config: cfg,
      baselineExists: true,
      baselinePath: "/p/.quality/baseline.json",
      gitRepo: false,
    });
    expect(report).toContain("Git repo: no");
    expect(report).not.toContain("Baseline:");
    expect(report).toContain("Doctor: FAILED (1 required missing)");
    expect(report).toContain("python:.:ruff missing but required");
  });
});

describe("formatVerificationSection", () => {
  it("renders PASS summary with counts and no failures", () => {
    const md = formatVerificationSection({
      status: "PASS",
      version: "abcdef1234567890",
      mode: "full",
      timestamp: "2026-08-05T00:00:00Z",
      results: [result("typescript.tsc", "PASS"), result("python.ruff", "SKIPPED")],
      failures: [],
      metrics: { "vitest.passed": 3, "vitest.failed": 0 },
    });
    expect(md).toContain("## Verification");
    expect(md).toContain("**Status:** PASS");
    expect(md).toContain("`abcdef123456`");
    expect(md).toContain("**Mode:** full");
    expect(md).toContain("**Checks:** 2 → 1 PASS · 1 SKIPPED");
    expect(md).toContain("**Tests:** 3 passed · 0 failed");
    expect(md).toContain("**Failures:** none");
  });

  it("renders failure table for FAIL checks", () => {
    const md = formatVerificationSection({
      status: "FAIL",
      version: "abcdef1234567890",
      results: [result("python.ruff", "FAIL", { reason: "2 violations" })],
      failures: ["python.ruff: 2 violations"],
      metrics: {},
    });
    expect(md).toContain("| Check | Status | Reason |");
    expect(md).toContain("| python.ruff | FAIL | 2 violations |");
    expect(md).toContain("- python.ruff: 2 violations");
    expect(md).toContain("**Checks:** 1 → 1 FAIL");
  });
});
