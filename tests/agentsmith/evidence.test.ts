import { describe, expect, it } from "vitest";
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
  fileContents: { "src/a.ts": "const safe = true;\nreturn null;\n" },
  suppliedContext: {},
};

describe("candidate evidence resolution", () => {
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

  it("uses the candidate file for an exact structural-type locator", () => {
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
    expect(resolved.gaps).toEqual([]);
    expect(resolved.records[0]).toMatchObject({ file: "src/a.ts", startLine: 1 });
  });

  it("falls back to the changed anchor when a same-file semantic locator is unusable", () => {
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
    expect(resolved.gaps).toEqual([]);
    expect(resolved.records[0]).toMatchObject({ file: "src/a.ts", startLine: 1 });
    expect(resolved.records[0].snippet).toContain("return null");
  });
});
