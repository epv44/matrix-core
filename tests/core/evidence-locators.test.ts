import { describe, expect, it } from "vitest";
import {
  buildEvidenceLocatorTable,
  buildEvidenceSelectorTable,
  compileEvidenceSelectorRequest,
  deterministicEvidenceSelectorKey,
  reviewLensValues,
  validateCandidateReviewOutput,
  validateEvidenceLocatorRequest,
  validateEvidenceLocatorTable,
  validateEvidenceSelectorRequest,
  validateEvidenceSelectorTable,
  type EvidenceLocatorDraft,
} from "../../src/core/review-contracts.js";

const taskId = "task-phase-3";
const snapshotId = "snapshot-phase-3";
const scopePaths = ["src/consumer.ts", "src/config.ts", "src/producer.ts"];

const locatorDrafts: EvidenceLocatorDraft[] = [
  {
    mode: "symbol",
    canonicalValue: "produce",
    allowedEvidenceKinds: ["implementation", "definition"],
    pathBound: "src/producer.ts",
  },
  {
    mode: "relationship",
    canonicalValue: "produce",
    sourceSymbol: "produce",
    relationshipKind: "callers",
    allowedEvidenceKinds: ["callers"],
    pathBound: "src/producer.ts",
  },
  {
    mode: "literal",
    canonicalValue: 'mode = "safe"',
    allowedEvidenceKinds: ["search", "config"],
    pathBound: "src/config.ts",
  },
  {
    mode: "path",
    canonicalValue: "src/consumer.ts",
    allowedEvidenceKinds: ["implementation"],
    pathBound: "src/consumer.ts",
  },
];

function table() {
  return buildEvidenceLocatorTable({ taskId, snapshotId, scopePaths, locators: locatorDrafts });
}

describe("Phase 3 task-scoped evidence locator table", () => {
  it("builds byte-stable IDs and canonical table order independent of input order", () => {
    const first = table();
    const second = buildEvidenceLocatorTable({
      taskId,
      snapshotId,
      scopePaths: [...scopePaths].reverse(),
      locators: [...locatorDrafts].reverse().map((locator) => ({
        ...locator,
        allowedEvidenceKinds: [...locator.allowedEvidenceKinds].reverse(),
      })) as EvidenceLocatorDraft[],
    });

    expect(second).toEqual(first);
    expect(first.scopePaths).toEqual([...scopePaths].sort());
    expect(first.locators.map((locator) => locator.id)).toEqual(first.locators.map((locator) => locator.id).sort());
    expect(first.locators.every((locator) => locator.id.startsWith("locator-"))).toBe(true);
  });

  it("derives readable deterministic selectors without changing internal SHA identities", () => {
    const current = table();
    const locatorIds = current.locators.map((locator) => locator.id);
    const selectors = buildEvidenceSelectorTable(current, { taskId, snapshotId });

    expect(selectors.selectors.map((selector) => selector.key)).toEqual([
      "callers.relationship:produce@src/producer.ts",
      "config.literal:mode%20%3D%20%22safe%22@src/config.ts",
      "definition.symbol:produce@src/producer.ts",
      "implementation.path:src/consumer.ts@src/consumer.ts",
      "implementation.symbol:produce@src/producer.ts",
      "search.literal:mode%20%3D%20%22safe%22@src/config.ts",
    ]);
    expect(buildEvidenceSelectorTable(current)).toEqual(selectors);
    expect(current.locators.map((locator) => locator.id)).toEqual(locatorIds);
    expect(current.locators.every((locator) => !("selectorKey" in locator))).toBe(true);
  });

  it("compiles a validated semantic selector to its internal locator request", () => {
    const current = table();
    const selectorKey = "definition.symbol:produce@src/producer.ts";
    const selector = validateEvidenceSelectorRequest({ selectorKey }, current, { taskId, snapshotId });

    expect(compileEvidenceSelectorRequest({ selectorKey }, current, { taskId, snapshotId })).toEqual({
      locatorId: selector.locatorId,
      evidenceKind: "definition",
    });
    expect(current.locators.find((locator) => locator.id === selector.locatorId)).toMatchObject({
      mode: "symbol",
      canonicalValue: "produce",
    });
    expect(() =>
      compileEvidenceSelectorRequest({ selectorKey: "definition.symbol:missing@task-scope" }, current),
    ).toThrow(/unknown evidence selector key/);
    expect(() => compileEvidenceSelectorRequest({ locatorId: selector.locatorId }, current)).toThrow();
  });

  it("validates selector tables against the frozen locator table and snapshot", () => {
    const current = table();
    const selectors = buildEvidenceSelectorTable(current);
    const tampered = {
      ...selectors,
      selectors: selectors.selectors.map((selector, index) =>
        index === 0 ? { ...selector, locatorId: current.locators.at(-1)!.id } : selector,
      ),
    };

    expect(validateEvidenceSelectorTable(selectors, current, { taskId, snapshotId })).toEqual(selectors);
    expect(() => validateEvidenceSelectorTable(tampered, current)).toThrow(/does not match/);
    expect(() => validateEvidenceSelectorTable(selectors, current, { snapshotId: "snapshot-stale" })).toThrow(/stale/);
  });

  it("rejects ambiguous semantic selectors and disallowed selector kinds", () => {
    const ambiguous = buildEvidenceLocatorTable({
      taskId,
      snapshotId,
      scopePaths,
      locators: [
        {
          mode: "symbol",
          canonicalValue: "produce",
          allowedEvidenceKinds: ["definition"],
          pathBound: "src/producer.ts",
        },
        {
          mode: "symbol",
          canonicalValue: "produce",
          allowedEvidenceKinds: ["definition", "implementation"],
          pathBound: "src/producer.ts",
        },
      ],
    });
    const symbol = table().locators.find((locator) => locator.mode === "symbol")!;

    expect(() => buildEvidenceSelectorTable(ambiguous)).toThrow(/ambiguous evidence selector key/);
    expect(() => deterministicEvidenceSelectorKey(symbol, "callers")).toThrow(/not allowed/);
  });

  it("binds every locator identity to the task and frozen snapshot", () => {
    const current = table();
    const otherTask = buildEvidenceLocatorTable({
      taskId: "task-other",
      snapshotId,
      scopePaths,
      locators: locatorDrafts,
    });
    const otherSnapshot = buildEvidenceLocatorTable({
      taskId,
      snapshotId: "snapshot-other",
      scopePaths,
      locators: locatorDrafts,
    });

    expect(otherTask.locators.map((locator) => locator.id)).not.toEqual(current.locators.map((locator) => locator.id));
    expect(otherSnapshot.locators.map((locator) => locator.id)).not.toEqual(
      current.locators.map((locator) => locator.id),
    );
    expect(() => validateEvidenceLocatorTable(current, { taskId: "task-other" })).toThrow(/different review task/);
    expect(() => validateEvidenceLocatorTable(current, { snapshotId: "snapshot-other" })).toThrow(/stale/);
  });

  it("accepts only known IDs with evidence kinds allowed by that locator", () => {
    const current = table();
    const symbol = current.locators.find((locator) => locator.mode === "symbol");
    expect(symbol).toBeDefined();

    expect(
      validateEvidenceLocatorRequest({ locatorId: symbol!.id, evidenceKind: "definition" }, current, {
        taskId,
        snapshotId,
      }),
    ).toEqual(symbol);
    expect(() =>
      validateEvidenceLocatorRequest({ locatorId: "locator-unknown", evidenceKind: "definition" }, current),
    ).toThrow(/unknown evidence locator ID/);
    expect(() => validateEvidenceLocatorRequest({ locatorId: symbol!.id, evidenceKind: "callers" }, current)).toThrow(
      /not allowed/,
    );
  });

  it("rejects duplicate, tampered, and noncanonical locator entries", () => {
    const current = table();
    const duplicate = { ...current, locators: [...current.locators, current.locators[0]] };
    const tampered = {
      ...current,
      locators: current.locators.map((locator, index) =>
        index === 0 ? { ...locator, canonicalValue: `${locator.canonicalValue}Changed` } : locator,
      ),
    };

    expect(() => validateEvidenceLocatorTable(duplicate)).toThrow(/duplicate evidence locator ID/);
    expect(() => validateEvidenceLocatorTable(tampered)).toThrow(/noncanonical ID/);
    expect(() =>
      buildEvidenceLocatorTable({
        taskId,
        snapshotId,
        scopePaths,
        locators: [locatorDrafts[0], locatorDrafts[0]],
      }),
    ).toThrow(/duplicate evidence locator ID/);
  });

  it("rejects paths outside the exhaustive frozen task scope", () => {
    expect(() =>
      buildEvidenceLocatorTable({
        taskId,
        snapshotId,
        scopePaths,
        locators: [
          {
            mode: "symbol",
            canonicalValue: "secret",
            allowedEvidenceKinds: ["definition"],
            pathBound: "src/secret.ts",
          },
        ],
      }),
    ).toThrow(/outside the frozen task scope/);
    expect(() =>
      buildEvidenceLocatorTable({
        taskId,
        snapshotId,
        scopePaths,
        locators: [
          {
            mode: "path",
            canonicalValue: "../secret.ts",
            allowedEvidenceKinds: ["definition"],
          },
        ],
      }),
    ).toThrow(/must not escape/);
  });

  it("keeps literal lookup explicit and never reinterprets an expression as a symbol", () => {
    const expression = 'host === "cline" ? cancel : continue';
    expect(() =>
      buildEvidenceLocatorTable({
        taskId,
        snapshotId,
        scopePaths,
        locators: [
          {
            mode: "symbol",
            canonicalValue: expression,
            allowedEvidenceKinds: ["type"],
            pathBound: "src/consumer.ts",
          },
        ],
      }),
    ).toThrow(/canonical graph symbol/);

    const literal = buildEvidenceLocatorTable({
      taskId,
      snapshotId,
      scopePaths,
      locators: [
        {
          mode: "literal",
          canonicalValue: expression,
          allowedEvidenceKinds: ["search"],
          pathBound: "src/consumer.ts",
        },
      ],
    });
    expect(literal.locators[0]).toMatchObject({ mode: "literal", canonicalValue: expression });
  });

  it("requires relationship locators to name one canonical source and matching relationship kind", () => {
    expect(() =>
      buildEvidenceLocatorTable({
        taskId,
        snapshotId,
        scopePaths,
        locators: [
          {
            mode: "relationship",
            canonicalValue: "produce",
            sourceSymbol: "consume",
            relationshipKind: "callers",
            allowedEvidenceKinds: ["callers"],
            pathBound: "src/producer.ts",
          },
        ],
      }),
    ).toThrow(/canonical source symbol/);
    expect(() =>
      buildEvidenceLocatorTable({
        taskId,
        snapshotId,
        scopePaths,
        locators: [
          {
            mode: "relationship",
            canonicalValue: "produce",
            sourceSymbol: "produce",
            relationshipKind: "callers",
            allowedEvidenceKinds: ["usage"],
            pathBound: "src/producer.ts",
          },
        ],
      }),
    ).toThrow(/declared relationship kind/);
  });

  it("validates candidate evidence needs against the frozen locator table", () => {
    const current = table();
    const symbol = current.locators.find((locator) => locator.mode === "symbol")!;
    const output = {
      status: "insufficient_context",
      findings: [],
      evidenceNeeds: [{ locatorId: symbol.id, kind: "definition", reason: "inspect the producer" }],
      contextRequests: [{ file: "src/producer.ts", symbol: "produce", reason: "inspect the producer" }],
    };

    expect(
      validateCandidateReviewOutput(output, {
        evidenceLocatorTable: current,
        expectedTaskId: taskId,
        expectedSnapshotId: snapshotId,
        existingFiles: scopePaths,
      }).status,
    ).toBe("insufficient_context");
    expect(() =>
      validateCandidateReviewOutput(
        { ...output, evidenceNeeds: [{ ...output.evidenceNeeds[0], locatorId: "locator-unknown" }] },
        { evidenceLocatorTable: current },
      ),
    ).toThrow(/unknown evidence locator ID/);
  });

  it("leaves the correctness lens and strong-route specialist lens vocabulary unchanged", () => {
    expect(reviewLensValues).toEqual(["correctness", "security", "performance", "contract"]);
  });
});
