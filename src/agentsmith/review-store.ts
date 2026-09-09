import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { CandidateResolutionAudit, ReviewIncompleteReason, ReviewResult } from "../core/types.js";

type LegacyReviewResultV3 = Omit<
  ReviewResult,
  "schemaVersion" | "candidateResolutions" | "migratedFromSchemaVersion"
> & {
  schemaVersion: 3;
  candidateResolutions?: never;
};

function isReviewShape(value: unknown): value is LegacyReviewResultV3 | ReviewResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyReviewResultV3 | ReviewResult>;
  return (
    (candidate.schemaVersion === 3 || candidate.schemaVersion === 4) &&
    typeof candidate.version === "string" &&
    ["completed", "partial", "error", "stale"].includes(String(candidate.status)) &&
    ["clear", "findings", "incomplete"].includes(String(candidate.outcome)) &&
    typeof candidate.summary === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.reviewer === "string" &&
    Array.isArray(candidate.findings) &&
    Boolean(candidate.coverage)
  );
}

export function isCurrentReviewResult(value: unknown): value is ReviewResult {
  return (
    isReviewShape(value) &&
    value.schemaVersion === 4 &&
    value.migratedFromSchemaVersion !== 3 &&
    Array.isArray(value.candidateResolutions)
  );
}

function emptyLegacyAudit(
  candidateId: string,
  resolution: CandidateResolutionAudit["resolution"],
  reasonCode: CandidateResolutionAudit["reasonCode"],
  detail: string,
  verifier: CandidateResolutionAudit["verifier"],
): CandidateResolutionAudit {
  return {
    candidateId,
    resolution,
    ...(reasonCode ? { reasonCode } : {}),
    detail,
    sourceWorkItemIds: [],
    sourceReviewers: [],
    evidence: { requestOutcomes: [], resolvedRecordIds: [], packedRecordIds: [] },
    verifier,
  };
}

/**
 * Adapt persisted schema-v3 review evidence for conservative compatibility reads.
 *
 * V3 mixed execution completeness with verifier abstention, so its status is
 * intentionally preserved rather than reinterpreted as a successful v4 run.
 */
export function adaptLegacyReviewResultV3(value: unknown): ReviewResult | null {
  if (!isReviewShape(value) || value.schemaVersion !== 3) return null;
  const reasons = (value.incompleteReasons ?? []) as ReviewIncompleteReason[];
  const candidateResolutions: CandidateResolutionAudit[] = value.findings.map((finding) =>
    emptyLegacyAudit(finding.id, "proven", undefined, "Legacy v3 artifact contains a published verified finding.", {
      verdict: "verified",
      supportingEvidenceIds: finding.evidence.map((record) => record.id),
      failureKinds: [],
    }),
  );
  const represented = new Set(candidateResolutions.map((audit) => audit.candidateId));
  for (const [index, reason] of reasons.entries()) {
    if (!["insufficient-evidence", "likely-unpublished", "unadjudicated-candidate"].includes(reason.kind)) continue;
    const candidateId = reason.id ?? `legacy-v3-unresolved-${index + 1}`;
    if (represented.has(candidateId)) continue;
    represented.add(candidateId);
    const likely = reason.kind === "likely-unpublished";
    candidateResolutions.push(
      emptyLegacyAudit(
        candidateId,
        "unproven",
        likely
          ? "verifier-likely-unpublished"
          : reason.kind === "unadjudicated-candidate"
            ? "selection-miss"
            : "verifier-insufficient-evidence",
        reason.detail,
        {
          verdict: likely ? "likely" : reason.kind === "unadjudicated-candidate" ? "not_run" : "insufficient_evidence",
          supportingEvidenceIds: [],
          failureKinds: [],
        },
      ),
    );
  }
  const aggregate = value.candidates;
  const appendAggregateAudits = (
    count: number,
    prefix: string,
    resolution: CandidateResolutionAudit["resolution"],
    reasonCode: CandidateResolutionAudit["reasonCode"],
    verdict: NonNullable<CandidateResolutionAudit["verifier"]>["verdict"],
    detail: string,
  ) => {
    for (let index = 0; index < count; index++) {
      const candidateId = `legacy-v3-${prefix}-${index + 1}`;
      if (represented.has(candidateId)) continue;
      represented.add(candidateId);
      candidateResolutions.push(
        emptyLegacyAudit(candidateId, resolution, reasonCode, detail, {
          verdict,
          supportingEvidenceIds: [],
          failureKinds: [],
        }),
      );
    }
  };
  const representedLikely = candidateResolutions.filter((audit) => audit.verifier?.verdict === "likely").length;
  const representedInsufficient = candidateResolutions.filter(
    (audit) => audit.verifier?.verdict === "insufficient_evidence",
  ).length;
  const representedRejected = candidateResolutions.filter((audit) => audit.verifier?.verdict === "rejected").length;
  const representedOmitted = candidateResolutions.filter((audit) => audit.verifier?.verdict === "not_run").length;
  appendAggregateAudits(
    Math.max(0, (aggregate?.likely ?? 0) - representedLikely),
    "likely",
    "unproven",
    "verifier-likely-unpublished",
    "likely",
    "Legacy v3 aggregate records a likely candidate without candidate-level evidence.",
  );
  appendAggregateAudits(
    Math.max(0, (aggregate?.insufficientEvidence ?? 0) - representedInsufficient),
    "insufficient",
    "unproven",
    "verifier-insufficient-evidence",
    "insufficient_evidence",
    "Legacy v3 aggregate records an insufficient-evidence candidate without candidate-level evidence.",
  );
  appendAggregateAudits(
    Math.max(0, (aggregate?.rejected ?? 0) - representedRejected),
    "rejected",
    "disproven",
    "verification-rejection",
    "rejected",
    "Legacy v3 aggregate records a verifier-rejected candidate without candidate-level evidence.",
  );
  appendAggregateAudits(
    Math.max(0, (aggregate?.omitted ?? 0) - representedOmitted),
    "omitted",
    "unproven",
    "selection-miss",
    "not_run",
    "Legacy v3 aggregate records an omitted candidate without candidate-level evidence.",
  );
  appendAggregateAudits(
    Math.max(0, (aggregate?.generated ?? 0) - candidateResolutions.length),
    "unknown",
    "unproven",
    "unknown",
    "not_run",
    "Legacy v3 aggregate lacks enough candidate-level evidence to reconstruct this resolution.",
  );
  const hasUnresolved = candidateResolutions.some(
    (audit) => audit.resolution === "unproven" || audit.resolution === "missed",
  );
  return {
    ...value,
    schemaVersion: 4,
    migratedFromSchemaVersion: 3,
    outcome: hasUnresolved && value.findings.length === 0 ? "incomplete" : value.outcome,
    candidateResolutions,
    cacheHit: false,
  };
}

export function reviewResultPath(root: string) {
  return path.join(root, ".quality", "review-result.yaml");
}
export function reviewMarkdownPath(root: string) {
  return path.join(root, ".quality", "review-result.md");
}
export function readReviewResult(root: string): ReviewResult | null {
  try {
    const value = yaml.load(fs.readFileSync(reviewResultPath(root), "utf8"));
    if (!isReviewShape(value)) return null;
    if (value.schemaVersion === 3) return adaptLegacyReviewResultV3(value);
    return isCurrentReviewResult(value) ? value : null;
  } catch {
    return null;
  }
}
