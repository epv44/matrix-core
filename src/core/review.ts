import { runGate, type RunGateOptions } from "./gate.js";
import { runReview, writeResult } from "../agentsmith/scripts/run-review.js";
import type { QualityCompletionResult, QualityReviewResult, ReviewResult } from "./types.js";
import { resolveConfig } from "./config-resolver.js";
import { captureReviewScope } from "../agentsmith/scope.js";
import { computeWorkspaceVersion } from "./version.js";
import type { ReviewProvider } from "../agentsmith/provider.js";
import { getQualityStatus } from "./status.js";
import { formatAgentSmithReview, REVIEW_MARKDOWN_ARTIFACT } from "../agentsmith/report.js";
export { runReview } from "../agentsmith/scripts/run-review.js";
function unavailableReview(version: string, message: string): ReviewResult {
  return {
    schemaVersion: 2,
    version,
    status: "error",
    outcome: "incomplete",
    mode: "partitioned",
    findings: [],
    coverage: {
      changedFiles: 0,
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
      omissions: [],
    },
    summary: message,
    timestamp: new Date().toISOString(),
    reviewer: "AgentSmith",
    errors: [message],
  };
}
export async function runQualityReview(
  opts: RunGateOptions & { configFlag?: string; signal?: AbortSignal; provider?: ReviewProvider },
): Promise<QualityReviewResult> {
  const resolved = resolveConfig({ configFlag: opts.configFlag, cwd: opts.cwd });
  const scope = captureReviewScope({
    root: resolved.configRoot,
    base: opts.base,
    contextFiles: resolved.config.agentsmith?.context_files,
  });
  const gate = await runGate(opts);
  const review: ReviewResult =
    gate.status !== "PASS"
      ? unavailableReview(gate.version, "AgentSmith was not run because the deterministic gate failed")
      : resolved.config.agentsmith?.enabled === false
        ? unavailableReview(gate.version, "AgentSmith disabled")
        : await runReview({
            cwd: resolved.configRoot,
            version: gate.version,
            base: opts.base,
            report: JSON.stringify({
              status: gate.status,
              checks: gate.checks,
              failures: gate.failures,
              metrics: gate.metrics,
            }),
            config: opts.configFlag,
            signal: opts.signal,
            scope,
            provider: opts.provider,
          });
  writeResult(resolved.configRoot, review, gate.status);
  const advisory = resolved.config.agentsmith?.advisory !== false;
  const reviewArtifact = REVIEW_MARKDOWN_ARTIFACT;
  return {
    version: gate.version,
    gate,
    review,
    advisory,
    reviewMarkdown: formatAgentSmithReview(review, { gateStatus: gate.status, artifact: reviewArtifact }),
    reviewArtifact,
    passed:
      gate.status === "PASS" &&
      computeWorkspaceVersion(resolved.configRoot) === scope.version &&
      (advisory || (review.status === "completed" && review.outcome === "clear")),
  };
}

export async function runQualityCompletion(
  opts: RunGateOptions & { configFlag?: string; signal?: AbortSignal; provider?: ReviewProvider },
): Promise<QualityCompletionResult> {
  const resolved = resolveConfig({ configFlag: opts.configFlag, cwd: opts.cwd });
  if (resolved.config.agentsmith?.enabled) {
    const result = await runQualityReview(opts);
    const current = getQualityStatus(resolved.configRoot);
    const status =
      result.gate.status !== "PASS"
        ? "disabled"
        : result.review.coverage.timeout
          ? "timeout"
          : result.review.errors?.length
            ? "provider_error"
            : "completed";
    return {
      ...result,
      reviewEnabled: true,
      deterministicPassed: result.gate.status === "PASS",
      completionAllowed: current.completionAllowed,
      passed: current.completionAllowed,
      advisoryReview: {
        status,
        verdict: result.review.findings.length > 0 ? "findings" : result.review.outcome === "clear" ? "pass" : null,
        findings: result.review.findings,
        errors: result.review.errors ?? [],
        profileId: result.gate.policy?.agentSmith.id ?? null,
        profileHash: result.gate.policy?.agentSmith.hash ?? null,
        completedAt: result.review.timestamp,
      },
    };
  }
  const gate = await runGate(opts);
  const current = getQualityStatus(resolved.configRoot);
  return {
    version: gate.version,
    gate,
    review: null,
    reviewEnabled: false,
    advisory: true,
    passed: current.completionAllowed,
    deterministicPassed: gate.status === "PASS",
    completionAllowed: current.completionAllowed,
    reviewMarkdown: formatAgentSmithReview(null, { gateStatus: gate.status }),
    reviewArtifact: null,
    advisoryReview: {
      status: "disabled",
      verdict: null,
      findings: [],
      errors: [],
      profileId: null,
      profileHash: null,
    },
  };
}
