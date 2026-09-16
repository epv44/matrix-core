import fs from "node:fs";
import path from "node:path";
import type {
  AgentSmithConfig,
  CandidateFinding,
  CandidateResolutionAudit,
  CandidateResolutionReasonCode,
  EvidenceRecord,
  EvidenceResolutionOutcome,
  ModelProfile,
  ReviewCoverage,
  ReviewFinding,
  ReviewResult,
} from "../core/types.js";
import { emptyReviewCoverage } from "../core/reviewer.js";
import { repositoryGraph } from "../core/graph/index.js";
import type { ReviewProvider } from "./provider.js";
import type { ReviewScope } from "./scope.js";
import { loadStructuredRules } from "./rules.js";
import {
  buildProjection,
  buildCandidateProjection,
  buildWorkItems,
  DEGREE_CAP,
  estimateTokens,
  MAX_DEGREE_BOOST,
  projectionBudget,
  rankWorkItems,
  routeReview,
  selectWorkItems,
} from "./projection.js";
import {
  VERIFICATION_INSTRUCTIONS,
  VERIFICATION_LABELS,
  StructuredOutputError,
  generateSpecialistCandidates,
  generateWorkItemCandidate,
  runScout,
  verifyCandidateWithModel,
} from "./candidate-generation.js";
import { candidateAnchorIssue, evidenceRequestId, resolveEvidenceRequests } from "./evidence.js";
import { buildTaskEvidenceLocatorTable, canonicalEvidenceLocatorTable, locatorToEvidenceRequest } from "./evidence-locators.js";
import type {
  CandidateBatch,
  ContractShadowAudit,
  ContractShadowAuditEntry,
  EngineExecution,
  ReviewWorkItem,
  VerificationResult,
} from "./engine-types.js";
import { computeWorkspaceVersion } from "../core/version.js";
import { AGENTSMITH_STRATEGY_HASH } from "./strategy.js";
import { loadSpecialists } from "./registry.js";
import { sha256, sha256Json } from "../core/hash.js";
import { atomicWriteFile } from "../core/filesystem.js";
import {
  CANDIDATE_RESULT_VERSION,
  REVIEW_TASK_VERSION,
  deterministicReviewDescriptorFingerprint,
  deterministicReviewTaskId,
  deterministicReviewUnitId,
  serializeReviewContract,
  validateReviewTask,
  type ContextRef,
  type ReviewTask,
  type ReviewUnit,
  type SourceRange,
} from "../core/review-contracts.js";

function profile(config: AgentSmithConfig, id: string | undefined, role: string): ModelProfile {
  if (!id) throw new Error(`Review ${role} model profile is not configured`);
  const found = config.model_profiles.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Review ${role} model profile is not approved: ${id}`);
  return found;
}

function captureProviderFailure(error: unknown, failures: NonNullable<EngineExecution["providerFailures"]>) {
  if (error instanceof StructuredOutputError) failures.push(...error.diagnostics);
}

function compactDeterministicReport(report?: string): string | undefined {
  if (!report) return report;
  try {
    const parsed = JSON.parse(report) as { status?: unknown };
    if (parsed.status === "PASS") return "Deterministic gate: PASS";
  } catch {
    // Preserve useful non-JSON diagnostics below.
  }
  return report.slice(0, 2_000);
}

export function isFreshDescriptorCacheEntry<T>(
  cached: unknown,
  descriptorFingerprint: string,
): cached is { schemaVersion: 1; descriptorFingerprint: string; value: T } {
  if (!cached || typeof cached !== "object") return false;
  const entry = cached as { schemaVersion?: unknown; descriptorFingerprint?: unknown; value?: unknown };
  return entry.schemaVersion === 1 && entry.descriptorFingerprint === descriptorFingerprint && entry.value !== undefined;
}

async function cachedStage<T>(opts: {
  root: string;
  enabled: boolean;
  stage: string;
  key: unknown;
  descriptorFingerprint: string;
  run: () => Promise<T>;
}): Promise<{ value: T; cacheStatus: "hit" | "miss"; stale: boolean }> {
  const digest = sha256Json({ strategyHash: AGENTSMITH_STRATEGY_HASH, key: opts.key });
  const target = path.join(opts.root, ".quality", "cache", "agentsmith-v4", "stages", opts.stage, `${digest}.json`);
  let stale = false;
  if (opts.enabled && fs.existsSync(target))
    try {
      const cached = JSON.parse(fs.readFileSync(target, "utf8")) as { descriptorFingerprint?: string; value?: T };
      if (isFreshDescriptorCacheEntry<T>(cached, opts.descriptorFingerprint))
        return { value: cached.value as T, cacheStatus: "hit", stale: false };
      stale = true;
    } catch {
      /* regenerate */
      stale = true;
    }
  const value = await opts.run();
  if (opts.enabled)
    atomicWriteFile(target, `${JSON.stringify({ schemaVersion: 1, descriptorFingerprint: opts.descriptorFingerprint, value })}\n`);
  return { value, cacheStatus: "miss", stale };
}

function modelDescriptorIdentity(model: ModelProfile) {
  return {
    id: model.id,
    model: model.model,
    contextTokens: model.contextTokens,
    requestedOutputTokens: model.requestedOutputTokens,
    safetyReserveTokens: model.safetyReserveTokens,
    tokenizer: model.tokenizer,
    inference: model.inference,
  };
}

function dispatchDescriptorFingerprint(value: unknown, model: ModelProfile, stage: string): string {
  return deterministicReviewDescriptorFingerprint({ stage, model: modelDescriptorIdentity(model), descriptor: value });
}

async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await fn(values[index]);
      }
    }),
  );
  return results;
}

class ReviewDeadlineError extends Error {
  constructor() {
    super("review deadline exceeded");
    this.name = "ReviewDeadlineError";
  }
}

function createExecutionBudget(maxDurationMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let active = 0;
  const stats = { callsStarted: 0, callsCompleted: 0, callsCancelled: 0, maxObservedConcurrency: 0 };
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const timer = setTimeout(() => abort(new ReviewDeadlineError()), maxDurationMs);
  if (parent) {
    if (parent.aborted) abort(parent.reason);
    else parent.addEventListener("abort", () => abort(parent.reason), { once: true });
  }
  return {
    signal: controller.signal,
    canStart() {
      return !controller.signal.aborted;
    },
    async call<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (controller.signal.aborted) throw new ReviewDeadlineError();
      stats.callsStarted++;
      active++;
      stats.maxObservedConcurrency = Math.max(stats.maxObservedConcurrency, active);
      try {
        const value = await fn(controller.signal);
        stats.callsCompleted++;
        return value;
      } catch (error) {
        if (controller.signal.aborted) stats.callsCancelled++;
        throw error;
      } finally {
        active--;
      }
    },
    timedOut() {
      return controller.signal.aborted && controller.signal.reason instanceof ReviewDeadlineError;
    },
    elapsedMs() {
      return Date.now() - startedAt;
    },
    finish() {
      if (timer) clearTimeout(timer);
    },
    stats,
  };
}

function anchorRecord(candidate: CandidateFinding, scope: ReviewScope): EvidenceRecord {
  const lines = (scope.fileContents[candidate.file] ?? "").split("\n");
  const start = Math.max(1, candidate.line - 2);
  const end = Math.min(lines.length, (candidate.endLine ?? candidate.line) + 2);
  const snippet = lines.slice(start - 1, end).join("\n");
  const id = sha256(`${candidate.file}:${start}:${snippet}`, 16);
  return {
    id,
    requestKind: "implementation",
    file: candidate.file,
    startLine: start,
    endLine: end,
    symbol: candidate.primarySymbol,
    snippet,
    relation: "changed-anchor",
  };
}

export function compactEvidenceRecord(record: EvidenceRecord, maxChars: number): EvidenceRecord {
  if (record.snippet.length <= maxChars) return record;
  const lines = record.snippet.split("\n");
  const locator = record.matchedLocator?.trim();
  const matchIndex = locator ? lines.findIndex((line) => line.includes(locator)) : -1;
  const target = matchIndex >= 0 ? matchIndex : Math.floor(lines.length / 2);
  let start = Math.max(0, target - Math.floor(lines.length / 2));
  let end = Math.min(lines.length, start + lines.length);
  let snippet = lines.slice(start, end).join("\n");
  while (snippet.length > maxChars && end - start > 1) {
    if (target - start > end - target - 1) start += 1;
    else end -= 1;
    snippet = lines.slice(start, end).join("\n");
  }
  if (snippet.length > maxChars) {
    const center = matchIndex >= 0 ? lines[matchIndex] : lines[target];
    snippet = center.slice(0, maxChars);
  }
  return {
    ...record,
    startLine: record.startLine + start,
    endLine: record.startLine + end - 1,
    snippet,
  };
}

function candidateKey(candidate: CandidateFinding) {
  // Keep findings anchored to distinct changed regions distinct. A rule and
  // primary symbol can legitimately occur in multiple work items; merging on
  // those fields alone can replace the evidence and line anchor for one
  // defect with another defect discovered in a neighboring unit.
  return `${candidate.file}:${candidate.line}:${candidate.endLine ?? candidate.line}:${candidate.primarySymbol ?? ""}:${candidate.category}:${candidate.ruleId ?? candidate.title.toLowerCase().replace(/\W+/g, "-")}`;
}

function evidenceRequestKey(request: CandidateFinding["evidenceRequests"][number]) {
  return `${request.locatorId ?? ""}:${request.kind}:${request.locatorMode ?? ""}:${request.symbol ?? ""}:${request.pathHint ?? ""}:${request.query ?? ""}`;
}

function uniqueEvidenceRequests(requests: CandidateFinding["evidenceRequests"], limit: number) {
  return [...new Map(requests.map((request) => [evidenceRequestKey(request), request])).values()].slice(0, limit);
}

function missingClaimDirectedRequest(
  candidate: CandidateFinding,
  locatorTable?: ReturnType<typeof buildTaskEvidenceLocatorTable>,
  anchoredSymbol?: string,
) {
  const consumerClaim =
    candidate.category === "contract" &&
    /\b(callers?|consumers?|downstream|assum(?:e|es|ed|ption)|expect(?:s|ed|ation)?)\b/i.test(candidate.description);
  if (
    !consumerClaim ||
    candidate.evidenceRequests.some((request) => request.kind === "callers" || request.kind === "usage")
  )
    return undefined;
  const subject = anchoredSymbol ?? candidate.primarySymbol;
  const relationshipLocator = locatorTable?.locators.find(
    (locator) => locator.mode === "relationship" && locator.relationshipKind === "callers" && locator.sourceSymbol === subject,
  );
  if (locatorTable && !relationshipLocator) return undefined;
  if (relationshipLocator)
    return locatorToEvidenceRequest(relationshipLocator, "callers", "candidate omitted required evidence from an actual caller or consumer");
  return {
    kind: "callers" as const,
    locatorMode: "symbol" as const,
    symbol: subject,
    pathHint: candidate.file,
    reason: "candidate omitted required evidence from an actual caller or consumer",
  };
}

function normalizeCandidates(candidates: CandidateFinding[], maxEvidenceRequests: number): CandidateFinding[] {
  const merged = new Map<string, CandidateFinding>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const current = merged.get(key);
    if (!current)
      merged.set(key, {
        ...candidate,
        sourceWorkItemIds: [...new Set(candidate.sourceWorkItemIds)].sort(),
        sourceReviewers: [...new Set(candidate.sourceReviewers)].sort(),
        evidenceRequests: uniqueEvidenceRequests(candidate.evidenceRequests, maxEvidenceRequests),
      });
    else {
      current.sourceWorkItemIds = [...new Set([...current.sourceWorkItemIds, ...candidate.sourceWorkItemIds])].sort();
      current.sourceReviewers = [...new Set([...current.sourceReviewers, ...candidate.sourceReviewers])].sort();
      current.evidenceRequests = uniqueEvidenceRequests(
        [...current.evidenceRequests, ...candidate.evidenceRequests],
        maxEvidenceRequests,
      );
      current.candidateConfidence = Math.max(current.candidateConfidence, candidate.candidateConfidence);
    }
  }
  return [...merged.values()].sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.id.localeCompare(right.id),
  );
}

function failedCandidateBatch(opts: {
  sourceId: string;
  error: string;
  specialist?: CandidateBatch["specialist"];
  diagnostic?: StructuredOutputError["diagnostic"] | null;
}): CandidateBatch {
  return {
    sourceId: opts.sourceId,
    specialist: opts.specialist,
    candidates: [],
    inputTokens: opts.diagnostic?.usage.inputTokens ?? 0,
    outputTokens: opts.diagnostic?.usage.outputTokens ?? 0,
    diagnostics: opts.diagnostic ? [opts.diagnostic] : undefined,
    error: opts.error,
  };
}

function severityRank(value: ReviewFinding["severity"]) {
  return { critical: 4, high: 3, medium: 2, low: 1 }[value];
}

function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const merged = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const key = `${finding.file}:${finding.category}:${finding.ruleId ?? finding.title.toLowerCase().replace(/\W+/g, "-")}:${finding.line}`;
    const current = merged.get(key);
    if (!current) merged.set(key, finding);
    else {
      current.sourceWorkItemIds = [...new Set([...current.sourceWorkItemIds, ...finding.sourceWorkItemIds])].sort();
      current.sourceReviewers = [...new Set([...current.sourceReviewers, ...finding.sourceReviewers])].sort();
      current.evidence = [
        ...new Map([...current.evidence, ...finding.evidence].map((item) => [item.id, item])).values(),
      ];
      if (severityRank(finding.severity) > severityRank(current.severity)) current.severity = finding.severity;
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line,
  );
}

type VerificationPreflight =
  | {
      candidate: CandidateFinding;
      kind: "rejected";
      reasoning: string;
      outcomes: EvidenceResolutionOutcome[];
      estimatedTokens: number;
    }
  | {
      candidate: CandidateFinding;
      kind: "insufficient";
      reasoning: string;
      anchor: EvidenceRecord;
      records: EvidenceRecord[];
      gaps: string[];
      outcomes: EvidenceResolutionOutcome[];
      estimatedTokens: number;
    }
  | {
      candidate: CandidateFinding;
      kind: "ready";
      reasoning: string;
      anchor: EvidenceRecord;
      records: EvidenceRecord[];
      gaps: string[];
      outcomes: EvidenceResolutionOutcome[];
      originating: string;
      evidenceText: string;
      estimatedTokens: number;
    };

function candidateResolutionReason(opts: {
  candidate: CandidateFinding;
  verification?: VerificationResult;
  evidenceOutcomes: EvidenceResolutionOutcome[];
  providerDiagnostics: NonNullable<EngineExecution["providerDiagnostics"]>;
  tokenOmitted: boolean;
  timedOut: boolean;
}): { reasonCode?: CandidateResolutionReasonCode; detail: string } {
  const { verification } = opts;
  if (verification?.verdict === "verified") return { detail: "Candidate was proven by the verifier." };
  if (verification?.verdict === "rejected")
    return {
      reasonCode: "verification-rejection",
      detail: verification.reasoningSummary ?? "Candidate was disproven by the verifier.",
    };
  if (verification?.verdict === "likely")
    return {
      reasonCode: "verifier-likely-unpublished",
      detail: verification.reasoningSummary ?? "Candidate remained plausible but was not proven.",
    };
  if (opts.timedOut)
    return { reasonCode: "timeout", detail: "Candidate verification did not finish before the review deadline." };
  if (opts.tokenOmitted)
    return {
      reasonCode: "evidence-packing-budget",
      detail: "Candidate did not fit the aggregate verification token budget.",
    };
  if (!verification)
    return {
      reasonCode: "selection-miss",
      detail: "Candidate was generated but did not enter the verification shortlist.",
    };

  const diagnostics = [
    ...(verification.diagnostics ?? []),
    ...opts.providerDiagnostics.filter((diagnostic) => diagnostic.sourceId === opts.candidate.id),
  ];
  if (
    verification.citationRepairAttempted &&
    diagnostics.some((diagnostic) => diagnostic.failureKind === "citation-validation")
  )
    return {
      reasonCode: "citation-validation-failure",
      detail: verification.reasoningSummary ?? "Verifier citations remained invalid after repair.",
    };
  if (verification.reasoningSummary === "verifier failed")
    return { reasonCode: "provider-failure", detail: "The verifier provider failed before adjudication." };
  if (
    opts.evidenceOutcomes.some(
      (outcome) => outcome.reason?.includes("verifier token budget") || outcome.reason?.includes("verifier context"),
    )
  )
    return {
      reasonCode: "evidence-packing-budget",
      detail: verification.reasoningSummary ?? "Required evidence did not fit the verifier context.",
    };
  if (
    opts.evidenceOutcomes.some((outcome) =>
      outcome.reason?.includes("candidate omitted required evidence from an actual caller or consumer"),
    )
  )
    return {
      reasonCode: "verifier-evidence-demand",
      detail: verification.reasoningSummary ?? "The candidate omitted a claim-directed evidence request.",
    };
  if (
    opts.evidenceOutcomes.some(
      (outcome) => outcome.reason?.includes("ambiguous locator") || outcome.reason?.includes("missing locator"),
    )
  )
    return {
      reasonCode: "locator-resolution-failure",
      detail: verification.reasoningSummary ?? "A required evidence locator could not be resolved deterministically.",
    };
  if (opts.evidenceOutcomes.some((outcome) => outcome.reason?.includes("no exact evidence matched")))
    return {
      reasonCode: "retrieval-miss",
      detail: verification.reasoningSummary ?? "No exact evidence matched a required request.",
    };
  return {
    reasonCode: "verifier-insufficient-evidence",
    detail: verification.reasoningSummary ?? "The verifier could not prove or disprove the candidate.",
  };
}

function buildCandidateResolutionAudits(opts: {
  candidates: CandidateFinding[];
  verificationById: Map<string, VerificationResult>;
  evidenceOutcomes: Record<string, EvidenceResolutionOutcome[]>;
  providerDiagnostics: NonNullable<EngineExecution["providerDiagnostics"]>;
  tokenOmittedCandidateIds: Set<string>;
  timedOutCandidateIds: Set<string>;
}): CandidateResolutionAudit[] {
  return opts.candidates.map((candidate) => {
    const verification = opts.verificationById.get(candidate.id);
    const outcomes = opts.evidenceOutcomes[candidate.id] ?? [];
    const resolution = verification
      ? verification.verdict === "verified"
        ? "proven"
        : verification.verdict === "rejected"
          ? "disproven"
          : "unproven"
      : "unproven";
    const { reasonCode, detail } = candidateResolutionReason({
      candidate,
      verification,
      evidenceOutcomes: outcomes,
      providerDiagnostics: opts.providerDiagnostics,
      tokenOmitted: opts.tokenOmittedCandidateIds.has(candidate.id),
      timedOut: opts.timedOutCandidateIds.has(candidate.id),
    });
    const resolvedRecordIds = [
      ...new Set(outcomes.flatMap((outcome) => outcome.records.map((record) => record.id))),
    ].sort();
    const packedRecordIds = [...new Set(outcomes.flatMap((outcome) => outcome.packedRecordIds ?? []))].sort();
    const diagnostics = [
      ...(verification?.diagnostics ?? []),
      ...opts.providerDiagnostics.filter((diagnostic) => diagnostic.sourceId === candidate.id),
    ];
    return {
      candidateId: candidate.id,
      resolution,
      ...(reasonCode ? { reasonCode } : {}),
      detail,
      sourceWorkItemIds: [...candidate.sourceWorkItemIds].sort(),
      sourceReviewers: [...candidate.sourceReviewers].sort(),
      evidence: {
        requestOutcomes: outcomes.map((outcome) => ({
          requestId: outcome.requestId,
          kind: outcome.request.kind,
          status: outcome.status,
          recordIds: outcome.records.map((record) => record.id).sort(),
          packedRecordIds: [...(outcome.packedRecordIds ?? [])].sort(),
          ...(outcome.resolverRoute ? { resolverRoute: outcome.resolverRoute } : {}),
          ...(outcome.consideredRecords !== undefined ? { consideredRecords: outcome.consideredRecords } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        })),
        resolvedRecordIds,
        packedRecordIds,
      },
      verifier: {
        verdict: verification?.verdict ?? "not_run",
        ...(verification ? { confidence: verification.confidence } : {}),
        ...(verification?.reasoningSummary ? { reasoningSummary: verification.reasoningSummary } : {}),
        supportingEvidenceIds: [...(verification?.supportingEvidenceIds ?? [])].sort(),
        failureKinds: [...new Set(diagnostics.map((diagnostic) => diagnostic.failureKind))].sort(),
        ...(verification?.citationRepairAttempted ? { citationRepairAttempted: true } : {}),
      },
    };
  });
}

function uniqueRanges(ranges: SourceRange[]): SourceRange[] {
  return [...new Map(ranges.map((range) => [`${range.file}:${range.startLine}:${range.endLine}`, range])).values()];
}

function shadowReviewTask(item: ReviewWorkItem, opts: {
  snapshotId: string;
  profile: ModelProfile;
  existingFiles: ReadonlySet<string>;
  knownSymbols: ReadonlySet<string>;
}): ReviewTask {
  const changedRanges = uniqueRanges(
    (item.changedRegions ?? []).map((range) => ({ file: range.file, startLine: range.start, endLine: range.end })),
  );
  const fallbackRanges = uniqueRanges(
    item.code.filter((snippet) => snippet.changed).map((snippet) => ({
      file: snippet.file,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
    })),
  );
  const effectiveRanges = changedRanges.length ? changedRanges : fallbackRanges;
  const changedSymbols = item.primarySymbols.map((symbol) => ({
    file: symbol.file,
    name: symbol.qualifiedName,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  }));
  const contextRefs = item.relatedSymbols.map((symbol) => ({
    file: symbol.file,
    symbol: symbol.qualifiedName,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    reason: "related selected work-item context",
  } satisfies ContextRef));
  const evidenceLocatorTable = buildTaskEvidenceLocatorTable({ snapshotId: opts.snapshotId, workItem: item });
  const allowedEvidenceLocators = evidenceLocatorTable.locators;
  const unitWithoutId: Omit<ReviewUnit, "id"> = {
    kind: item.kind,
    changedSymbols,
    changedRanges: effectiveRanges,
    context: contextRefs,
    riskScore: Math.max(0, item.priority ?? item.rankFactors?.semanticRisk ?? 0),
    riskReasons: [
      ...(item.selectionReason ? [item.selectionReason.slice(0, 240)] : []),
      ...(item.rankFactors?.semanticRisk !== undefined ? [`semanticRisk=${item.rankFactors.semanticRisk}`] : []),
      ...(item.rankFactors?.graphDegree !== undefined ? [`graphDegree=${item.rankFactors.graphDegree}`] : []),
    ],
    estimatedTokens: Math.max(0, item.estimatedTokens),
  };
  const unit: ReviewUnit = { ...unitWithoutId, id: deterministicReviewUnitId(unitWithoutId) };
  const taskWithoutId: Omit<ReviewTask, "taskId"> = {
    taskVersion: REVIEW_TASK_VERSION,
    unit,
    lens: "correctness",
    lensVersion: "correctness/v1",
    snapshotId: opts.snapshotId,
    question: "Identify correctness issues in this bounded review unit and request only necessary evidence.",
    changedRanges: effectiveRanges,
    contextRefs,
                allowedEvidenceLocators,
    tokenBudget: Math.max(1, item.estimatedTokens),
    outputTokenBudget: Math.max(1, Math.min(100_000, opts.profile.requestedOutputTokens)),
    modelCallBudget: 1,
    expansionBudget: 0,
    outputContractVersion: CANDIDATE_RESULT_VERSION,
    evidenceNeeds: [],
    budget: {
      inputTokens: Math.max(1, item.estimatedTokens),
      outputTokens: Math.max(1, Math.min(100_000, opts.profile.requestedOutputTokens)),
      modelCalls: 1,
      contextExpansions: 0,
    },
  };
  const task: ReviewTask = {
    ...taskWithoutId,
    taskId: deterministicReviewTaskId(taskWithoutId),
  };
  return validateReviewTask(task, {
    existingFiles: opts.existingFiles,
    knownSymbols: opts.knownSymbols,
    allowedEvidenceLocators,
    evidenceLocatorTable: canonicalEvidenceLocatorTable(evidenceLocatorTable),
  });
}

function buildContractShadowAudit(opts: {
  selectedWorkItems: ReviewWorkItem[];
  snapshotId: string;
  profile: ModelProfile;
  existingFiles: ReadonlySet<string>;
  knownSymbols: ReadonlySet<string>;
}): ContractShadowAudit {
  const entries: ContractShadowAuditEntry[] = opts.selectedWorkItems.map((item) => {
    try {
      const task = shadowReviewTask(item, opts);
      const serializedDescriptor = serializeReviewContract(task);
      return {
        sourceWorkItemId: item.id,
        taskId: task.taskId,
        descriptorHash: sha256(serializedDescriptor),
        descriptorFingerprint: dispatchDescriptorFingerprint(task, opts.profile, "candidates"),
        serializedDescriptor,
        validation: { valid: true },
        legacyInputFingerprint: sha256Json({ sourceWorkItemId: item.id, workItem: item }),
      };
    } catch (error) {
      return {
        sourceWorkItemId: item.id,
        taskId: "",
        descriptorHash: "",
        serializedDescriptor: "",
        validation: { valid: false, error: error instanceof Error ? error.message : String(error) },
        legacyInputFingerprint: sha256Json({ sourceWorkItemId: item.id, workItem: item }),
      };
    }
  });
  return { schemaVersion: 1, lens: "correctness", entries };
}

function legacyOutputFingerprint(batch: CandidateBatch): string {
  return sha256Json({ sourceId: batch.sourceId, candidates: batch.candidates, error: batch.error ?? null });
}

export async function executeReviewEngine(opts: {
  root: string;
  version: string;
  scope: ReviewScope;
  config: AgentSmithConfig;
  provider: ReviewProvider;
  profileHash?: string;
  assetRoot?: string;
  deterministicReport?: string;
  signal?: AbortSignal;
  variant?: {
    includeInteractions?: boolean;
    resolveEvidence?: boolean;
    /** Reviewed candidates used to isolate evidence and later pipeline stages in eval replay. */
    seedCandidates?: CandidateFinding[];
  };
  enforceWorkspaceVersion?: boolean;
}): Promise<{ result: ReviewResult; execution: EngineExecution }> {
  const stageTimingsMs: NonNullable<EngineExecution["stageTimingsMs"]> = {};
  const candidateProfile = profile(opts.config, opts.config.models.candidate, "candidate");
  const scoutProfile = opts.config.models.scout ? profile(opts.config, opts.config.models.scout, "scout") : undefined;
  const verifierProfile = profile(opts.config, opts.config.models.verifier ?? opts.config.models.candidate, "verifier");
  const requiredModels = [
    ...new Set(
      [candidateProfile.model, scoutProfile?.model, verifierProfile.model].filter((value): value is string =>
        Boolean(value),
      ),
    ),
  ];
  let stageStarted = Date.now();
  const health = await opts.provider.health(opts.signal);
  stageTimingsMs.providerHealth = Date.now() - stageStarted;
  if (!health.ok) throw new Error(`Review provider unavailable: ${health.error ?? "unknown error"}`);
  const missing = requiredModels.filter(
    (model) => !health.models.some((found) => found === model || found.startsWith(`${model}:`)),
  );
  if (missing.length) throw new Error(`Review model not installed: ${missing.join(", ")}`);

  stageStarted = Date.now();
  const graph = await repositoryGraph(opts.root).getContext(opts.scope, Number.MAX_SAFE_INTEGER, opts.config.graph);
  stageTimingsMs.graph = Date.now() - stageStarted;
  stageStarted = Date.now();
  const rules = loadStructuredRules(opts.assetRoot);
  const deterministicReport = compactDeterministicReport(opts.deterministicReport);
  const full = buildProjection({
    scope: opts.scope,
    graph,
    profile: candidateProfile,
    rules,
    kind: "full",
    deterministicReport,
  });
  const compact = buildProjection({
    scope: opts.scope,
    graph,
    profile: scoutProfile ?? candidateProfile,
    rules,
    kind: "compact",
    deterministicReport,
  });
  const route = routeReview({
    requestedMode: opts.config.mode,
    candidate: candidateProfile,
    scout: scoutProfile,
    routing: opts.config.routing,
    full,
    compact,
  });
  const reviewPath =
    route.mode === "holistic" && candidateProfile.reviewCapability === "strong" ? "specialist" : "generic";
  stageTimingsMs.projection = Date.now() - stageStarted;
  stageStarted = Date.now();
  const executionBudget = createExecutionBudget(opts.config.maxDurationMs, opts.signal);
  let staleCacheEntries = 0;
  const effectiveParallelism = Math.min(opts.config.concurrency, opts.config.partitioned.maxParallelUnits);
  const workItemOptions = {
    projection: full,
    graph,
    profile: candidateProfile,
    policy: opts.config.partitioned,
    rules,
    inputBudgetTokens: route.candidateBudget.inputBudgetTokens,
    maxInteractionNeighborsPerSymbol: opts.config.graph.maxInteractionNeighborsPerSymbol,
  };
  const workItems = route.mode === "holistic" ? [] : buildWorkItems(workItemOptions);
  const errors: string[] = [];
  const providerFailures: NonNullable<EngineExecution["providerFailures"]> = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let hotspots = undefined;
  let scoutTrace: EngineExecution["scout"];
  if (route.mode === "hybrid" && scoutProfile)
    try {
      const { value: scout, cacheStatus, stale } = await cachedStage({
        root: opts.root,
        enabled: opts.config.cache,
        stage: "scout",
        key: { snapshot: opts.scope.id, projection: compact.id, profile: scoutProfile },
        descriptorFingerprint: dispatchDescriptorFingerprint(
          { snapshotId: opts.scope.id, projection: compact, route: route.mode },
          scoutProfile,
          "scout",
        ),
        run: () =>
          executionBudget.call((signal) =>
            runScout({
              projection: compact,
              profile: scoutProfile,
              provider: opts.provider,
              signal,
            }),
          ),
      });
      if (stale) staleCacheEntries += 1;
      hotspots = scout.hotspots.slice(0, opts.config.hybrid.maxHotspots);
      scoutTrace = {
        ...scout,
        cacheStatus,
        descriptorFingerprint: dispatchDescriptorFingerprint(
          { snapshotId: opts.scope.id, projection: compact, route: route.mode },
          scoutProfile,
          "scout",
        ),
      };
      inputTokens += scout.inputTokens;
      outputTokens += scout.outputTokens;
    } catch (error) {
      captureProviderFailure(error, providerFailures);
      if (!executionBudget.timedOut()) errors.push(`scout: ${error instanceof Error ? error.message : String(error)}`);
    }
  const plannedWorkItems = route.mode === "hybrid" ? buildWorkItems({ ...workItemOptions, hotspots }) : workItems;
  const eligibleWorkItems =
    opts.variant?.includeInteractions === false
      ? plannedWorkItems.filter((item) => item.kind === "local")
      : plannedWorkItems;
  stageTimingsMs.planning = Date.now() - stageStarted;
  stageStarted = Date.now();
  const rankedWorkItems = rankWorkItems(eligibleWorkItems);
  stageTimingsMs.ranking = Date.now() - stageStarted;
  stageStarted = Date.now();
  const candidateInputBudget =
    opts.config.partitioned.maxCandidateInputTokens ?? Math.floor(route.candidateBudget.inputBudgetTokens * 2);
  const selection =
    route.mode === "holistic"
      ? {
          selected: eligibleWorkItems,
          omitted: [] as typeof eligibleWorkItems,
          tokenOmitted: [] as typeof eligibleWorkItems,
          estimatedTokens: 0,
        }
      : selectWorkItems(rankedWorkItems, opts.config.partitioned.maxCandidateWorkItems ?? 4, candidateInputBudget);
  const selectedWorkItems = selection.selected;
  const candidateProjection =
    route.mode === "holistic" ? full : buildCandidateProjection(full, selectedWorkItems, candidateProfile);
  const omittedWorkItems = selection.omitted;
  const tokenOmittedWorkItems = selection.tokenOmitted;
  stageTimingsMs.selection = Date.now() - stageStarted;
  // Phase 1 shadow integration: construct and validate descriptors from the
  // selected inputs, but do not pass them to the provider or execution path.
  const shadowExistingFiles = new Set([
    ...opts.scope.changedFiles,
    ...full.manifest.map((entry) => entry.path),
    ...graph.nodes.map(({ symbol }) => symbol.file),
    ...selectedWorkItems.flatMap((item) => [
      ...item.code.map((snippet) => snippet.file),
      ...item.primarySymbols.map((symbol) => symbol.file),
      ...item.relatedSymbols.map((symbol) => symbol.file),
    ]),
  ]);
  const shadowKnownSymbols = new Set(
    graph.nodes.flatMap(({ symbol }) => [symbol.name, symbol.qualifiedName, `${symbol.file}:${symbol.name}`, `${symbol.file}:${symbol.qualifiedName}`]),
  );
  const contractShadow = buildContractShadowAudit({
    selectedWorkItems,
    snapshotId: opts.scope.id,
    profile: candidateProfile,
    existingFiles: shadowExistingFiles,
    knownSymbols: shadowKnownSymbols,
  });
  stageStarted = Date.now();
  const candidateBatches: CandidateBatch[] = [];
  if (opts.variant?.seedCandidates) {
    const sources = selectedWorkItems.length ? selectedWorkItems.map((item) => item.id) : ["holistic"];
    candidateBatches.push(
      ...sources.map((sourceId, index) => ({
        sourceId,
        candidates: index === 0 ? structuredClone(opts.variant!.seedCandidates!) : [],
        inputTokens: 0,
        outputTokens: 0,
      })),
    );
  } else if (reviewPath === "specialist") {
    const specialists = loadSpecialists(opts.assetRoot);
    const maxCandidatesPerSpecialist = Math.max(1, Math.floor(opts.config.holistic.maxCandidates / specialists.length));
    const batches = await mapLimit(specialists, effectiveParallelism, async (specialist): Promise<CandidateBatch> => {
      const sourceId = `specialist:${specialist.name}`;
      if (!executionBudget.canStart())
        return failedCandidateBatch({ sourceId, specialist: specialist.name, error: "review deadline exceeded" });
      try {
        const { value, cacheStatus, stale } = await cachedStage({
          root: opts.root,
          enabled: opts.config.cache,
          stage: "specialist-candidates",
          key: { snapshot: opts.scope.id, projection: full.id, profile: candidateProfile, specialist },
          descriptorFingerprint: dispatchDescriptorFingerprint(
            { snapshotId: opts.scope.id, projection: full, specialist, route: route.mode },
            candidateProfile,
            "specialist-candidates",
          ),
          run: () =>
            executionBudget.call((signal) =>
              generateSpecialistCandidates({
                specialist,
                projection: full,
                profile: candidateProfile,
                provider: opts.provider,
                allowedFiles: opts.scope.changedFiles,
                maxCandidates: maxCandidatesPerSpecialist,
                signal,
              }),
            ),
        });
        if (stale) staleCacheEntries += 1;
        return {
          ...value,
          cacheStatus,
          descriptorFingerprint: dispatchDescriptorFingerprint(
            { snapshotId: opts.scope.id, projection: full, specialist, route: route.mode },
            candidateProfile,
            "specialist-candidates",
          ),
        };
      } catch (error) {
        captureProviderFailure(error, providerFailures);
        const message = `${specialist.name}: ${error instanceof Error ? error.message : String(error)}`;
        const diagnostic = error instanceof StructuredOutputError ? error.diagnostic : null;
        if (!executionBudget.timedOut()) errors.push(message);
        return failedCandidateBatch({
          sourceId,
          specialist: specialist.name,
          diagnostic,
          error: executionBudget.timedOut() ? "review deadline exceeded" : message,
        });
      }
    });
    candidateBatches.push(...batches);
  } else {
    if (route.mode === "holistic") throw new Error("Holistic review requires the specialist execution path");
    const batches = await mapLimit(selectedWorkItems, effectiveParallelism, async (item) => {
      if (!executionBudget.canStart())
        return failedCandidateBatch({ sourceId: item.id, error: "review deadline exceeded" });
      const evidenceLocatorTable = buildTaskEvidenceLocatorTable({ snapshotId: opts.scope.id, workItem: item });
      try {
        const { value, cacheStatus, stale } = await cachedStage({
          root: opts.root,
          enabled: opts.config.cache,
          stage: "candidates",
          key: { snapshot: opts.scope.id, item, profile: candidateProfile, evidenceLocatorTable },
          descriptorFingerprint:
            contractShadow.entries.find((entry) => entry.sourceWorkItemId === item.id)?.descriptorFingerprint ??
            dispatchDescriptorFingerprint({ snapshotId: opts.scope.id, item, evidenceLocatorTable }, candidateProfile, "candidates"),
          run: () =>
            executionBudget.call((signal) =>
              generateWorkItemCandidate({
                item,
                profile: candidateProfile,
                provider: opts.provider,
                allowedFiles: opts.scope.changedFiles,
                maxCandidates: opts.config.partitioned.maxCandidatesPerWorkItem ?? 2,
                allowedEvidenceSelectors: evidenceLocatorTable.selectors,
                signal,
              }),
            ),
        });
        if (stale) staleCacheEntries += 1;
        return {
          ...value,
          cacheStatus,
          descriptorFingerprint:
            contractShadow.entries.find((entry) => entry.sourceWorkItemId === item.id)?.descriptorFingerprint ??
            dispatchDescriptorFingerprint({ snapshotId: opts.scope.id, item, evidenceLocatorTable }, candidateProfile, "candidates"),
        };
      } catch (error) {
        captureProviderFailure(error, providerFailures);
        const message = `${item.id}: ${error instanceof Error ? error.message : String(error)}`;
        const diagnostic = error instanceof StructuredOutputError ? error.diagnostic : null;
        if (!executionBudget.timedOut()) errors.push(message);
        return failedCandidateBatch({
          sourceId: item.id,
          diagnostic,
          error: executionBudget.timedOut() ? "review deadline exceeded" : message,
        });
      }
    });
    candidateBatches.push(...batches);
  }
  inputTokens += candidateBatches.reduce((sum, batch) => sum + batch.inputTokens, 0);
  outputTokens += candidateBatches.reduce((sum, batch) => sum + batch.outputTokens, 0);
  for (const entry of contractShadow.entries) {
    const batch = candidateBatches.find((candidateBatch) => candidateBatch.sourceId === entry.sourceWorkItemId);
    if (batch) entry.legacyOutputFingerprint = legacyOutputFingerprint(batch);
  }
  const candidates = normalizeCandidates(
    candidateBatches.flatMap((batch) => batch.candidates),
    opts.config.evidence.maxRequestsPerCandidate,
  );
  stageTimingsMs.candidateGeneration = Date.now() - stageStarted;
  const workItemPriority = new Map(selectedWorkItems.map((item) => [item.id, item.priority ?? 0]));
  const severityPriority = { critical: 4, high: 3, medium: 2, low: 1 } as const;
  const rankedCandidates = [...candidates].sort(
    (left, right) =>
      severityPriority[right.severity] - severityPriority[left.severity] ||
      right.candidateConfidence - left.candidateConfidence ||
      Math.max(...right.sourceWorkItemIds.map((id) => workItemPriority.get(id) ?? 0), 0) -
        Math.max(...left.sourceWorkItemIds.map((id) => workItemPriority.get(id) ?? 0), 0) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.id.localeCompare(right.id),
  );
  const verificationInputBudget =
    opts.config.partitioned.maxVerificationInputTokens ??
    Math.floor(
      projectionBudget(verifierProfile, opts.config.routing).inputBudgetTokens *
        (opts.config.partitioned.maxVerificationCandidates ?? 4),
    );
  const verifierCallBudget = projectionBudget(verifierProfile, opts.config.routing).inputBudgetTokens;
  stageStarted = Date.now();
  const preflights = await mapLimit(
    rankedCandidates,
    Math.min(effectiveParallelism, opts.config.evidence.maxParallelResolutions),
    async (candidate): Promise<VerificationPreflight> => {
      const anchorIssue = candidateAnchorIssue(candidate, opts.scope);
      if (anchorIssue)
        return {
          candidate,
          kind: "rejected",
          reasoning: anchorIssue,
          outcomes: candidate.evidenceRequests.map((request) => ({
            requestId: evidenceRequestId(request),
            request,
            status: "skipped",
            records: [],
            reason: anchorIssue,
          })),
          estimatedTokens: 0,
        };
      const sourceItem = selectedWorkItems.find((item) => item.id === candidate.sourceWorkItemIds[0]);
      const locatorTable = reviewPath === "specialist" || !sourceItem
        ? undefined
        : buildTaskEvidenceLocatorTable({ snapshotId: opts.scope.id, workItem: sourceItem });
      const anchoredSymbol = sourceItem?.primarySymbols.find(
        (symbol) => symbol.file === candidate.file && symbol.startLine <= candidate.line && symbol.endLine >= candidate.line,
      )?.qualifiedName;
      const missingDirected = missingClaimDirectedRequest(candidate, locatorTable, anchoredSymbol);
      const candidateForResolution =
        missingDirected && reviewPath !== "specialist"
          ? { ...candidate, evidenceRequests: [...candidate.evidenceRequests, missingDirected] }
          : candidate;
      const resolved =
        opts.variant?.resolveEvidence === false
          ? {
              records: [],
              gaps: candidateForResolution.evidenceRequests.map((request) => `${request.kind}: evidence resolution disabled`),
              outcomes: candidateForResolution.evidenceRequests.map((request) => ({
                requestId: evidenceRequestId(request),
                request,
                status: "unresolved" as const,
                records: [],
                reason: "evidence resolution disabled",
              })),
            }
          : resolveEvidenceRequests({ candidate: candidateForResolution, scope: opts.scope, graph, policy: opts.config.evidence });
      if (missingDirected && reviewPath === "specialist") {
        const requestId = evidenceRequestId(missingDirected);
        const reason = missingDirected.reason;
        resolved.gaps.push(`callers: ${reason}`);
        resolved.outcomes.push({ requestId, request: missingDirected, status: "unresolved", records: [], reason });
      }
      const anchor = anchorRecord(candidate, opts.scope);
      const originating = full.code
        .filter(
          (code) =>
            code.file === candidate.file &&
            code.startLine <= (candidate.endLine ?? candidate.line) &&
            code.endLine >= candidate.line,
        )
        .map((code) => code.content)
        .join("\n\n");
      const fixedTokens =
        estimateTokens(VERIFICATION_INSTRUCTIONS, verifierProfile, false) +
        estimateTokens(VERIFICATION_LABELS, verifierProfile, false) +
        estimateTokens(JSON.stringify(candidate), verifierProfile, false);
      const maxOriginChars = Math.max(
        200,
        Math.floor((verifierCallBudget - fixedTokens) * 0.4 * verifierProfile.tokenizer.codeCharsPerToken),
      );
      const boundedOriginating = (originating || anchor.snippet).slice(0, maxOriginChars);
      const packedRecords: EvidenceRecord[] = [];
      const packingGaps: string[] = [];
      const renderEvidence = (records: EvidenceRecord[]) =>
        [anchor, ...records]
          .map(
            (item) =>
              `[${item.id}]${item.requestId ? ` request=${item.requestId}` : " anchor"} ${item.file}:${item.startLine}-${item.endLine}\n${item.snippet}`,
          )
          .join("\n\n");
      // Pack evidence by request group in round-robin order. This reserves
      // the minimum one-record witness for every satisfied request before a
      // large early group can consume the verifier budget.
      const fairRecords: EvidenceRecord[] = [];
      const groupedRecords = resolved.outcomes
        .filter((outcome) => outcome.status === "satisfied")
        .map((outcome) => outcome.records);
      const maxGroupRecords = Math.max(0, ...groupedRecords.map((group) => group.length));
      for (let round = 0; round < maxGroupRecords; round++)
        for (const group of groupedRecords) if (group[round]) fairRecords.push(group[round]);
      for (const record of fairRecords) {
        const currentTokens =
          fixedTokens +
          estimateTokens(boundedOriginating, verifierProfile, true) +
          estimateTokens(renderEvidence(packedRecords), verifierProfile, true);
        const remainingTokens = Math.max(0, verifierCallBudget - currentTokens);
        const maxSnippetChars = Math.max(
          96,
          Math.floor(remainingTokens * verifierProfile.tokenizer.codeCharsPerToken * 0.8),
        );
        const boundedRecord = compactEvidenceRecord(record, maxSnippetChars);
        const proposed = [...packedRecords, boundedRecord];
        const proposedText = renderEvidence(proposed);
        const proposedTokens =
          fixedTokens +
          estimateTokens(boundedOriginating, verifierProfile, true) +
          estimateTokens(proposedText, verifierProfile, true);
        if (proposedTokens <= verifierCallBudget) packedRecords.push(boundedRecord);
        else packingGaps.push(`${record.requestKind}: resolved evidence omitted by verifier token budget`);
      }
      const evidenceText = renderEvidence(packedRecords);
      const estimatedTokens =
        fixedTokens +
        estimateTokens(boundedOriginating, verifierProfile, true) +
        estimateTokens(evidenceText, verifierProfile, true);
      const packedIds = new Set(packedRecords.map((record) => record.id));
      const outcomes = resolved.outcomes.map((outcome): EvidenceResolutionOutcome => {
        if (outcome.status !== "satisfied") return outcome;
        const packed = outcome.records.filter((record) => packedIds.has(record.id));
        if (packed.length === outcome.records.length)
          return { ...outcome, packedRecordIds: packed.map((record) => record.id) };
        if (packed.length)
          return {
            ...outcome,
            status: "partial",
            packedRecordIds: packed.map((record) => record.id),
            reason: "some resolved evidence was omitted by the verifier token budget",
          };
        return {
          ...outcome,
          status: "unresolved",
          packedRecordIds: [],
          reason: "resolved evidence did not fit the verifier token budget",
        };
      });
      const gaps = [
        ...new Set([
          ...resolved.gaps,
          ...packingGaps,
          ...outcomes
            .filter((outcome) => outcome.status === "unresolved")
            .map((outcome) => `${outcome.request.kind}: ${outcome.reason ?? "unresolved"}`),
        ]),
      ];
      if (candidate.evidenceRequests.length && outcomes.some((outcome) => outcome.status === "unresolved"))
        return {
          candidate,
          kind: "insufficient",
          reasoning: gaps.join("; ") || "required evidence was unresolved",
          anchor,
          records: packedRecords,
          gaps,
          outcomes,
          estimatedTokens: 0,
        };
      if (candidate.evidenceRequests.length && !packedRecords.length)
        return {
          candidate,
          kind: "insufficient",
          reasoning: gaps.join("; ") || "resolved evidence did not fit the verifier context",
          anchor,
          records: packedRecords,
          gaps,
          outcomes,
          estimatedTokens: 0,
        };
      return {
        candidate,
        kind: "ready",
        reasoning: "",
        anchor,
        records: packedRecords,
        gaps,
        outcomes,
        originating: boundedOriginating,
        evidenceText,
        estimatedTokens,
      };
    },
  );
  stageTimingsMs.evidence = Date.now() - stageStarted;
  const candidatesForVerification: CandidateFinding[] = [];
  const tokenOmittedCandidates: CandidateFinding[] = [];
  const preflightOutcomes: VerificationResult[] = [];
  const evidence: Record<string, EvidenceRecord[]> = {};
  const evidenceOutcomes: Record<string, EvidenceResolutionOutcome[]> = {};
  let verificationEstimatedTokens = 0;
  for (const preflight of preflights) {
    const candidate = preflight.candidate;
    evidenceOutcomes[candidate.id] = preflight.outcomes;
    if (preflight.kind === "rejected") {
      preflightOutcomes.push({
        candidateId: candidate.id,
        verdict: "rejected",
        confidence: 1,
        reasoningSummary: preflight.reasoning,
        supportingEvidenceIds: [],
      });
      continue;
    }
    if (preflight.kind === "insufficient") {
      evidence[candidate.id] = [preflight.anchor, ...preflight.records];
      preflightOutcomes.push({
        candidateId: candidate.id,
        verdict: "insufficient_evidence",
        confidence: 1,
        reasoningSummary: preflight.reasoning,
        supportingEvidenceIds: [preflight.anchor.id],
      });
      continue;
    }
    if (candidatesForVerification.length >= (opts.config.partitioned.maxVerificationCandidates ?? 4)) continue;
    if (verificationEstimatedTokens + preflight.estimatedTokens > verificationInputBudget) {
      tokenOmittedCandidates.push(candidate);
      continue;
    }
    evidence[candidate.id] = [preflight.anchor, ...preflight.records];
    candidatesForVerification.push(candidate);
    verificationEstimatedTokens += preflight.estimatedTokens;
  }
  const preflightById = new Map(preflights.map((preflight) => [preflight.candidate.id, preflight]));
  stageStarted = Date.now();
  const modelResults = await mapLimit(candidatesForVerification, effectiveParallelism, async (candidate) => {
    const preflight = preflightById.get(candidate.id);
    if (!preflight || preflight.kind !== "ready") return undefined;
    if (!executionBudget.canStart()) return undefined;
    try {
      const judgedStage = await cachedStage({
        root: opts.root,
        enabled: opts.config.cache,
        stage: "verification",
        key: { snapshot: opts.scope.id, candidate, evidence: evidence[candidate.id], profile: verifierProfile },
        descriptorFingerprint: dispatchDescriptorFingerprint(
          { snapshotId: opts.scope.id, candidate, evidence: evidence[candidate.id], profile: verifierProfile },
          verifierProfile,
          "verification",
        ),
        run: () =>
          executionBudget.call((signal) =>
            verifyCandidateWithModel({
              candidate,
              originatingCode: preflight.originating || preflight.anchor.snippet,
              evidenceText: preflight.evidenceText,
              evidenceIds: evidence[candidate.id].map((item) => item.id),
              requiredEvidenceIdsByRequest: Object.fromEntries(
                preflight.outcomes
                  .filter((outcome) => outcome.status === "satisfied" || outcome.status === "partial")
                  .map((outcome) => [
                    outcome.requestId,
                    outcome.packedRecordIds ?? outcome.records.map((record) => record.id),
                  ]),
              ),
              profile: verifierProfile,
              provider: opts.provider,
              signal,
            }),
          ),
      });
      const judged = judgedStage.value;
      judged.result.cacheStatus = judgedStage.cacheStatus;
      judged.result.descriptorFingerprint = dispatchDescriptorFingerprint(
        { snapshotId: opts.scope.id, candidate, evidence: evidence[candidate.id], profile: verifierProfile },
        verifierProfile,
        "verification",
      );
      if (judgedStage.stale) staleCacheEntries += 1;
      inputTokens += judged.inputTokens;
      outputTokens += judged.outputTokens;
      return judged.result;
    } catch (error) {
      captureProviderFailure(error, providerFailures);
      if (!executionBudget.timedOut())
        errors.push(`verify ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
      if (executionBudget.timedOut()) return undefined;
      return {
        candidateId: candidate.id,
        verdict: "insufficient_evidence",
        confidence: 0,
        reasoningSummary: "verifier failed",
        supportingEvidenceIds: [],
      };
    }
  });
  const verificationById = new Map<string, VerificationResult>();
  for (const outcome of preflightOutcomes) verificationById.set(outcome.candidateId, outcome);
  for (const outcome of modelResults.filter((result): result is VerificationResult => result !== undefined))
    verificationById.set(outcome.candidateId, outcome);
  const verification: VerificationResult[] = [];
  const findings: ReviewFinding[] = [];
  for (const candidate of rankedCandidates) {
    const outcome = verificationById.get(candidate.id);
    if (!outcome) continue;
    verification.push(outcome);
    if (outcome.verdict === "verified") {
      const records = evidence[candidate.id] ?? [];
      const anchor = records[0] ?? anchorRecord(candidate, opts.scope);
      const selectedEvidence = outcome.supportingEvidenceIds.length
        ? records.filter((item) => outcome.supportingEvidenceIds.includes(item.id))
        : records;
      findings.push({
        id: candidate.id,
        file: candidate.file,
        line: candidate.line,
        endLine: candidate.endLine,
        severity: candidate.severity,
        category: candidate.category,
        title: candidate.title,
        description: candidate.description,
        suggestion: candidate.suggestion,
        confidence: "verified",
        evidence: selectedEvidence.length ? selectedEvidence : [anchor],
        ruleId: candidate.ruleId,
        sourceWorkItemIds: candidate.sourceWorkItemIds,
        sourceReviewers: candidate.sourceReviewers,
      });
    }
  }
  stageTimingsMs.verification = Date.now() - stageStarted;
  stageStarted = Date.now();
  const omittedCandidates = candidates.filter(
    (candidate) =>
      !candidatesForVerification.some((selected) => selected.id === candidate.id) &&
      !preflightOutcomes.some((outcome) => outcome.candidateId === candidate.id),
  );
  if (opts.enforceWorkspaceVersion !== false && computeWorkspaceVersion(opts.root) !== opts.scope.version)
    errors.push("Workspace changed during review");

  const completedSources = new Set(candidateBatches.filter((batch) => !batch.error).map((batch) => batch.sourceId));
  const holisticCompleted =
    reviewPath === "specialist"
      ? candidateBatches.length === 4 && candidateBatches.every((batch) => batch.specialist && !batch.error)
      : completedSources.has("holistic");
  const timedOutWorkItems = candidateBatches
    .filter((batch) => batch.error === "review deadline exceeded")
    .map((batch) => batch.sourceId);
  const verificationIds = new Set(verification.map((item) => item.candidateId));
  const timedOutCandidates = executionBudget.timedOut()
    ? candidatesForVerification.filter((candidate) => !verificationIds.has(candidate.id))
    : [];
  const reviewedItems = selectedWorkItems.filter((item) => completedSources.has(item.id));
  const reviewedFiles = new Set(
    route.mode === "holistic" && holisticCompleted
      ? full.code.filter((code) => code.changed).map((code) => code.file)
      : reviewedItems.flatMap((item) => item.code.filter((code) => code.changed).map((code) => code.file)),
  );
  const reviewedSymbols = new Set(
    reviewedItems.flatMap((item) => item.primarySymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`)),
  );
  if (route.mode === "holistic" && holisticCompleted)
    for (const symbol of graph.changedSymbols) reviewedSymbols.add(`${symbol.file}:${symbol.qualifiedName}`);
  const reviewedEdgeKeys = new Set(
    (route.mode === "holistic" && holisticCompleted
      ? graph.edges
      : reviewedItems.flatMap((item) => item.graphEdges)
    ).map((edge) => `${edge.kind}:${edge.source}:${edge.target ?? edge.targetText}`),
  );
  const changedSymbolKeys = new Set(graph.changedSymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`));
  const eligibleEdges = graph.edges.filter(
    (edge) => Boolean(edge.target) && (changedSymbolKeys.has(edge.source) || changedSymbolKeys.has(edge.target!)),
  );
  const eligibleEdgeKeys = new Set(
    eligibleEdges.map((edge) => `${edge.kind}:${edge.source}:${edge.target ?? edge.targetText}`),
  );
  const localItems = selectedWorkItems.filter((item) => item.kind === "local");
  const interactionItems = selectedWorkItems.filter((item) => item.kind === "interaction");
  const rawOmissions = [
    ...emptyReviewCoverage(opts.scope).omissions,
    ...full.omissions.map((item) => ({ kind: item.kind, id: item.id, reason: item.reason })),
    ...omittedWorkItems.map((item) => ({
      kind: "work-item",
      id: item.id,
      reason: tokenOmittedWorkItems.includes(item) ? "token-budget" : "lower-ranked",
    })),
    ...timedOutWorkItems.map((id) => ({ kind: "work-item", id, reason: "timeout" })),
    ...omittedCandidates.map((candidate) => ({
      kind: "candidate",
      id: candidate.id,
      reason: tokenOmittedCandidates.includes(candidate) ? "token-budget" : "lower-ranked",
    })),
    ...timedOutCandidates.map((candidate) => ({ kind: "candidate", id: candidate.id, reason: "timeout" })),
    ...(executionBudget.timedOut() && route.mode === "holistic"
      ? [{ kind: "context", id: "holistic", reason: "timeout" }]
      : []),
  ];
  const omissions = [...new Map(rawOmissions.map((item) => [`${item.kind}:${item.id}:${item.reason}`, item])).values()];
  const allEvidenceOutcomes = Object.values(evidenceOutcomes).flat();
  const evidenceRequestsSatisfied = allEvidenceOutcomes.filter((outcome) => outcome.status === "satisfied").length;
  const evidenceRequestsPartiallySatisfied = allEvidenceOutcomes.filter(
    (outcome) => outcome.status === "partial",
  ).length;
  const evidenceRequestsUnresolved = allEvidenceOutcomes.filter((outcome) => outcome.status === "unresolved").length;
  const evidenceRequestsSkipped = allEvidenceOutcomes.filter((outcome) => outcome.status === "skipped").length;
  const coverage: ReviewCoverage = {
    selection: omittedWorkItems.length || omittedCandidates.length ? "bounded" : "full",
    ...emptyReviewCoverage(opts.scope),
    changedFilesReviewed: reviewedFiles.size,
    changedSymbols: graph.changedSymbols.length,
    changedSymbolsReviewed: reviewedSymbols.size,
    localUnitsGenerated: eligibleWorkItems.filter((item) => item.kind === "local").length,
    localUnitsReviewed: localItems.filter((item) => completedSources.has(item.id)).length,
    interactionUnitsGenerated: eligibleWorkItems.filter((item) => item.kind === "interaction").length,
    interactionUnitsReviewed: interactionItems.filter((item) => completedSources.has(item.id)).length,
    dependencyEdgesIdentified: graph.edges.length,
    dependencyEdgesEligible: eligibleEdges.length,
    dependencyEdgesReviewed: [...reviewedEdgeKeys].filter((key) => eligibleEdgeKeys.has(key)).length,
    evidenceRequests: allEvidenceOutcomes.length,
    evidenceRequestsAttempted: allEvidenceOutcomes.length - evidenceRequestsSkipped,
    evidenceRequestsSatisfied,
    evidenceRequestsPartiallySatisfied,
    evidenceRequestsUnresolved,
    evidenceRequestsSkipped,
    evidenceRecordsResolved: allEvidenceOutcomes.reduce((sum, outcome) => sum + outcome.records.length, 0),
    evidenceRecordsPacked: allEvidenceOutcomes.reduce(
      (sum, outcome) =>
        sum + (outcome.packedRecordIds?.length ?? (outcome.status === "satisfied" ? outcome.records.length : 0)),
      0,
    ),
    evidenceResolved: Object.values(evidence).reduce((sum, records) => sum + Math.max(0, records.length - 1), 0),
    evidenceGaps: evidenceRequestsUnresolved + evidenceRequestsPartiallySatisfied,
    globalScan:
      route.mode === "holistic" && holisticCompleted
        ? "full"
        : route.mode === "hybrid" && hotspots
          ? "compact"
          : "none",
    configuredParallelism: opts.config.concurrency,
    effectiveParallelism,
    maxObservedConcurrency: executionBudget.stats.maxObservedConcurrency,
    candidateTokenBudget: candidateInputBudget,
    candidateTokensEstimated: selection.estimatedTokens,
    verificationTokenBudget: verificationInputBudget,
    verificationTokensEstimated: verificationEstimatedTokens,
    selectedWorkItems: selectedWorkItems.length,
    omittedWorkItems: omittedWorkItems.length,
    timeoutOmissions: omissions.filter((item) => item.reason === "timeout").length,
    tokenBudgetOmissions: omissions.filter((item) => item.reason === "token-budget").length,
    deadlineMs: opts.config.maxDurationMs,
    elapsedMs: executionBudget.elapsedMs(),
    callsStarted: executionBudget.stats.callsStarted,
    callsCompleted: executionBudget.stats.callsCompleted,
    callsCancelled: executionBudget.stats.callsCancelled,
    omissions,
  };
  const verified = deduplicateFindings(findings);
  const providerDiagnostics = [
    ...(scoutTrace?.diagnostics ?? []),
    ...candidateBatches.flatMap((batch) => batch.diagnostics ?? []),
    ...verification.flatMap((item) => item.diagnostics ?? []),
  ];
  const resolutionDiagnostics = [...providerDiagnostics, ...providerFailures];
  const candidateResolutions = buildCandidateResolutionAudits({
    candidates: rankedCandidates,
    verificationById,
    evidenceOutcomes,
    providerDiagnostics: resolutionDiagnostics,
    tokenOmittedCandidateIds: new Set(tokenOmittedCandidates.map((candidate) => candidate.id)),
    timedOutCandidateIds: new Set(timedOutCandidates.map((candidate) => candidate.id)),
  });
  const cacheStatuses = [
    scoutTrace?.cacheStatus,
    ...candidateBatches.map((batch) => batch.cacheStatus),
    ...verification.map((item) => item.cacheStatus),
  ].filter((value): value is "hit" | "miss" => Boolean(value));
  coverage.cacheHits = cacheStatuses.filter((value) => value === "hit").length;
  coverage.cacheMisses = cacheStatuses.filter((value) => value === "miss").length;
  coverage.staleCacheEntries = staleCacheEntries;
  coverage.structuredRepairs = providerDiagnostics.filter(
    (diagnostic) => diagnostic.failureKind !== "citation-validation",
  ).length;
  coverage.citationRepairs = verification.filter((item) => item.citationRepairAttempted).length;
  coverage.providerInvocations =
    (scoutTrace && scoutTrace.cacheStatus !== "hit" ? 1 + (scoutTrace.diagnostics?.length ?? 0) : 0) +
    candidateBatches.reduce(
      (sum, batch) => sum + (batch.cacheStatus === "hit" || batch.error ? 0 : 1 + (batch.diagnostics?.length ?? 0)),
      0,
    ) +
    verification.reduce(
      (sum, item) => sum + (item.cacheStatus === "hit" ? 0 : (item.providerInvocations ?? (item.completion ? 1 : 0))),
      0,
    );
  const providerMs = (completion: { totalDurationNs?: number | null } | undefined) =>
    completion?.totalDurationNs ? Math.round(completion.totalDurationNs / 1_000_000) : 0;
  coverage.candidateProviderMs = candidateBatches.reduce((sum, batch) => sum + providerMs(batch.completion), 0);
  coverage.verificationProviderMs = verification.reduce((sum, item) => sum + providerMs(item.completion), 0);
  coverage.scoutProviderMs = providerMs(scoutTrace?.completion);
  const stale = errors.includes("Workspace changed during review");
  const incompleteReasons: NonNullable<ReviewResult["incompleteReasons"]> = [];
  if (stale)
    incompleteReasons.push({
      kind: "stale-workspace",
      detail: "Workspace changed during review.",
    });
  if (executionBudget.timedOut())
    incompleteReasons.push({
      kind: "timeout",
      detail: `Review exceeded its ${opts.config.maxDurationMs}ms deadline.`,
    });
  for (const error of errors.filter((value) => value !== "Workspace changed during review"))
    incompleteReasons.push({ kind: "provider-failure", detail: error });
  for (const item of selectedWorkItems.filter((item) => !completedSources.has(item.id)))
    incompleteReasons.push({
      kind: "unfinished-work-item",
      id: item.id,
      detail: "Selected candidate-generation work item did not complete.",
    });
  for (const batch of candidateBatches.filter((batch) => batch.candidateState === "insufficient_context"))
    incompleteReasons.push({
      kind: "insufficient-context",
      id: batch.sourceId,
      detail: "Candidate generator reported insufficient context for the selected review task.",
    });
  for (const candidate of omittedCandidates.filter(
    (item) => tokenOmittedCandidates.includes(item) || item.severity === "critical" || item.severity === "high",
  ))
    incompleteReasons.push({
      kind: "unadjudicated-candidate",
      id: candidate.id,
      detail: tokenOmittedCandidates.includes(candidate)
        ? "Shortlisted candidate did not fit the aggregate verification token budget."
        : `${candidate.severity} candidate fell outside the verification shortlist.`,
    });
  for (const resolution of candidateResolutions) {
    if (resolution.resolution !== "unproven") continue;
    if (resolution.reasonCode === "evidence-packing-budget")
      incompleteReasons.push({
        kind: "evidence-packing-budget",
        id: resolution.candidateId,
        detail: resolution.detail,
      });
    if (resolution.reasonCode === "citation-validation-failure")
      incompleteReasons.push({
        kind: "citation-validation-failure",
        id: resolution.candidateId,
        detail: resolution.detail,
      });
  }
  for (const omission of coverage.omissions.filter(
    (item) => !["binary", "generated", "lower-ranked", "token-budget", "unsupported-artifact"].includes(item.reason),
  ))
    incompleteReasons.push({
      kind: "material-omission",
      id: omission.id,
      detail: `${omission.kind} omitted because ${omission.reason}.`,
    });
  const uniqueIncompleteReasons = [
    ...new Map(
      incompleteReasons.map((reason) => [`${reason.kind}:${reason.id ?? ""}:${reason.detail}`, reason]),
    ).values(),
  ];
  const executionIncomplete = uniqueIncompleteReasons.length > 0;
  const unresolvedCandidates = candidateResolutions.filter(
    (resolution) => resolution.resolution === "unproven" || resolution.resolution === "missed",
  );
  const shortlistIds = new Set([
    ...candidatesForVerification.map((candidate) => candidate.id),
    ...preflightOutcomes.map((outcome) => outcome.candidateId),
  ]);
  const specialistResults =
    reviewPath === "specialist"
      ? candidateBatches
          .filter((batch): batch is CandidateBatch & { specialist: NonNullable<CandidateBatch["specialist"]> } =>
            Boolean(batch.specialist),
          )
          .map((batch) => ({
            reviewer: batch.specialist,
            status: batch.error ? ("error" as const) : ("completed" as const),
            summary: batch.summary ?? (batch.error ? "Specialist review did not complete." : "No summary returned."),
            candidates: batch.candidates.map((candidate) => {
              const outcome = verificationById.get(candidate.id);
              return {
                id: candidate.id,
                title: candidate.title,
                file: candidate.file,
                line: candidate.line,
                severity: candidate.severity,
                disposition: outcome?.verdict ?? ("unadjudicated" as const),
                ...(outcome?.reasoningSummary ? { reasoning: outcome.reasoningSummary } : {}),
              };
            }),
            ...(batch.error ? { error: batch.error } : {}),
          }))
      : undefined;
  const completedSpecialists = specialistResults?.filter((item) => item.status === "completed").length ?? 0;
  const result: ReviewResult = {
    schemaVersion: 4,
    version: opts.version,
    snapshotId: opts.scope.id,
    status: stale ? "stale" : executionIncomplete ? "partial" : "completed",
    outcome:
      executionIncomplete || (!verified.length && unresolvedCandidates.length)
        ? "incomplete"
        : verified.length
          ? "findings"
          : "clear",
    mode: route.mode,
    reviewPath,
    findings: verified,
    coverage,
    summary: stale
      ? "Workspace changed during review; result is stale."
      : executionIncomplete
        ? executionBudget.timedOut()
          ? "Review timed out before completing the selected scope; partial result, not approval."
          : errors.length > 0
            ? "Review incomplete due to provider failures; partial result, not approval."
            : `Review incomplete: ${uniqueIncompleteReasons
                .slice(0, 3)
                .map((reason) => reason.detail)
                .join(" ")}`
        : unresolvedCandidates.length
          ? verified.length
            ? `${verified.length} verified finding${verified.length === 1 ? "" : "s"}; ${unresolvedCandidates.length} candidate${unresolvedCandidates.length === 1 ? " remains" : "s remain"} unproven.`
            : `Review execution completed, but ${unresolvedCandidates.length} candidate${unresolvedCandidates.length === 1 ? " remains" : "s remain"} unproven; not approval.`
          : reviewPath === "specialist"
            ? `${completedSpecialists}/4 specialist reviews completed. ${verified.length ? `${verified.length} verified finding${verified.length === 1 ? "" : "s"}.` : "No verified findings."}`
            : verified.length
              ? `${verified.length} verified finding${verified.length === 1 ? "" : "s"}${coverage.selection === "bounded" ? " in the selected risk-ranked review scope" : ""}.`
              : coverage.selection === "bounded"
                ? "No verified findings in the selected risk-ranked review scope."
                : "No verified findings.",
    timestamp: new Date().toISOString(),
    reviewer: "AgentSmith",
    candidates: {
      generated: candidates.length,
      shortlisted: shortlistIds.size,
      adjudicated: verification.length,
      omitted: omittedCandidates.length,
      verified: verification.filter((item) => item.verdict === "verified").length,
      likely: verification.filter((item) => item.verdict === "likely").length,
      rejected: verification.filter((item) => item.verdict === "rejected").length,
      insufficientEvidence: verification.filter((item) => item.verdict === "insufficient_evidence").length,
    },
    candidateResolutions,
    incompleteReasons: uniqueIncompleteReasons,
    ...(specialistResults ? { specialists: specialistResults } : {}),
    errors,
    scopeId: opts.scope.id,
    profileHash: opts.profileHash,
    strategyHash: AGENTSMITH_STRATEGY_HASH,
    graphSnapshotHash: graph.snapshot.snapshotHash,
    runtime: { models: opts.config.models, inputTokens, outputTokens, concurrency: opts.config.concurrency },
  };
  if (executionBudget.timedOut())
    coverage.timeout = {
      deadlineMs: opts.config.maxDurationMs,
      elapsedMs: executionBudget.elapsedMs(),
      ...executionBudget.stats,
    };
  executionBudget.finish();
  stageTimingsMs.aggregation = Date.now() - stageStarted;
  const selectedWorkItemIds = new Set(selectedWorkItems.map((item) => item.id));
  const tokenOmittedWorkItemIds = new Set(tokenOmittedWorkItems.map((item) => item.id));
  const plannerManifest: NonNullable<EngineExecution["plannerManifest"]> = rankedWorkItems.map((item) => ({
    id: item.id,
    kind: item.kind,
    rank: item.rank,
    priority: item.priority ?? 0,
    estimatedTokens: item.estimatedTokens,
    selected: selectedWorkItemIds.has(item.id),
    tokenOmitted: tokenOmittedWorkItemIds.has(item.id),
    files: [...new Set(item.code.map((snippet) => snippet.file))],
    symbols: [
      ...new Set(
        [...item.primarySymbols, ...item.relatedSymbols].map((symbol) => `${symbol.file}#${symbol.qualifiedName}`),
      ),
    ],
    edges: item.graphEdges.map((edge) => `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`),
    changedRegions: item.changedRegions,
    promptVisibleRanges: item.promptVisibleRanges,
    rankFactors: item.rankFactors,
    selectionReason: item.selectionReason,
  }));
  return {
    result,
    execution: {
      contractShadow,
      rankingConfig: { maxDegreeBoost: MAX_DEGREE_BOOST, degreeCap: DEGREE_CAP },
      graphSnapshot: graph.snapshot,
      graphManifest: {
        changedSymbols: graph.changedSymbols,
        nodes: graph.nodes.map((node) => node.symbol),
        edges: graph.edges,
        selectedNodeKeys: graph.selectedNodeKeys,
        omittedNodeKeys: graph.omittedNodeKeys,
      },
      mode: route.mode,
      reviewPath,
      route,
      modelProfiles: { candidate: candidateProfile, scout: scoutProfile, verifier: verifierProfile },
      projection: full,
      sourceProjection: full,
      candidateProjection,
      compactProjection: route.mode === "hybrid" ? compact : undefined,
      scout: scoutTrace,
      workItems: selectedWorkItems,
      candidateBatches,
      candidates,
      evidence,
      evidenceOutcomes,
      verification,
      candidateResolutions,
      ...(providerFailures.length ? { providerFailures } : {}),
      ...(providerDiagnostics.length ? { providerDiagnostics } : {}),
      coverage,
      errors,
      inputTokens,
      outputTokens,
      stageTimingsMs,
      plannerManifest,
    },
  };
}
