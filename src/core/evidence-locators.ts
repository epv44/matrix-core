import { z } from "zod";
import { sha256 } from "./hash.js";

export const EVIDENCE_LOCATOR_TABLE_VERSION = "evidence-locator-table/v1" as const;
export const EVIDENCE_SELECTOR_TABLE_VERSION = "evidence-selector-table/v1" as const;
export const evidenceLocatorModeValues = ["symbol", "literal", "relationship", "path"] as const;
export const evidenceKindValues = [
  "definition",
  "callers",
  "callees",
  "type",
  "implementation",
  "usage",
  "config",
  "test",
  "schema",
  "search",
] as const;
export const evidenceRelationshipKindValues = ["callers", "callees", "usage"] as const;

export type EvidenceLocatorMode = (typeof evidenceLocatorModeValues)[number];
export type EvidenceKind = (typeof evidenceKindValues)[number];
export type EvidenceRelationshipKind = (typeof evidenceRelationshipKindValues)[number];

interface EvidenceLocatorBase {
  id: string;
  taskId: string;
  snapshotId: string;
  canonicalValue: string;
  allowedEvidenceKinds: EvidenceKind[];
  pathBound?: string;
}

export interface SymbolEvidenceLocator extends EvidenceLocatorBase {
  mode: "symbol";
}

export interface LiteralEvidenceLocator extends EvidenceLocatorBase {
  mode: "literal";
}

export interface RelationshipEvidenceLocator extends EvidenceLocatorBase {
  mode: "relationship";
  sourceSymbol: string;
  relationshipKind: EvidenceRelationshipKind;
}

export interface PathEvidenceLocator extends EvidenceLocatorBase {
  mode: "path";
}

export type EvidenceLocator =
  SymbolEvidenceLocator | LiteralEvidenceLocator | RelationshipEvidenceLocator | PathEvidenceLocator;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type EvidenceLocatorIdentity = WithoutId<EvidenceLocator>;

type LocatorIdentityFields = "id" | "taskId" | "snapshotId";
export type EvidenceLocatorDraft =
  | Omit<SymbolEvidenceLocator, LocatorIdentityFields>
  | Omit<LiteralEvidenceLocator, LocatorIdentityFields>
  | Omit<RelationshipEvidenceLocator, LocatorIdentityFields>
  | Omit<PathEvidenceLocator, LocatorIdentityFields>;

export interface EvidenceLocatorTable {
  version: typeof EVIDENCE_LOCATOR_TABLE_VERSION;
  taskId: string;
  snapshotId: string;
  scopePaths: string[];
  locators: EvidenceLocator[];
}

export interface EvidenceLocatorTableInput {
  taskId: string;
  snapshotId: string;
  scopePaths: readonly string[];
  locators: readonly EvidenceLocatorDraft[];
}

export interface EvidenceLocatorRequest {
  locatorId: string;
  evidenceKind: EvidenceKind;
}

export interface EvidenceSelectorEntry {
  key: string;
  locatorId: string;
  evidenceKind: EvidenceKind;
}

export interface EvidenceSelectorTable {
  version: typeof EVIDENCE_SELECTOR_TABLE_VERSION;
  taskId: string;
  snapshotId: string;
  selectors: EvidenceSelectorEntry[];
}

export interface EvidenceSelectorRequest {
  selectorKey: string;
}

export interface EvidenceLocatorExpectation {
  taskId?: string;
  snapshotId?: string;
}

const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const workspacePathSchema = boundedText(1_000)
  .refine((value) => value === value.trim(), "path must not contain surrounding whitespace")
  .refine(
    (value) => !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(value),
    "path must be workspace-relative",
  )
  .refine((value) => !value.split(/[\\/]/).includes(".."), "path must not escape the workspace")
  .refine((value) => !value.includes("\\"), "path must use workspace-relative POSIX separators")
  .refine((value) => !value.split("/").includes("."), "path must be normalized")
  .refine((value) => !value.includes("//") && !value.endsWith("/"), "path must be normalized");
const canonicalSymbolSchema = boundedText(500)
  .regex(
    /^(?:(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+:)?[A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$]*)*$/u,
    "symbol must be a canonical graph symbol, not an expression",
  )
  .refine((value) => value === value.trim(), "symbol must not contain surrounding whitespace");
const literalSchema = boundedText(1_000).refine(
  (value) => value === value.trim(),
  "literal must not contain surrounding whitespace",
);
const evidenceKindsSchema = z.array(z.enum(evidenceKindValues)).min(1).max(evidenceKindValues.length);

const locatorBaseShape = {
  id: boundedText(200),
  taskId: boundedText(200),
  snapshotId: boundedText(300),
  allowedEvidenceKinds: evidenceKindsSchema,
  pathBound: workspacePathSchema.optional(),
};

export const taskScopedEvidenceLocatorSchema = z.discriminatedUnion("mode", [
  z.object({ ...locatorBaseShape, mode: z.literal("symbol"), canonicalValue: canonicalSymbolSchema }).strict(),
  z.object({ ...locatorBaseShape, mode: z.literal("literal"), canonicalValue: literalSchema }).strict(),
  z
    .object({
      ...locatorBaseShape,
      mode: z.literal("relationship"),
      canonicalValue: canonicalSymbolSchema,
      sourceSymbol: canonicalSymbolSchema,
      relationshipKind: z.enum(evidenceRelationshipKindValues),
    })
    .strict(),
  z.object({ ...locatorBaseShape, mode: z.literal("path"), canonicalValue: workspacePathSchema }).strict(),
]);

const evidenceLocatorDraftSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("symbol"),
      canonicalValue: canonicalSymbolSchema,
      allowedEvidenceKinds: evidenceKindsSchema,
      pathBound: workspacePathSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("literal"),
      canonicalValue: literalSchema,
      allowedEvidenceKinds: evidenceKindsSchema,
      pathBound: workspacePathSchema.optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("relationship"),
      canonicalValue: canonicalSymbolSchema,
      allowedEvidenceKinds: evidenceKindsSchema,
      pathBound: workspacePathSchema.optional(),
      sourceSymbol: canonicalSymbolSchema,
      relationshipKind: z.enum(evidenceRelationshipKindValues),
    })
    .strict(),
  z
    .object({
      mode: z.literal("path"),
      canonicalValue: workspacePathSchema,
      allowedEvidenceKinds: evidenceKindsSchema,
      pathBound: workspacePathSchema.optional(),
    })
    .strict(),
]);

export const evidenceLocatorTableSchema = z
  .object({
    version: z.literal(EVIDENCE_LOCATOR_TABLE_VERSION),
    taskId: boundedText(200),
    snapshotId: boundedText(300),
    scopePaths: z.array(workspacePathSchema).max(10_000),
    locators: z.array(taskScopedEvidenceLocatorSchema).max(1_000),
  })
  .strict();

const evidenceLocatorRequestSchema = z
  .object({ locatorId: boundedText(200), evidenceKind: z.enum(evidenceKindValues) })
  .strict();
const evidenceSelectorEntrySchema = z
  .object({ key: boundedText(2_500), locatorId: boundedText(200), evidenceKind: z.enum(evidenceKindValues) })
  .strict();
export const evidenceSelectorTableSchema = z
  .object({
    version: z.literal(EVIDENCE_SELECTOR_TABLE_VERSION),
    taskId: boundedText(200),
    snapshotId: boundedText(300),
    selectors: z.array(evidenceSelectorEntrySchema).max(10_000),
  })
  .strict();
export const evidenceSelectorRequestSchema = z.object({ selectorKey: boundedText(2_500) }).strict();

const modeEvidenceKinds: Readonly<Record<EvidenceLocatorMode, ReadonlySet<EvidenceKind>>> = {
  symbol: new Set(["definition", "type", "implementation"]),
  literal: new Set(["implementation", "usage", "config", "test", "schema", "search"]),
  relationship: new Set(evidenceRelationshipKindValues),
  path: new Set(["definition", "type", "implementation", "config", "test", "schema", "search"]),
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

function serialize(value: unknown): string {
  return JSON.stringify(stable(value));
}

function canonicalEvidenceKinds(kinds: readonly EvidenceKind[]): EvidenceKind[] {
  if (new Set(kinds).size !== kinds.length)
    throw new Error("evidence locator contains duplicate allowed evidence kinds");
  return [...kinds].sort((left, right) => evidenceKindValues.indexOf(left) - evidenceKindValues.indexOf(right));
}

function locatorWithoutId(locator: EvidenceLocator): EvidenceLocatorIdentity {
  const { id: _id, ...identity } = locator;
  return identity;
}

function canonicalSymbolPath(value: string): string | undefined {
  const separator = value.indexOf(":");
  return separator >= 0 && value[separator + 1] !== ":" ? value.slice(0, separator) : undefined;
}

function readableSelectorComponent(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "/").replaceAll("%3A", ":");
}

function assertModeContract(locator: EvidenceLocatorIdentity): void {
  for (const kind of locator.allowedEvidenceKinds) {
    if (!modeEvidenceKinds[locator.mode].has(kind)) {
      throw new Error(`evidence kind ${kind} is incompatible with ${locator.mode} locator mode`);
    }
  }
  if (locator.mode === "relationship") {
    if (locator.canonicalValue !== locator.sourceSymbol) {
      throw new Error("relationship canonical value must equal its canonical source symbol");
    }
    if (locator.allowedEvidenceKinds.length !== 1 || locator.allowedEvidenceKinds[0] !== locator.relationshipKind) {
      throw new Error("relationship locator must allow exactly its declared relationship kind");
    }
  }
  if (locator.mode === "path" && locator.pathBound !== undefined && locator.pathBound !== locator.canonicalValue) {
    throw new Error("path locator bound must equal its canonical path");
  }
}

export function deterministicEvidenceLocatorId(locator: EvidenceLocatorIdentity): string {
  return `locator-${sha256(serialize({ version: EVIDENCE_LOCATOR_TABLE_VERSION, ...locator }), 20)}`;
}

function assertTableContract(table: EvidenceLocatorTable, expectation: EvidenceLocatorExpectation = {}): void {
  if (expectation.taskId !== undefined && table.taskId !== expectation.taskId) {
    throw new Error("evidence locator table belongs to a different review task");
  }
  if (expectation.snapshotId !== undefined && table.snapshotId !== expectation.snapshotId) {
    throw new Error("evidence locator table belongs to a stale repository snapshot");
  }
  if (new Set(table.scopePaths).size !== table.scopePaths.length) {
    throw new Error("evidence locator table contains duplicate scope paths");
  }
  const canonicalScopePaths = [...table.scopePaths].sort((left, right) => left.localeCompare(right));
  if (serialize(table.scopePaths) !== serialize(canonicalScopePaths)) {
    throw new Error("evidence locator table scope paths are not in canonical order");
  }
  const scopePaths = new Set(table.scopePaths);
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const locator of table.locators) {
    if (locator.taskId !== table.taskId) throw new Error("evidence locator belongs to a different review task");
    if (locator.snapshotId !== table.snapshotId)
      throw new Error("evidence locator belongs to a stale repository snapshot");
    if (ids.has(locator.id)) throw new Error(`duplicate evidence locator ID: ${locator.id}`);
    ids.add(locator.id);
    const identity = locatorWithoutId(locator);
    const identityKey = serialize(identity);
    if (identities.has(identityKey)) throw new Error("duplicate evidence locator entry");
    identities.add(identityKey);
    if (locator.id !== deterministicEvidenceLocatorId(identity)) {
      throw new Error(`evidence locator has a noncanonical ID: ${locator.id}`);
    }
    if (serialize(locator.allowedEvidenceKinds) !== serialize(canonicalEvidenceKinds(locator.allowedEvidenceKinds))) {
      throw new Error("evidence locator kinds are not in canonical order");
    }
    assertModeContract(identity);
    if (locator.pathBound !== undefined && !scopePaths.has(locator.pathBound)) {
      throw new Error(`evidence locator path is outside the frozen task scope: ${locator.pathBound}`);
    }
    if (locator.mode === "symbol" || locator.mode === "relationship") {
      const embeddedPath = canonicalSymbolPath(locator.canonicalValue);
      if (embeddedPath !== undefined && !scopePaths.has(embeddedPath)) {
        throw new Error(`evidence locator path is outside the frozen task scope: ${embeddedPath}`);
      }
      if (embeddedPath !== undefined && locator.pathBound !== undefined && embeddedPath !== locator.pathBound) {
        throw new Error("evidence locator canonical symbol conflicts with its path bound");
      }
    }
    if (locator.mode === "path" && !scopePaths.has(locator.canonicalValue)) {
      throw new Error(`evidence locator path is outside the frozen task scope: ${locator.canonicalValue}`);
    }
  }
  const canonicalLocatorIds = table.locators
    .map((locator) => locator.id)
    .sort((left, right) => left.localeCompare(right));
  if (serialize(table.locators.map((locator) => locator.id)) !== serialize(canonicalLocatorIds)) {
    throw new Error("evidence locator table entries are not in canonical order");
  }
}

export function validateEvidenceLocatorTable(
  value: unknown,
  expectation: EvidenceLocatorExpectation = {},
): EvidenceLocatorTable {
  const table = evidenceLocatorTableSchema.parse(value) as EvidenceLocatorTable;
  assertTableContract(table, expectation);
  return table;
}

export function buildEvidenceLocatorTable(input: EvidenceLocatorTableInput): EvidenceLocatorTable {
  const taskId = boundedText(200).parse(input.taskId);
  const snapshotId = boundedText(300).parse(input.snapshotId);
  const scopePaths = [...new Set(input.scopePaths.map((path) => workspacePathSchema.parse(path)))].sort((left, right) =>
    left.localeCompare(right),
  );
  const locators = input.locators.map((candidate): EvidenceLocator => {
    const draft = evidenceLocatorDraftSchema.parse(candidate) as EvidenceLocatorDraft;
    const identity = {
      ...draft,
      allowedEvidenceKinds: canonicalEvidenceKinds(draft.allowedEvidenceKinds),
      taskId,
      snapshotId,
    } as EvidenceLocatorIdentity;
    assertModeContract(identity);
    return { ...identity, id: deterministicEvidenceLocatorId(identity) } as EvidenceLocator;
  });
  locators.sort((left, right) => left.id.localeCompare(right.id));
  const table: EvidenceLocatorTable = {
    version: EVIDENCE_LOCATOR_TABLE_VERSION,
    taskId,
    snapshotId,
    scopePaths,
    locators,
  };
  assertTableContract(table);
  return table;
}

export function validateEvidenceLocatorRequest(
  value: unknown,
  tableValue: unknown,
  expectation: EvidenceLocatorExpectation = {},
): EvidenceLocator {
  const request = evidenceLocatorRequestSchema.parse(value) as EvidenceLocatorRequest;
  const table = validateEvidenceLocatorTable(tableValue, expectation);
  const locator = table.locators.find((entry) => entry.id === request.locatorId);
  if (!locator) throw new Error(`unknown evidence locator ID: ${request.locatorId}`);
  if (!locator.allowedEvidenceKinds.includes(request.evidenceKind)) {
    throw new Error(`evidence kind ${request.evidenceKind} is not allowed for locator ${request.locatorId}`);
  }
  return locator;
}

export function deterministicEvidenceSelectorKey(locator: EvidenceLocator, evidenceKind: EvidenceKind): string {
  if (!locator.allowedEvidenceKinds.includes(evidenceKind)) {
    throw new Error(`evidence kind ${evidenceKind} is not allowed for locator ${locator.id}`);
  }
  const target = readableSelectorComponent(locator.canonicalValue);
  const path = readableSelectorComponent(
    locator.pathBound ?? (locator.mode === "path" ? locator.canonicalValue : "task-scope"),
  );
  return `${evidenceKind}.${locator.mode}:${target}@${path}`;
}

export function buildEvidenceSelectorTable(
  locatorTableValue: unknown,
  expectation: EvidenceLocatorExpectation = {},
): EvidenceSelectorTable {
  const locatorTable = validateEvidenceLocatorTable(locatorTableValue, expectation);
  const selectors = new Map<string, EvidenceSelectorEntry>();
  for (const locator of locatorTable.locators) {
    for (const evidenceKind of locator.allowedEvidenceKinds) {
      const key = deterministicEvidenceSelectorKey(locator, evidenceKind);
      const entry = { key, locatorId: locator.id, evidenceKind } satisfies EvidenceSelectorEntry;
      const existing = selectors.get(key);
      if (existing && (existing.locatorId !== entry.locatorId || existing.evidenceKind !== entry.evidenceKind)) {
        throw new Error(`ambiguous evidence selector key: ${key}`);
      }
      selectors.set(key, entry);
    }
  }
  return {
    version: EVIDENCE_SELECTOR_TABLE_VERSION,
    taskId: locatorTable.taskId,
    snapshotId: locatorTable.snapshotId,
    selectors: [...selectors.values()].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

export function validateEvidenceSelectorTable(
  selectorTableValue: unknown,
  locatorTableValue: unknown,
  expectation: EvidenceLocatorExpectation = {},
): EvidenceSelectorTable {
  const selectorTable = evidenceSelectorTableSchema.parse(selectorTableValue) as EvidenceSelectorTable;
  const expected = buildEvidenceSelectorTable(locatorTableValue, expectation);
  if (serialize(selectorTable) !== serialize(expected)) {
    throw new Error("evidence selector table does not match its frozen locator table");
  }
  return selectorTable;
}

export function validateEvidenceSelectorRequest(
  value: unknown,
  locatorTableValue: unknown,
  expectation: EvidenceLocatorExpectation = {},
): EvidenceSelectorEntry {
  const request = evidenceSelectorRequestSchema.parse(value) as EvidenceSelectorRequest;
  const selectorTable = buildEvidenceSelectorTable(locatorTableValue, expectation);
  const selector = selectorTable.selectors.find((entry) => entry.key === request.selectorKey);
  if (!selector) throw new Error(`unknown evidence selector key: ${request.selectorKey}`);
  return selector;
}

export function compileEvidenceSelectorRequest(
  value: unknown,
  locatorTableValue: unknown,
  expectation: EvidenceLocatorExpectation = {},
): EvidenceLocatorRequest {
  const selector = validateEvidenceSelectorRequest(value, locatorTableValue, expectation);
  const request = { locatorId: selector.locatorId, evidenceKind: selector.evidenceKind };
  validateEvidenceLocatorRequest(request, locatorTableValue, expectation);
  return request;
}
