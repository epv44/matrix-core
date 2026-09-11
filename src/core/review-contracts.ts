import { z } from "zod";
import { sha256 } from "./hash.js";
import {
  evidenceKindValues,
  taskScopedEvidenceLocatorSchema,
  validateEvidenceLocatorRequest,
  validateEvidenceLocatorTable,
  type EvidenceKind,
  type EvidenceLocator as TaskScopedEvidenceLocator,
  type EvidenceLocatorTable,
} from "./evidence-locators.js";

export {
  EVIDENCE_LOCATOR_TABLE_VERSION,
  EVIDENCE_SELECTOR_TABLE_VERSION,
  buildEvidenceLocatorTable,
  buildEvidenceSelectorTable,
  compileEvidenceSelectorRequest,
  deterministicEvidenceLocatorId,
  deterministicEvidenceSelectorKey,
  evidenceKindValues,
  evidenceLocatorModeValues,
  evidenceLocatorTableSchema,
  evidenceRelationshipKindValues,
  evidenceSelectorRequestSchema,
  evidenceSelectorTableSchema,
  taskScopedEvidenceLocatorSchema,
  validateEvidenceLocatorRequest,
  validateEvidenceLocatorTable,
  validateEvidenceSelectorRequest,
  validateEvidenceSelectorTable,
} from "./evidence-locators.js";
export type {
  EvidenceKind,
  EvidenceLocatorDraft,
  EvidenceLocatorExpectation,
  EvidenceLocatorIdentity,
  EvidenceLocatorMode,
  EvidenceLocatorRequest,
  EvidenceLocatorTable,
  EvidenceLocatorTableInput,
  EvidenceRelationshipKind,
  EvidenceSelectorEntry,
  EvidenceSelectorRequest,
  EvidenceSelectorTable,
  LiteralEvidenceLocator,
  PathEvidenceLocator,
  RelationshipEvidenceLocator,
  SymbolEvidenceLocator,
  EvidenceLocator as TaskScopedEvidenceLocator,
} from "./evidence-locators.js";

export const REVIEW_CONTRACT_VERSION = "1.0" as const;
export const REVIEW_TASK_VERSION = "review-task/v1" as const;
export const CANDIDATE_RESULT_VERSION = "candidate-result/v1" as const;
export const reviewLensValues = ["correctness", "security", "performance", "contract"] as const;
export type ReviewLens = (typeof reviewLensValues)[number];
export type RiskReason = string;

export interface SourceRange {
  file: string;
  startLine: number;
  endLine: number;
}
export interface SymbolRef extends SourceRange {
  name: string;
}
export interface ContextRef extends SourceRange {
  symbol?: string;
  reason?: string;
}
export interface ReviewUnit {
  id: string;
  kind: "local" | "interaction";
  changedSymbols: SymbolRef[];
  changedRanges: SourceRange[];
  context: ContextRef[];
  riskScore: number;
  riskReasons: RiskReason[];
  estimatedTokens: number;
}
export type EvidenceLocatorKind = "caller" | "consumer" | "symbol" | "range" | "file" | "callee" | "usage" | "literal";
export interface LegacyEvidenceLocator {
  id: string;
  kind: EvidenceLocatorKind;
  file: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  value?: string;
}
export type EvidenceLocator = TaskScopedEvidenceLocator;
type AcceptedEvidenceLocator = EvidenceLocator | LegacyEvidenceLocator;
export type EvidenceNeedKind = EvidenceLocatorKind | EvidenceKind;
export interface EvidenceNeed {
  locatorId: string;
  kind: EvidenceNeedKind;
  reason: string;
}
export interface ReviewBudget {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  contextExpansions: number;
}
export interface ReviewTask {
  taskId: string;
  taskVersion: string;
  unit: ReviewUnit;
  lens: ReviewLens;
  lensVersion: string;
  snapshotId: string;
  question: string;
  changedRanges: SourceRange[];
  contextRefs: ContextRef[];
  allowedEvidenceLocators: EvidenceLocator[];
  tokenBudget: number;
  outputTokenBudget: number;
  modelCallBudget: number;
  expansionBudget: number;
  outputContractVersion: string;
  evidenceNeeds: EvidenceNeed[];
  budget: ReviewBudget;
}
export interface CandidateReviewFinding {
  id: string;
  file: string;
  startLine: number;
  endLine?: number;
  title: string;
  impact: string;
  evidence: string[];
  confidence: number;
  category: ReviewLens;
  triggeringValue: string;
  violatedInvariant: string;
  observableImpact?: string;
  evidenceNeeds: EvidenceNeed[];
}
export interface ContextRequest {
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  reason: string;
}
export interface FindingCandidateResult {
  contractVersion?: typeof CANDIDATE_RESULT_VERSION;
  status: "finding";
  findings: CandidateReviewFinding[];
  evidenceNeeds: EvidenceNeed[];
  contextRequests: ContextRequest[];
}
export interface NoFindingCandidateResult {
  contractVersion?: typeof CANDIDATE_RESULT_VERSION;
  status: "no_finding";
  findings: [];
  evidenceNeeds: [];
  contextRequests: [];
}
export interface InsufficientContextCandidateResult {
  contractVersion?: typeof CANDIDATE_RESULT_VERSION;
  status: "insufficient_context";
  findings: [];
  evidenceNeeds: EvidenceNeed[];
  contextRequests: ContextRequest[];
}
export type CandidateReviewOutput =
  FindingCandidateResult | NoFindingCandidateResult | InsufficientContextCandidateResult;

const line = z.number().int().min(1);
const workspacePath = z
  .string()
  .min(1)
  .refine(
    (v) => !v.startsWith("/") && !v.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(v),
    "path must be workspace-relative",
  )
  .refine((v) => !v.split(/[\\/]/).includes(".."), "path must not escape the workspace")
  .refine((v) => !v.includes("\\"), "path must use workspace-relative POSIX separators");
const text = (max: number) => z.string().min(1).max(max);
const sourceRangeSchema = z
  .object({ file: workspacePath, startLine: line, endLine: line })
  .strict()
  .refine((v) => v.endLine >= v.startLine, "endLine must not precede startLine");
const symbolSchema = z
  .object({ file: workspacePath, name: text(240), startLine: line, endLine: line })
  .strict()
  .refine((v) => v.endLine >= v.startLine, "endLine must not precede startLine");
const contextSchema = z
  .object({
    file: workspacePath,
    startLine: line,
    endLine: line,
    symbol: text(240).optional(),
    reason: text(240).optional(),
  })
  .strict()
  .refine((v) => v.endLine >= v.startLine, "endLine must not precede startLine");
export const reviewUnitSchema = z
  .object({
    id: text(200),
    kind: z.enum(["local", "interaction"]),
    changedSymbols: z.array(symbolSchema).max(100),
    changedRanges: z.array(sourceRangeSchema).max(100),
    context: z.array(contextSchema).max(200),
    riskScore: z.number().finite().min(0),
    riskReasons: z.array(text(240)).max(50),
    estimatedTokens: z.number().int().min(0).max(1_000_000),
  })
  .strict();
const legacyEvidenceLocatorSchema = z
  .object({
    id: text(200),
    kind: z.enum(["caller", "consumer", "symbol", "range", "file", "callee", "usage", "literal"]),
    file: workspacePath,
    symbol: text(240).optional(),
    startLine: line.optional(),
    endLine: line.optional(),
    value: text(240).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (["caller", "consumer", "symbol", "callee", "usage"].includes(v.kind) && !v.symbol)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "symbol is required for this locator kind" });
    if (v.kind === "range" && (v.startLine === undefined || v.endLine === undefined || v.endLine < v.startLine))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "range locator is invalid" });
    if (v.kind === "literal" && !v.value)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is required for a literal locator" });
  });
const evidenceLocatorSchema = z.union([legacyEvidenceLocatorSchema, taskScopedEvidenceLocatorSchema]);
const evidenceNeedKindValues = [
  "caller",
  "consumer",
  "symbol",
  "range",
  "file",
  "callee",
  "usage",
  "literal",
  "definition",
  "callers",
  "callees",
  "type",
  "implementation",
  "config",
  "test",
  "schema",
  "search",
] as const;
export const evidenceNeedSchema = z
  .object({ locatorId: text(200), kind: z.enum(evidenceNeedKindValues), reason: text(500) })
  .strict();
const positiveBudget = z.number().int().positive();
const nonNegativeBudget = z.number().int().min(0);
export const reviewBudgetSchema = z
  .object({
    inputTokens: positiveBudget.max(1_000_000),
    outputTokens: positiveBudget.max(100_000),
    modelCalls: positiveBudget.max(16),
    contextExpansions: nonNegativeBudget.max(32),
  })
  .strict();
const taskInputSchema = z
  .object({
    taskId: text(200),
    taskVersion: z.literal(REVIEW_TASK_VERSION),
    unit: reviewUnitSchema,
    lens: z.enum(reviewLensValues),
    lensVersion: text(40),
    snapshotId: text(300),
    question: text(2_000),
    changedRanges: z.array(sourceRangeSchema).max(100),
    contextRefs: z.array(contextSchema).max(200),
    allowedEvidenceLocators: z.array(evidenceLocatorSchema).max(50),
    tokenBudget: positiveBudget.max(1_000_000),
    outputTokenBudget: positiveBudget.max(100_000),
    modelCallBudget: positiveBudget.max(16),
    expansionBudget: nonNegativeBudget.max(32),
    outputContractVersion: z.literal(CANDIDATE_RESULT_VERSION),
    evidenceNeeds: z.array(evidenceNeedSchema).max(20).default([]),
    budget: reviewBudgetSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.budget &&
      (v.budget.inputTokens !== v.tokenBudget ||
        v.budget.outputTokens !== v.outputTokenBudget ||
        v.budget.modelCalls !== v.modelCallBudget ||
        v.budget.contextExpansions !== v.expansionBudget)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "budget aliases must match the task limits" });
  })
  .transform((v) => ({
    ...v,
    budget: v.budget ?? {
      inputTokens: v.tokenBudget,
      outputTokens: v.outputTokenBudget,
      modelCalls: v.modelCallBudget,
      contextExpansions: v.expansionBudget,
    },
  }));
export const reviewTaskSchema = taskInputSchema;
const findingSchema = z
  .object({
    id: text(200),
    file: workspacePath,
    startLine: line,
    endLine: line.optional(),
    title: text(300),
    impact: text(1_000),
    evidence: z.array(text(1_000)).min(1).max(10),
    confidence: z.number().finite().min(0).max(1),
    category: z.enum(reviewLensValues),
    triggeringValue: text(240),
    violatedInvariant: text(500),
    observableImpact: text(500).optional(),
    evidenceNeeds: z.array(evidenceNeedSchema).min(1).max(10),
  })
  .strict()
  .refine((v) => v.endLine === undefined || v.endLine >= v.startLine, "endLine must not precede startLine");
const contextRequestSchema = z
  .object({
    file: workspacePath,
    startLine: line.optional(),
    endLine: line.optional(),
    symbol: text(240).optional(),
    reason: text(500),
  })
  .strict()
  .refine(
    (v) => v.endLine === undefined || (v.startLine !== undefined && v.endLine >= v.startLine),
    "context request range is invalid",
  );
const candidateBase = {
  contractVersion: z.literal(CANDIDATE_RESULT_VERSION).optional().default(CANDIDATE_RESULT_VERSION),
  findings: z.array(findingSchema).max(20),
  evidenceNeeds: z.array(evidenceNeedSchema).max(20),
  contextRequests: z.array(contextRequestSchema).max(20),
};
export const candidateReviewOutputSchema = z.union([
  z
    .object({ ...candidateBase, status: z.literal("finding") })
    .strict()
    .refine((v) => v.findings.length > 0, "finding result requires a finding"),
  z
    .object({
      ...candidateBase,
      status: z.literal("no_finding"),
      findings: z.tuple([]),
      evidenceNeeds: z.tuple([]),
      contextRequests: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...candidateBase,
      status: z.literal("insufficient_context"),
      findings: z.tuple([]),
      evidenceNeeds: z.array(evidenceNeedSchema).min(1),
      contextRequests: z.array(contextRequestSchema).min(1),
    })
    .strict(),
]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export function serializeReviewContract(value: unknown): string {
  return JSON.stringify(stable(value));
}
export function deterministicReviewUnitId(unit: Omit<ReviewUnit, "id">): string {
  return `unit-${sha256(serializeReviewContract({ ...unit, id: "" }), 16)}`;
}
export function deterministicReviewTaskId(task: Omit<ReviewTask, "taskId">): string {
  return `task-${sha256(serializeReviewContract({ ...task, taskId: "" }), 16)}`;
}
export function deterministicCandidateFindingId(finding: Omit<CandidateReviewFinding, "id">): string {
  return `finding-${sha256(serializeReviewContract({ ...finding, id: "" }), 16)}`;
}
export interface ContractValidationOptions {
  existingFiles?: ReadonlySet<string> | readonly string[];
  knownSymbols?: ReadonlySet<string> | readonly string[];
  allowedEvidenceLocators?: readonly AcceptedEvidenceLocator[];
  evidenceLocatorTable?: EvidenceLocatorTable;
  expectedTaskId?: string;
  expectedSnapshotId?: string;
  changedRanges?: readonly SourceRange[];
}
function isTaskScopedLocator(locator: AcceptedEvidenceLocator): locator is EvidenceLocator {
  return "mode" in locator;
}
function locatorFiles(locator: AcceptedEvidenceLocator): string[] {
  if (!isTaskScopedLocator(locator)) return [locator.file];
  if (locator.mode === "path") return [locator.canonicalValue];
  return locator.pathBound ? [locator.pathBound] : [];
}
function validateNeed(need: EvidenceNeed, options: ContractValidationOptions): void {
  if (options.evidenceLocatorTable) {
    if (!(evidenceKindValues as readonly string[]).includes(need.kind))
      throw new Error("legacy evidence kind is incompatible with a task-scoped locator table");
    validateEvidenceLocatorRequest(
      { locatorId: need.locatorId, evidenceKind: need.kind },
      options.evidenceLocatorTable,
      { taskId: options.expectedTaskId, snapshotId: options.expectedSnapshotId },
    );
    return;
  }
  const allowed = options.allowedEvidenceLocators;
  if (allowed) {
    const locator = allowed.find((candidate) => candidate.id === need.locatorId);
    if (!locator) throw new Error("evidence locator is not allowed by the review task");
    if (isTaskScopedLocator(locator)) {
      if (
        !(evidenceKindValues as readonly string[]).includes(need.kind) ||
        !locator.allowedEvidenceKinds.includes(need.kind as EvidenceKind)
      )
        throw new Error("evidence kind is incompatible with the task-scoped locator");
    } else if (locator.kind !== need.kind) {
      throw new Error("evidence locator is not allowed by the review task");
    }
  }
}
function validateRangeInScope(value: SourceRange, ranges: readonly SourceRange[] | undefined): void {
  if (
    ranges &&
    ranges.length > 0 &&
    !ranges.some((r) => r.file === value.file && value.startLine >= r.startLine && value.endLine <= r.endLine)
  )
    throw new Error("finding anchor is outside the changed scope");
}
export function validateReviewTask(value: unknown, options: ContractValidationOptions = {}): ReviewTask {
  const task = reviewTaskSchema.parse(value);
  const files = options.existingFiles && new Set(options.existingFiles);
  const symbols = options.knownSymbols && new Set(options.knownSymbols);
  const scopedLocators = task.allowedEvidenceLocators.filter(isTaskScopedLocator);
  if (scopedLocators.length > 0) {
    const table = options.evidenceLocatorTable ?? {
      version: "evidence-locator-table/v1",
      taskId: scopedLocators[0].taskId,
      snapshotId: task.snapshotId,
      scopePaths: [...new Set(scopedLocators.flatMap(locatorFiles))].sort((left, right) => left.localeCompare(right)),
      locators: scopedLocators,
    };
    const validatedTable = validateEvidenceLocatorTable(table, {
      taskId: options.expectedTaskId,
      snapshotId: options.expectedSnapshotId ?? task.snapshotId,
    });
    if (serializeReviewContract(scopedLocators) !== serializeReviewContract(validatedTable.locators))
      throw new Error("review task locator entries do not match the frozen locator table");
  }
  const refs = [
    ...task.unit.changedRanges,
    ...task.unit.changedSymbols,
    ...task.unit.context,
    ...task.allowedEvidenceLocators.flatMap(locatorFiles).map((file) => ({ file })),
    ...(options.evidenceLocatorTable?.scopePaths ?? []).map((file) => ({ file })),
  ];
  if (files)
    for (const ref of refs)
      if (!files.has(ref.file)) throw new Error(`review task references nonexistent file: ${ref.file}`);
  if (symbols)
    for (const ref of task.unit.changedSymbols)
      if (!symbols.has(ref.name) && !symbols.has(`${ref.file}:${ref.name}`))
        throw new Error(`review task references unknown symbol: ${ref.name}`);
  if (task.tokenBudget < task.unit.estimatedTokens || task.budget.inputTokens < task.unit.estimatedTokens)
    throw new Error("tokenBudget is smaller than estimatedTokens");
  const needOptions = options.evidenceLocatorTable
    ? { ...options, expectedSnapshotId: task.snapshotId }
    : { ...options, allowedEvidenceLocators: task.allowedEvidenceLocators };
  for (const need of task.evidenceNeeds) validateNeed(need, needOptions);
  return task as unknown as ReviewTask;
}
function normalizeLegacyCandidate(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("status" in value)) return value;
  const input = value as Record<string, unknown>;
  if (input.contractVersion) return value;
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const requests = Array.isArray(input.contextRequests) ? input.contextRequests : [];
  if (input.status === "finding" || input.status === "no_finding") return value;
  if (input.status === "insufficient_context" && Array.isArray(input.evidenceNeeds))
    return { ...input, contractVersion: CANDIDATE_RESULT_VERSION };
  if (input.status === "insufficient_context")
    return {
      contractVersion: CANDIDATE_RESULT_VERSION,
      status: "insufficient_context",
      findings: [],
      evidenceNeeds: requests.map((r) => ({
        locatorId: `legacy-${sha256(serializeReviewContract(r), 12)}`,
        kind: "file",
        reason: (r as ContextRequest).reason,
      })),
      contextRequests: requests,
    };
  if (input.status === "complete")
    return {
      contractVersion: CANDIDATE_RESULT_VERSION,
      status: findings.length > 0 ? "finding" : "no_finding",
      findings,
      evidenceNeeds: [],
      contextRequests: [],
    };
  return value;
}
export function validateCandidateReviewOutput(
  value: unknown,
  options: ContractValidationOptions = {},
): CandidateReviewOutput {
  const output = candidateReviewOutputSchema.parse(normalizeLegacyCandidate(value));
  const files = options.existingFiles && new Set(options.existingFiles);
  for (const finding of output.findings) {
    if (files && !files.has(finding.file)) throw new Error(`finding references nonexistent file: ${finding.file}`);
    validateRangeInScope(
      { file: finding.file, startLine: finding.startLine, endLine: finding.endLine ?? finding.startLine },
      options.changedRanges,
    );
    for (const need of finding.evidenceNeeds) validateNeed(need, options);
  }
  for (const need of output.evidenceNeeds) validateNeed(need, options);
  if (files)
    for (const request of output.contextRequests)
      if (!files.has(request.file)) throw new Error(`context request references nonexistent file: ${request.file}`);
  if (output.status === "insufficient_context" && output.contextRequests.length === 0)
    throw new Error("insufficient_context requires a typed context request");
  return output;
}
