import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentSmithConfig,
  CandidateFinding,
  EvidenceRecord,
  ModelProfile,
  ReviewCoverage,
  ReviewFinding,
  ReviewResult,
} from "../core/types.js";
import { repositoryGraph } from "../core/graph/index.js";
import type { ReviewProvider } from "./provider.js";
import type { ReviewScope } from "./scope.js";
import { loadStructuredRules } from "./rules.js";
import {
  buildProjection,
  buildWorkItems,
  estimateTokens,
  projectionBudget,
  routeReview,
  selectWorkItems,
} from "./projection.js";
import {
  VERIFICATION_INSTRUCTIONS,
  VERIFICATION_LABELS,
  generateHolisticCandidates,
  generateWorkItemCandidate,
  runScout,
  verifyCandidateWithModel,
} from "./candidate-generation.js";
import { candidateAnchorIssue, resolveEvidenceRequests } from "./evidence.js";
import type { EngineExecution, VerificationResult } from "./engine-types.js";
import { computeWorkspaceVersion } from "../core/version.js";

function profile(config: AgentSmithConfig, id: string | undefined, role: string): ModelProfile {
  if (!id) throw new Error(`Review ${role} model profile is not configured`);
  const found = config.model_profiles.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Review ${role} model profile is not approved: ${id}`);
  return found;
}

async function cachedStage<T>(opts: {
  root: string;
  enabled: boolean;
  stage: string;
  key: unknown;
  run: () => Promise<T>;
}): Promise<{ value: T; cacheStatus: "hit" | "miss" }> {
  const digest = crypto.createHash("sha256").update(JSON.stringify(opts.key)).digest("hex");
  const target = path.join(opts.root, ".quality", "cache", "agentsmith-v2", "stages", opts.stage, `${digest}.json`);
  if (opts.enabled && fs.existsSync(target))
    try {
      return { value: JSON.parse(fs.readFileSync(target, "utf8")) as T, cacheStatus: "hit" };
    } catch {
      /* regenerate */
    }
  const value = await opts.run();
  if (opts.enabled) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
    fs.renameSync(temporary, target);
  }
  return { value, cacheStatus: "miss" };
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
  const id = crypto.createHash("sha256").update(`${candidate.file}:${start}:${snippet}`).digest("hex").slice(0, 16);
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

function candidateKey(candidate: CandidateFinding) {
  return `${candidate.file}:${candidate.primarySymbol ?? candidate.line}:${candidate.category}:${candidate.ruleId ?? candidate.title.toLowerCase().replace(/\W+/g, "-")}`;
}

function normalizeCandidates(candidates: CandidateFinding[], maxEvidenceRequests: number): CandidateFinding[] {
  const merged = new Map<string, CandidateFinding>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const current = merged.get(key);
    if (!current) merged.set(key, candidate);
    else {
      current.sourceWorkItemIds = [...new Set([...current.sourceWorkItemIds, ...candidate.sourceWorkItemIds])].sort();
      current.evidenceRequests = [...current.evidenceRequests, ...candidate.evidenceRequests].slice(
        0,
        maxEvidenceRequests,
      );
      current.candidateConfidence = Math.max(current.candidateConfidence, candidate.candidateConfidence);
    }
  }
  return [...merged.values()].sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.id.localeCompare(right.id),
  );
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
  | { candidate: CandidateFinding; kind: "rejected"; reasoning: string; estimatedTokens: number }
  | {
      candidate: CandidateFinding;
      kind: "insufficient";
      reasoning: string;
      anchor: EvidenceRecord;
      records: EvidenceRecord[];
      gaps: string[];
      estimatedTokens: number;
    }
  | {
      candidate: CandidateFinding;
      kind: "ready";
      reasoning: string;
      anchor: EvidenceRecord;
      records: EvidenceRecord[];
      gaps: string[];
      originating: string;
      evidenceText: string;
      estimatedTokens: number;
    };

function emptyCoverage(scope: ReviewScope): ReviewCoverage {
  return {
    changedFiles: scope.changedFiles.length,
    changedFilesReviewed: 0,
    changedSymbols: 0,
    changedSymbolsReviewed: 0,
    localUnitsGenerated: 0,
    localUnitsReviewed: 0,
    interactionUnitsGenerated: 0,
    interactionUnitsReviewed: 0,
    dependencyEdgesIdentified: 0,
    dependencyEdgesEligible: 0,
    dependencyEdgesReviewed: 0,
    evidenceRequests: 0,
    evidenceResolved: 0,
    evidenceGaps: 0,
    globalScan: "none",
    omissions: (scope.omissions ?? []).map((item) => ({ kind: item.kind, id: item.id, reason: item.reason })),
  };
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
  variant?: { includeInteractions?: boolean; resolveEvidence?: boolean };
  enforceWorkspaceVersion?: boolean;
}): Promise<{ result: ReviewResult; execution: EngineExecution }> {
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
  const health = await opts.provider.health(opts.signal);
  if (!health.ok) throw new Error(`Review provider unavailable: ${health.error ?? "unknown error"}`);
  const missing = requiredModels.filter(
    (model) => !health.models.some((found) => found === model || found.startsWith(`${model}:`)),
  );
  if (missing.length) throw new Error(`Review model not installed: ${missing.join(", ")}`);

  const graph = await repositoryGraph(opts.root).getContext(opts.scope, Number.MAX_SAFE_INTEGER, opts.config.graph);
  const rules = loadStructuredRules(opts.assetRoot);
  const full = buildProjection({
    scope: opts.scope,
    graph,
    profile: candidateProfile,
    rules,
    kind: "full",
    deterministicReport: opts.deterministicReport,
  });
  const compact = buildProjection({
    scope: opts.scope,
    graph,
    profile: scoutProfile ?? candidateProfile,
    rules,
    kind: "compact",
    deterministicReport: opts.deterministicReport,
  });
  const route = routeReview({
    requestedMode: opts.config.mode,
    candidate: candidateProfile,
    scout: scoutProfile,
    routing: opts.config.routing,
    full,
    compact,
  });
  const executionBudget = createExecutionBudget(opts.config.maxDurationMs, opts.signal);
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
  let inputTokens = 0;
  let outputTokens = 0;
  let hotspots = undefined;
  let scoutTrace: EngineExecution["scout"];
  if (route.mode === "hybrid" && scoutProfile)
    try {
      const { value: scout } = await cachedStage({
        root: opts.root,
        enabled: opts.config.cache,
        stage: "scout",
        key: { snapshot: opts.scope.id, projection: compact.id, profile: scoutProfile },
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
      hotspots = scout.hotspots.slice(0, opts.config.hybrid.maxHotspots);
      scoutTrace = scout;
      inputTokens += scout.inputTokens;
      outputTokens += scout.outputTokens;
    } catch (error) {
      if (!executionBudget.timedOut()) errors.push(`scout: ${error instanceof Error ? error.message : String(error)}`);
    }
  const plannedWorkItems = route.mode === "hybrid" ? buildWorkItems({ ...workItemOptions, hotspots }) : workItems;
  const eligibleWorkItems =
    opts.variant?.includeInteractions === false
      ? plannedWorkItems.filter((item) => item.kind === "local")
      : plannedWorkItems;
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
      : selectWorkItems(eligibleWorkItems, opts.config.partitioned.maxCandidateWorkItems ?? 4, candidateInputBudget);
  const selectedWorkItems = selection.selected;
  const omittedWorkItems = selection.omitted;
  const tokenOmittedWorkItems = selection.tokenOmitted;
  const candidateBatches = [];
  if (route.mode === "holistic")
    try {
      const { value, cacheStatus } = await cachedStage({
        root: opts.root,
        enabled: opts.config.cache,
        stage: "candidates",
        key: { snapshot: opts.scope.id, projection: full.id, profile: candidateProfile },
        run: () =>
          executionBudget.call((signal) =>
            generateHolisticCandidates({
              projection: full,
              profile: candidateProfile,
              provider: opts.provider,
              allowedFiles: opts.scope.changedFiles,
              signal,
            }),
          ),
      });
      value.candidates = value.candidates.slice(0, opts.config.holistic.maxCandidates);
      candidateBatches.push({ ...value, cacheStatus });
    } catch (error) {
      if (!executionBudget.timedOut())
        errors.push(`holistic: ${error instanceof Error ? error.message : String(error)}`);
    }
  else {
    const batches = await mapLimit(selectedWorkItems, effectiveParallelism, async (item) => {
      if (!executionBudget.canStart())
        return {
          sourceId: item.id,
          candidates: [],
          inputTokens: 0,
          outputTokens: 0,
          error: "review deadline exceeded",
        };
      try {
        const { value, cacheStatus } = await cachedStage({
          root: opts.root,
          enabled: opts.config.cache,
          stage: "candidates",
          key: { snapshot: opts.scope.id, item, profile: candidateProfile },
          run: () =>
            executionBudget.call((signal) =>
              generateWorkItemCandidate({
                item,
                profile: candidateProfile,
                provider: opts.provider,
                allowedFiles: opts.scope.changedFiles,
                signal,
              }),
            ),
        });
        return { ...value, cacheStatus };
      } catch (error) {
        const message = `${item.id}: ${error instanceof Error ? error.message : String(error)}`;
        if (!executionBudget.timedOut()) errors.push(message);
        return {
          sourceId: item.id,
          candidates: [],
          inputTokens: 0,
          outputTokens: 0,
          error: executionBudget.timedOut() ? "review deadline exceeded" : message,
        };
      }
    });
    candidateBatches.push(...batches);
  }
  inputTokens += candidateBatches.reduce((sum, batch) => sum + batch.inputTokens, 0);
  outputTokens += candidateBatches.reduce((sum, batch) => sum + batch.outputTokens, 0);
  const candidates = normalizeCandidates(
    candidateBatches.flatMap((batch) => batch.candidates),
    opts.config.evidence.maxRequestsPerCandidate,
  );
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
    Math.floor(projectionBudget(verifierProfile, opts.config.routing).inputBudgetTokens * 2);
  const preflights = await mapLimit(
    rankedCandidates,
    Math.min(effectiveParallelism, opts.config.evidence.maxParallelResolutions),
    async (candidate): Promise<VerificationPreflight> => {
      const anchorIssue = candidateAnchorIssue(candidate, opts.scope);
      if (anchorIssue) return { candidate, kind: "rejected", reasoning: anchorIssue, estimatedTokens: 0 };
      const resolved =
        opts.variant?.resolveEvidence === false
          ? {
              records: [],
              gaps: candidate.evidenceRequests.map((request) => `${request.kind}: evidence resolution disabled`),
            }
          : resolveEvidenceRequests({ candidate, scope: opts.scope, graph, policy: opts.config.evidence });
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
      const evidenceText = [anchor, ...resolved.records]
        .map((item) => `[${item.id}] ${item.file}:${item.startLine}-${item.endLine}\n${item.snippet}`)
        .join("\n\n");
      const estimatedTokens =
        estimateTokens(VERIFICATION_INSTRUCTIONS, verifierProfile, false) +
        estimateTokens(VERIFICATION_LABELS, verifierProfile, false) +
        estimateTokens(JSON.stringify(candidate), verifierProfile, false) +
        estimateTokens(originating || anchor.snippet, verifierProfile, true) +
        estimateTokens(evidenceText, verifierProfile, true);
      if (candidate.evidenceRequests.length && !resolved.records.length)
        return {
          candidate,
          kind: "insufficient",
          reasoning: resolved.gaps.join("; "),
          anchor,
          records: resolved.records,
          gaps: resolved.gaps,
          estimatedTokens: 0,
        };
      return {
        candidate,
        kind: "ready",
        reasoning: "",
        anchor,
        records: resolved.records,
        gaps: resolved.gaps,
        originating,
        evidenceText,
        estimatedTokens,
      };
    },
  );
  const candidatesForVerification: CandidateFinding[] = [];
  const tokenOmittedCandidates: CandidateFinding[] = [];
  const preflightOutcomes: VerificationResult[] = [];
  const evidence: Record<string, EvidenceRecord[]> = {};
  let verificationEstimatedTokens = 0;
  let evidenceGaps = 0;
  for (const preflight of preflights) {
    const candidate = preflight.candidate;
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
      evidenceGaps += preflight.gaps.length;
      preflightOutcomes.push({
        candidateId: candidate.id,
        verdict: "insufficient_evidence",
        confidence: 1,
        reasoningSummary: preflight.reasoning,
        supportingEvidenceIds: [preflight.anchor.id],
      });
      continue;
    }
    if (candidatesForVerification.length >= (opts.config.partitioned.maxVerificationCandidates ?? 4)) break;
    if (verificationEstimatedTokens + preflight.estimatedTokens > verificationInputBudget) {
      tokenOmittedCandidates.push(candidate);
      continue;
    }
    evidence[candidate.id] = [preflight.anchor, ...preflight.records];
    evidenceGaps += preflight.gaps.length;
    candidatesForVerification.push(candidate);
    verificationEstimatedTokens += preflight.estimatedTokens;
  }
  const preflightById = new Map(preflights.map((preflight) => [preflight.candidate.id, preflight]));
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
        run: () =>
          executionBudget.call((signal) =>
            verifyCandidateWithModel({
              candidate,
              originatingCode: preflight.originating || preflight.anchor.snippet,
              evidenceText: preflight.evidenceText,
              evidenceIds: evidence[candidate.id].map((item) => item.id),
              profile: verifierProfile,
              provider: opts.provider,
              signal,
            }),
          ),
      });
      const judged = judgedStage.value;
      judged.result.cacheStatus = judgedStage.cacheStatus;
      inputTokens += judged.inputTokens;
      outputTokens += judged.outputTokens;
      return judged.result;
    } catch (error) {
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
      });
    }
  }
  const omittedCandidates = candidates.filter(
    (candidate) =>
      !candidatesForVerification.some((selected) => selected.id === candidate.id) &&
      !preflightOutcomes.some((outcome) => outcome.candidateId === candidate.id),
  );
  if (opts.enforceWorkspaceVersion !== false && computeWorkspaceVersion(opts.root) !== opts.scope.version)
    errors.push("Workspace changed during review");

  const completedSources = new Set(candidateBatches.filter((batch) => !batch.error).map((batch) => batch.sourceId));
  const timedOutWorkItems = candidateBatches
    .filter((batch) => batch.error === "review deadline exceeded")
    .map((batch) => batch.sourceId);
  const verificationIds = new Set(verification.map((item) => item.candidateId));
  const timedOutCandidates = executionBudget.timedOut()
    ? candidatesForVerification.filter((candidate) => !verificationIds.has(candidate.id))
    : [];
  const reviewedItems = selectedWorkItems.filter((item) => completedSources.has(item.id));
  const reviewedFiles = new Set(
    route.mode === "holistic" && completedSources.has("holistic")
      ? full.code.filter((code) => code.changed).map((code) => code.file)
      : reviewedItems.flatMap((item) => item.code.filter((code) => code.changed).map((code) => code.file)),
  );
  const reviewedSymbols = new Set(
    reviewedItems.flatMap((item) => item.primarySymbols.map((symbol) => `${symbol.file}:${symbol.qualifiedName}`)),
  );
  if (route.mode === "holistic" && completedSources.has("holistic"))
    for (const symbol of graph.changedSymbols) reviewedSymbols.add(`${symbol.file}:${symbol.qualifiedName}`);
  const reviewedEdgeKeys = new Set(
    (route.mode === "holistic" && completedSources.has("holistic")
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
  const omissions = [
    ...emptyCoverage(opts.scope).omissions,
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
  const coverage: ReviewCoverage = {
    selection: omittedWorkItems.length || omittedCandidates.length ? "bounded" : "full",
    ...emptyCoverage(opts.scope),
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
    evidenceRequests: candidates.reduce((sum, candidate) => sum + candidate.evidenceRequests.length, 0),
    evidenceResolved: Object.values(evidence).reduce((sum, records) => sum + Math.max(0, records.length - 1), 0),
    evidenceGaps,
    globalScan:
      route.mode === "holistic" && completedSources.has("holistic")
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
    omittedWorkItems: omittedWorkItems.length + tokenOmittedWorkItems.length,
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
  const materialOmission = coverage.omissions.some(
    (item) => !["binary", "generated", "lower-ranked", "token-budget"].includes(item.reason),
  );
  const incomplete =
    errors.length > 0 ||
    evidenceGaps > 0 ||
    materialOmission ||
    (route.mode !== "holistic" && selectedWorkItems.some((item) => !completedSources.has(item.id)));
  const stale = errors.includes("Workspace changed during review");
  const result: ReviewResult = {
    schemaVersion: 2,
    version: opts.version,
    snapshotId: opts.scope.id,
    status: stale ? "stale" : incomplete ? "partial" : "completed",
    outcome: incomplete ? "incomplete" : verified.length ? "findings" : "clear",
    mode: route.mode,
    findings: verified,
    coverage,
    summary: stale
      ? "Workspace changed during review; result is stale."
      : incomplete
        ? executionBudget.timedOut()
          ? "Review timed out before completing the selected scope; partial result, not approval."
          : errors.length > 0
            ? "Review incomplete due to provider failures; partial result, not approval."
            : "Review incomplete; inspect coverage and errors before relying on the result."
        : verified.length
          ? `${verified.length} verified finding${verified.length === 1 ? "" : "s"}${coverage.selection === "bounded" ? " in the selected risk-ranked review scope" : ""}.`
          : coverage.selection === "bounded"
            ? "No verified findings in the selected risk-ranked review scope."
            : "No verified findings.",
    timestamp: new Date().toISOString(),
    reviewer: "AgentSmith",
    candidates: {
      generated: candidates.length,
      verified: verification.filter((item) => item.verdict === "verified").length,
      likely: verification.filter((item) => item.verdict === "likely").length,
      rejected: verification.filter((item) => item.verdict === "rejected").length,
      insufficientEvidence: verification.filter((item) => item.verdict === "insufficient_evidence").length,
    },
    errors,
    scopeId: opts.scope.id,
    profileHash: opts.profileHash,
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
  return {
    result,
    execution: {
      mode: route.mode,
      route,
      modelProfiles: { candidate: candidateProfile, scout: scoutProfile, verifier: verifierProfile },
      projection: full,
      compactProjection: route.mode === "hybrid" ? compact : undefined,
      scout: scoutTrace,
      workItems: selectedWorkItems,
      candidateBatches,
      candidates,
      evidence,
      verification,
      coverage,
      errors,
      inputTokens,
      outputTokens,
    },
  };
}
