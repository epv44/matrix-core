import type { ReviewResult } from "../core/types.js";

export interface ShadowComparison {
  schemaVersion: 1;
  old: {
    status: ReviewResult["status"];
    outcome: ReviewResult["outcome"];
    findings: number;
    verifiedPrecision: number;
  };
  next: {
    status: ReviewResult["status"];
    outcome: ReviewResult["outcome"];
    findings: number;
    verifiedPrecision: number;
  };
  deltas: {
    findings: number;
    verifiedPrecision: number;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    partial: number;
  };
  findingIdsAdded: string[];
  findingIdsRemoved: string[];
}

function precision(result: ReviewResult): number {
  const verified = result.findings.length;
  const candidates = result.candidates;
  return candidates && candidates.verified > 0 ? verified / candidates.verified : verified === 0 ? 1 : 0;
}

function summary(result: ReviewResult) {
  return {
    status: result.status,
    outcome: result.outcome,
    findings: result.findings.length,
    verifiedPrecision: precision(result),
  };
}

/** Produce a deterministic, side-effect-free comparison for old/new shadow runs. */
export function buildShadowComparison(oldResult: ReviewResult, nextResult: ReviewResult): ShadowComparison {
  const old = summary(oldResult);
  const next = summary(nextResult);
  const oldIds = new Set(oldResult.findings.map((finding) => finding.id));
  const nextIds = new Set(nextResult.findings.map((finding) => finding.id));
  return {
    schemaVersion: 1,
    old,
    next,
    deltas: {
      findings: next.findings - old.findings,
      verifiedPrecision: next.verifiedPrecision - old.verifiedPrecision,
      inputTokens: (nextResult.runtime?.inputTokens ?? 0) - (oldResult.runtime?.inputTokens ?? 0),
      outputTokens: (nextResult.runtime?.outputTokens ?? 0) - (oldResult.runtime?.outputTokens ?? 0),
      calls: (nextResult.coverage.callsStarted ?? 0) - (oldResult.coverage.callsStarted ?? 0),
      partial: Number(nextResult.status === "partial") - Number(oldResult.status === "partial"),
    },
    findingIdsAdded: [...nextIds].filter((id) => !oldIds.has(id)).sort(),
    findingIdsRemoved: [...oldIds].filter((id) => !nextIds.has(id)).sort(),
  };
}

export function escalationSignals(result: ReviewResult): string[] {
  const signals: string[] = [];
  if (result.status === "partial") signals.push("partial-execution");
  if (result.coverage.tokenBudgetOmissions && result.coverage.tokenBudgetOmissions > 0)
    signals.push("budget-exhausted");
  if (result.coverage.timeoutOmissions && result.coverage.timeoutOmissions > 0) signals.push("timeout");
  if (
    result.candidateResolutions.some(
      (candidate) => candidate.resolution === "unproven" || candidate.resolution === "missed",
    )
  )
    signals.push("insufficient-context");
  return signals;
}
