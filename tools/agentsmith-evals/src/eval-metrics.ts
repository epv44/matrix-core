import type { ReviewResult } from "../../../src/core/types.js";
import type { EngineExecution, ReviewWorkItem } from "../../../src/agentsmith/engine-types.js";
import type { ReviewScope } from "../../../src/agentsmith/scope.js";
import type { AgentSmithTrace } from "../../../src/agentsmith/trace.js";
import { evidenceLocatorParts } from "../../../src/agentsmith/evidence.js";

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function isMaterialSeverity(candidate: { severity: string }): boolean {
  return ["critical", "high"].includes(candidate.severity);
}

function changedLineRanges(diff: string): Map<string, Array<{ start: number; end: number }>> {
  const ranges = new Map<string, Array<{ start: number; end: number }>>();
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    if (!file || !line.startsWith("@@")) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count <= 0) continue;
    const values = ranges.get(file) ?? [];
    values.push({ start, end: start + count - 1 });
    ranges.set(file, values);
  }
  return ranges;
}

function reviewedChangedLines(scope: ReviewScope, workItems: ReviewWorkItem[]) {
  const ranges = changedLineRanges(scope.diff);
  const eligible = new Set<string>();
  const reviewed = new Set<string>();
  for (const [file, fileRanges] of ranges)
    for (const range of fileRanges)
      for (let line = range.start; line <= range.end; line += 1) eligible.add(`${file}:${line}`);
  for (const item of workItems)
    for (const snippet of item.code) {
      const fileRanges = ranges.get(snippet.file) ?? [];
      for (const range of fileRanges) {
        const start = Math.max(range.start, snippet.startLine);
        const end = Math.min(range.end, snippet.endLine);
        for (let line = start; line <= end; line += 1) reviewed.add(`${snippet.file}:${line}`);
      }
    }
  return { eligible: eligible.size, reviewed: reviewed.size };
}

function evidenceMetrics(execution: EngineExecution) {
  let requests = 0;
  let validRequests = 0;
  let resolvedRecords = 0;
  let relevantRecords = 0;
  for (const candidate of execution.candidates) {
    requests += candidate.evidenceRequests.length;
    validRequests += candidate.evidenceRequests.filter((request) =>
      Boolean(request.symbol || request.pathHint || request.query),
    ).length;
    const records = (execution.evidence[candidate.id] ?? []).slice(1);
    resolvedRecords += records.length;
    for (const record of records) {
      const relevant = candidate.evidenceRequests.some((request) => {
        const locator = evidenceLocatorParts(request);
        const pathMatches = locator.pathHint
          ? record.file === locator.pathHint || record.file.endsWith(`/${locator.pathHint}`)
          : false;
        const symbolMatches = request.symbol
          ? locator.symbolCandidates.some((symbol) => record.symbol === symbol || record.symbol?.endsWith(`.${symbol}`))
          : false;
        const queryMatches = locator.textQueries.some((query) => record.snippet.includes(query));
        return pathMatches || symbolMatches || queryMatches;
      });
      if (relevant) relevantRecords += 1;
    }
  }
  return {
    requests,
    validRequests,
    requestValidityRate: ratio(validRequests, requests),
    resolvedRecords,
    relevantRecords,
    relevanceRate: ratio(relevantRecords, resolvedRecords),
    unsupportedResolvedRecords: resolvedRecords - relevantRecords,
  };
}

export function collectEvalMetrics(opts: {
  scope: ReviewScope;
  result: ReviewResult;
  execution: EngineExecution;
  durationMs: number;
}) {
  const { scope, result, execution } = opts;
  const coverage = result.coverage;
  const changedLines = reviewedChangedLines(scope, execution.workItems);
  const workOmissions = coverage.omissions.filter((item) => item.kind === "work-item");
  const candidateOmissions = coverage.omissions.filter((item) => item.kind === "candidate");
  const uniqueWorkIds = new Set([
    ...execution.workItems.map((item) => item.id),
    ...workOmissions.map((item) => item.id),
  ]);
  const duplicateWorkItemRows = execution.workItems.length + workOmissions.length - uniqueWorkIds.size;
  const adjudicatedIds = new Set(execution.verification.map((item) => item.candidateId));
  const modelAdjudicated = execution.verification.filter((item) => item.cacheStatus !== undefined).length;
  const omittedIds = new Set(candidateOmissions.map((item) => item.id));
  const omittedHighSeverity = execution.candidates.filter(
    (candidate) => omittedIds.has(candidate.id) && isMaterialSeverity(candidate),
  ).length;
  const tokenOmittedCandidateIds = new Set(
    candidateOmissions.filter((item) => item.reason === "token-budget").map((item) => item.id),
  );
  const materialCandidateOmissions = new Set([
    ...execution.candidates
      .filter((candidate) => omittedIds.has(candidate.id) && isMaterialSeverity(candidate))
      .map((candidate) => candidate.id),
    ...tokenOmittedCandidateIds,
  ]).size;
  const shortlisted = result.candidates?.shortlisted ?? execution.candidates.length - candidateOmissions.length;
  const evidence = evidenceMetrics(execution);
  const eligibleWorkItems = coverage.localUnitsGenerated + coverage.interactionUnitsGenerated;
  const reviewedWorkItems = coverage.localUnitsReviewed + coverage.interactionUnitsReviewed;
  const honesty = {
    clearWithUnreviewedFiles:
      result.outcome === "clear" &&
      coverage.selection !== "bounded" &&
      coverage.changedFilesReviewed < coverage.changedFiles,
    completedWithCandidateOmissions: result.status === "completed" && materialCandidateOmissions > 0,
    zeroGapsWithUnsupportedEvidence: coverage.evidenceGaps === 0 && evidence.unsupportedResolvedRecords > 0,
    duplicateWorkItemRows,
    honest:
      !(
        result.outcome === "clear" &&
        coverage.selection !== "bounded" &&
        coverage.changedFilesReviewed < coverage.changedFiles
      ) &&
      !(result.status === "completed" && materialCandidateOmissions > 0) &&
      !(coverage.evidenceGaps === 0 && evidence.unsupportedResolvedRecords > 0) &&
      duplicateWorkItemRows === 0,
  };
  return {
    coverage: {
      changedFiles: {
        reviewed: coverage.changedFilesReviewed,
        eligible: coverage.changedFiles,
        rate: ratio(coverage.changedFilesReviewed, coverage.changedFiles),
      },
      changedSymbols: {
        reviewed: coverage.changedSymbolsReviewed,
        eligible: coverage.changedSymbols,
        rate: ratio(coverage.changedSymbolsReviewed, coverage.changedSymbols),
      },
      changedLines: { ...changedLines, rate: ratio(changedLines.reviewed, changedLines.eligible) },
      localUnits: {
        reviewed: coverage.localUnitsReviewed,
        eligible: coverage.localUnitsGenerated,
        rate: ratio(coverage.localUnitsReviewed, coverage.localUnitsGenerated),
      },
      interactionUnits: {
        reviewed: coverage.interactionUnitsReviewed,
        eligible: coverage.interactionUnitsGenerated,
        rate: ratio(coverage.interactionUnitsReviewed, coverage.interactionUnitsGenerated),
      },
      workItems: {
        reviewed: reviewedWorkItems,
        eligible: eligibleWorkItems,
        unique: uniqueWorkIds.size,
        duplicateRows: duplicateWorkItemRows,
        rate: ratio(reviewedWorkItems, eligibleWorkItems),
      },
      globalScan: coverage.globalScan,
    },
    candidates: {
      generated: execution.candidates.length,
      adjudicated: adjudicatedIds.size,
      modelAdjudicated,
      omitted: candidateOmissions.length,
      omittedHighSeverity,
      shortlisted,
      adjudicationRate: ratio(adjudicatedIds.size, execution.candidates.length),
      shortlistAdjudicationRate: ratio(adjudicatedIds.size, shortlisted),
      modelAdjudicationRate: ratio(modelAdjudicated, execution.candidates.length),
    },
    evidence,
    reliability: {
      callsStarted: coverage.callsStarted ?? 0,
      callsCompleted: coverage.callsCompleted ?? 0,
      callsCancelled: coverage.callsCancelled ?? 0,
      providerFailures: execution.providerFailures?.length ?? 0,
      structuredRepairs: execution.providerDiagnostics?.length ?? 0,
      errors: result.errors?.length ?? 0,
      timeout: Boolean(coverage.timeout),
    },
    efficiency: {
      durationMs: opts.durationMs,
      inputTokens: execution.inputTokens,
      outputTokens: execution.outputTokens,
      calls: coverage.callsStarted ?? 0,
      reviewedChangedLinesPerSecond: opts.durationMs > 0 ? changedLines.reviewed / (opts.durationMs / 1000) : null,
      reviewedChangedLinesPerThousandInputTokens:
        execution.inputTokens > 0 ? changedLines.reviewed / (execution.inputTokens / 1000) : null,
    },
    honesty,
  };
}

export function collectTraceMetrics(trace: AgentSmithTrace) {
  if (!trace.execution) throw new Error(`Trace ${trace.traceId} does not contain AgentSmith execution data`);
  return collectEvalMetrics({
    scope: trace.scope,
    result: trace.result,
    execution: trace.execution,
    durationMs: trace.result.coverage.elapsedMs ?? trace.result.coverage.timeout?.elapsedMs ?? 0,
  });
}
