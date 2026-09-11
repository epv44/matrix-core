import { describe, expect, it } from "vitest";
import { resolveEvidenceRequests } from "../../src/agentsmith/evidence.js";
import type { ReviewScope } from "../../src/agentsmith/scope.js";
import type { CandidateFinding, EvidenceRequest } from "../../src/core/types.js";
import type { GraphContext } from "../../src/core/graph/types.js";
import { sha256 } from "../../src/core/hash.js";

const scope: ReviewScope = {
  id: "phase-3-scope",
  version: "phase-3-version",
  root: "/repo",
  base: "main",
  diff: "",
  changedFiles: ["src/consumer.ts"],
  changeSources: { "src/consumer.ts": ["working-tree"] },
  fileContents: {
    "src/consumer.ts": [
      "export function consume(): string {",
      "  return produce();",
      "}",
    ].join("\n"),
    "src/producer.ts": [
      "export function produce(): string {",
      '  return "value";',
      "}",
    ].join("\n"),
    "src/config.ts": 'export const mode = "safe";\n',
  },
  suppliedContext: {},
};

function emptyGraph(overrides: Partial<GraphContext> = {}): GraphContext {
  return {
    snapshot: {
      state: "READY",
      schemaVersion: 1,
      workspaceHash: "workspace",
      snapshotHash: "snapshot",
      indexedCommit: "commit-1",
      providerVersions: {},
      completedAt: "now",
      fileCount: 3,
    },
    changedSymbols: [],
    nodes: [],
    edges: [],
    rendered: "",
    tokenEstimate: 0,
    budgetTokens: 100,
    selectedNodeKeys: [],
    omittedNodeKeys: [],
    ...overrides,
  };
}

function symbol(file: string, name: string, contentHash = "current") {
  return {
    file,
    provider: "typescript-compiler",
    kind: "function" as const,
    name,
    qualifiedName: name,
    startLine: 1,
    endLine: 3,
    contentHash: contentHash === "current" ? sha256(scope.fileContents[file] ?? scope.suppliedContext[file] ?? "") : contentHash,
  };
}

function candidate(request: EvidenceRequest): CandidateFinding {
  return {
    id: "phase-3-candidate",
    sourceWorkItemIds: ["interaction:phase-3"],
    sourceReviewers: [],
    file: "src/consumer.ts",
    line: 2,
    severity: "high",
    category: "contract",
    title: "Producer and consumer contract",
    description: "The consumer relies on the producer contract.",
    evidenceRequests: [request],
    candidateConfidence: 0.9,
  };
}

function resolve(request: EvidenceRequest, graph: GraphContext = emptyGraph(), currentScope = scope) {
  return resolveEvidenceRequests({
    candidate: candidate(request),
    scope: currentScope,
    graph,
    policy: {
      maxRequestsPerCandidate: 2,
      maxParallelResolutions: 1,
      maxSnippetLines: 20,
      maxRecordsPerRequest: 2,
      maxRecordsPerCandidate: 4,
    },
  });
}

describe("Phase 3 constrained evidence locator contracts", () => {
  it("resolves a valid canonical symbol request", () => {
    const produce = symbol("src/producer.ts", "produce");
    const result = resolve(
      { kind: "definition", locatorMode: "symbol", symbol: "produce", pathHint: "src/producer.ts", reason: "inspect producer" },
      emptyGraph({ nodes: [{ symbol: produce, score: 100, distance: 1 }] }),
    );

    expect(result.gaps).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "satisfied", resolverRoute: "graph-symbol" });
    expect(result.records[0]).toMatchObject({ file: "src/producer.ts", symbol: "produce", requestKind: "definition" });
  });

  it("rejects an unknown symbol locator without substituting the candidate anchor", () => {
    const result = resolve({
      kind: "implementation",
      locatorMode: "symbol",
      symbol: "doesNotExist",
      reason: "inspect the unknown implementation",
    });

    expect(result.records).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "unresolved", records: [] });
  });

  it("rejects a stale graph symbol whose content identity does not match the frozen snapshot", () => {
    const staleProduce = symbol("src/producer.ts", "produce", sha256("hash-from-an-older-snapshot"));
    const result = resolve(
      { kind: "definition", locatorMode: "symbol", symbol: "produce", pathHint: "src/producer.ts", reason: "inspect current producer" },
      emptyGraph({ nodes: [{ symbol: staleProduce, score: 100, distance: 1 }] }),
    );

    // Phase 3 requires locator identity to be bound to the frozen snapshot.
    // This currently fails because the resolver matches the symbol without
    // checking its contentHash against the supplied snapshot.
    expect(result.records).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "unresolved", records: [] });
  });

  it("does not satisfy a relationship request from an incompatible edge kind", () => {
    const producer = symbol("src/producer.ts", "produce");
    const consumer = symbol("src/consumer.ts", "consume");
    const result = resolve(
      { kind: "callers", locatorMode: "symbol", symbol: "produce", pathHint: "src/producer.ts", reason: "inspect callers" },
      emptyGraph({
        nodes: [producer, consumer].map((item) => ({ symbol: item, score: 100, distance: 1 })),
        edges: [
          {
            source: "src/consumer.ts:consume",
            target: "src/producer.ts:produce",
            targetText: "produce",
            kind: "imports",
            confidence: "exact",
            provider: "typescript-compiler",
            sourceSymbol: consumer,
            targetSymbol: producer,
          },
        ],
      }),
    );

    // A callers request must consume canonical call edges only. Current
    // production code treats every edge as a relationship match here.
    expect(result.records).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "unresolved", records: [] });
  });

  it("rejects a locator outside the frozen task scope", () => {
    const result = resolve({
      kind: "implementation",
      locatorMode: "symbol",
      symbol: "secret",
      pathHint: "../secret.ts",
      reason: "attempt to escape the task scope",
    });

    expect(result.records).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "unresolved", records: [] });
  });

  it("rejects an ambiguous unqualified symbol instead of choosing a winner", () => {
    const first = symbol("src/one.ts", "resolve", "one");
    const second = symbol("src/two.ts", "resolve", "two");
    const result = resolve(
      { kind: "implementation", locatorMode: "symbol", symbol: "resolve", reason: "inspect implementation" },
      emptyGraph({ nodes: [first, second].map((item) => ({ symbol: item, score: 100, distance: 1 })) }),
      { ...scope, suppliedContext: { "src/one.ts": "function resolve() {}", "src/two.ts": "function resolve() {}" } },
    );

    expect(result.records).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "unresolved", reason: expect.stringContaining("ambiguous") });
  });

  it("resolves callers and callees according to canonical relationship direction", () => {
    const producer = symbol("src/producer.ts", "produce");
    const consumer = symbol("src/consumer.ts", "consume");
    const graph = emptyGraph({
      nodes: [producer, consumer].map((item) => ({ symbol: item, score: 100, distance: 1 })),
      edges: [
        {
          source: "src/consumer.ts:consume",
          target: "src/producer.ts:produce",
          targetText: "produce",
          kind: "calls",
          confidence: "exact",
          provider: "typescript-compiler",
          sourceSymbol: consumer,
          targetSymbol: producer,
        },
      ],
    });

    const callers = resolve(
      { kind: "callers", locatorMode: "symbol", symbol: "produce", pathHint: "src/producer.ts", reason: "inspect callers" },
      graph,
    );
    const callees = resolve(
      { kind: "callees", locatorMode: "symbol", symbol: "consume", pathHint: "src/consumer.ts", reason: "inspect callees" },
      graph,
    );

    expect(callers.records[0]).toMatchObject({ file: "src/consumer.ts", symbol: "consume", relation: "callers" });
    expect(callees.records[0]).toMatchObject({ file: "src/producer.ts", symbol: "produce", relation: "callees" });
    expect(callers.outcomes[0]?.status).toBe("satisfied");
    expect(callees.outcomes[0]?.status).toBe("satisfied");
  });

  it("keeps literal lookup explicit and does not treat it as symbol lookup", () => {
    const result = resolve(
      {
        kind: "config",
        locatorMode: "literal",
        query: "safe",
        pathHint: "src/config.ts",
        reason: "inspect configured mode",
      },
      emptyGraph(),
      { ...scope, suppliedContext: { "src/config.ts": scope.fileContents["src/config.ts"] } },
    );

    expect(result.outcomes[0]).toMatchObject({ status: "satisfied", resolverRoute: "repository-literal" });
    expect(result.records[0]).toMatchObject({ file: "src/config.ts", requestKind: "config", relation: "repository-search" });
  });

  it("rejects expression-shaped symbol requests rather than reinterpreting them as literals", () => {
    const result = resolve({
      kind: "type",
      locatorMode: "symbol",
      symbol: 'host === "cline" ? { cancel: true } : { decision: "continue" }',
      reason: "inspect the return contract",
    });

    expect(result.records).toEqual([]);
    expect(result.gaps).toEqual([expect.stringContaining("invalid expression-shaped symbol locator")]);
    expect(result.outcomes[0]).toMatchObject({ status: "unresolved", records: [] });
  });
});
