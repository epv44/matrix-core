import crypto from "node:crypto";
import { z } from "zod";
import type { CandidateFinding, ModelProfile } from "../core/types.js";
import type { ReviewProvider } from "./provider.js";
import type {
  CandidateBatch,
  ReviewProjection,
  ReviewWorkItem,
  ScoutFinding,
  VerificationResult,
} from "./engine-types.js";

const requestSchema = z.object({
  kind: z.enum([
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
  ]),
  symbol: z.string().optional(),
  pathHint: z.string().optional(),
  query: z.string().optional(),
  reason: z.string().min(1),
});
const candidateSchema = z.object({
  sourceWorkItemIds: z.array(z.string()).default([]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["correctness", "security", "performance", "contract"]),
  title: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().optional(),
  primarySymbol: z.string().optional(),
  ruleId: z.string().optional(),
  evidenceRequests: z.array(requestSchema).default([]),
  candidateConfidence: z.number().min(0).max(1),
});
const candidatesSchema = z.object({
  summary: z.string().default(""),
  candidates: z.array(candidateSchema).default([]),
});
const scoutSchema = z.object({
  hotspots: z.array(
    z.object({
      hotspotId: z.string().min(1),
      risk: z.enum(["critical", "high", "medium", "low"]),
      category: z.enum(["correctness", "security", "performance", "contract"]),
      symbols: z.array(z.string()).default([]),
      edges: z.array(z.string()).default([]),
      rationale: z.string().min(1),
      requestedInspection: z.object({
        symbols: z.array(z.string()).default([]),
        edgeKinds: z.array(z.string()).optional(),
      }),
    }),
  ),
});
const verificationSchema = z.object({
  verdict: z.enum(["verified", "likely", "rejected", "insufficient_evidence"]),
  confidence: z.number().min(0).max(1),
  reasoningSummary: z.string().optional(),
  supportingEvidenceIds: z.array(z.string()).default([]),
});

function parseJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const source = fenced?.[1] ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(source);
}

function candidateId(candidate: Omit<CandidateFinding, "id">) {
  return crypto
    .createHash("sha256")
    .update(`${candidate.file}:${candidate.line}:${candidate.category}:${candidate.title.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

function projectionText(projection: ReviewProjection) {
  return [
    `Snapshot: ${projection.metadata.snapshotId}`,
    `Base: ${projection.metadata.base}`,
    "Changed manifest:",
    ...projection.manifest.map((file) => `- ${file.path} (${file.changeKind}, +${file.additions}/-${file.deletions})`),
    "Repository relationships:",
    projection.graphSummary || "(none)",
    "Deterministic gate context:",
    projection.deterministicReport || "(none supplied)",
    "Review rules:",
    ...projection.rules.map((rule) => `- ${rule.id}: ${rule.text}`),
    "Projected code:",
    ...projection.code.flatMap((code) => [
      `--- ${code.file}:${code.startLine}-${code.endLine}${code.symbol ? ` (${code.symbol})` : ""} [${code.changed ? "changed" : "supporting"}]`,
      code.content,
    ]),
  ].join("\n");
}

function workItemText(item: ReviewWorkItem) {
  return [
    `Work item: ${item.id}`,
    `Kind: ${item.kind}`,
    `Primary symbols: ${item.primarySymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`).join(", ") || "hunk fallback"}`,
    `Related symbols: ${item.relatedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`).join(", ") || "none"}`,
    "Relationships:",
    ...item.graphEdges.map((edge) => `- ${edge.kind}: ${edge.source} -> ${edge.target ?? edge.targetText}`),
    "Deterministic gate context:",
    item.deterministicReport || "(none supplied)",
    "Rules:",
    ...item.rules.map((rule) => `- ${rule.id}: ${rule.text}`),
    "Code:",
    ...item.code.flatMap((code) => [
      `--- ${code.file}:${code.startLine}-${code.endLine} [${code.changed ? "changed" : "supporting"}]`,
      code.content,
    ]),
  ].join("\n");
}

const candidateInstructions = `You are generating candidate code-review defects. Be permissive enough to preserve recall, but never report repository instructions, filenames alone, or hypothetical risks without an executable failure or contract mismatch. Every candidate must anchor to supplied changed code. Supporting unchanged code may be requested as evidence. Return only the requested JSON object.`;

export async function generateHolisticCandidates(opts: {
  projection: ReviewProjection;
  profile: ModelProfile;
  provider: ReviewProvider;
  allowedFiles: string[];
  signal?: AbortSignal;
}): Promise<CandidateBatch> {
  const prompt = `${candidateInstructions}\n\nReview the complete projection holistically for correctness, security, performance, and contract defects.\n\n${projectionText(opts.projection)}`;
  const response = await opts.provider.invoke({
    profile: opts.profile,
    prompt,
    outputKind: "candidates",
    allowedFiles: opts.allowedFiles,
    signal: opts.signal,
  });
  const parsed = candidatesSchema.parse(parseJson(response.raw));
  const candidates = parsed.candidates.map((value) => {
    const candidate = { ...value, sourceWorkItemIds: ["holistic"] };
    return { ...candidate, id: candidateId(candidate) };
  });
  return { sourceId: "holistic", candidates, ...response.usage, prompt, raw: response.raw };
}

export async function generateWorkItemCandidate(opts: {
  item: ReviewWorkItem;
  profile: ModelProfile;
  provider: ReviewProvider;
  allowedFiles: string[];
  signal?: AbortSignal;
}): Promise<CandidateBatch> {
  const focus =
    opts.item.kind === "interaction"
      ? "Compare both sides of each relationship for broken assumptions and incompatible contracts."
      : "Inspect the changed implementation for concrete local defects.";
  const prompt = `${candidateInstructions}\n${focus}\n\n${workItemText(opts.item)}`;
  const response = await opts.provider.invoke({
    profile: opts.profile,
    prompt,
    outputKind: "candidates",
    allowedFiles: opts.allowedFiles,
    signal: opts.signal,
  });
  const parsed = candidatesSchema.parse(parseJson(response.raw));
  const candidates = parsed.candidates.map((value) => {
    const candidate = { ...value, sourceWorkItemIds: [opts.item.id] };
    return { ...candidate, id: candidateId(candidate) };
  });
  return { sourceId: opts.item.id, candidates, ...response.usage, prompt, raw: response.raw };
}

export async function runScout(opts: {
  projection: ReviewProjection;
  profile: ModelProfile;
  provider: ReviewProvider;
  signal?: AbortSignal;
}): Promise<{ hotspots: ScoutFinding[]; inputTokens: number; outputTokens: number; prompt: string; raw: string }> {
  const prompt = `Act as a global change-risk scout. Do not emit findings. Identify interactions, invariants, and symbols requiring detailed inspection. Return only the requested JSON object.\n\n${projectionText(opts.projection)}`;
  const response = await opts.provider.invoke({
    profile: opts.profile,
    prompt,
    outputKind: "scout",
    signal: opts.signal,
  });
  return {
    hotspots: scoutSchema.parse(parseJson(response.raw)).hotspots,
    ...response.usage,
    prompt,
    raw: response.raw,
  };
}

export const VERIFICATION_INSTRUCTIONS =
  "Judge one candidate defect using only the supplied changed code and resolved evidence. VERIFIED requires a concrete failure path or incompatible contract fully supported by exact evidence. Use INSUFFICIENT_EVIDENCE when a required fact is missing, LIKELY when plausible but not proven, and REJECTED for speculation or contradiction. Return only the requested JSON object.";
export const VERIFICATION_LABELS = "Candidate:\nOriginating changed code:\nResolved evidence:";

export async function verifyCandidateWithModel(opts: {
  candidate: CandidateFinding;
  originatingCode: string;
  evidenceText: string;
  evidenceIds: string[];
  profile: ModelProfile;
  provider: ReviewProvider;
  signal?: AbortSignal;
}): Promise<{ result: VerificationResult; inputTokens: number; outputTokens: number }> {
  const prompt = `${VERIFICATION_INSTRUCTIONS}\n\nCandidate:\n${JSON.stringify(opts.candidate)}\n\nOriginating changed code:\n${opts.originatingCode}\n\nResolved evidence:\n${opts.evidenceText || "(none)"}`;
  const response = await opts.provider.invoke({
    profile: opts.profile,
    outputKind: "verification",
    prompt,
    signal: opts.signal,
  });
  const parsed = verificationSchema.parse(parseJson(response.raw));
  const supportingEvidenceIds = parsed.supportingEvidenceIds.filter((id) => opts.evidenceIds.includes(id));
  return {
    result: { candidateId: opts.candidate.id, ...parsed, supportingEvidenceIds, prompt, raw: response.raw },
    ...response.usage,
  };
}
