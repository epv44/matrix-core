import { z } from "zod";
import { sha256 } from "../core/hash.js";
import type { CandidateFinding, ModelProfile } from "../core/types.js";
import type { AgentDef } from "./types.js";
import type { ProviderCompletionMetadata, ProviderResponse, ReviewOutputKind, ReviewProvider } from "./provider.js";
import type {
  CandidateBatch,
  ProviderFailureDiagnostic,
  ReviewProjection,
  ReviewWorkItem,
  ScoutFinding,
  VerificationResult,
} from "./engine-types.js";

const compactRequestSchema = z.object({
  k: z.enum([
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
  v: z.string().min(1).max(240),
  m: z.enum(["symbol", "literal"]).optional(),
  p: z.string().max(240).optional(),
  r: z.string().min(1).max(120),
});
const compactCandidateSchema = z.object({
  f: z.string().min(1),
  l: z.number().int().positive(),
  x: z.number().int().positive().optional(),
  s: z.enum(["critical", "high", "medium", "low"]),
  k: z.enum(["correctness", "security", "performance", "contract"]),
  t: z.string().min(1).max(80),
  d: z.string().min(1).max(280),
  g: z.string().max(160).optional(),
  p: z.string().max(160).optional(),
  r: z.string().max(120).optional(),
  e: z.array(compactRequestSchema).max(2).default([]),
  q: z.number().min(0).max(1),
});
function compactCandidatesSchema(maxCandidates: number) {
  return z.object({ c: z.array(compactCandidateSchema).max(maxCandidates).default([]) });
}
function specialistCandidatesSchema(maxCandidates: number) {
  return z.object({
    summary: z.string().min(1).max(1200),
    c: z.array(compactCandidateSchema).max(maxCandidates).default([]),
  });
}
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

function structuredSource(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced?.[1]) return fenced[1].trim();
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : trimmed;
}

function completionMetadata(response: ProviderResponse): ProviderCompletionMetadata {
  return (
    response.completion ?? {
      model: "unknown",
      done: null,
      doneReason: null,
      totalDurationNs: null,
      loadDurationNs: null,
      promptEvalDurationNs: null,
      evalDurationNs: null,
    }
  );
}

export class StructuredOutputError extends Error {
  readonly diagnostic: ProviderFailureDiagnostic;
  constructor(readonly diagnostics: ProviderFailureDiagnostic[]) {
    const diagnostic = diagnostics.at(-1)!;
    super(
      `Structured provider output invalid (kind=${diagnostic.outputKind}, failure=${diagnostic.failureKind}, done_reason=${diagnostic.completion.doneReason ?? "unknown"}, output_tokens=${diagnostic.usage.outputTokens}, raw_chars=${diagnostic.raw.length}${diagnostic.parsePosition === null ? "" : `, parse_position=${diagnostic.parsePosition}`}): ${diagnostic.parseError}`,
    );
    this.diagnostic = diagnostic;
    this.name = "StructuredOutputError";
  }
}

function structuredOutputFailure(
  opts: {
    response: ProviderResponse;
    prompt: string;
    sourceId: string;
    outputKind: ReviewOutputKind;
    attempt?: number;
  },
  details: Pick<
    ProviderFailureDiagnostic,
    "parseError" | "failureKind" | "validationIssues" | "parsePosition" | "parseContext"
  >,
): StructuredOutputError {
  return new StructuredOutputError([
    {
      sourceId: opts.sourceId,
      outputKind: opts.outputKind,
      prompt: opts.prompt,
      raw: opts.response.raw,
      usage: opts.response.usage,
      completion: completionMetadata(opts.response),
      attempt: opts.attempt ?? 1,
      ...details,
    },
  ]);
}

function parseStructuredResponse<T>(opts: {
  response: ProviderResponse;
  prompt: string;
  sourceId: string;
  outputKind: ReviewOutputKind;
  attempt?: number;
  validate: (value: unknown) => T;
}): T {
  const source = structuredSource(opts.response.raw);
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    const positionMatch = /position (\d+)/i.exec(parseError);
    const parsePosition = positionMatch ? Number(positionMatch[1]) : null;
    const contextPosition = parsePosition ?? source.length;
    throw structuredOutputFailure(opts, {
      parseError,
      failureKind: "json-syntax",
      validationIssues: [],
      parsePosition,
      parseContext: source.slice(Math.max(0, contextPosition - 160), Math.min(source.length, contextPosition + 160)),
    });
  }
  try {
    return opts.validate(decoded);
  } catch (error) {
    const validationIssues =
      error instanceof z.ZodError
        ? error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        : [];
    const parseError =
      validationIssues.length > 0
        ? validationIssues.map((issue) => `${issue.path || "root"}: ${issue.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    throw structuredOutputFailure(opts, {
      parseError,
      failureKind: "schema-validation",
      validationIssues,
      parsePosition: null,
      parseContext: source.slice(0, 320),
    });
  }
}

async function invokeStructured<T>(opts: {
  provider: ReviewProvider;
  profile: ModelProfile;
  prompt: string;
  sourceId: string;
  outputKind: ReviewOutputKind;
  allowedFiles?: string[];
  maxCandidates?: number;
  signal?: AbortSignal;
  validate: (value: unknown) => T;
}): Promise<{ parsed: T; response: ProviderResponse; diagnostics: ProviderFailureDiagnostic[] }> {
  const invoke = (prompt: string) =>
    opts.provider.invoke({
      profile: opts.profile,
      prompt,
      outputKind: opts.outputKind,
      allowedFiles: opts.allowedFiles,
      maxCandidates: opts.maxCandidates,
      signal: opts.signal,
    });
  const response = await invoke(opts.prompt);
  try {
    return {
      parsed: parseStructuredResponse({ ...opts, response, attempt: 1 }),
      response,
      diagnostics: [],
    };
  } catch (error) {
    if (!(error instanceof StructuredOutputError) || opts.signal?.aborted) throw error;
    const first = error.diagnostic;
    const repairPrompt = `Correct the previous response so it matches the required JSON schema. Return only corrected JSON, with no prose or Markdown. Validation failure: ${first.parseError}\nPrevious response:\n${first.raw.slice(0, 12_000)}`;
    const repaired = await invoke(repairPrompt);
    try {
      return {
        parsed: parseStructuredResponse({ ...opts, prompt: repairPrompt, response: repaired, attempt: 2 }),
        response: {
          ...repaired,
          usage: {
            inputTokens: response.usage.inputTokens + repaired.usage.inputTokens,
            outputTokens: response.usage.outputTokens + repaired.usage.outputTokens,
          },
        },
        diagnostics: error.diagnostics,
      };
    } catch (repairError) {
      if (repairError instanceof StructuredOutputError)
        throw new StructuredOutputError([...error.diagnostics, ...repairError.diagnostics]);
      throw repairError;
    }
  }
}

function candidateId(candidate: Omit<CandidateFinding, "id">) {
  return sha256(
    `${candidate.file}:${candidate.line}:${candidate.category}:${candidate.title.trim().toLowerCase()}`,
    16,
  );
}

function expandCandidate(
  value: z.infer<typeof compactCandidateSchema>,
  sourceWorkItemId: string,
  specialist?: AgentDef["name"],
): Omit<CandidateFinding, "id"> {
  const symbolRequestKinds = new Set(["definition", "callers", "callees", "type", "implementation", "usage"]);
  return {
    sourceWorkItemIds: [sourceWorkItemId],
    sourceReviewers: specialist ? [specialist] : [],
    file: value.f,
    line: value.l,
    endLine: value.x,
    severity: value.s,
    category: value.k,
    title: value.t,
    description: value.d,
    suggestion: value.g,
    primarySymbol: value.p,
    ruleId: value.r,
    candidateConfidence: value.q,
    evidenceRequests: value.e.map((request) => {
      const locatorMode = request.m ?? (symbolRequestKinds.has(request.k) ? "symbol" : "literal");
      return {
        kind: request.k,
        locatorMode,
        symbol: locatorMode === "symbol" ? request.v : undefined,
        pathHint: request.p,
        query: locatorMode === "literal" ? request.v : undefined,
        reason: request.r,
      };
    }),
  };
}

function projectionText(projection: ReviewProjection) {
  return [
    `Snapshot: ${projection.metadata.snapshotId}`,
    `Base: ${projection.metadata.base ?? "working-tree"}`,
    "Changed manifest:",
    ...projection.manifest.map((file) => `- ${file.path} (${file.changeKind}, +${file.additions}/-${file.deletions})`),
    "Repository relationships:",
    projection.graphSummary || "(none)",
    "Deterministic gate context:",
    projection.deterministicReport || "(none supplied)",
    "Dependency context:",
    ...(projection.dependencySummary.length
      ? projection.dependencySummary.map((summary) => `- ${summary}`)
      : ["(none)"]),
    "Supplied review context:",
    ...(projection.contextSummary.length ? projection.contextSummary.map((summary) => `- ${summary}`) : ["(none)"]),
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
    "Dependency context:",
    ...(item.contextSummaries?.length ? item.contextSummaries.map((summary) => `- ${summary}`) : ["(none)"]),
    "Rules:",
    ...item.rules.map((rule) => `- ${rule.id}: ${rule.text}`),
    "Code:",
    ...item.code.flatMap((code) => [
      `--- ${code.file}:${code.startLine}-${code.endLine} [${code.changed ? "changed" : "supporting"}]`,
      code.content,
    ]),
  ].join("\n");
}

function candidateInstructions(maxCandidates: number, includeSummary = false) {
  const empty = includeSummary ? '{"summary":"concise review summary","c":[]}' : '{"c":[]}';
  return `You are generating candidate code-review defects. Inspect concrete runtime behavior, value flow, failure paths, boundary conditions, and contracts. For interaction work, compare callers, callees, producers, consumers, schemas, types, configuration, and tests across both sides of each supplied relationship. For finite or discriminated contract values, enumerate the supplied values and check whether changed branching preserves each value's observable meaning. Every candidate must identify the triggering input or value, the violated contract or invariant, and the observable outcome. A partial string-label mapping is not by itself a runtime exception. Be permissive enough to preserve recall, but never report repository instructions, filenames alone, style preferences, missing tests without a demonstrated defect, or hypothetical risks without an executable failure or contract mismatch. Generate zero to ${maxCandidates} distinct candidates anchored to supplied changed code. Supporting unchanged code may be requested as evidence. Use one short sentence per text field; set q to confidence from 0 to 1 as a decimal, never a percentage. Request at most two evidence items using {"k":"kind","m":"symbol or literal","v":"required symbol or literal","p":"optional repository path","r":"short reason"}; v is always required. Use m=symbol for exact definitions/callers/callees/types/usages and m=literal when implementation or test evidence must locate a concrete value such as an enum member. Every request is a required fact for adjudication. Claims about callers, consumers, downstream behavior, assumptions, or expectations must request callers or usage evidence for the exact producer symbol. Never request evidence for text that appears only in review instructions or deterministic-gate context. Return only the compact JSON object required by the schema, with no prose or Markdown, and use ${empty} when no concrete candidate exists.`;
}

export async function generateSpecialistCandidates(opts: {
  specialist: AgentDef;
  projection: ReviewProjection;
  profile: ModelProfile;
  provider: ReviewProvider;
  allowedFiles: string[];
  maxCandidates: number;
  signal?: AbortSignal;
}): Promise<CandidateBatch> {
  const sourceId = `specialist:${opts.specialist.name}`;
  const prompt = `${opts.specialist.prompt}\n\n${candidateInstructions(opts.maxCandidates, true)}\nReview the complete projection through only your specialist remit. Your summary must concisely state what you inspected and the most important conclusion; it must not claim global approval.\n\n${projectionText(opts.projection)}`;
  const { parsed, response, diagnostics } = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    prompt,
    sourceId,
    outputKind: "specialist",
    allowedFiles: opts.allowedFiles,
    maxCandidates: opts.maxCandidates,
    signal: opts.signal,
    validate: (value) => specialistCandidatesSchema(opts.maxCandidates).parse(value),
  });
  const candidates = parsed.c.map((value) => {
    const candidate = expandCandidate(value, sourceId, opts.specialist.name);
    return { ...candidate, id: candidateId(candidate) };
  });
  return {
    sourceId,
    specialist: opts.specialist.name,
    summary: parsed.summary,
    candidates,
    ...response.usage,
    prompt,
    raw: response.raw,
    completion: response.completion,
    diagnostics,
  };
}

export async function generateWorkItemCandidate(opts: {
  item: ReviewWorkItem;
  profile: ModelProfile;
  provider: ReviewProvider;
  allowedFiles: string[];
  maxCandidates: number;
  signal?: AbortSignal;
}): Promise<CandidateBatch> {
  const focus =
    opts.item.kind === "interaction"
      ? "Compare both sides of each relationship for broken assumptions and incompatible contracts."
      : "Inspect the changed implementation for concrete local defects.";
  const prompt = `${candidateInstructions(opts.maxCandidates)}\n${focus}\n\n${workItemText(opts.item)}`;
  const { parsed, response, diagnostics } = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    prompt,
    sourceId: opts.item.id,
    outputKind: "candidates",
    allowedFiles: opts.allowedFiles,
    maxCandidates: opts.maxCandidates,
    signal: opts.signal,
    validate: (value) => compactCandidatesSchema(opts.maxCandidates).parse(value),
  });
  const candidates = parsed.c.map((value) => {
    const candidate = expandCandidate(value, opts.item.id);
    candidate.primarySymbol ??= opts.item.primarySymbols[0]?.qualifiedName;
    return { ...candidate, id: candidateId(candidate) };
  });
  return {
    sourceId: opts.item.id,
    candidates,
    ...response.usage,
    prompt,
    raw: response.raw,
    completion: response.completion,
    diagnostics,
  };
}

export async function runScout(opts: {
  projection: ReviewProjection;
  profile: ModelProfile;
  provider: ReviewProvider;
  signal?: AbortSignal;
}): Promise<{
  hotspots: ScoutFinding[];
  inputTokens: number;
  outputTokens: number;
  prompt: string;
  raw: string;
  completion?: ProviderResponse["completion"];
  diagnostics?: ProviderFailureDiagnostic[];
}> {
  const prompt = `Act as a global change-risk scout. Do not emit findings. Identify interactions, invariants, and symbols requiring detailed inspection. Return only the requested JSON object.\n\n${projectionText(opts.projection)}`;
  const { parsed, response, diagnostics } = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    sourceId: "scout",
    prompt,
    outputKind: "scout",
    signal: opts.signal,
    validate: (value) => scoutSchema.parse(value),
  });
  return {
    hotspots: parsed.hotspots,
    ...response.usage,
    prompt,
    raw: response.raw,
    completion: response.completion,
    diagnostics,
  };
}

export const VERIFICATION_INSTRUCTIONS =
  "Judge one candidate defect using only the supplied changed code and resolved evidence. VERIFIED requires a concrete failure path or incompatible contract fully supported by exact evidence. REJECTED requires cited evidence that directly contradicts the claim; nearby defensive code is not enough. Use INSUFFICIENT_EVIDENCE whenever a required fact is missing, and LIKELY when plausible but not proven. In supportingEvidenceIds, use the exact raw evidence IDs without brackets or other decoration. Return only the requested JSON object.";
export const VERIFICATION_LABELS = "Candidate:\nOriginating changed code:\nResolved evidence:";

export async function verifyCandidateWithModel(opts: {
  candidate: CandidateFinding;
  originatingCode: string;
  evidenceText: string;
  evidenceIds: string[];
  requiredEvidenceIdsByRequest?: Record<string, string[]>;
  profile: ModelProfile;
  provider: ReviewProvider;
  signal?: AbortSignal;
}): Promise<{ result: VerificationResult; inputTokens: number; outputTokens: number }> {
  const prompt = `${VERIFICATION_INSTRUCTIONS}\n\nCandidate:\n${JSON.stringify(opts.candidate)}\n\nOriginating changed code:\n${opts.originatingCode}\n\nResolved evidence:\n${opts.evidenceText || "(none)"}`;
  const first = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    sourceId: opts.candidate.id,
    outputKind: "verification",
    prompt,
    signal: opts.signal,
    validate: (value) => verificationSchema.parse(value),
  });
  const citationErrors = (parsed: z.infer<typeof verificationSchema>) => {
    const errors: string[] = [];
    const unknown = parsed.supportingEvidenceIds.filter((id) => !opts.evidenceIds.includes(id));
    if (unknown.length) errors.push(`unknown or malformed evidence IDs: ${unknown.join(", ")}`);
    const exact = parsed.supportingEvidenceIds.filter((id) => opts.evidenceIds.includes(id));
    if (parsed.verdict !== "insufficient_evidence" && !exact.length)
      errors.push(`${parsed.verdict} verdict requires at least one exact evidence ID`);
    if (["verified", "rejected"].includes(parsed.verdict))
      for (const [requestId, ids] of Object.entries(opts.requiredEvidenceIdsByRequest ?? {}))
        if (!ids.some((id) => exact.includes(id))) errors.push(`required request ${requestId} is not cited`);
    return errors;
  };
  const diagnostic = (
    response: ProviderResponse,
    usedPrompt: string,
    attempt: number,
    errors: string[],
  ): ProviderFailureDiagnostic => ({
    sourceId: opts.candidate.id,
    outputKind: "verification",
    prompt: usedPrompt,
    raw: response.raw,
    usage: response.usage,
    completion: completionMetadata(response),
    parseError: errors.join("; "),
    failureKind: "citation-validation",
    validationIssues: errors.map((message) => ({ path: "supportingEvidenceIds", message })),
    attempt,
    parsePosition: null,
    parseContext: response.raw.slice(0, 320),
  });
  const firstErrors = citationErrors(first.parsed);
  if (!firstErrors.length)
    return {
      result: {
        candidateId: opts.candidate.id,
        ...first.parsed,
        prompt,
        raw: first.response.raw,
        completion: first.response.completion,
        diagnostics: first.diagnostics,
        providerInvocations: 1 + first.diagnostics.length,
      },
      ...first.response.usage,
    };
  const firstCitationDiagnostic = diagnostic(first.response, prompt, 1, firstErrors);
  const requiredCitationGroups = Object.entries(opts.requiredEvidenceIdsByRequest ?? {})
    .map(([requestId, ids]) => `- request ${requestId}: include at least one of ${ids.join(", ")}`)
    .join("\n");
  const repairPrompt = `${VERIFICATION_INSTRUCTIONS}\n\nCorrect only the citation contract in the previous verdict. Preserve its verdict and reasoning. Allowed evidence IDs: ${opts.evidenceIds.join(", ") || "none"}. Required citation groups:\n${requiredCitationGroups || "(none)"}\nCitation errors: ${firstErrors.join("; ")}. Return the complete corrected JSON object with exact raw IDs and no prose.\nPrevious response:\n${first.response.raw.slice(0, 12_000)}`;
  const repaired = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    sourceId: opts.candidate.id,
    outputKind: "verification",
    prompt: repairPrompt,
    signal: opts.signal,
    validate: (value) => verificationSchema.parse(value),
  });
  const repairedErrors = citationErrors(repaired.parsed);
  const diagnostics = [
    ...first.diagnostics,
    firstCitationDiagnostic,
    ...repaired.diagnostics,
    ...(repairedErrors.length ? [diagnostic(repaired.response, repairPrompt, 2, repairedErrors)] : []),
  ];
  const usage = {
    inputTokens: first.response.usage.inputTokens + repaired.response.usage.inputTokens,
    outputTokens: first.response.usage.outputTokens + repaired.response.usage.outputTokens,
  };
  if (repairedErrors.length)
    return {
      result: {
        candidateId: opts.candidate.id,
        verdict: "insufficient_evidence",
        confidence: 0,
        reasoningSummary: `verifier citation validation failed after repair: ${repairedErrors.join("; ")}`,
        supportingEvidenceIds: [],
        prompt: repairPrompt,
        raw: repaired.response.raw,
        completion: repaired.response.completion,
        diagnostics,
        citationRepairAttempted: true,
        providerInvocations: 2 + first.diagnostics.length + repaired.diagnostics.length,
      },
      ...usage,
    };
  return {
    result: {
      candidateId: opts.candidate.id,
      ...repaired.parsed,
      prompt: repairPrompt,
      raw: repaired.response.raw,
      completion: repaired.response.completion,
      diagnostics,
      citationRepairAttempted: true,
      providerInvocations: 2 + first.diagnostics.length + repaired.diagnostics.length,
    },
    ...usage,
  };
}
