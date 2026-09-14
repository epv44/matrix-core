import { z } from "zod";
import { sha256 } from "../core/hash.js";
import type { CandidateFinding, ModelProfile } from "../core/types.js";
import type { AgentDef } from "./types.js";
import type { TaskEvidenceSelector } from "./evidence-locators.js";
import { selectorPromptText, selectorToEvidenceRequest } from "./evidence-locators.js";
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
const boundedRequestSchema = z.object({
  selector: z.string().min(1).max(120),
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
const citationSelectionSchema = z.object({
  citations: z.array(
    z.object({
      requestId: z.string().min(1),
      evidenceId: z.string().min(1),
    }),
  ),
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
  evidenceSelectorKeys?: string[];
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
      evidenceSelectorKeys: opts.evidenceSelectorKeys,
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
    const repairPrompt =
      opts.outputKind === "candidates" && opts.evidenceSelectorKeys !== undefined
        ? `Repair the previous candidate response and return only valid JSON, with no prose or Markdown. Keep the candidate fields and values unless the validation failure requires a correction. ${
            opts.evidenceSelectorKeys.length === 0
              ? 'This task has zero allowed evidence selectors. Set "e":[] and remove every evidence object; do not emit a subject, selector, symbol, path, hash, or legacy locator.'
              : 'For every evidence entry, use exactly this shape: {"selector":"<one exact allowed selector key>","r":"short reason"}. The selector value is required and must never be empty. If no evidence request is needed, use "e":[].'
          } Allowed selector keys:\n${opts.evidenceSelectorKeys.map((key) => `- ${key}`).join("\n")}\nValidation failure: ${first.parseError}\nPrevious response:\n${first.raw.slice(0, 12_000)}`
        : `Correct the previous response so it matches the required JSON schema. Return only corrected JSON, with no prose or Markdown. Validation failure: ${first.parseError}\nPrevious response:\n${first.raw.slice(0, 12_000)}`;
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
  value: Omit<z.infer<typeof compactCandidateSchema>, "e"> & {
    e: Array<z.infer<typeof compactRequestSchema> | z.infer<typeof boundedRequestSchema>>;
  },
  sourceWorkItemId: string,
  specialist?: AgentDef["name"],
  selectors?: ReadonlyMap<string, TaskEvidenceSelector>,
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
    evidenceRequests: value.e.map((rawRequest) => {
      const request = rawRequest as unknown as
        | z.infer<typeof compactRequestSchema>
        | z.infer<typeof boundedRequestSchema>;
      if ("selector" in request) {
        const selector = selectors?.get(request.selector);
        if (!selector) throw new Error(`unknown evidence selector: ${request.selector}`);
        return selectorToEvidenceRequest(selector, request.r);
      }
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

function deterministicEvidenceDefaults(
  selectors: readonly TaskEvidenceSelector[],
  maxRequests = 2,
) {
  const priority = ["implementation", "type", "definition", "callers", "callees", "usage", "config", "schema", "test", "search"];
  return [...selectors]
    .sort((left, right) => {
      const leftRank = priority.indexOf(left.key.slice(left.key.lastIndexOf(".") + 1));
      const rightRank = priority.indexOf(right.key.slice(right.key.lastIndexOf(".") + 1));
      return (leftRank < 0 ? priority.length : leftRank) - (rightRank < 0 ? priority.length : rightRank) || left.key.localeCompare(right.key);
    })
    .slice(0, maxRequests)
    .map((selector) => selectorToEvidenceRequest(selector, "deterministic host-selected evidence for candidate adjudication"));
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

function directedQuestion(item: ReviewWorkItem): string {
  if (item.kind === "local") {
    return "Bounded question: Does the changed implementation contain one concrete executable correctness defect? If yes, report the strongest defect; otherwise return no candidates.";
  }
  const edgeKinds = new Set(item.graphEdges.map((edge) => edge.kind));
  const checks = [
    edgeKinds.has("calls") && "check argument, return-value, and unit compatibility",
    edgeKinds.has("reads-type") && "check nullability, discriminated variants, and value preservation",
    edgeKinds.has("exports") && "check public/API compatibility",
    (edgeKinds.has("producer-consumer") || edgeKinds.has("serialization")) && "check state, ownership, cleanup, and ordering invariants",
    (edgeKinds.has("schema-user") || edgeKinds.has("config")) && "check field, shape, and configuration compatibility",
  ].filter((value): value is string => Boolean(value));
  const focus = checks.length ? ` Specifically ${checks.join("; ")}.` : " Compare both sides for one concrete incompatible assumption.";
  return `Bounded question: Do the supplied relationship sides disagree for any concrete input, value, or state? If yes, report the strongest executable contract defect; otherwise return no candidates.${focus}`;
}

function candidateInstructions(maxCandidates: number, includeSummary = false, boundedEvidence = false) {
  const empty = includeSummary ? '{"summary":"concise review summary","c":[]}' : '{"c":[]}';
  const evidenceInstructions = boundedEvidence
    ? 'Request at most two evidence items using {"selector":"semantic selector key","r":"short reason"}. Use only keys from the supplied selector table; never invent hashes, symbols, paths, expressions, or selector keys. Every request is a required fact for adjudication.'
    : 'Request at most two evidence items using {"k":"kind","m":"symbol or literal","v":"required symbol or literal","p":"optional repository path","r":"short reason"}; v is always required. Use m=symbol for canonical symbol names only; never use a source expression, type union, path:line locator, boolean expression, or call expression as a symbol. Use m=literal for concrete value text or enum members. For a finite-value mapping, prefer a literal request for the exact discriminant or emitted value, plus a canonical producer or consumer symbol when relationship evidence is required; do not encode the field access or mapping expression as a symbol.';
  return `You are a bounded code-review candidate generator. Inspect only the supplied changed code and context for concrete executable defects: runtime behavior, value flow, failure paths, boundaries, and contracts. For interaction work, compare both sides of every supplied relationship, including callers/callees, producers/consumers, types, schemas, configuration, and tests. Enumerate supplied finite or discriminated values and report a concrete mismatch when changed branching collapses, relabels, or makes a value indistinguishable. Anchor each candidate to the smallest changed line that causes the defect. Do not report style, missing tests, instructions, filenames alone, or hypothetical risks. ${includeSummary ? "Return a concise inspection summary plus candidates; the summary must not claim global approval. " : ""}Use a concrete title naming the broken behavior and its contract or observable impact; do not use only a generic category. Format d as one compact string with three labeled claims: Trigger: <input/value>; Invariant: <violated contract>; Impact: <observable outcome>. Keep d under 240 characters. Generate zero to ${maxCandidates} distinct candidates and return ${empty} when none exists. Set q to a decimal from 0 to 1. ${evidenceInstructions} Every evidence request must name a required fact; claims about callers, consumers, downstream behavior, assumptions, or expectations must request evidence for the exact producer symbol. Return only the required compact JSON, with no prose or Markdown.`;
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
  allowedEvidenceSelectors?: readonly TaskEvidenceSelector[];
  signal?: AbortSignal;
}): Promise<CandidateBatch> {
  const focus =
    opts.item.kind === "interaction"
      ? "Compare both sides of each relationship for broken assumptions and incompatible contracts."
      : "Inspect the changed implementation for concrete local defects.";
  const selectors = opts.allowedEvidenceSelectors ?? [];
  const boundedSelectors = opts.allowedEvidenceSelectors !== undefined;
  const locatorInstructions = boundedSelectors
    ? "For this bounded task, every e entry must use {\"selector\":\"semantic selector key\",\"r\":\"short reason\"}. Do not return hashes, symbols, paths, v, m, p, i, k, or s in an evidence entry. Use e=[] when no evidence is needed."
    : "";
  const prompt = `${candidateInstructions(opts.maxCandidates, false, boundedSelectors)}\n${directedQuestion(opts.item)}\n${focus}\n${locatorInstructions}\n${selectorPromptText(selectors)}\n\n${workItemText(opts.item)}`;
  const candidateValueSchema = compactCandidateSchema;
  const boundedSchema = z.object({
    c: z.array(
      candidateValueSchema.extend({ e: z.array(boundedRequestSchema).max(boundedSelectors ? 2 : 0).default([]) }),
    ).max(opts.maxCandidates).default([]),
  });
  const { parsed, response, diagnostics } = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    prompt,
    sourceId: opts.item.id,
    outputKind: "candidates",
    allowedFiles: opts.allowedFiles,
    maxCandidates: opts.maxCandidates,
    evidenceSelectorKeys: selectors.map((selector) => selector.key),
    signal: opts.signal,
    validate: (value) => (boundedSelectors ? boundedSchema.parse(value) : compactCandidatesSchema(opts.maxCandidates).parse(value)),
  });
  const selectorMap = new Map(selectors.map((selector) => [selector.key, selector]));
  const contractDrops: NonNullable<CandidateBatch["contractDrops"]> = [];
  const candidates = parsed.c.flatMap((value, candidateIndex) => {
    try {
      const candidate = expandCandidate(value, opts.item.id, undefined, selectors.length ? selectorMap : undefined);
      if (boundedSelectors)
        candidate.evidenceRequests = [...candidate.evidenceRequests, ...deterministicEvidenceDefaults(selectors)];
      candidate.evidenceRequests = [...new Map(candidate.evidenceRequests.map((request) => [JSON.stringify(request), request])).values()].slice(0, 2);
      candidate.primarySymbol ??= opts.item.primarySymbols[0]?.qualifiedName;
      return [{ ...candidate, id: candidateId(candidate) }];
    } catch {
      // A bounded model response that names an unknown or incompatible locator
      // is an invalid candidate, not a reason to fail the whole review task.
      // The strict contract rejects it by omission and the eval attributes the
      // resulting miss to candidate quality.
      const request = value.e.find((entry) => "selector" in entry || "s" in entry);
      contractDrops.push({
        candidateIndex,
        reason: request ? "unknown-selector" : "invalid-selector",
        ...(request && "selector" in request ? { selector: request.selector } : {}),
      });
      return [];
    }
  });
  return {
    sourceId: opts.item.id,
    candidates,
    ...response.usage,
    prompt,
    raw: response.raw,
    completion: response.completion,
    diagnostics,
    contractDrops,
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
  const normalizeId = (id: string) => id.trim().replace(/^\[|\]$/g, "");
  const citationErrors = (parsed: z.infer<typeof verificationSchema>) => {
    const errors: string[] = [];
    const normalized = parsed.supportingEvidenceIds.map(normalizeId);
    const unknown = normalized.filter((id) => !opts.evidenceIds.includes(id));
    if (unknown.length) errors.push(`unknown or malformed evidence IDs: ${unknown.join(", ")}`);
    const exact = normalized.filter((id) => opts.evidenceIds.includes(id));
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
        rawVerdict: first.parsed.verdict,
        rawConfidence: first.parsed.confidence,
        rawSupportingEvidenceIds: first.parsed.supportingEvidenceIds,
        supportingEvidenceIds: first.parsed.supportingEvidenceIds.map(normalizeId),
        prompt,
        raw: first.response.raw,
        completion: first.response.completion,
        diagnostics: first.diagnostics,
        providerInvocations: 1 + first.diagnostics.length,
      },
      ...first.response.usage,
    };
  const firstCitationDiagnostic = diagnostic(first.response, prompt, 1, firstErrors);
  const initialExactIds = first.parsed.supportingEvidenceIds
    .map(normalizeId)
    .filter((id) => opts.evidenceIds.includes(id));
  const missingGroups = Object.entries(opts.requiredEvidenceIdsByRequest ?? {}).filter(
    ([, ids]) => !ids.some((id) => initialExactIds.includes(id)),
  );
  if (first.parsed.verdict !== "insufficient_evidence" && !initialExactIds.length && !missingGroups.length)
    missingGroups.push(["verdict-citation", opts.evidenceIds]);
  const requiredCitationGroups = missingGroups
    .map(([requestId, ids]) => `- request ${requestId}: choose exactly one of ${ids.join(", ")}`)
    .join("\n");
  const repairPrompt = `Select citations only. Do not restate or change the verdict, confidence, or reasoning. For every listed request, choose one exact allowed evidence ID. Return only {"citations":[{"requestId":"...","evidenceId":"..."}]}.\n\nMissing citation groups:\n${requiredCitationGroups || "(none)"}`;
  const repaired = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    sourceId: opts.candidate.id,
    outputKind: "citation-selection",
    prompt: repairPrompt,
    signal: opts.signal,
    validate: (value) => citationSelectionSchema.parse(value),
  });
  const allowedByRequest = new Map(missingGroups);
  const selectedIds: string[] = [];
  const selectionErrors: string[] = [];
  for (const citation of repaired.parsed.citations) {
    const evidenceId = normalizeId(citation.evidenceId);
    const allowed = allowedByRequest.get(citation.requestId);
    if (!allowed) selectionErrors.push(`unknown citation request ${citation.requestId}`);
    else if (!allowed.includes(evidenceId))
      selectionErrors.push(`evidence ${evidenceId} is not allowed for request ${citation.requestId}`);
    else selectedIds.push(evidenceId);
  }
  for (const [requestId, ids] of missingGroups)
    if (
      !repaired.parsed.citations.some(
        (item) => item.requestId === requestId && ids.includes(normalizeId(item.evidenceId)),
      )
    )
      selectionErrors.push(`required request ${requestId} is not cited`);
  const mergedIds = [...new Set([...initialExactIds, ...selectedIds])];
  const repairedVerdict = { ...first.parsed, supportingEvidenceIds: mergedIds };
  const repairedErrors = [...selectionErrors, ...citationErrors(repairedVerdict)];
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
        rawVerdict: first.parsed.verdict,
        rawConfidence: first.parsed.confidence,
        rawSupportingEvidenceIds: first.parsed.supportingEvidenceIds,
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
      ...first.parsed,
      rawVerdict: first.parsed.verdict,
      rawConfidence: first.parsed.confidence,
      rawSupportingEvidenceIds: first.parsed.supportingEvidenceIds,
      supportingEvidenceIds: mergedIds,
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
