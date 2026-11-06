import { describe, expect, it } from "vitest";
import { partitionCandidateDispatch } from "../../src/agentsmith/engine.js";
import type { ReviewWorkItem } from "../../src/agentsmith/engine-types.js";
import type { GraphContextEdge, GraphSymbol } from "../../src/core/graph/types.js";

function symbol(file: string, qualifiedName: string): GraphSymbol {
  return {
    file,
    qualifiedName,
    name: qualifiedName.split(".").at(-1) ?? qualifiedName,
    kind: "function",
    startLine: 1,
    endLine: 10,
    language: "typescript",
    provider: "test",
  };
}

function edge(kind: GraphContextEdge["kind"], source: string, target: string): GraphContextEdge {
  return { kind, source, target, targetText: target, confidence: "exact", provider: "test" };
}

function item(overrides: Partial<ReviewWorkItem> & Pick<ReviewWorkItem, "id" | "kind" | "selectionReason">): ReviewWorkItem {
  return {
    primarySymbols: [],
    relatedSymbols: [],
    code: [],
    graphEdges: [],
    rules: [],
    estimatedTokens: 10,
    ...overrides,
  };
}

describe("partitionCandidateDispatch", () => {
  it("keeps a required local and interaction pair and skips contained ranked-fill fragments", () => {
    const interaction = item({
      id: "interaction:guard",
      kind: "interaction",
      selectionReason: "required-interaction",
      primarySymbols: [symbol("src/routes.ts", "deleteUser")],
      promptVisibleRanges: [{ file: "src/routes.ts", start: 3, end: 7 }, { file: "src/auth.ts", start: 1, end: 4 }],
      changedRegions: [{ file: "src/routes.ts", start: 3, end: 6 }],
      graphEdges: [edge("reads-type", "src/routes.ts:deleteUser", "src/auth.ts:Session")],
    });
    const local = item({
      id: "local:guard",
      kind: "local",
      selectionReason: "required-local",
      primarySymbols: [symbol("src/routes.ts", "deleteUser")],
      promptVisibleRanges: [{ file: "src/routes.ts", start: 3, end: 7 }],
      changedRegions: [{ file: "src/routes.ts", start: 3, end: 7 }],
      graphEdges: [edge("reads-type", "src/routes.ts:deleteUser", "src/auth.ts:Session")],
    });
    const role = item({
      id: "local:role",
      kind: "local",
      selectionReason: "ranked-fill; rank=3",
      primarySymbols: [symbol("src/routes.ts", "role")],
      promptVisibleRanges: [{ file: "src/routes.ts", start: 4, end: 4 }],
      changedRegions: [{ file: "src/routes.ts", start: 4, end: 4 }],
    });
    const empty = item({
      id: "local:empty",
      kind: "local",
      selectionReason: "ranked-fill; rank=4",
      promptVisibleRanges: [{ file: "src/routes.ts", start: 1, end: 8 }],
    });
    const plan = partitionCandidateDispatch([interaction, local, role, empty]);
    expect(plan.dispatch.map((entry) => entry.id)).toEqual(["interaction:guard", "local:guard"]);
    expect(plan.skipped.map((entry) => entry.id)).toEqual(["local:role", "local:empty"]);
  });

  it("keeps a ranked-fill interaction that shows a caller the kept items do not", () => {
    const interaction = item({
      id: "interaction:profile",
      kind: "interaction",
      selectionReason: "required-interaction",
      primarySymbols: [symbol("src/profile.ts", "loadProfile")],
      promptVisibleRanges: [{ file: "src/profile.ts", start: 2, end: 7 }],
      changedRegions: [{ file: "src/profile.ts", start: 5, end: 7 }],
      graphEdges: [edge("reads-type", "src/profile.ts:loadProfile", "src/profile.ts:Profile")],
    });
    const local = item({
      id: "local:profile",
      kind: "local",
      selectionReason: "required-local",
      primarySymbols: [symbol("src/profile.ts", "loadProfile")],
      promptVisibleRanges: [{ file: "src/profile.ts", start: 5, end: 7 }],
      changedRegions: [{ file: "src/profile.ts", start: 5, end: 7 }],
      graphEdges: [edge("calls", "src/display.ts:displayName", "src/profile.ts:loadProfile")],
    });
    const caller = item({
      id: "interaction:display",
      kind: "interaction",
      selectionReason: "ranked-fill; rank=4",
      primarySymbols: [symbol("src/profile.ts", "loadProfile")],
      promptVisibleRanges: [
        { file: "src/profile.ts", start: 5, end: 7 },
        { file: "src/display.ts", start: 3, end: 7 },
      ],
      changedRegions: [{ file: "src/profile.ts", start: 5, end: 7 }],
      graphEdges: [edge("calls", "src/display.ts:displayName", "src/profile.ts:loadProfile")],
    });
    const plan = partitionCandidateDispatch([interaction, local, caller]);
    expect(plan.dispatch.map((entry) => entry.id)).toEqual(["interaction:profile", "local:profile", "interaction:display"]);
    expect(plan.skipped).toEqual([]);
  });

  it("does not skip the only ranked-fill item", () => {
    const only = item({
      id: "local:only",
      kind: "local",
      selectionReason: "ranked-fill; rank=1",
      primarySymbols: [symbol("src/pagination.py", "page_slice")],
      promptVisibleRanges: [{ file: "src/pagination.py", start: 1, end: 4 }],
      changedRegions: [{ file: "src/pagination.py", start: 3, end: 4 }],
    });
    const plan = partitionCandidateDispatch([only]);
    expect(plan.dispatch.map((entry) => entry.id)).toEqual(["local:only"]);
    expect(plan.skipped).toEqual([]);
  });

  it("keeps a ranked-fill item that introduces a new edge or an uncovered changed line", () => {
    const kept = item({
      id: "local:card",
      kind: "local",
      selectionReason: "required-local",
      promptVisibleRanges: [{ file: "view.tsx", start: 900, end: 980 }],
      changedRegions: [{ file: "view.tsx", start: 928, end: 928 }],
      graphEdges: [edge("calls", "view.tsx:HoldingsCard", "view.tsx:min")],
    });
    const newEdge = item({
      id: "interaction:instrument",
      kind: "interaction",
      selectionReason: "ranked-fill; rank=3",
      promptVisibleRanges: [{ file: "view.tsx", start: 944, end: 948 }],
      changedRegions: [{ file: "view.tsx", start: 944, end: 948 }],
      graphEdges: [edge("calls", "view.tsx:instrument", "view.tsx:assetLabel")],
    });
    const uncovered = item({
      id: "local:other",
      kind: "local",
      selectionReason: "ranked-fill; rank=4",
      promptVisibleRanges: [{ file: "view.tsx", start: 10, end: 12 }],
      changedRegions: [{ file: "view.tsx", start: 10, end: 12 }],
    });
    const plan = partitionCandidateDispatch([kept, newEdge, uncovered]);
    expect(plan.dispatch.map((entry) => entry.id)).toEqual(["local:card", "interaction:instrument", "local:other"]);
  });
});
