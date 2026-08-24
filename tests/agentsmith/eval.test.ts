import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareEvalReports,
  curateTrace,
  readEvalCase,
  runEvalCases,
  scoreFindings,
  scoreInspectionTargets,
} from "../../src/agentsmith/eval.js";
import { captureReviewScope } from "../../src/agentsmith/scope.js";
import { writeAgentSmithTrace } from "../../src/agentsmith/trace.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import type { ReviewResult } from "../../src/core/types.js";

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
const emptyCoverage = {
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

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix eval v2 "));
  fs.writeFileSync(path.join(root, "quality.yaml"), "version: 2\nproject: eval-v2\nreview:\n  agentsmith: true\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"eval-v2","private":true}\n');
  fs.writeFileSync(path.join(root, "a.ts"), "export function value() { return 1; }\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "matrix@example.invalid");
  git(root, "config", "user.name", "Matrix");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  fs.writeFileSync(path.join(root, "a.ts"), "export function value() { return 2; }\n");
  const scope = captureReviewScope({ root, base: "HEAD" });
  const result: ReviewResult = {
    schemaVersion: 3,
    version: scope.version,
    snapshotId: scope.id,
    status: "completed",
    outcome: "clear",
    mode: "partitioned",
    reviewPath: "generic",
    findings: [],
    coverage: emptyCoverage,
    summary: "No verified findings.",
    timestamp: new Date().toISOString(),
    reviewer: "AgentSmith",
  };
  vi.stubEnv("MATRIXCORE_TRACE", "agentsmith");
  const written = writeAgentSmithTrace(root, {
    packageVersion: "test",
    version: scope.version,
    scope,
    deterministicReport: "PASS",
    result,
    decisionProvenance: {
      publishedFindingIds: [],
      rejectedCandidateIds: [],
      likelyCandidateIds: [],
      insufficientEvidenceCandidateIds: [],
      aggregateRule: "verified only",
      errors: [],
    },
  });
  return { root, traceId: written.traceId! };
}

afterEach(() => vi.unstubAllEnvs());

describe("AgentSmith v2 eval cases", () => {
  it("curates L0-L3 labels from a local trace", () => {
    const { root, traceId } = fixture();
    try {
      curateTrace(root, traceId, "case-one");
      const { definition } = readEvalCase(root, "case-one");
      expect(definition).toMatchObject({ schemaVersion: 2, expectedOutcome: "clear" });
      expect(() => curateTrace(root, traceId, "case-one")).toThrow(/already exists/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scores class-specific recall", () => {
    const actual = [
      {
        id: "a",
        file: "src/a.ts",
        line: 5,
        severity: "high" as const,
        category: "contract" as const,
        title: "Mismatch",
        description: "bad",
        confidence: "verified" as const,
        evidence: [],
        sourceWorkItemIds: ["interaction"],
        sourceReviewers: [],
      },
    ];
    const expected: any[] = [
      {
        id: "e1",
        file: "src/a.ts",
        lineStart: 5,
        lineEnd: 5,
        category: "contract",
        discoveryClass: "L2",
        requiredEvidence: [],
      },
      { id: "e2", file: "src/b.ts", lineStart: 2, lineEnd: 2, discoveryClass: "L3", requiredEvidence: [] },
    ];
    const score = scoreFindings(actual, expected);
    expect(score).toMatchObject({ truePositive: 1, falseNegative: 1, precision: 1, recall: 0.5 });
    expect(score.byClass.L2.recall).toBe(1);
    expect(score.byClass.L3.recall).toBe(0);
  });

  it("runs partitioned variants against the same frozen snapshot", async () => {
    const { root, traceId } = fixture();
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen3.5:9b-q4_K_M"] }),
      invoke: async (input) => ({
        raw: input.outputKind === "scout" ? '{"hotspots":[]}' : '{"c":[]}',
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
    };
    try {
      curateTrace(root, traceId, "case-run");
      const result = await runEvalCases({
        root,
        slugs: ["case-run"],
        modes: ["partitioned-local", "partitioned-interactions"],
        provider,
      });
      expect(result.cases[0].results).toHaveLength(2);
      expect(
        result.cases[0].results.every((item) => item.outcome === "clear"),
        JSON.stringify(result.cases[0].results, null, 2),
      ).toBe(true);
      expect(result.summary).toHaveLength(2);
      expect(result.cases[0].results[0].benchmark.coverage.changedFiles.rate).toBe(1);
      expect(result.cases[0].results[0].diagnostics).toMatchObject({
        candidates: [],
        verification: [],
        providerFailures: [],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scores explicit inspection targets and report deltas", () => {
    const inspection = scoreInspectionTargets(
      {
        workItems: [
          {
            code: [{ file: "src/a.ts" }],
            primarySymbols: [{ file: "src/a.ts", name: "run", qualifiedName: "Service.run" }],
            relatedSymbols: [],
            graphEdges: [{ source: "Service.run", target: "Store.save", targetText: "Store.save", kind: "calls" }],
          },
        ],
      } as any,
      {
        files: ["src/a.ts", "src/missing.ts"],
        symbols: ["src/a.ts#Service.run"],
        edges: ["Service.run->Store.save:calls"],
      },
    );
    expect(inspection.files).toMatchObject({ expected: 2, matched: 1, rate: 0.5, missing: ["src/missing.ts"] });
    expect(inspection.symbols.rate).toBe(1);
    expect(inspection.edges.rate).toBe(1);

    const baseline = {
      cases: [
        {
          id: "case",
          results: [
            { mode: "partitioned-local", qualityEvaluable: true, metrics: { f1: 0.5 }, durationMs: 20, errors: [] },
          ],
        },
      ],
    };
    const current = {
      cases: [
        {
          id: "case",
          results: [
            { mode: "partitioned-local", qualityEvaluable: true, metrics: { f1: 0.75 }, durationMs: 15, errors: [] },
          ],
        },
      ],
    };
    expect(compareEvalReports(baseline, current)[0].delta).toMatchObject({ f1: 0.25, durationMs: -5 });
  });
});
