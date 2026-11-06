import { describe, expect, it } from "vitest";
import { shouldAggregateInsufficientContext } from "../../src/agentsmith/engine.js";
import type { CandidateBatch, ReviewWorkItem } from "../../src/agentsmith/engine-types.js";

function symbol(file: string, qualifiedName: string) {
  return {
    file,
    qualifiedName,
    name: qualifiedName.split(".").at(-1) ?? qualifiedName,
    kind: "function" as const,
    startLine: 1,
    endLine: 10,
    language: "typescript",
  };
}

function workItem(
  id: string,
  kind: ReviewWorkItem["kind"],
  primary: ReturnType<typeof symbol>[],
): ReviewWorkItem {
  return {
    id,
    kind,
    primarySymbols: primary,
    relatedSymbols: [],
    code: [],
    graphEdges: [],
    rules: [],
    estimatedTokens: 100,
  };
}

function batch(
  sourceId: string,
  candidateState: CandidateBatch["candidateState"],
  extras: Partial<CandidateBatch> = {},
): CandidateBatch {
  return {
    sourceId,
    candidateState,
    candidates: candidateState === "finding" ? [{ id: `${sourceId}:c1` } as CandidateBatch["candidates"][number]] : [],
    inputTokens: 0,
    outputTokens: 0,
    ...extras,
  };
}

describe("insufficient-context partial aggregation", () => {
  const shared = symbol("src/units.ts", "produce");

  it("skips local insufficient_context when a paired interaction completed", () => {
    const selectedWorkItems = [
      workItem("local:produce", "local", [shared]),
      workItem("interaction:produce->consume", "interaction", [shared]),
    ];
    const candidateBatches = [
      batch("local:produce", "insufficient_context"),
      batch("interaction:produce->consume", "finding"),
    ];
    expect(
      shouldAggregateInsufficientContext({
        sourceId: "local:produce",
        selectedWorkItems,
        candidateBatches,
      }),
    ).toBe(false);
  });

  it("still aggregates local insufficient_context without a completed interaction sibling", () => {
    const selectedWorkItems = [
      workItem("local:produce", "local", [shared]),
      workItem("interaction:produce->consume", "interaction", [shared]),
    ];
    const candidateBatches = [
      batch("local:produce", "insufficient_context"),
      batch("interaction:produce->consume", "insufficient_context"),
    ];
    expect(
      shouldAggregateInsufficientContext({
        sourceId: "local:produce",
        selectedWorkItems,
        candidateBatches,
      }),
    ).toBe(true);
  });

  it("always aggregates interaction insufficient_context", () => {
    const selectedWorkItems = [
      workItem("local:produce", "local", [shared]),
      workItem("interaction:produce->consume", "interaction", [shared]),
    ];
    const candidateBatches = [
      batch("local:produce", "finding"),
      batch("interaction:produce->consume", "insufficient_context"),
    ];
    expect(
      shouldAggregateInsufficientContext({
        sourceId: "interaction:produce->consume",
        selectedWorkItems,
        candidateBatches,
      }),
    ).toBe(true);
  });
});
