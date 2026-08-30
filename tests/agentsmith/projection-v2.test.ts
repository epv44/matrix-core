import { describe, expect, it } from "vitest";
import {
  buildProjection,
  buildWorkItems,
  extensionLanguage,
  projectionBudget,
  routeReview,
  selectWorkItems,
} from "../../src/agentsmith/projection.js";
import type { ModelProfile } from "../../src/core/types.js";
import type { GraphContext } from "../../src/core/graph/types.js";
import type { ReviewScope } from "../../src/agentsmith/scope.js";
import type { ReviewWorkItem } from "../../src/agentsmith/engine-types.js";

const small: ModelProfile = {
  id: "small",
  provider: "ollama",
  model: "small",
  contextTokens: 8192,
  reviewCapability: "small",
  requestedOutputTokens: 1000,
  safetyReserveTokens: 1000,
  tokenizer: { kind: "conservative-ratio", codeCharsPerToken: 2, proseCharsPerToken: 3 },
  inference: { temperature: 0, thinking: false, timeoutMs: 1000 },
};
const strong: ModelProfile = {
  ...small,
  id: "strong",
  model: "strong",
  contextTokens: 131072,
  reviewCapability: "strong",
  requestedOutputTokens: 4000,
  safetyReserveTokens: 4000,
};
const routing = { inputContextFraction: 0.7, enableHolistic: true, enablePartitioned: true, enableHybrid: true };
const manifest = [
  {
    path: "api.ts",
    changeKind: "modified" as const,
    additions: 1,
    deletions: 1,
    language: "typescript",
    generated: false,
    binary: false,
  },
];
const scope: ReviewScope = {
  id: "snapshot",
  version: "version",
  root: process.cwd(),
  base: "main",
  diff: "diff --git a/api.ts b/api.ts\n+++ b/api.ts\n@@ -1,1 +1,1 @@\n-export function read(): string { return oldValue(); }\n+export function read(): number { return 1; }",
  changedFiles: ["api.ts"],
  changeSources: { "api.ts": ["working-tree"] },
  fileContents: { "api.ts": "export function read(): number { return 1; }\n" },
  suppliedContext: {},
  manifest,
  omissions: [],
  languages: ["typescript"],
  metadata: { fileCount: 1, additions: 1, deletions: 1, capturedAt: "now" },
};
const changed = {
  file: "api.ts",
  provider: "typescript",
  kind: "function" as const,
  name: "read",
  qualifiedName: "read",
  startLine: 1,
  endLine: 1,
  contentHash: "a",
};
const consumer = {
  file: "consumer.ts",
  provider: "typescript",
  kind: "function" as const,
  name: "useRead",
  qualifiedName: "useRead",
  startLine: 1,
  endLine: 1,
  contentHash: "b",
};
const edge = {
  source: "consumer.ts:useRead",
  target: "api.ts:read",
  targetText: "read",
  kind: "calls" as const,
  confidence: "exact" as const,
  provider: "typescript",
  sourceSymbol: consumer,
  targetSymbol: changed,
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
    fileCount: 2,
  },
  changedSymbols: [changed],
  nodes: [
    { symbol: changed, score: 130, distance: 0 },
    { symbol: consumer, score: 90, distance: 1, excerpt: "export function useRead() { return read().trim(); }" },
  ],
  edges: [edge],
  rendered: "",
  tokenEstimate: 0,
  budgetTokens: 100000,
  selectedNodeKeys: [],
  omittedNodeKeys: [],
};
const rules = [
  {
    id: "contract.calls",
    languages: ["typescript"],
    categories: ["contract" as const],
    triggers: [{ edgeKinds: ["calls"] }],
    short: "Compare caller and callee contracts.",
    explanation: "Require both sides.",
  },
];

describe("adaptive projection planning", () => {
  it("maps changed symbols into deterministic local units with bounded token accounting", () => {
    const projection = buildProjection({ scope, graph, profile: small, rules, kind: "full" });
    const budget = projectionBudget(small, routing).inputBudgetTokens;
    const items = buildWorkItems({
      projection,
      graph,
      profile: small,
      rules,
      inputBudgetTokens: budget,
      policy: { maxParallelUnits: 20, maxRulesPerUnit: 8, maxUnitsPerChangedSymbol: 6, preferSemanticBoundaries: true, hunkFallback: true },
    });
    const local = items.find((item) => item.kind === "local");
    expect(local?.primarySymbols).toEqual([changed]);
    expect(local?.code[0]).toMatchObject({ file: "api.ts", symbol: "read", changed: true });
    expect(local?.estimatedTokens).toBeGreaterThan(0);
    expect(local?.estimatedTokens).toBeLessThanOrEqual(budget);
    const again = buildWorkItems({ projection, graph, profile: small, rules, inputBudgetTokens: budget, policy: { maxParallelUnits: 20, maxRulesPerUnit: 8, maxUnitsPerChangedSymbol: 6, preferSemanticBoundaries: true, hunkFallback: true } });
    expect(again.map((item) => item.id)).toEqual(items.map((item) => item.id));
  });

  it("falls back to changed hunk context when semantic symbols are unavailable", () => {
    expect(extensionLanguage("worker.py")).toBe("python");
    expect(extensionLanguage("worker.rb")).toBe("rb");
    const noSymbols = buildProjection({ scope, graph: { ...graph, changedSymbols: [], nodes: [], edges: [] }, profile: small, rules: [], kind: "full" });
    const fallback = noSymbols.code.find((item) => item.changed);
    expect(fallback?.reason).toContain("changed hunk fallback");
    expect(fallback?.content).toContain("read");
  });

  it("routes by complete projection fit and reasoning capability", () => {
    const fullSmall = buildProjection({ scope, graph, profile: small, rules, kind: "full" });
    const compactSmall = buildProjection({ scope, graph, profile: small, rules, kind: "compact" });
    expect(
      routeReview({ requestedMode: "auto", candidate: small, routing, full: fullSmall, compact: compactSmall }).mode,
    ).toBe("partitioned");
    const fullStrong = buildProjection({ scope, graph, profile: strong, rules, kind: "full" });
    const compactStrong = buildProjection({ scope, graph, profile: strong, rules, kind: "compact" });
    expect(
      routeReview({ requestedMode: "auto", candidate: strong, routing, full: fullStrong, compact: compactStrong }).mode,
    ).toBe("holistic");
    expect(projectionBudget(small, routing).inputBudgetTokens).toBeLessThan(small.contextTokens);
  });

  it("creates proactive local and interaction work items within budget", () => {
    const projection = buildProjection({ scope, graph, profile: small, rules, kind: "full" });
    const budget = projectionBudget(small, routing).inputBudgetTokens;
    const items = buildWorkItems({
      projection,
      graph,
      profile: small,
      rules,
      inputBudgetTokens: budget,
      policy: {
        maxParallelUnits: 20,
        maxRulesPerUnit: 8,
        maxUnitsPerChangedSymbol: 6,
        preferSemanticBoundaries: true,
        hunkFallback: true,
      },
    });
    expect(items.map((item) => item.kind)).toEqual(["local", "interaction"]);
    expect(items.every((item) => item.estimatedTokens <= budget)).toBe(true);
    expect(items[1].code.map((code) => code.file)).toEqual(["api.ts", "consumer.ts"]);
    const selection = selectWorkItems(items, 1);
    expect(selection.selected).toHaveLength(1);
    expect(selection.selected[0].kind).toBe("interaction");
    expect(selection.omitted).toHaveLength(1);
  });

  it("constructs one deterministic local unit for each changed symbol", () => {
    const secondChanged = { ...changed, name: "write", qualifiedName: "write", startLine: 2, endLine: 2 };
    const secondGraph: GraphContext = {
      ...graph,
      changedSymbols: [changed, secondChanged],
      nodes: [
        { symbol: changed, score: 130, distance: 0 },
        { symbol: secondChanged, score: 120, distance: 0 },
      ],
      edges: [],
    };
    const projection = buildProjection({ scope, graph: secondGraph, profile: small, rules: [], kind: "full" });
    const build = () =>
      buildWorkItems({
        projection,
        graph: secondGraph,
        profile: small,
        rules: [],
        inputBudgetTokens: 20_000,
        policy: {
          maxParallelUnits: 20,
          maxRulesPerUnit: 8,
          maxUnitsPerChangedSymbol: 6,
          preferSemanticBoundaries: true,
          hunkFallback: true,
        },
      });
    const first = build();
    const second = build();
    expect(first.filter((item) => item.kind === "local")).toHaveLength(2);
    expect(first.filter((item) => item.kind === "local").map((item) => item.primarySymbols[0].qualifiedName)).toEqual([
      "read",
      "write",
    ]);
    expect(first).toEqual(second);
    expect(first.every((item) => item.estimatedTokens <= 20_000)).toBe(true);
  });

  it("deduplicates overlapping provider facts and stratifies selected review surfaces", () => {
    const duplicateChanged = { ...changed, provider: "tree-sitter-wasm" };
    const duplicateEdge = { ...edge, provider: "tree-sitter-wasm", confidence: "syntactic" as const };
    const duplicatedGraph: GraphContext = {
      ...graph,
      changedSymbols: [changed, duplicateChanged],
      nodes: [...graph.nodes, { symbol: duplicateChanged, score: 120, distance: 0 }],
      edges: [edge, duplicateEdge],
    };
    const projection = buildProjection({ scope, graph: duplicatedGraph, profile: small, rules, kind: "full" });
    const items = buildWorkItems({
      projection,
      graph: duplicatedGraph,
      profile: small,
      rules,
      inputBudgetTokens: 20_000,
      policy: {
        maxParallelUnits: 20,
        maxRulesPerUnit: 8,
        maxUnitsPerChangedSymbol: 6,
        preferSemanticBoundaries: true,
        hunkFallback: true,
      },
    });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    const selection = selectWorkItems([...items, ...items], 2, 20_000);
    expect(selection.selected).toHaveLength(2);
    expect(new Set(selection.selected.map((item) => item.kind))).toEqual(new Set(["local", "interaction"]));
    expect(selection.omitted).toHaveLength(0);
  });

  it("keeps changed-hunk context when only nested symbols are available", () => {
    const content = [
      'test("contract", async () => {',
      "  await setup();",
      '  const card = page.getByText("Contribution activity");',
      "  await expect(card).toBeVisible();",
      '  await expect(page.getByText("2026-01")).toHaveCount(0);',
      "});",
    ].join("\n");
    const hunkScope: ReviewScope = {
      ...scope,
      diff: 'diff --git a/dashboard.spec.ts b/dashboard.spec.ts\n+++ b/dashboard.spec.ts\n@@ -1,1 +1,6 @@\n+test("contract", async () => {\n+  await setup();\n+  const card = page.getByText("Contribution activity");\n+  await expect(card).toBeVisible();\n+  await expect(page.getByText("2026-01")).toHaveCount(0);\n+});',
      changedFiles: ["dashboard.spec.ts"],
      changeSources: { "dashboard.spec.ts": ["working-tree"] },
      fileContents: { "dashboard.spec.ts": content },
      manifest: [{ ...manifest[0], path: "dashboard.spec.ts", additions: 6, deletions: 0 }],
    };
    const nested = {
      ...changed,
      file: "dashboard.spec.ts",
      name: "card",
      qualifiedName: "card",
      startLine: 3,
      endLine: 3,
    };
    const hunkGraph: GraphContext = {
      ...graph,
      changedSymbols: [nested],
      nodes: [{ symbol: nested, score: 130, distance: 0 }],
      edges: [],
    };
    const projection = buildProjection({ scope: hunkScope, graph: hunkGraph, profile: small, rules: [], kind: "full" });
    const fallback = projection.code.find((item) => item.reason === "changed hunk fallback with surrounding context");
    expect(fallback?.content).toContain("Contribution activity");
    expect(fallback?.content).toContain("toHaveCount");
  });

  it("uses semantic ranking and subsystem diversity instead of hash identifiers", () => {
    const workSymbol = (file: string, name: string) => ({ ...changed, file, name, qualifiedName: name });
    const workItem = (id: string, kind: ReviewWorkItem["kind"], file: string, name: string): ReviewWorkItem => ({
      id,
      kind,
      priority: kind === "interaction" ? 300 : 200,
      primarySymbols: [workSymbol(file, name)],
      relatedSymbols: [],
      code: [],
      graphEdges: [],
      rules: [],
      estimatedTokens: 100,
      rankFactors: {
        edgeRisk: kind === "interaction" ? 80 : 0,
        changedEndpoints: 1,
        productionSurface: 1,
        changedLines: 1,
        graphDegree: 1,
      },
    });
    const local = workItem("local:ffff", "local", "src/core/local.ts", "local");
    const coreA = workItem("interaction:ffff", "interaction", "src/core/a.ts", "a");
    const coreB = workItem("interaction:0000", "interaction", "src/core/b.ts", "b");
    const pack = workItem("interaction:zzzz", "interaction", "src/packs/c.ts", "c");
    const selected = selectWorkItems([coreB, pack, local, coreA], 3, 1000).selected;
    expect(selected.map((item) => item.primarySymbols[0].file)).toEqual([
      "src/core/a.ts",
      "src/core/local.ts",
      "src/packs/c.ts",
    ]);
    expect(selected.every((item) => item.selectionReason)).toBe(true);
  });

  it("enforces both hard work-item and projected-token budgets while reserving an interaction", () => {
    const item = (id: string, kind: ReviewWorkItem["kind"], priority: number, tokens: number): ReviewWorkItem => ({
      id,
      kind,
      priority,
      primarySymbols: [changed],
      relatedSymbols: kind === "interaction" ? [consumer] : [],
      code: [], graphEdges: kind === "interaction" ? [edge] : [], rules: [], estimatedTokens: tokens,
      rankFactors: { edgeRisk: kind === "interaction" ? 100 : 0, changedEndpoints: 1, productionSurface: 1, changedLines: 1, graphDegree: 1 },
    });
    const interaction = item("interaction:contract", "interaction", 80, 40);
    const local = item("local:primary", "local", 200, 40);
    const extra = item("local:extra", "local", 190, 40);
    const selected = selectWorkItems([extra, interaction, local], 2, 80);
    expect(selected.selected).toHaveLength(2);
    expect(new Set(selected.selected.map((entry) => entry.kind))).toEqual(new Set(["local", "interaction"]));
    expect(selected.estimatedTokens).toBeLessThanOrEqual(80);
    expect(selected.omitted).toHaveLength(1);
    const tokenLimited = selectWorkItems([local, interaction], 10, 40);
    expect(tokenLimited.selected).toHaveLength(1);
    expect(tokenLimited.estimatedTokens).toBeLessThanOrEqual(40);
  });
});
