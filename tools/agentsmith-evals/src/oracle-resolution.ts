import type { EngineExecution } from "../../../src/agentsmith/engine-types.js";
import type { ReviewFinding, ReviewResult } from "../../../src/core/types.js";
import type { EvalCase } from "./case.js";
import type { Stage1RunScore } from "./stage-1.js";
import type { StageEvaluation } from "./stage-score.js";

export type CandidateResolution = "proven" | "disproven" | "unproven" | "missed";

export type RootCauseCode =
  | "candidate-miss"
  | "selection-miss"
  | "verifier-evidence-demand"
  | "locator-resolution-failure"
  | "retrieval-miss"
  | "evidence-packing-budget"
  | "citation-validation-failure"
  | "verifier-insufficient-evidence"
  | "verifier-likely-unpublished"
  | "verification-rejection"
  | "aggregation-miss"
  | "false-positive"
  | "timeout"
  | "provider-failure"
  | "fixture-invalid"
  | "unknown";

export type OracleDisposition = "proven" | "disproven" | "unproven";
export type EvalStatus = "pass" | "fail" | "partial";

export interface OracleResolutionAudit {
  oracleId: string;
  expectedDisposition: OracleDisposition;
  resolution: CandidateResolution;
  oracleSatisfied: boolean;
  reasonCode: RootCauseCode | null;
  candidateId: string | null;
  verifierVerdict: string | null;
}

type CandidateLabel = NonNullable<NonNullable<EvalCase["expectations"]["candidates"]>["items"]>[number];

function overlaps(actual: { file: string; line: number; endLine?: number; category?: string; severity?: string; title: string }, expected: {
  file: string;
  lineStart: number;
  lineEnd: number;
  category?: string;
  severity?: string;
  titleContains?: string;
}) {
  const endLine = actual.endLine ?? actual.line;
  return (
    actual.file === expected.file &&
    endLine >= expected.lineStart &&
    actual.line <= expected.lineEnd &&
    (!expected.category || actual.category === expected.category) &&
    (!expected.severity || actual.severity === expected.severity) &&
    (!expected.titleContains || actual.title.toLowerCase().includes(expected.titleContains.toLowerCase()))
  );
}

function expectedDisposition(label: CandidateLabel): OracleDisposition {
  if (!label.expectedPresence || label.expectedVerdict === "rejected") return "disproven";
  if (label.expectedVerdict === "verified") return "proven";
  return "unproven";
}

function verdictResolution(verdict: string | undefined): Exclude<CandidateResolution, "missed"> {
  if (verdict === "verified") return "proven";
  if (verdict === "rejected") return "disproven";
  return "unproven";
}

function textIncludes(value: unknown, pattern: RegExp): boolean {
  return pattern.test(JSON.stringify(value ?? "").toLowerCase());
}

function reasonForUnproven(
  execution: EngineExecution,
  candidateId: string,
  verdict: EngineExecution["verification"][number] | undefined,
): RootCauseCode {
  if (textIncludes(verdict?.diagnostics, /citation[- ]validation|unknown evidence|supporting evidence/))
    return "citation-validation-failure";
  if (verdict?.verdict === "insufficient_evidence") return "verifier-insufficient-evidence";
  if (verdict?.verdict === "likely") return "verifier-likely-unpublished";
  const outcomes = execution.evidenceOutcomes?.[candidateId] ?? [];
  if (outcomes.some((outcome) => textIncludes(outcome.reason, /token|budget|pack/))) return "evidence-packing-budget";
  if (outcomes.some((outcome) => textIncludes(outcome, /candidate omitted required evidence|engine-added|verifier/)))
    return "verifier-evidence-demand";
  if (outcomes.some((outcome) => textIncludes(outcome.reason, /locator|symbol|ambiguous|not found|unresolved/)))
    return "locator-resolution-failure";
  if (outcomes.some((outcome) => outcome.status === "unresolved" || outcome.status === "partial"))
    return "retrieval-miss";
  return "verification-rejection";
}

function reasonForMiss(execution: EngineExecution, stage1: Stage1RunScore | undefined, oracleId: string): RootCauseCode {
  if ((execution.providerFailures?.length ?? 0) > 0 || (execution.errors?.length ?? 0) > 0) return "provider-failure";
  const attribution = stage1?.gold.find((item) => item.id === oracleId)?.attribution;
  if (attribution === "selection-miss") return "selection-miss";
  if (attribution === "coverage-budget-failure") return "evidence-packing-budget";
  return "candidate-miss";
}

function syntheticLabels(definition: EvalCase): CandidateLabel[] {
  return (definition.expectations.aggregation?.findings ?? []).map((finding) => ({
    id: finding.id,
    file: finding.file,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    category: finding.category,
    severity: finding.severity,
    titleContains: finding.titleContains,
    expectedPresence: true,
    expectedVerdict: "verified" as const,
    requiredEvidenceKinds: [],
    requiredReasoningTerms: [],
    forbiddenReasoningTerms: [],
    rationale: finding.rationale,
  }));
}

function clearCaseAudit(execution: EngineExecution, result: ReviewResult): OracleResolutionAudit {
  if (result.findings.length > 0)
    return {
      oracleId: "case-clear",
      expectedDisposition: "disproven",
      resolution: "proven",
      oracleSatisfied: false,
      reasonCode: "false-positive",
      candidateId: result.findings[0]?.id ?? null,
      verifierVerdict: "verified",
    };
  if (!execution.candidates.length)
    return {
      oracleId: "case-clear",
      expectedDisposition: "disproven",
      resolution: "disproven",
      oracleSatisfied: true,
      reasonCode: null,
      candidateId: null,
      verifierVerdict: null,
    };
  const resolved = execution.candidates.map((candidate) => ({
    candidate,
    verdict: execution.verification.find((item) => item.candidateId === candidate.id),
  }));
  if (resolved.every((item) => item.verdict?.verdict === "rejected"))
    return {
      oracleId: "case-clear",
      expectedDisposition: "disproven",
      resolution: "disproven",
      oracleSatisfied: true,
      reasonCode: "verification-rejection",
      candidateId: resolved[0]?.candidate.id ?? null,
      verifierVerdict: "rejected",
    };
  const item = resolved.find((entry) => entry.verdict?.verdict !== "rejected") ?? resolved[0];
  const resolution = verdictResolution(item?.verdict?.verdict);
  return {
    oracleId: "case-clear",
    expectedDisposition: "disproven",
    resolution,
    oracleSatisfied: false,
    reasonCode:
      resolution === "proven"
        ? "false-positive"
        : reasonForUnproven(execution, item.candidate.id, item.verdict),
    candidateId: item.candidate.id,
    verifierVerdict: item.verdict?.verdict ?? null,
  };
}

export function evaluateOracleResolutions(input: {
  definition: EvalCase;
  execution: EngineExecution;
  result: ReviewResult;
  stage1?: Stage1RunScore;
}): OracleResolutionAudit[] {
  const declared =
    input.definition.expectations.verification?.candidates ??
    input.definition.expectations.candidates?.items ??
    [];
  const labels = declared.length ? declared : syntheticLabels(input.definition);
  if (!labels.length && input.definition.expectations.aggregation?.outcome === "clear")
    return [clearCaseAudit(input.execution, input.result)];
  const audits = labels.map((label) => {
    const candidate = input.execution.candidates.find((item) => overlaps(item, label));
    if (!candidate) {
      const expected = expectedDisposition(label);
      const resolution: CandidateResolution = label.expectedPresence ? "missed" : "disproven";
      return {
        oracleId: label.id,
        expectedDisposition: expected,
        resolution,
        oracleSatisfied: !label.expectedPresence,
        reasonCode: label.expectedPresence ? reasonForMiss(input.execution, input.stage1, label.id) : null,
        candidateId: null,
        verifierVerdict: null,
      };
    }
    const verdict = input.execution.verification.find((item) => item.candidateId === candidate.id);
    const published = input.result.findings.some((finding: ReviewFinding) => overlaps(finding, label));
    const resolution = published ? "proven" : verdictResolution(verdict?.verdict);
    const expected = expectedDisposition(label);
    const oracleSatisfied = resolution === expected && (expected !== "proven" || published);
    return {
      oracleId: label.id,
      expectedDisposition: expected,
      resolution,
      oracleSatisfied,
      reasonCode:
        oracleSatisfied
          ? resolution === "disproven" && candidate ? "verification-rejection" : null
          : expected === "proven" && resolution === "proven" && !published
            ? "aggregation-miss"
          : resolution === "unproven"
            ? reasonForUnproven(input.execution, candidate.id, verdict)
            : resolution === "proven"
              ? "false-positive"
              : "verification-rejection",
      candidateId: candidate.id,
      verifierVerdict: verdict?.verdict ?? null,
    };
  });
  if (input.definition.groundTruth?.exhaustiveCandidates) {
    const matchedCandidateIds = new Set(audits.flatMap((audit) => audit.candidateId ? [audit.candidateId] : []));
    for (const candidate of input.execution.candidates.filter((item) => !matchedCandidateIds.has(item.id))) {
      const verdict = input.execution.verification.find((item) => item.candidateId === candidate.id);
      const published = input.result.findings.some((finding) => finding.id === candidate.id);
      const resolution = published ? "proven" : verdictResolution(verdict?.verdict);
      audits.push({
        oracleId: `unexpected:${candidate.id}`,
        expectedDisposition: "disproven",
        resolution,
        oracleSatisfied: resolution === "disproven",
        reasonCode:
          resolution === "disproven"
            ? "verification-rejection"
            : resolution === "proven"
              ? "false-positive"
              : reasonForUnproven(input.execution, candidate.id, verdict),
        candidateId: candidate.id,
        verifierVerdict: verdict?.verdict ?? null,
      });
    }
  }
  return audits;
}

export function deriveEvalStatus(input: {
  executionStatus: string;
  oracleResolutions: OracleResolutionAudit[];
  stages: StageEvaluation[];
  errors?: string[];
  incompatibilities?: string[];
}): EvalStatus | "error" | "incompatible" | "unavailable" {
  if (input.errors?.length || input.executionStatus === "error") return "error";
  if (input.incompatibilities?.length) return "incompatible";
  const applicable = input.stages.filter((stage) => stage.evaluation !== "not-applicable");
  if (applicable.length > 0 && applicable.every((stage) => stage.evaluation === "not-evaluable")) return "unavailable";
  const definitiveOracleFailure = input.oracleResolutions.some(
    (item) => !item.oracleSatisfied && item.resolution !== "unproven",
  );
  if (definitiveOracleFailure) return "fail";
  const unresolvedOracle = input.oracleResolutions.some((item) => !item.oracleSatisfied && item.resolution === "unproven");
  if (unresolvedOracle || input.executionStatus === "partial" || input.executionStatus === "stale") return "partial";
  if (applicable.some((stage) => stage.causalStatus === "root-failure")) return "fail";
  if (applicable.some((stage) => stage.evaluation === "not-evaluable")) return "partial";
  return "pass";
}
