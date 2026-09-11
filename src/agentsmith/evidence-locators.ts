import type { EvidenceRequestKind } from "../core/types.js";
import { buildEvidenceLocatorTable, type EvidenceLocator, type EvidenceLocatorDraft } from "../core/evidence-locators.js";
import type { ReviewWorkItem } from "./engine-types.js";

export type TaskEvidenceLocator = EvidenceLocator;
export interface TaskEvidenceSelector {
  key: string;
  label: string;
  locator: TaskEvidenceLocator;
}

export function canonicalEvidenceLocatorTable(table: ReturnType<typeof buildEvidenceLocatorTable>) {
  const { version, taskId, snapshotId, scopePaths, locators } = table;
  return { version, taskId, snapshotId, scopePaths, locators };
}
const relationKinds = ["callers", "callees", "usage"] as const;

function simpleLiteral(value: string | null | undefined): boolean {
  return Boolean(value && /^[A-Za-z_$][\w$.-]*$/.test(value));
}

function edgePath(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(":");
  return separator > 0 ? value.slice(0, separator) : undefined;
}

export function buildTaskEvidenceLocatorTable(opts: { snapshotId: string; workItem: ReviewWorkItem }) {
  const { snapshotId, workItem } = opts;
  const scopePaths = [...new Set([
    ...workItem.code.map((entry) => entry.file),
    ...workItem.primarySymbols.map((symbol) => symbol.file),
    ...workItem.relatedSymbols.map((symbol) => symbol.file),
    ...workItem.graphEdges.flatMap((edge) => [edgePath(edge.source), edgePath(edge.target)]),
  ].filter((value): value is string => Boolean(value)))].sort();
  const drafts: EvidenceLocatorDraft[] = [];
  for (const symbol of [...workItem.primarySymbols, ...workItem.relatedSymbols]) {
    drafts.push({ mode: "symbol", canonicalValue: symbol.qualifiedName, pathBound: symbol.file, allowedEvidenceKinds: ["definition", "implementation", "type"] });
    for (const relationshipKind of relationKinds) {
      drafts.push({ mode: "relationship", canonicalValue: symbol.qualifiedName, sourceSymbol: symbol.qualifiedName, relationshipKind, pathBound: symbol.file, allowedEvidenceKinds: [relationshipKind] });
    }
  }
  for (const edge of workItem.graphEdges) {
    if (simpleLiteral(edge.targetText)) {
      drafts.push({ mode: "literal", canonicalValue: edge.targetText, pathBound: edge.source.split(":")[0], allowedEvidenceKinds: ["usage", "search"] });
    }
  }
  const uniqueDrafts = [...new Map(drafts.map((draft) => [JSON.stringify(draft), draft])).values()];
  const table = buildEvidenceLocatorTable({ taskId: workItem.id, snapshotId, scopePaths, locators: uniqueDrafts });
  const primarySymbols = workItem.primarySymbols.map((symbol) => `${symbol.file}\0${symbol.qualifiedName}`);
  const relatedSymbols = workItem.relatedSymbols.map((symbol) => `${symbol.file}\0${symbol.qualifiedName}`);
  const symbolOrdinal = new Map<string, string>();
  for (const [index, identity] of primarySymbols.entries()) symbolOrdinal.set(identity, `primary-${index + 1}`);
  for (const [index, identity] of relatedSymbols.entries())
    if (!symbolOrdinal.has(identity)) symbolOrdinal.set(identity, `related-${index + 1}`);
  const literalOrdinal = new Map<string, string>();
  let literalIndex = 0;
  const selectors: TaskEvidenceSelector[] = [];
  for (const locator of table.locators) {
    let subject: string;
    if (locator.mode === "symbol" || locator.mode === "relationship") {
      subject = symbolOrdinal.get(`${locator.pathBound ?? ""}\0${locator.canonicalValue}`) ?? `symbol-${selectors.length + 1}`;
    } else if (locator.mode === "literal") {
      subject = literalOrdinal.get(locator.canonicalValue) ?? `literal-${++literalIndex}`;
      literalOrdinal.set(locator.canonicalValue, subject);
    } else {
      subject = `path-${selectors.length + 1}`;
    }
    for (const kind of locator.allowedEvidenceKinds) {
      const key = `${subject}.${kind}`;
      if (selectors.some((selector) => selector.key === key)) continue;
      const description = locator.mode === "relationship"
        ? `${kind} of ${locator.canonicalValue}`
        : `${kind} for ${locator.canonicalValue}`;
      selectors.push({ key, label: `${description}${locator.pathBound ? ` (${locator.pathBound})` : ""}`, locator });
    }
  }
  selectors.sort((left, right) => left.key.localeCompare(right.key));
  return { ...table, selectors };
}

export function buildTaskEvidenceLocators(opts: { snapshotId: string; workItem: ReviewWorkItem }): TaskEvidenceLocator[] {
  return buildTaskEvidenceLocatorTable(opts).locators;
}

export function buildTaskEvidenceSelectors(opts: { snapshotId: string; workItem: ReviewWorkItem }): TaskEvidenceSelector[] {
  return buildTaskEvidenceLocatorTable(opts).selectors;
}

export function selectorPromptText(selectors: readonly TaskEvidenceSelector[]): string {
  if (!selectors.length) return "Available evidence selectors: (none; do not request evidence).";
  return [
    "Available evidence selectors (return the exact key in the selector field; never invent a selector, symbol, path, or expression):",
    ...selectors.map((selector) => `- ${selector.key}: ${selector.label}`),
  ].join("\n");
}

export function selectorToEvidenceRequest(selector: TaskEvidenceSelector, reason: string) {
  const kind = selector.key.slice(selector.key.lastIndexOf(".") + 1) as EvidenceRequestKind;
  return locatorToEvidenceRequest(selector.locator, kind, reason);
}

export function locatorToEvidenceRequest(locator: TaskEvidenceLocator, evidenceKind: EvidenceRequestKind, reason: string) {
  return {
    kind: evidenceKind,
    locatorId: locator.id,
    taskId: locator.taskId,
    snapshotId: locator.snapshotId,
    locatorMode: locator.mode === "literal" ? "literal" as const : "symbol" as const,
    ...(locator.mode === "literal" ? { query: locator.canonicalValue } : { symbol: locator.canonicalValue }),
    ...(locator.pathBound ? { pathHint: locator.pathBound } : {}),
    reason,
  };
}
