import { atomicWriteFile } from "../../core/filesystem.js";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { GateStatus, ReviewResult } from "../../core/types.js";
import { resolveConfig } from "../../core/config-resolver.js";
import { resolvePolicyForConfig } from "../../core/resolved-policy.js";
import { ENGINE_VERSION } from "../../core/meta.js";
import { AGENT_SMITH, emptyReviewCoverage } from "../../core/reviewer.js";
import { OllamaProvider, type ReviewProvider } from "../provider.js";
import { captureReviewScope, type ReviewScope } from "../scope.js";
import { executeReviewEngine } from "../engine.js";
import { isAgentSmithTraceEnabled, writeAgentSmithTrace } from "../trace.js";
import { captureSourceSnapshot, sourceManifestHash, type CapturedSourceSnapshot } from "../source-snapshot.js";
import { formatAgentSmithReview, REVIEW_MARKDOWN_ARTIFACT } from "../report.js";
import { hashDiff } from "./hash-diff.js";
import { AGENTSMITH_STRATEGY_HASH } from "../strategy.js";

export interface RunReviewOptions {
  cwd: string;
  version: string;
  base?: string;
  report?: string;
  config?: string;
  signal?: AbortSignal;
  provider?: ReviewProvider;
  scope?: ReviewScope;
}
export interface RunReviewDeps {
  provider?: ReviewProvider;
}

export function materializeCachedReview(
  cached: ReviewResult,
  current: { version: string; timestamp: string; scopeId?: string },
): ReviewResult {
  return {
    ...cached,
    version: current.version,
    timestamp: current.timestamp,
    scopeId: current.scopeId,
    cacheHit: true,
  };
}

export function writeResult(cwd: string, result: ReviewResult, gateStatus?: GateStatus) {
  const directory = path.join(cwd, ".quality");
  fs.mkdirSync(directory, { recursive: true });
  const outputs = [
    [path.join(directory, "review-result.yaml"), yaml.dump(result, { noRefs: true, sortKeys: true })],
    [
      path.join(cwd, REVIEW_MARKDOWN_ARTIFACT),
      formatAgentSmithReview(result, { gateStatus, artifact: REVIEW_MARKDOWN_ARTIFACT }),
    ],
  ] as const;
  for (const [target, contents] of outputs) {
    atomicWriteFile(target, contents);
  }
}

export async function runReview(opts: RunReviewOptions, deps: RunReviewDeps = {}): Promise<ReviewResult> {
  const resolved = resolveConfig({ configFlag: opts.config, cwd: opts.cwd });
  const policy = resolvePolicyForConfig(resolved);
  const config = resolved.config.agentsmith!;
  const scopeStarted = Date.now();
  const scope =
    opts.scope ??
    captureReviewScope({ root: resolved.configRoot, base: opts.base, contextFiles: config.context_files });
  let sourceSnapshotCapture: CapturedSourceSnapshot | undefined;
  if (isAgentSmithTraceEnabled()) {
    try {
      sourceSnapshotCapture = captureSourceSnapshot(resolved.configRoot, scope.version);
    } catch (error) {
      const warning = `source snapshot capture failed: ${error instanceof Error ? error.message : String(error)}`;
      const manifest = {
        schemaVersion: 1 as const,
        repositoryFingerprint: scope.version,
        gitHead: null,
        entries: [],
        deletedPaths: [],
      };
      sourceSnapshotCapture = {
        manifest,
        manifestHash: sourceManifestHash(manifest),
        fileCount: 0,
        totalBytes: 0,
        complete: false,
        portable: false,
        captureDurationMs: 0,
        warnings: [warning],
      };
    }
  }
  const snapshotElapsedMs = Date.now() - scopeStarted;
  const timestamp = new Date().toISOString();
  const cacheKey = hashDiff({
    diff: scope.diff,
    config: JSON.stringify({
      schemaVersion: 3,
      scopeId: scope.id,
      profileHash: policy.agentSmith.hash,
      strategyHash: AGENTSMITH_STRATEGY_HASH,
      models: config.models,
      mode: config.mode,
    }),
  });
  const cacheFile = path.join(resolved.configRoot, ".quality", "cache", "agentsmith-v4", `${cacheKey}.yaml`);
  try {
    if (config.cache && fs.existsSync(cacheFile)) {
      const cached = yaml.load(fs.readFileSync(cacheFile, "utf8")) as ReviewResult;
      if (cached?.schemaVersion === 3) {
        const result = materializeCachedReview(cached, { version: opts.version, timestamp, scopeId: scope.id });
        const recorded = writeAgentSmithTrace(resolved.configRoot, {
          packageVersion: ENGINE_VERSION,
          version: result.version,
          profileHash: result.profileHash,
          strategyHash: result.strategyHash,
          graphSnapshotHash: result.graphSnapshotHash,
          sourceSnapshotCapture,
          scope,
          deterministicReport: opts.report ?? "",
          result,
          decisionProvenance: {
            publishedFindingIds: result.findings.map((finding) => finding.id),
            rejectedCandidateIds: [],
            likelyCandidateIds: [],
            insufficientEvidenceCandidateIds: [],
            aggregateRule: "cached completed result; only previously verified findings are published",
            errors: result.errors ?? [],
          },
        });
        if (recorded.traceId) result.traceId = recorded.traceId;
        const traceWarnings = [
          ...(recorded.warning ? [recorded.warning] : []),
          ...(sourceSnapshotCapture && (!sourceSnapshotCapture.complete || !sourceSnapshotCapture.portable)
            ? sourceSnapshotCapture.warnings
            : []),
        ];
        if (traceWarnings.length) result.traceWarnings = traceWarnings;
        writeResult(resolved.configRoot, result);
        return result;
      }
    }
    const provider = opts.provider ?? deps.provider ?? new OllamaProvider(config);
    const { result, execution } = await executeReviewEngine({
      root: resolved.configRoot,
      version: opts.version,
      scope,
      config,
      provider,
      profileHash: policy.agentSmith.hash,
      assetRoot: policy.agentSmith.assetRoot,
      deterministicReport: opts.report,
      signal: opts.signal,
    });
    const rejected = execution.verification
      .filter((item) => item.verdict === "rejected")
      .map((item) => item.candidateId);
    const likely = execution.verification.filter((item) => item.verdict === "likely").map((item) => item.candidateId);
    const insufficient = execution.verification
      .filter((item) => item.verdict === "insufficient_evidence")
      .map((item) => item.candidateId);
    execution.stageTimingsMs = { ...execution.stageTimingsMs, snapshot: snapshotElapsedMs };
    const reportingStarted = Date.now();
    formatAgentSmithReview(result, { artifact: REVIEW_MARKDOWN_ARTIFACT });
    execution.stageTimingsMs.reporting = Date.now() - reportingStarted;
    const recorded = writeAgentSmithTrace(resolved.configRoot, {
      packageVersion: ENGINE_VERSION,
      version: result.version,
      profileHash: result.profileHash,
      strategyHash: result.strategyHash,
      graphSnapshotHash: result.graphSnapshotHash,
      sourceSnapshotCapture,
      scope,
      deterministicReport: opts.report ?? "",
      execution,
      result,
      decisionProvenance: {
        publishedFindingIds: result.findings.map((finding) => finding.id),
        rejectedCandidateIds: rejected,
        likelyCandidateIds: likely,
        insufficientEvidenceCandidateIds: insufficient,
        aggregateRule: "only verifier-confirmed candidates are published; incomplete work prevents a clear outcome",
        errors: result.errors ?? [],
      },
    });
    if (recorded.traceId) result.traceId = recorded.traceId;
    const traceWarnings = [
      ...(recorded.warning ? [recorded.warning] : []),
      ...(sourceSnapshotCapture && (!sourceSnapshotCapture.complete || !sourceSnapshotCapture.portable)
        ? sourceSnapshotCapture.warnings
        : []),
    ];
    if (traceWarnings.length) result.traceWarnings = traceWarnings;
    if (config.cache && result.status === "completed") {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, yaml.dump(result, { noRefs: true, sortKeys: true }), "utf8");
    }
    writeResult(resolved.configRoot, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result: ReviewResult = {
      schemaVersion: 3,
      version: opts.version,
      snapshotId: scope.id,
      status: "error",
      outcome: "incomplete",
      mode: config.mode === "auto" ? "partitioned" : config.mode,
      reviewPath: "generic",
      findings: [],
      coverage: emptyReviewCoverage(scope),
      summary: "Review could not be completed.",
      timestamp,
      reviewer: AGENT_SMITH,
      candidates: { generated: 0, verified: 0, likely: 0, rejected: 0, insufficientEvidence: 0 },
      errors: [message],
      scopeId: scope.id,
      profileHash: policy.agentSmith.hash,
      strategyHash: AGENTSMITH_STRATEGY_HASH,
      graphSnapshotHash: null,
      runtime: { models: config.models, inputTokens: 0, outputTokens: 0, concurrency: config.concurrency },
    };
    const recorded = writeAgentSmithTrace(resolved.configRoot, {
      packageVersion: ENGINE_VERSION,
      version: result.version,
      profileHash: result.profileHash,
      strategyHash: result.strategyHash,
      graphSnapshotHash: null,
      sourceSnapshotCapture,
      scope,
      deterministicReport: opts.report ?? "",
      result,
      decisionProvenance: {
        publishedFindingIds: [],
        rejectedCandidateIds: [],
        likelyCandidateIds: [],
        insufficientEvidenceCandidateIds: [],
        aggregateRule: "provider or engine failure produces incomplete review",
        errors: [message],
      },
    });
    if (recorded.traceId) result.traceId = recorded.traceId;
    const traceWarnings = [
      ...(recorded.warning ? [recorded.warning] : []),
      ...(sourceSnapshotCapture && (!sourceSnapshotCapture.complete || !sourceSnapshotCapture.portable)
        ? sourceSnapshotCapture.warnings
        : []),
    ];
    if (traceWarnings.length) result.traceWarnings = traceWarnings;
    writeResult(resolved.configRoot, result);
    return result;
  }
}
