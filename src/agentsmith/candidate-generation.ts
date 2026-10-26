import { z } from "zod";
import { sha256 } from "../core/hash.js";
import type { CandidateFinding, ModelProfile } from "../core/types.js";
import type { AgentDef } from "./types.js";
import type { TaskEvidenceSelector } from "./evidence-locators.js";
import { selectorPromptText, selectorToEvidenceRequest } from "./evidence-locators.js";
import { reviewOutputSchema, type ProviderCompletionMetadata, type ProviderResponse, type ReviewOutputKind, type ReviewProvider } from "./provider.js";
import type {
  CandidateBatch,
  CandidateConclusion,
  CandidateConclusionDecision,
  CandidateGenerationArm,
  CandidateInferenceMode,
  CandidatePromptVariant,
  ProviderFailureDiagnostic,
  ReviewProjection,
  ReviewWorkItem,
  ScoutFinding,
  VerificationResult,
} from "./engine-types.js";

const BRANCH_ANALYSIS_BEHAVIOR_PROMPT = `You are performing bounded executable code-review analysis.

Before deciding whether to report a candidate, analyze the runtime behavior of each changed conditional or condition that can affect the reviewed behavior.

Prioritize:
- nullable or optional values;
- boolean guards and short-circuit operands;
- discriminated unions;
- finite enums or declared role/value sets;
- conditions that determine whether the code throws, returns, authorizes, transforms, or forwards a value.

For each relevant runtime state:
1. Identify the concrete input or value.
2. Evaluate each boolean operand in source order.
3. Apply short-circuit semantics exactly as written.
4. Determine whether execution throws, returns, skips a guard, or reaches the changed boundary.
5. Compare the observed behavior with the supplied type, contract, or security rule.

Do not analyze unrelated conditions. Do not infer behavior from variable names or intended semantics. Do not replace the condition that is written with the condition the author may have intended.

The candidate decision must be derived from the behavioral comparison above.
If a concrete runtime state violates a supplied type, contract, or security rule, preserve that failing state in the final candidate. The candidate trigger must describe the runtime state that actually demonstrates the defect, and the invariant must describe the supplied rule that state violates.

Do not discard a demonstrated failing runtime state while converting the analysis into the final structured response. Do not substitute another branch merely because it is syntactically earlier or more obvious.

`;

const BRANCH_ANALYSIS_STATE_SCAN_PROMPT = `${BRANCH_ANALYSIS_BEHAVIOR_PROMPT}Use a compact state scan, not a narrative explanation.

For every changed condition with a finite state space, enumerate each relevant state exactly once. For each state, internally record only:

state → operands in source order → short-circuit result → observable outcome.

Do not restate the task, source code, types, rules, or a state already evaluated. Do not reconsider a completed state.

`;

const BRANCH_ANALYSIS_DELTA_FIRST_PROMPT = `${BRANCH_ANALYSIS_BEHAVIOR_PROMPT}Use a delta-first compact state scan, not a narrative explanation. When the work item supplies a host-derived control-flow delta state, evaluate that state before any other runtime state, internally recording: state → operands in source order → short-circuit result → observable outcome → applicable visible rule. Do not restate the task, source code, types, rules, or delta. If the evaluated state demonstrates a visible-rule violation, form the candidate decision immediately; otherwise evaluate each remaining relevant state exactly once. Treat the delta as evidence to evaluate, not proof of a defect, and do not reconsider a completed state.

`;

const BRANCH_ANALYSIS_TYPE_OUTCOME_PROMPT = `${BRANCH_ANALYSIS_BEHAVIOR_PROMPT}A type or signature describes values that may arrive at a boundary. It does not by itself require every value to succeed, continue, authorize, return normally, or bypass a guard.

Treat a rejection as defective only when a supplied rule or concrete producer/consumer contract requires that state to proceed. Do not invent a success-path requirement from nullability, optionality, or union membership.

`;

const BRANCH_ANALYSIS_GUARD_PASS_THROUGH_PROMPT = `${BRANCH_ANALYSIS_BEHAVIOR_PROMPT}For any changed guard that can throw, return, skip work, or gate a visible effect, evaluate both its blocking and pass-through states.

When choosing a candidate, prioritize a concrete state that passes or short-circuits the guard and reaches the affected effect despite a value distinction expressed by that guard. Do not choose a blocking state as the defect unless a supplied rule requires that state to pass.

`;

function branchAnalysisSystemPrompt(behavior: string, providerOwnsSerialization: boolean) {
  return `${behavior}
${providerOwnsSerialization
  ? "The serving API supplies and enforces the response schema. Populate the schema's semantic fields from the behavioral comparison. Do not emit analysis, a truth table, or prose outside the provider-defined response."
  : "Only after completing that behavioral comparison, emit the required candidate JSON response. Do not emit the analysis, a truth table, or any prose outside the required JSON object. Preserve the existing candidate schema and report only concrete executable defects supported by the supplied work item."}`;
}

export const BRANCH_ANALYSIS_SYSTEM_PROMPT = branchAnalysisSystemPrompt(BRANCH_ANALYSIS_BEHAVIOR_PROMPT, false);

const branchAnalysisBehaviorByVariant: Partial<Record<CandidatePromptVariant, string>> = {
  "branch-analysis-v1": BRANCH_ANALYSIS_BEHAVIOR_PROMPT,
  "branch-analysis-state-scan-v2": BRANCH_ANALYSIS_STATE_SCAN_PROMPT,
  "branch-analysis-delta-first-v3": BRANCH_ANALYSIS_DELTA_FIRST_PROMPT,
  "branch-analysis-type-outcome-v2": BRANCH_ANALYSIS_TYPE_OUTCOME_PROMPT,
  "branch-analysis-guard-pass-through-v2": BRANCH_ANALYSIS_GUARD_PASS_THROUGH_PROMPT,
};

function candidateSystemPrompt(
  variant: CandidatePromptVariant | undefined,
  arm: CandidateGenerationArm,
  provider: ModelProfile["provider"],
  inferenceMode: CandidateInferenceMode | undefined,
): string | undefined {
  const behavior = variant ? branchAnalysisBehaviorByVariant[variant] : undefined;
  if ((arm === "simplified-contract" || arm === "rule-bound-classification") && behavior)
    return branchAnalysisSystemPrompt(behavior, ["ollama", "vllm", "openai-responses"].includes(provider) && inferenceMode === "thinking-structured");
  return undefined;
}

export const CONCLUSION_REASONER_SYSTEM_PROMPT = `${BRANCH_ANALYSIS_SYSTEM_PROMPT}

You may emit ordinary analysis for diagnostics, but you must end with exactly one compact conclusion block in this exact form:
BEGIN_CONCLUSION
DECISION: finding|no_finding|insufficient_context
DECISIVE_RUNTIME_STATE: <concrete runtime state or none>
EVALUATION:
<key> = <value>
VIOLATED_RULE: <supplied rule or none>
DEFECT: <concrete defect or none>
END_CONCLUSION

Use one or more concise key/value lines under EVALUATION. For a finding, preserve the concrete failing runtime state, violated rule, and defect. For no_finding or insufficient_context, use none for VIOLATED_RULE and DEFECT. Do not put candidate JSON in the conclusion block.`;

export const CONCLUSION_FORMATTER_SYSTEM_PROMPT = `You are a strict candidate JSON formatter. Serialize only the supplied conclusion into the required candidate schema.

Do not re-analyze the source. Do not select a different runtime state. Do not introduce a new defect. Do not broaden or narrow the trigger. Use only DECISION, DECISIVE_RUNTIME_STATE, VIOLATED_RULE, and DEFECT from the supplied conclusion.

If DECISION is finding, serialize that finding. If DECISION is no_finding, return no_finding. If DECISION is insufficient_context, return insufficient_context. Return only the required JSON object.`;

export class CandidateConclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateConclusionError";
  }
}

export const REASONER_CONTEXT_TOKENS = 32_768;
export const REASONER_OUTPUT_TOKENS = 16_384;

function parseConclusionField(block: string, label: string): string {
  const match = new RegExp(`^${label}:\\s*(.*)$`, "m").exec(block);
  if (!match?.[1]?.trim()) throw new CandidateConclusionError(`reasoner conclusion missing ${label}`);
  return match[1].trim();
}

export function parseCandidateConclusion(source: string): CandidateConclusion {
  const starts = source.match(/BEGIN_CONCLUSION/g) ?? [];
  const ends = source.match(/END_CONCLUSION/g) ?? [];
  if (starts.length !== 1 || ends.length !== 1) throw new CandidateConclusionError("reasoner conclusion must contain exactly one bounded block");
  const match = /BEGIN_CONCLUSION\s*\n([\s\S]*?)\nEND_CONCLUSION/.exec(source);
  if (!match) throw new CandidateConclusionError("reasoner conclusion block is malformed");
  const block = match[1];
  const decision = parseConclusionField(block, "DECISION") as CandidateConclusionDecision;
  if (!["finding", "no_finding", "insufficient_context"].includes(decision))
    throw new CandidateConclusionError(`invalid reasoner decision: ${decision}`);
  const decisiveRuntimeState = parseConclusionField(block, "DECISIVE_RUNTIME_STATE");
  const violatedRule = parseConclusionField(block, "VIOLATED_RULE");
  const defect = parseConclusionField(block, "DEFECT");
  const evaluationStart = block.indexOf("EVALUATION:");
  const evaluationEnd = block.indexOf("VIOLATED_RULE:");
  if (evaluationStart < 0 || evaluationEnd <= evaluationStart) throw new CandidateConclusionError("reasoner conclusion missing EVALUATION");
  const evaluation: Record<string, string> = {};
  for (const line of block.slice(evaluationStart + "EVALUATION:".length, evaluationEnd).trim().split("\n")) {
    const entry = /^(?<key>[a-z][a-z0-9_]*)\s*=\s*(?<value>.+)$/.exec(line.trim());
    if (!entry?.groups?.key || !entry.groups.value) throw new CandidateConclusionError("reasoner evaluation must contain key/value lines");
    if (evaluation[entry.groups.key] !== undefined) throw new CandidateConclusionError(`duplicate reasoner evaluation key: ${entry.groups.key}`);
    evaluation[entry.groups.key] = entry.groups.value.trim();
  }
  if (!Object.keys(evaluation).length) throw new CandidateConclusionError("reasoner conclusion evaluation is empty");
  if (decision === "finding" && [decisiveRuntimeState, violatedRule, defect].some((value) => value === "none"))
    throw new CandidateConclusionError("finding conclusion must preserve runtime state, violated rule, and defect");
  if (decision !== "finding" && (violatedRule !== "none" || defect !== "none"))
    throw new CandidateConclusionError("non-finding conclusion must use none for rule and defect");
  return { decision, decisiveRuntimeState, evaluation, violatedRule, defect };
}

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
const simplifiedCandidateSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    category: z.enum(["correctness", "security", "performance", "contract"]),
    trigger: z.string().min(1).max(160),
    invariant: z.string().min(1).max(240),
    impact: z.string().min(1).max(240),
    confidence: z.number().min(0).max(1),
    basisRuleId: z.string().min(1).optional(),
  })
  .strict();
const simplifiedCandidateResponseSchema = z
  .object({
    state: z.enum(["finding", "no_finding", "insufficient_context"]),
    candidates: z.array(simplifiedCandidateSchema).max(2).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.state === "finding" && value.candidates.length === 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "finding state requires at least one candidate" });
    if (value.state !== "finding" && value.candidates.length > 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.state} state cannot contain candidates` });
  });
const workItemCandidateResponseSchema = (maxCandidates: number) =>
  z.union([
    simplifiedCandidateResponseSchema,
    z.object({
      c: z.array(
        compactCandidateSchema.extend({ e: z.array(boundedRequestSchema).max(2).default([]) }),
      ).max(maxCandidates).default([]),
    }),
    compactCandidatesSchema(maxCandidates),
  ]);
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
      thinking: opts.response.thinking,
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
  allowedRuleIds?: string[];
  candidateArm?: CandidateGenerationArm;
  inferenceMode?: CandidateInferenceMode;
  systemPrompt?: string;
  inferenceOverrides?: { contextTokens?: number; outputTokens?: number; thinkingTokens?: number };
  stream?: boolean;
  streamTracePath?: string;
  repairInvalid?: boolean;
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
      allowedRuleIds: opts.allowedRuleIds,
      candidateArm: opts.candidateArm,
      inferenceMode: opts.inferenceMode,
      systemPrompt: opts.systemPrompt,
      inferenceOverrides: opts.inferenceOverrides,
      stream: opts.stream,
      streamTracePath: opts.streamTracePath,
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
    if (!(error instanceof StructuredOutputError) || opts.signal?.aborted || opts.repairInvalid === false) throw error;
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

function expandSimplifiedCandidate(
  value: z.infer<typeof simplifiedCandidateSchema>,
  item: ReviewWorkItem,
  selectors: readonly TaskEvidenceSelector[],
  arm: CandidateGenerationArm,
): Omit<CandidateFinding, "id"> {
  const basisRule = arm === "rule-bound-classification"
    ? item.rules.find((rule) => rule.id === value.basisRuleId)
    : undefined;
  // Validation guarantees a basis rule for the rule-bound arm. Keep this
  // defensive guard so host normalization never invents a policy mapping.
  if (arm === "rule-bound-classification" && !basisRule)
    throw new CandidateConclusionError("rule-bound candidate omitted a visible basis rule");
  const category = basisRule?.categories.length === 1 ? basisRule.categories[0] : value.category;
  const severity = basisRule?.severity ?? value.severity;
  const primarySymbol = item.primarySymbols[0]?.qualifiedName;
  const title = `${category} defect: ${value.invariant}`;
  const description = `Trigger: ${value.trigger} Invariant: ${value.invariant} Impact: ${value.impact}`;
  return {
    sourceWorkItemIds: [item.id],
    sourceReviewers: [],
    file: value.file,
    line: value.line,
    endLine: value.endLine,
    severity,
    category,
    title,
    description,
    primarySymbol,
    ruleId: basisRule?.id ?? item.rules[0]?.id,
    ...(basisRule
      ? {
          classification: {
            basisRuleId: basisRule.id,
            categorySource: basisRule.categories.length === 1 ? ("rule" as const) : ("model" as const),
            severitySource: basisRule.severity ? ("rule" as const) : ("model" as const),
          },
        }
      : {}),
    candidateConfidence: value.confidence,
    evidenceRequests: deterministicEvidenceDefaults(selectors),
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

function workItemText(item: ReviewWorkItem, includeRuleClassification = false) {
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
    ...item.rules.map((rule) => {
      if (!includeRuleClassification) return `- ${rule.id}: ${rule.text}`;
      const classification = [
        `categories: ${rule.categories.join(", ")}`,
        ...(rule.severity ? [`severity: ${rule.severity}`] : []),
      ].join("; ");
      return `- ${rule.id} [${classification}]: ${rule.text}`;
    }),
    ...(item.controlFlowDeltas?.length
      ? [
          "Control-flow delta (host-derived; it is not itself a finding or policy rule):",
          ...item.controlFlowDeltas.map(
            (delta) =>
              `- ${delta.file}:${delta.startLine}; state ${delta.state}; previous guard ${delta.previousOutcome}; current guard ${delta.currentOutcome}.`,
          ),
        ]
      : []),
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

function candidateInstructions(maxCandidates: number, includeSummary = false, boundedEvidence = false, providerOwnsSerialization = false) {
  const empty = includeSummary ? '{"summary":"concise review summary","c":[]}' : '{"c":[]}';
  const evidenceInstructions = boundedEvidence
    ? 'Request at most two evidence items using {"selector":"semantic selector key","r":"short reason"}. Use only keys from the supplied selector table; never invent hashes, symbols, paths, expressions, or selector keys. Every request is a required fact for adjudication.'
    : 'Request at most two evidence items using {"k":"kind","m":"symbol or literal","v":"required symbol or literal","p":"optional repository path","r":"short reason"}; v is always required. Use m=symbol for canonical symbol names only; never use a source expression, type union, path:line locator, boolean expression, or call expression as a symbol. Use m=literal for concrete value text or enum members. For a finite-value mapping, prefer a literal request for the exact discriminant or emitted value, plus a canonical producer or consumer symbol when relationship evidence is required; do not encode the field access or mapping expression as a symbol.';
  const serializationInstructions = providerOwnsSerialization
    ? "The serving API supplies and enforces the response schema. Populate its semantic fields from the inspection; do not emit analysis or prose outside the provider-defined response."
    : `Generate zero to ${maxCandidates} distinct candidates and return ${empty} when none exists. Set q to a decimal from 0 to 1. Every evidence request must name a required fact; claims about callers, consumers, downstream behavior, assumptions, or expectations must request evidence for the exact producer symbol. Return only the required compact JSON, with no prose or Markdown.`;
  return `You are a bounded code-review candidate generator. Inspect only the supplied changed code and context for concrete executable defects: runtime behavior, value flow, failure paths, boundaries, and contracts. For interaction work, compare both sides of every supplied relationship, including callers/callees, producers/consumers, types, schemas, configuration, and tests. Enumerate supplied finite or discriminated values and report a concrete mismatch when changed branching collapses, relabels, or makes a value indistinguishable. Anchor each candidate to the smallest changed line that causes the defect. Do not report style, missing tests, instructions, filenames alone, or hypothetical risks. ${includeSummary ? "Return a concise inspection summary plus candidates; the summary must not claim global approval. " : ""}Use a concrete title naming the broken behavior and its contract or observable impact; do not use only a generic category. Format d as one compact string with three labeled claims: Trigger: <input/value>; Invariant: <violated contract>; Impact: <observable outcome>. Keep d under 240 characters. ${evidenceInstructions} ${serializationInstructions}`;
}

function simplifiedCandidateInstructions(maxCandidates: number, providerOwnsSerialization = false) {
  if (providerOwnsSerialization)
    return `Inspect only the supplied changed code and context for concrete executable defects. A supplied Control-flow delta is mechanically derived context: inspect any newly admitted or newly blocked concrete state before choosing a candidate, but do not treat the delta itself as proof of a policy violation. Do not report style, missing tests, instructions, filenames alone, or hypothetical risks. Determine whether the bounded task is a finding, no_finding, or insufficient_context. For a finding, populate the provider-defined candidate fields file, line, optional endLine, severity, category, trigger, invariant, impact, and confidence. The host derives title, primary symbol, rule identifier, evidence requests, and attribution fields. The serving API supplies and enforces the response schema; do not emit analysis or prose outside the provider-defined response.`;
  return `Inspect only the supplied changed code and context for concrete executable defects. A supplied Control-flow delta is mechanically derived context: inspect any newly admitted or newly blocked concrete state before choosing a candidate, but do not treat the delta itself as proof of a policy violation. Do not report style, missing tests, instructions, filenames alone, or hypothetical risks. Return exactly one JSON object with state set to finding, no_finding, or insufficient_context and a candidates array with at most ${maxCandidates} items. A finding requires at least one candidate; the other states require an empty candidates array. Each candidate must contain only file, line, optional endLine, severity, category, trigger, invariant, impact, and confidence. The host derives the title, primary symbol, rule identifier, evidence requests, and attribution fields. Do not emit evidence requests, selectors, hashes, symbols, paths with line numbers, suggestions, or prose outside the JSON object.`;
}

function ruleBoundClassificationInstructions(providerOwnsSerialization = false) {
  const serialization = providerOwnsSerialization
    ? "The serving API supplies and enforces the response schema."
    : "Return only the required JSON object.";
  return `Each finding must name basisRuleId: exactly one visible rule whose stated requirement the concrete runtime state violates. Do not select a rule merely because its keywords appear in code. Select security.authorization-boundary only when the candidate demonstrates an executable authorization bypass. The host validates basisRuleId and derives category when that rule has one declared category and severity when that rule declares one. ${serialization}`;
}

function validateRuleBoundCandidateResponse(value: unknown, maxCandidates: number, item: ReviewWorkItem) {
  const parsed = simplifiedCandidateResponseSchema.parse(value);
  if (parsed.candidates.length > maxCandidates)
    throw new z.ZodError([{ code: z.ZodIssueCode.too_big, maximum: maxCandidates, type: "array", inclusive: true, path: ["candidates"], message: `at most ${maxCandidates} candidates are allowed` }]);
  const allowedRuleIds = new Set(item.rules.map((rule) => rule.id));
  for (const [index, candidate] of parsed.candidates.entries()) {
    if (!candidate.basisRuleId || !allowedRuleIds.has(candidate.basisRuleId))
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["candidates", index, "basisRuleId"], message: "basisRuleId must name one visible work-item rule" }]);
  }
  return parsed;
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
    thinking: response.thinking,
    reasoningSummary: response.reasoningSummary,
    completion: response.completion,
    diagnostics,
  };
}

async function generateConclusionThenStructuredCandidate(opts: {
  item: ReviewWorkItem;
  profile: ModelProfile;
  provider: ReviewProvider;
  allowedFiles: string[];
  maxCandidates: number;
  allowedEvidenceSelectors: readonly TaskEvidenceSelector[];
  arm: CandidateGenerationArm;
  stream?: boolean;
  streamTraceDir?: string;
  thinkingTokens?: number;
  signal?: AbortSignal;
}): Promise<CandidateBatch> {
  if (opts.arm !== "simplified-contract")
    throw new CandidateConclusionError("thinking-conclusion-then-structured requires simplified-contract");
  const focus =
    opts.item.kind === "interaction"
      ? "Compare both sides of each relationship for broken assumptions and incompatible contracts."
      : "Inspect the changed implementation for concrete local defects.";
  const reasonerPrompt = `${directedQuestion(opts.item)}\n${focus}\nDo not request more context; reason only from the supplied bounded task. Analyze the runtime states and finish with the required conclusion block.\n\n${workItemText(opts.item)}`;
  const reasoner = await opts.provider.invoke({
    profile: opts.profile,
    prompt: reasonerPrompt,
    outputKind: "candidates",
    allowedFiles: opts.allowedFiles,
    maxCandidates: opts.maxCandidates,
    candidateArm: opts.arm,
    inferenceMode: "thinking-no-format",
    systemPrompt: CONCLUSION_REASONER_SYSTEM_PROMPT,
    inferenceOverrides: { contextTokens: REASONER_CONTEXT_TOKENS, outputTokens: REASONER_OUTPUT_TOKENS },
    stream: opts.stream,
    ...(opts.streamTraceDir
      ? { streamTracePath: `${opts.streamTraceDir}/${opts.item.id.replace(/[^A-Za-z0-9._-]/g, "_")}-reasoner.ndjson` }
      : {}),
    signal: opts.signal,
  });
  const conclusion = parseCandidateConclusion(reasoner.raw);
  const formatterPrompt = `Original bounded work item:\n\n${workItemText(opts.item)}\n\nNormalized conclusion:\nDECISION: ${conclusion.decision}\nDECISIVE_RUNTIME_STATE: ${conclusion.decisiveRuntimeState}\nVIOLATED_RULE: ${conclusion.violatedRule}\nDEFECT: ${conclusion.defect}\n\nSerialize the normalized conclusion according to the required candidate schema.`;
  const { parsed, response, diagnostics } = await invokeStructured({
    provider: opts.provider,
    profile: opts.profile,
    prompt: formatterPrompt,
    sourceId: opts.item.id,
    outputKind: "candidates",
    allowedFiles: opts.allowedFiles,
    maxCandidates: opts.maxCandidates,
    evidenceSelectorKeys: opts.allowedEvidenceSelectors.map((selector) => selector.key),
    candidateArm: opts.arm,
    inferenceMode: "structured",
    systemPrompt: CONCLUSION_FORMATTER_SYSTEM_PROMPT,
    repairInvalid: false,
    signal: opts.signal,
    validate: (value) => simplifiedCandidateResponseSchema.parse(value),
  });
  if (parsed.state !== conclusion.decision || (conclusion.decision === "finding" ? parsed.candidates.length === 0 : parsed.candidates.length > 0))
    throw new CandidateConclusionError("formatter decision does not match reasoner conclusion");
  const candidates = parsed.candidates.map((value) => ({
    ...expandSimplifiedCandidate(value, opts.item, opts.allowedEvidenceSelectors, opts.arm),
    id: candidateId(expandSimplifiedCandidate(value, opts.item, opts.allowedEvidenceSelectors, opts.arm)),
  }));
  return {
    sourceId: opts.item.id,
    candidateState: parsed.state,
    candidates,
    inputTokens: reasoner.usage.inputTokens + response.usage.inputTokens,
    outputTokens: reasoner.usage.outputTokens + response.usage.outputTokens,
    prompt: formatterPrompt,
    raw: response.raw,
    thinking: response.thinking,
    completion: response.completion,
    reasonerRaw: reasoner.raw,
    reasonerThinking: reasoner.thinking,
    reasonerCompletion: reasoner.completion,
    conclusion,
    formatterRaw: response.raw,
    formatterCompletion: response.completion,
    reasonerDiagnostics: [],
    formatterDiagnostics: diagnostics,
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
  arm?: CandidateGenerationArm;
  inferenceMode?: CandidateInferenceMode;
  promptVariant?: CandidatePromptVariant;
  stream?: boolean;
  streamTraceDir?: string;
  thinkingTokens?: number;
  signal?: AbortSignal;
}): Promise<CandidateBatch> {
  const arm = opts.arm ?? "simplified-contract";
  if (opts.inferenceMode === "thinking-conclusion-then-structured")
    return generateConclusionThenStructuredCandidate({
      item: opts.item,
      profile: opts.profile,
      provider: opts.provider,
      allowedFiles: opts.allowedFiles,
      maxCandidates: opts.maxCandidates,
      allowedEvidenceSelectors: opts.allowedEvidenceSelectors ?? [],
      arm,
      stream: opts.stream,
      streamTraceDir: opts.streamTraceDir,
      thinkingTokens: opts.thinkingTokens,
      signal: opts.signal,
    });
  const focus =
    opts.item.kind === "interaction"
      ? "Compare both sides of each relationship for broken assumptions and incompatible contracts."
      : "Inspect the changed implementation for concrete local defects.";
  const selectors = opts.allowedEvidenceSelectors ?? [];
  const boundedSelectors = opts.allowedEvidenceSelectors !== undefined;
  const ruleBound = arm === "rule-bound-classification";
  const legacy = arm !== "simplified-contract" && !ruleBound;
  const providerOwnsSerialization = ["ollama", "vllm", "openai-responses"].includes(opts.profile.provider) && opts.inferenceMode === "thinking-structured";
  const systemPrompt = candidateSystemPrompt(opts.promptVariant, arm, opts.profile.provider, opts.inferenceMode);
  const outputSchema = reviewOutputSchema(
    "candidates",
    opts.allowedFiles,
    opts.maxCandidates,
    selectors.map((selector) => selector.key),
    arm,
    ruleBound ? opts.item.rules.map((rule) => rule.id) : undefined,
  );
  const prompt = legacy
    ? `${candidateInstructions(opts.maxCandidates, false, arm === "host-defaults" && boundedSelectors, providerOwnsSerialization)}\n${directedQuestion(opts.item)}\n${focus}\n${arm === "host-defaults" ? selectorPromptText(selectors) : "Evidence is owned by the host; do not request selectors."}\n\n${workItemText(opts.item)}`
    : `${simplifiedCandidateInstructions(opts.maxCandidates, providerOwnsSerialization)}${ruleBound ? `\n${ruleBoundClassificationInstructions(providerOwnsSerialization)}` : ""}\n${directedQuestion(opts.item)}\n${focus}\nDo not request more context; reason only from the supplied bounded task.\n\n${workItemText(opts.item, ruleBound)}`;
  const legacySchema = z.object({
    c: z.array(
      compactCandidateSchema.extend({
        e: z.array(arm === "host-defaults" && boundedSelectors ? boundedRequestSchema : compactRequestSchema)
          .max(2)
          .default([]),
      }),
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
    // Keep the selector table available to the bounded repair path even when a
    // compatibility fixture returns the legacy shape under the simplified arm.
    evidenceSelectorKeys: selectors.map((selector) => selector.key),
    ...(ruleBound ? { allowedRuleIds: opts.item.rules.map((rule) => rule.id) } : {}),
    candidateArm: arm,
    inferenceMode: opts.inferenceMode,
    systemPrompt,
    ...(opts.thinkingTokens !== undefined ? { inferenceOverrides: { thinkingTokens: opts.thinkingTokens } } : {}),
    stream: opts.stream,
    ...(opts.streamTraceDir
      ? { streamTracePath: `${opts.streamTraceDir}/${opts.item.id.replace(/[^A-Za-z0-9._-]/g, "_")}.ndjson` }
      : {}),
    repairInvalid: opts.inferenceMode !== "thinking-structured",
    signal: opts.signal,
    validate: (value) =>
      legacy
        ? legacySchema.parse(value)
        : ruleBound
          ? validateRuleBoundCandidateResponse(value, opts.maxCandidates, opts.item)
          : workItemCandidateResponseSchema(opts.maxCandidates).parse(value),
  });
  const selectorMap = new Map(selectors.map((selector) => [selector.key, selector]));
  const contractDrops: NonNullable<CandidateBatch["contractDrops"]> = [];
  const candidates = "state" in parsed
    ? parsed.candidates.map((value) => {
        const candidate = expandSimplifiedCandidate(value, opts.item, selectors, arm);
        return { ...candidate, id: candidateId(candidate) };
      })
    : parsed.c.flatMap((value, candidateIndex) => {
        try {
          const candidate = expandCandidate(value, opts.item.id, undefined, selectors.length ? selectorMap : undefined);
          if (boundedSelectors && (arm === "host-defaults" || !(("state" in parsed))))
            candidate.evidenceRequests = [...candidate.evidenceRequests, ...deterministicEvidenceDefaults(selectors)];
          if (arm === "deterministic-evidence") candidate.evidenceRequests = deterministicEvidenceDefaults(selectors);
          if (arm === "host-derived-metadata") {
            candidate.primarySymbol = opts.item.primarySymbols[0]?.qualifiedName;
            candidate.ruleId = opts.item.rules[0]?.id;
            candidate.title = `${candidate.category} defect: ${candidate.description.split(".")[0]}`.slice(0, 80);
          }
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
    candidateState: "state" in parsed ? parsed.state : candidates.length ? "finding" : "no_finding",
    candidates,
    ...response.usage,
    prompt,
    contract: {
      candidateArm: arm,
      inferenceMode: opts.inferenceMode,
      promptVariant: opts.promptVariant,
      systemPromptSha256: sha256(systemPrompt ?? ""),
      outputSchemaSha256: sha256(JSON.stringify(outputSchema)),
    },
    raw: response.raw,
    thinking: response.thinking,
    reasoningSummary: response.reasoningSummary,
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
