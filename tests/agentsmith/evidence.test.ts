import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEvidenceRequests } from "../../src/agentsmith/evidence.js";
import type { ReviewScope } from "../../src/agentsmith/scope.js";
import type { CandidateFinding } from "../../src/core/types.js";
import type { GraphContext } from "../../src/core/graph/types.js";

const scope: ReviewScope = {
  id: "scope",
  version: "version",
  root: "/repo",
  base: "main",
  diff: "",
  changedFiles: ["src/a.ts"],
  changeSources: { "src/a.ts": ["working-tree"] },
  fileContents: { "src/a.ts": "const safe = true;\nreturn null;\n" },
  suppliedContext: {},
};

describe("candidate evidence resolution", () => {
  const emptyGraph = (): GraphContext => ({
    snapshot: {
      state: "READY",
      schemaVersion: 1,
      workspaceHash: "w",
      snapshotHash: "g",
      indexedCommit: null,
      providerVersions: {},
      completedAt: "now",
      fileCount: 0,
    },
    changedSymbols: [],
    nodes: [],
    edges: [],
    rendered: "",
    tokenEstimate: 0,
    budgetTokens: 100,
    selectedNodeKeys: [],
    omittedNodeKeys: [],
  });

  it("deduplicates equivalent requests and caps evidence records by code identity", () => {
    const symbol = {
      file: "src/a.ts",
      provider: "typescript-compiler",
      kind: "function" as const,
      name: "safe",
      qualifiedName: "safe",
      startLine: 1,
      endLine: 2,
      contentHash: "a",
    };
    const graph: GraphContext = {
      snapshot: {
        state: "READY",
        schemaVersion: 1,
        workspaceHash: "w",
        snapshotHash: "g",
        indexedCommit: null,
        providerVersions: {},
        completedAt: "now",
        fileCount: 1,
      },
      changedSymbols: [symbol],
      nodes: [{ symbol, score: 130, distance: 0 }],
      edges: [],
      rendered: "",
      tokenEstimate: 0,
      budgetTokens: 100,
      selectedNodeKeys: [],
      omittedNodeKeys: [],
    };
    const request = { kind: "implementation" as const, symbol: "safe", reason: "inspect implementation" };
    const candidate: CandidateFinding = {
      id: "candidate",
      sourceWorkItemIds: ["local:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 1,
      severity: "medium",
      category: "correctness",
      title: "Candidate",
      description: "Candidate description",
      evidenceRequests: [request, { ...request, reason: "duplicate reason" }],
      candidateConfidence: 0.8,
    };
    const resolved = resolveEvidenceRequests({
      candidate,
      scope,
      graph,
      policy: {
        maxRequestsPerCandidate: 8,
        maxParallelResolutions: 1,
        maxSnippetLines: 20,
        maxRecordsPerRequest: 1,
        maxRecordsPerCandidate: 1,
      },
    });
    expect(resolved.gaps).toEqual([]);
    expect(resolved.records).toHaveLength(1);
    expect(resolved.records[0]).toMatchObject({ file: "src/a.ts", symbol: "safe" });
  });

  it("normalizes path-qualified semantic locators from compact model output", () => {
    const symbol = {
      file: "src/core/verbose.ts",
      provider: "typescript-compiler",
      kind: "function" as const,
      name: "isVerboseEnabled",
      qualifiedName: "isVerboseEnabled",
      startLine: 1,
      endLine: 3,
      contentHash: "verbose",
    };
    const graph: GraphContext = {
      snapshot: {
        state: "READY",
        schemaVersion: 1,
        workspaceHash: "w",
        snapshotHash: "g",
        indexedCommit: null,
        providerVersions: {},
        completedAt: "now",
        fileCount: 1,
      },
      changedSymbols: [],
      nodes: [{ symbol, score: 80, distance: 1 }],
      edges: [],
      rendered: "",
      tokenEstimate: 0,
      budgetTokens: 100,
      selectedNodeKeys: [],
      omittedNodeKeys: [],
    };
    const candidate: CandidateFinding = {
      id: "qualified",
      sourceWorkItemIds: ["interaction:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 1,
      severity: "medium",
      category: "contract",
      title: "Candidate",
      description: "Candidate description",
      evidenceRequests: [
        {
          kind: "type",
          symbol: "src/core/verbose.ts:isVerboseEnabled()",
          reason: "inspect signature",
        },
      ],
      candidateConfidence: 0.8,
    };
    const resolved = resolveEvidenceRequests({
      candidate,
      scope: {
        ...scope,
        suppliedContext: { "src/core/verbose.ts": "function isVerboseEnabled(): boolean {\n  return true;\n}" },
      },
      graph,
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20 },
    });
    expect(resolved.gaps).toEqual([]);
    expect(resolved.records[0]).toMatchObject({
      file: "src/core/verbose.ts",
      symbol: "isVerboseEnabled",
    });
  });

  it("rejects expression-shaped symbol locators instead of broadening them", () => {
    const candidate: CandidateFinding = {
      id: "structural",
      sourceWorkItemIds: ["local:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 1,
      severity: "medium",
      category: "contract",
      title: "Candidate",
      description: "Candidate description",
      evidenceRequests: [
        {
          kind: "type",
          symbol: "{ cancel?: boolean; decision?: string }",
          reason: "inspect return type",
        },
      ],
      candidateConfidence: 0.8,
    };
    const resolved = resolveEvidenceRequests({
      candidate,
      scope: {
        ...scope,
        fileContents: {
          "src/a.ts": "function result(): { cancel?: boolean; decision?: string } {\n  return {};\n}",
        },
      },
      graph: {
        snapshot: {
          state: "READY",
          schemaVersion: 1,
          workspaceHash: "w",
          snapshotHash: "g",
          indexedCommit: null,
          providerVersions: {},
          completedAt: "now",
          fileCount: 1,
        },
        changedSymbols: [],
        nodes: [],
        edges: [],
        rendered: "",
        tokenEstimate: 0,
        budgetTokens: 100,
        selectedNodeKeys: [],
        omittedNodeKeys: [],
      },
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20 },
    });
    expect(resolved.records).toEqual([]);
    expect(resolved.outcomes[0]).toMatchObject({ status: "unresolved" });
  });

  it("reports an unusable same-file semantic locator instead of substituting the changed anchor", () => {
    const candidate: CandidateFinding = {
      id: "damaged-locator",
      sourceWorkItemIds: ["local:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 2,
      severity: "critical",
      category: "contract",
      title: "Candidate",
      description: "Candidate description",
      evidenceRequests: [
        {
          kind: "type",
          symbol: 'host === "cline" ? { cancel: true ...,p:"src/a.ts"',
          pathHint: "src/a.ts",
          reason: "inspect return contract",
        },
      ],
      candidateConfidence: 0.9,
    };
    const resolved = resolveEvidenceRequests({
      candidate,
      scope,
      graph: {
        snapshot: {
          state: "READY",
          schemaVersion: 1,
          workspaceHash: "w",
          snapshotHash: "g",
          indexedCommit: null,
          providerVersions: {},
          completedAt: "now",
          fileCount: 1,
        },
        changedSymbols: [],
        nodes: [],
        edges: [],
        rendered: "",
        tokenEstimate: 0,
        budgetTokens: 100,
        selectedNodeKeys: [],
        omittedNodeKeys: [],
      },
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20 },
    });
    expect(resolved.records).toEqual([]);
    expect(resolved.gaps).toEqual([expect.stringContaining("invalid expression-shaped symbol locator")]);
    expect(resolved.outcomes).toEqual([expect.objectContaining({ status: "unresolved", records: [] })]);
  });

  it("falls back to repository-wide, role-aware search when the graph has no match", () => {
    const root = mkdtempSync(join(tmpdir(), "matrixcore-evidence-"));
    mkdirSync(join(root, "finance/services"), { recursive: true });
    mkdirSync(join(root, "tests/unit"), { recursive: true });
    writeFileSync(
      join(root, "finance/services/portfolio.py"),
      'from finance.storage import cash_snapshot\n\ndef _latest_cash_balances():\n    return "cash_snapshot"\n',
    );
    writeFileSync(
      join(root, "tests/unit/test_portfolio.py"),
      'def _cash_snapshot():\n    return "cash_snapshot"\n\ndef test_cash_snapshot_contract():\n    assert "cash_snapshot"\n',
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], {
      cwd: root,
    });
    const fixtureScope: ReviewScope = {
      ...scope,
      root,
      fileContents: { "src/a.ts": "const safe = true;\n" },
    };
    const graph = emptyGraph();
    const makeCandidate = (kind: "implementation" | "test") => ({
      id: kind,
      sourceWorkItemIds: ["local:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 1,
      severity: "medium" as const,
      category: "correctness" as const,
      title: "Candidate",
      description: "Candidate description",
      evidenceRequests: [
        { kind, locatorMode: "literal" as const, query: "cash_snapshot", reason: "locate supporting code" },
      ],
      candidateConfidence: 0.8,
    });
    const implementation = resolveEvidenceRequests({
      candidate: makeCandidate("implementation"),
      scope: fixtureScope,
      graph,
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20, maxRecordsPerRequest: 1 },
    });
    const test = resolveEvidenceRequests({
      candidate: makeCandidate("test"),
      scope: fixtureScope,
      graph,
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20, maxRecordsPerRequest: 1 },
    });
    expect(implementation.records[0]?.file).toBe("finance/services/portfolio.py");
    expect(implementation.records[0]?.symbol).toBe("_latest_cash_balances");
    expect(implementation.records[0]?.snippet).toContain('return "cash_snapshot"');
    expect(implementation.outcomes[0]).toMatchObject({
      resolverRoute: "repository-literal",
      consideredRecords: 6,
    });
    expect(test.records[0]?.file).toBe("tests/unit/test_portfolio.py");
    expect(test.records[0]?.symbol).toBe("test_cash_snapshot_contract");
  });

  it("does not report a missing literal search as resolved", () => {
    const candidate: CandidateFinding = {
      id: "missing-search",
      sourceWorkItemIds: ["local:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 1,
      severity: "medium",
      category: "correctness",
      title: "Candidate",
      description: "Candidate description",
      evidenceRequests: [{ kind: "search", query: "not in the repository", reason: "find exact text" }],
      candidateConfidence: 0.8,
    };
    const resolved = resolveEvidenceRequests({
      candidate,
      scope,
      graph: emptyGraph(),
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20 },
    });
    expect(resolved.records).toEqual([]);
    expect(resolved.outcomes[0]).toMatchObject({ status: "unresolved" });
  });

  it("marks an unqualified symbol shared by multiple files as ambiguous", () => {
    const symbols = ["src/one.ts", "src/two.ts"].map((file) => ({
      file,
      provider: "typescript-compiler",
      kind: "function" as const,
      name: "resolve",
      qualifiedName: "resolve",
      startLine: 1,
      endLine: 1,
      contentHash: file,
    }));
    const graph = emptyGraph();
    graph.nodes = symbols.map((symbol) => ({ symbol, score: 80, distance: 1 }));
    const candidate: CandidateFinding = {
      id: "ambiguous",
      sourceWorkItemIds: ["local:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 1,
      severity: "medium",
      category: "contract",
      title: "Candidate",
      description: "Candidate description",
      evidenceRequests: [{ kind: "implementation", symbol: "resolve", reason: "inspect implementation" }],
      candidateConfidence: 0.8,
    };
    const resolved = resolveEvidenceRequests({
      candidate,
      scope: {
        ...scope,
        suppliedContext: { "src/one.ts": "function resolve() {}", "src/two.ts": "function resolve() {}" },
      },
      graph,
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20 },
    });
    expect(resolved.records).toEqual([]);
    expect(resolved.outcomes[0]).toMatchObject({ status: "unresolved", reason: expect.stringContaining("ambiguous") });
  });

  it("resolves callers in the incoming graph-edge direction", () => {
    const producer = {
      file: "src/a.ts",
      provider: "typescript-compiler",
      kind: "function" as const,
      name: "produce",
      qualifiedName: "produce",
      startLine: 1,
      endLine: 1,
      contentHash: "producer",
    };
    const caller = {
      ...producer,
      file: "src/caller.ts",
      name: "consume",
      qualifiedName: "consume",
      contentHash: "caller",
    };
    const graph = emptyGraph();
    graph.nodes = [producer, caller].map((symbol) => ({ symbol, score: 100, distance: 0 }));
    graph.edges = [
      {
        source: "src/caller.ts:consume",
        target: "src/a.ts:produce",
        targetText: "produce",
        kind: "calls",
        confidence: "exact",
        provider: "typescript-compiler",
        sourceSymbol: caller,
        targetSymbol: producer,
      },
    ];
    const candidate: CandidateFinding = {
      id: "callers",
      sourceWorkItemIds: ["interaction:1"],
      sourceReviewers: [],
      file: "src/a.ts",
      line: 1,
      severity: "high",
      category: "contract",
      title: "Producer mismatch",
      description: "Callers expect a different value.",
      evidenceRequests: [
        { kind: "callers", symbol: "produce", pathHint: "src/a.ts", reason: "inspect actual callers" },
      ],
      candidateConfidence: 0.9,
    };
    const resolved = resolveEvidenceRequests({
      candidate,
      scope: { ...scope, suppliedContext: { "src/caller.ts": "function consume() { return produce(); }" } },
      graph,
      policy: { maxRequestsPerCandidate: 2, maxParallelResolutions: 1, maxSnippetLines: 20 },
    });
    expect(resolved.outcomes[0]).toMatchObject({ status: "satisfied" });
    expect(resolved.records[0]).toMatchObject({ file: "src/caller.ts", symbol: "consume", relation: "callers" });
  });
});
