import type { CandidateFinding } from "../core/types.js";
import type { ControlFlowWitness } from "../core/review-contracts.js";
import type { StructuredReviewRule, VerificationResult } from "./engine-types.js";

export const LEGACY_VERIFICATION_CONTRACT = "legacy-verdict/v1" as const;
export const WITNESS_RULE_PROVENANCE_CONTRACT = "witness-rule-provenance/v1" as const;
export type VerificationContractId =
  | typeof LEGACY_VERIFICATION_CONTRACT
  | typeof WITNESS_RULE_PROVENANCE_CONTRACT;

export interface VerificationRuleProvenance {
  id: string;
  short: string;
  explanation: string;
}

export interface VerificationWitnessProvenance {
  version: ControlFlowWitness["version"];
  witnessId: string;
  witnessKey: string;
  file: string;
  startLine: number;
  endLine: number;
  previousGuard: string;
  currentGuard: string;
  state: string;
  previousOutcome: ControlFlowWitness["previousOutcome"];
  currentOutcome: ControlFlowWitness["currentOutcome"];
}

export interface VerificationProvenance {
  contract: typeof WITNESS_RULE_PROVENANCE_CONTRACT;
  rule?: VerificationRuleProvenance;
  witness?: VerificationWitnessProvenance;
}

export const PROVENANCE_VERIFICATION_INSTRUCTIONS =
  "Judge one candidate defect using only the supplied changed code, resolved evidence, and host provenance. Host provenance is immutable: treat a bound control-flow witness outcome as a mechanical fact about the named state and guard, and treat the canonical rule text as the policy under review. VERIFIED requires that the witnessed or evidenced behavior violates the supplied rule and is fully supported by exact evidence IDs. REJECTED requires cited evidence or a witness outcome that directly contradicts the claim; nearby defensive code is not enough. Use INSUFFICIENT_EVIDENCE whenever a required fact is missing, and LIKELY when plausible but not proven. Do not invent rules, witnesses, or evidence. In supportingEvidenceIds, use the exact raw evidence IDs without brackets or other decoration. Return only the requested JSON object.";

/** Generic claim polarity from title/description; never fixture-specific policy wording. */
export function claimedGuardOutcome(
  candidate: Pick<CandidateFinding, "title" | "description">,
): ControlFlowWitness["currentOutcome"] | undefined {
  const text = `${candidate.title}\n${candidate.description}`.toLowerCase();
  const blocked =
    /\bblocking throw executes\b/.test(text) ||
    /\bcannot reach\b/.test(text) ||
    /\bare blocked\b/.test(text) ||
    /\bis blocked\b/.test(text) ||
    /\bevaluates true\b/.test(text) ||
    /\bblocks\b/.test(text);
  const passes =
    /\bblocking throw is skipped\b/.test(text) ||
    /\bbypasses\b/.test(text) ||
    /\bevaluates false\b/.test(text) ||
    /\bcontinues\b/.test(text) ||
    /\ballows\b/.test(text);
  if (blocked && !passes) return "blocked";
  if (passes && !blocked) return "passes";
  return undefined;
}

/** True when the claim is about a guard/authorization boundary, not a generic contract miss. */
export function isGuardAuthorizationClaim(
  candidate: Pick<CandidateFinding, "title" | "description" | "category" | "ruleId"> & {
    classification?: { basisRuleId?: string };
  },
): boolean {
  if (candidate.category === "security") return true;
  const ruleId = `${candidate.classification?.basisRuleId ?? ""} ${candidate.ruleId ?? ""}`.toLowerCase();
  if (/authoriz|authenticat|access-control|permission|rbac/.test(ruleId)) return true;
  const text = `${candidate.title}\n${candidate.description}`.toLowerCase();
  return /\b(authoriz|authenticat|guard|bypass|forbidden|permission|role\b|session\b)/.test(text);
}

/** Bound witness establishes a concrete newly-introduced policy-relevant pass (bypass). */
export function witnessEstablishesRuleViolation(witness: VerificationWitnessProvenance): boolean {
  return witness.previousOutcome === "blocked" && witness.currentOutcome === "passes";
}

function witnessProvenance(witness: ControlFlowWitness): VerificationWitnessProvenance {
  return {
    version: witness.version,
    witnessId: witness.witnessId,
    witnessKey: witness.witnessKey,
    file: witness.file,
    startLine: witness.startLine,
    endLine: witness.endLine,
    previousGuard: witness.previousGuard,
    currentGuard: witness.currentGuard,
    state: witness.state,
    previousOutcome: witness.previousOutcome,
    currentOutcome: witness.currentOutcome,
  };
}

function bindWitness(
  candidate: CandidateFinding,
  witnesses: readonly ControlFlowWitness[],
): ControlFlowWitness | undefined {
  if (candidate.witness?.witnessKey) {
    const byKey = witnesses.find((entry) => entry.witnessKey === candidate.witness!.witnessKey);
    if (
      byKey &&
      byKey.file === candidate.file &&
      byKey.startLine === candidate.line &&
      byKey.endLine === (candidate.endLine ?? candidate.line) &&
      (!candidate.witness.witnessId || byKey.witnessId === candidate.witness.witnessId)
    )
      return byKey;
    return undefined;
  }
  const locationMatches = witnesses.filter(
    (entry) =>
      entry.file === candidate.file &&
      entry.startLine === candidate.line &&
      entry.endLine === (candidate.endLine ?? candidate.line),
  );
  if (!locationMatches.length) return undefined;
  // Require positive state overlap so an unrelated claim at the same line does
  // not inherit a co-located witness. Explicit candidate.witness keys bind above.
  const claimText = `${candidate.title}\n${candidate.description}`.toLowerCase();
  const scored = locationMatches
    .map((entry) => {
      const tokens = entry.state.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
      const overlap = tokens.filter((token) => token.length > 2 && claimText.includes(token)).length;
      return { entry, overlap };
    })
    .sort((left, right) => right.overlap - left.overlap || left.entry.witnessKey.localeCompare(right.entry.witnessKey));
  if (
    scored[0]!.overlap > 0 &&
    (scored.length === 1 || scored[0]!.overlap > (scored[1]?.overlap ?? 0))
  )
    return scored[0]!.entry;
  return undefined;
}

export function resolveVerificationProvenance(opts: {
  candidate: CandidateFinding;
  rules: readonly StructuredReviewRule[];
  witnesses: readonly ControlFlowWitness[];
}): VerificationProvenance {
  const ruleId = opts.candidate.classification?.basisRuleId ?? opts.candidate.ruleId;
  const structured = ruleId ? opts.rules.find((rule) => rule.id === ruleId) : undefined;
  const witness = bindWitness(opts.candidate, opts.witnesses);
  return {
    contract: WITNESS_RULE_PROVENANCE_CONTRACT,
    ...(structured
      ? {
          rule: {
            id: structured.id,
            short: structured.short,
            explanation: structured.explanation,
          },
        }
      : {}),
    ...(witness ? { witness: witnessProvenance(witness) } : {}),
  };
}

/**
 * Fail-closed host checks only. Never emits `verified`.
 * Returns null when the model must adjudicate.
 */
export function failClosedProvenancePreflight(opts: {
  candidate: CandidateFinding;
  provenance: VerificationProvenance;
  /** When the review unit exposes CF witnesses, auth/guard claims must bind one. */
  controlFlowWitnessesAvailable?: boolean;
}): VerificationResult | null {
  const { candidate, provenance } = opts;
  if (!provenance.rule && !provenance.witness) {
    return {
      candidateId: candidate.id,
      verdict: "insufficient_evidence",
      confidence: 1,
      reasoningSummary:
        "host provenance preflight: candidate has no resolvable canonical rule or validated control-flow witness for its invariant",
      supportingEvidenceIds: [],
    };
  }
  if (
    opts.controlFlowWitnessesAvailable &&
    isGuardAuthorizationClaim(candidate) &&
    !provenance.witness
  ) {
    return {
      candidateId: candidate.id,
      verdict: "insufficient_evidence",
      confidence: 1,
      reasoningSummary:
        "host provenance preflight: guard/authorization claim requires a bound control-flow witness when witnesses are available",
      supportingEvidenceIds: [],
    };
  }
  if (provenance.witness) {
    const claimed = claimedGuardOutcome(candidate);
    if (isGuardAuthorizationClaim(candidate) && !claimed) {
      return {
        candidateId: candidate.id,
        verdict: "insufficient_evidence",
        confidence: 1,
        reasoningSummary:
          "host provenance preflight: guard/authorization claim lacks concrete bypass/block polarity against the bound witness",
        supportingEvidenceIds: [],
      };
    }
    if (claimed && claimed !== provenance.witness.currentOutcome) {
      return {
        candidateId: candidate.id,
        verdict: "rejected",
        confidence: 1,
        reasoningSummary: `host provenance preflight: claim polarity (${claimed}) contradicts bound witness currentOutcome (${provenance.witness.currentOutcome}) for state ${provenance.witness.state}`,
        supportingEvidenceIds: [],
      };
    }
    if (isGuardAuthorizationClaim(candidate) && !witnessEstablishesRuleViolation(provenance.witness)) {
      return {
        candidateId: candidate.id,
        verdict: "rejected",
        confidence: 1,
        reasoningSummary: `host provenance preflight: bound witness (${provenance.witness.previousOutcome}→${provenance.witness.currentOutcome}) does not establish an authorization-rule violation for state ${provenance.witness.state}`,
        supportingEvidenceIds: [],
      };
    }
  }
  return null;
}

/**
 * Post-model publish gate for provenance contract. Never upgrades a verdict.
 * Demotes unverifiable `verified` outcomes; host never auto-emits verified.
 */
export function demoteUnpublishableVerified(opts: {
  candidate: CandidateFinding;
  outcome: VerificationResult;
  provenance: VerificationProvenance;
  controlFlowWitnessesAvailable?: boolean;
}): VerificationResult {
  if (opts.outcome.verdict !== "verified") return opts.outcome;
  const closed = failClosedProvenancePreflight({
    candidate: opts.candidate,
    provenance: opts.provenance,
    controlFlowWitnessesAvailable: opts.controlFlowWitnessesAvailable,
  });
  if (closed) {
    return {
      ...closed,
      reasoningSummary: `host provenance publish gate: ${closed.reasoningSummary}`,
    };
  }
  if (!opts.outcome.supportingEvidenceIds.length) {
    return {
      candidateId: opts.candidate.id,
      verdict: "insufficient_evidence",
      confidence: Math.min(opts.outcome.confidence, 1),
      reasoningSummary:
        "host provenance publish gate: verified verdict missing supporting evidence citations",
      supportingEvidenceIds: [],
    };
  }
  if (opts.provenance.witness) {
    const claimed = claimedGuardOutcome(opts.candidate);
    if (claimed && claimed !== opts.provenance.witness.currentOutcome) {
      return {
        candidateId: opts.candidate.id,
        verdict: "rejected",
        confidence: 1,
        reasoningSummary: `host provenance publish gate: claim polarity (${claimed}) contradicts bound witness currentOutcome (${opts.provenance.witness.currentOutcome})`,
        supportingEvidenceIds: opts.outcome.supportingEvidenceIds,
      };
    }
  } else if (
    opts.controlFlowWitnessesAvailable &&
    isGuardAuthorizationClaim(opts.candidate)
  ) {
    return {
      candidateId: opts.candidate.id,
      verdict: "insufficient_evidence",
      confidence: 1,
      reasoningSummary:
        "host provenance publish gate: guard/authorization verified claim lacks a bound control-flow witness",
      supportingEvidenceIds: [],
    };
  }
  return opts.outcome;
}

export function buildProvenanceVerificationPrompt(opts: {
  candidate: CandidateFinding;
  originatingCode: string;
  evidenceText: string;
  provenance: VerificationProvenance;
}): string {
  return [
    PROVENANCE_VERIFICATION_INSTRUCTIONS,
    "",
    "Host provenance (immutable):",
    JSON.stringify(opts.provenance, null, 2),
    "",
    "Candidate:",
    JSON.stringify(opts.candidate),
    "",
    "Originating changed code:",
    opts.originatingCode,
    "",
    "Resolved evidence:",
    opts.evidenceText || "(none)",
  ].join("\n");
}
