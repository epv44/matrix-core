import { z } from "zod";
import { sha256 } from "./hash.js";

export const reviewLensValues = ["correctness", "security", "performance", "contract"] as const;
export type ReviewLens = (typeof reviewLensValues)[number];
export type RiskReason = string;

export interface SourceRange {
  file: string;
  startLine: number;
  endLine: number;
}
export interface SymbolRef {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
}
export interface ContextRef {
  file: string;
  startLine: number;
  endLine: number;
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
export interface ReviewTask {
  unit: ReviewUnit;
  lens: ReviewLens;
  snapshotId: string;
  tokenBudget: number;
  expansionBudget: number;
  outputContractVersion: string;
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
}
export interface ContextRequest {
  file: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  reason: string;
}
export interface CandidateReviewOutput {
  findings: CandidateReviewFinding[];
  contextRequests: ContextRequest[];
  status: "complete" | "insufficient_context";
}

const line = z.number().int().min(1);
const path = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "path must be workspace-relative");
const range = z.object({ file: path, startLine: line, endLine: line }).strict().refine((value) => value.endLine >= value.startLine, "endLine must not precede startLine");
const symbol = z.object({ file: path, name: z.string().min(1), startLine: line, endLine: line }).strict().refine((value) => value.endLine >= value.startLine, "endLine must not precede startLine");
const context = z.object({ file: path, startLine: line, endLine: line, symbol: z.string().min(1).optional(), reason: z.string().min(1).optional() }).strict().refine((value) => value.endLine >= value.startLine, "endLine must not precede startLine");

export const reviewUnitSchema = z.object({
  id: z.string().min(1), kind: z.enum(["local", "interaction"]), changedSymbols: z.array(symbol), changedRanges: z.array(range), context: z.array(context),
  riskScore: z.number().finite().min(0), riskReasons: z.array(z.string().min(1)), estimatedTokens: z.number().int().min(0),
}).strict();
export const reviewTaskSchema = z.object({ unit: reviewUnitSchema, lens: z.enum(reviewLensValues), snapshotId: z.string().min(1), tokenBudget: z.number().int().positive(), expansionBudget: z.number().int().min(0), outputContractVersion: z.string().min(1) }).strict();
const finding = z.object({ id: z.string().min(1), file: path, startLine: line, endLine: line.optional(), title: z.string().min(1), impact: z.string().min(1), evidence: z.array(z.string().min(1)).min(1), confidence: z.number().finite().min(0).max(1), category: z.enum(reviewLensValues) }).strict().refine((value) => value.endLine === undefined || value.endLine >= value.startLine, "endLine must not precede startLine");
const request = z.object({ file: path, startLine: line.optional(), endLine: line.optional(), symbol: z.string().min(1).optional(), reason: z.string().min(1) }).strict().refine((value) => value.endLine === undefined || value.startLine !== undefined && value.endLine >= value.startLine, "context request range is invalid");
export const candidateReviewOutputSchema = z.object({ findings: z.array(finding).max(20), contextRequests: z.array(request).max(20), status: z.enum(["complete", "insufficient_context"]) }).strict();

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export function serializeReviewContract(value: ReviewUnit | ReviewTask | CandidateReviewOutput): string { return JSON.stringify(stable(value)); }
export function deterministicReviewUnitId(unit: Omit<ReviewUnit, "id">): string { return `unit-${sha256(serializeReviewContract({ ...unit, id: "" } as ReviewUnit), 16)}`; }

export interface ContractValidationOptions { existingFiles?: ReadonlySet<string> | readonly string[]; knownSymbols?: ReadonlySet<string> | readonly string[]; }
export function validateReviewTask(value: unknown, options: ContractValidationOptions = {}): ReviewTask {
  const task = reviewTaskSchema.parse(value);
  const files = options.existingFiles && new Set(options.existingFiles);
  const symbols = options.knownSymbols && new Set(options.knownSymbols);
  const refs = [...task.unit.changedRanges, ...task.unit.changedSymbols, ...task.unit.context];
  if (files) for (const ref of refs) if (!files.has(ref.file)) throw new Error(`review task references nonexistent file: ${ref.file}`);
  if (symbols) for (const ref of task.unit.changedSymbols) if (!symbols.has(ref.name) && !symbols.has(`${ref.file}:${ref.name}`)) throw new Error(`review task references unknown symbol: ${ref.name}`);
  if (task.tokenBudget < task.unit.estimatedTokens) throw new Error("tokenBudget is smaller than estimatedTokens");
  return task;
}
export function validateCandidateReviewOutput(value: unknown, options: ContractValidationOptions = {}): CandidateReviewOutput {
  const output = candidateReviewOutputSchema.parse(value);
  const files = options.existingFiles && new Set(options.existingFiles);
  if (files) for (const finding of output.findings) if (!files.has(finding.file)) throw new Error(`finding references nonexistent file: ${finding.file}`);
  return output;
}
