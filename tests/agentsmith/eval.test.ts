import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import {
  compareEvalReports,
  runEvalCases,
  scoreFindings,
  scoreInspectionTargets,
} from "../../tools/agentsmith-evals/src/eval.js";
import {
  curateTrace,
  readEvalCase,
  validateCaseFixture,
  validateEvalCases,
} from "../../tools/agentsmith-evals/src/case.js";
import { captureReviewScope } from "../../src/agentsmith/scope.js";
import { captureSourceSnapshot } from "../../src/agentsmith/source-snapshot.js";
import { writeAgentSmithTrace } from "../../src/agentsmith/trace.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import type { ReviewResult } from "../../src/core/types.js";
import { sha256 } from "../../src/core/hash.js";

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
    sourceSnapshotCapture: captureSourceSnapshot(root, scope.version),
  });
  return { root, traceId: written.traceId! };
}

function activate(root: string, slug: string) {
  const target = path.join(root, "evals", "agentsmith", slug, "case.yaml");
  const definition = yaml.load(fs.readFileSync(target, "utf8")) as any;
  definition.status = "active";
  definition.sanitization = {
    reviewed: true,
    absolutePathsRemoved: true,
    sensitiveContentReviewed: true,
    redistributable: true,
  };
  definition.groundTruth = {
    reviewed: true,
    reviewedBy: "test-suite",
    reviewedAt: "2026-08-26T00:00:00.000Z",
    contractFamily: "synthetic-clear",
    exhaustiveCandidates: true,
  };
  definition.expectations = { aggregation: { outcome: "clear", findings: [] } };
  fs.writeFileSync(target, yaml.dump(definition));
}

afterEach(() => vi.unstubAllEnvs());

describe("AgentSmith v4 eval cases", () => {
  it("curates an unlabeled sanitized draft from a local trace", () => {
    const { root, traceId } = fixture();
    try {
      curateTrace({ root, traceId, slug: "case-one" });
      const { definition } = readEvalCase(root, "case-one");
      expect(definition).toMatchObject({ schemaVersion: 6, status: "draft", expectations: {} });
      expect(definition.source.fixture).toBeTruthy();
      expect(() => curateTrace({ root, traceId, slug: "case-one" })).toThrow(/already exists/);
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

  it("does not match a semantically different finding at the same line", () => {
    const actual = [
      {
        id: "wrong",
        file: "src/view.ts",
        line: 9,
        severity: "medium" as const,
        category: "contract" as const,
        title: "String mapping may throw",
        description: "wrong claim",
        confidence: "verified" as const,
        evidence: [],
        sourceWorkItemIds: [],
        sourceReviewers: [],
      },
    ];
    const expected = [
      {
        id: "cash-source",
        file: "src/view.ts",
        lineStart: 9,
        lineEnd: 9,
        severity: "low" as const,
        category: "contract" as const,
        titleContains: "cash snapshot",
        discoveryClass: "L2" as const,
        requiredEvidence: ["cash_snapshot"],
        symbols: [],
        description: "wrong provenance label",
        rationale: "distinct claim",
      },
    ];
    expect(scoreFindings(actual, expected)).toMatchObject({ truePositive: 0, falsePositive: 1, falseNegative: 1 });
  });

  it("accepts only digest-bound sensitive-content exemptions", () => {
    const { root, traceId } = fixture();
    try {
      curateTrace({ root, traceId, slug: "case-sensitive" });
      const directory = path.join(root, "evals", "agentsmith", "case-sensitive");
      const note = 'token = "fake-token-value"\n';
      fs.writeFileSync(path.join(directory, "review-note.txt"), note);
      expect(validateEvalCases(root).valid).toBe(false);

      const target = path.join(directory, "case.yaml");
      const definition = yaml.load(fs.readFileSync(target, "utf8")) as any;
      definition.sanitization.sensitiveContentExemptions = [
        {
          path: "review-note.txt",
          patternId: "credential-assignment",
          sha256: sha256(note),
          rationale: "deterministic fake value",
        },
      ];
      fs.writeFileSync(target, yaml.dump(definition));
      expect(validateEvalCases(root).valid).toBe(true);

      fs.writeFileSync(path.join(directory, "review-note.txt"), 'token = "different-fake-token"\n');
      const stale = validateEvalCases(root);
      expect(stale.valid).toBe(false);
      expect(stale.cases[0].findings.join("\n")).toMatch(/stale|matched/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      curateTrace({ root, traceId, slug: "case-run" });
      await expect(runEvalCases({ root, slugs: ["case-run"], provider })).rejects.toThrow(/draft/);
      activate(root, "case-run");
      const canonical = path.join(root, "evals", "agentsmith", "case-run", "fixture", "repo");
      const before = fs.readFileSync(path.join(canonical, "a.ts"), "utf8");
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
      expect(result.cases[0].results[0].provenance.fixtureDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.readFileSync(path.join(canonical, "a.ts"), "utf8")).toBe(before);
      expect(fs.existsSync(path.join(canonical, ".quality"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects fixture drift before replay", () => {
    const { root, traceId } = fixture();
    try {
      curateTrace({ root, traceId, slug: "case-drift" });
      const target = path.join(root, "evals", "agentsmith", "case-drift", "fixture", "repo", "a.ts");
      fs.appendFileSync(target, "// drift\n");
      expect(() => validateCaseFixture(root, "case-drift")).toThrow(/content mismatch/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays a curated case after the producer repository is removed", async () => {
    const { root: producer, traceId } = fixture();
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-eval-lab-"));
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen3.5:9b-q4_K_M"] }),
      invoke: async () => ({ raw: '{"c":[]}', usage: { inputTokens: 1, outputTokens: 1 } }),
    };
    try {
      curateTrace({ root: lab, traceRoot: producer, traceId, slug: "detached" });
      activate(lab, "detached");
      fs.rmSync(producer, { recursive: true, force: true });
      const report = await runEvalCases({ root: lab, slugs: ["detached"], provider });
      expect(report.cases[0].results[0]).toMatchObject({ outcome: "clear", errors: [] });
    } finally {
      fs.rmSync(producer, { recursive: true, force: true });
      fs.rmSync(lab, { recursive: true, force: true });
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
