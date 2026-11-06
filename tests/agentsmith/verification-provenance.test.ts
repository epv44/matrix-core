import { describe, expect, it } from "vitest";
import type { CandidateFinding } from "../../src/core/types.js";
import type { ControlFlowWitness } from "../../src/core/review-contracts.js";
import type { StructuredReviewRule } from "../../src/agentsmith/engine-types.js";
import {
  WITNESS_RULE_PROVENANCE_CONTRACT,
  buildProvenanceVerificationPrompt,
  claimedGuardOutcome,
  demoteUnpublishableVerified,
  failClosedProvenancePreflight,
  isGuardAuthorizationClaim,
  resolveVerificationProvenance,
  witnessEstablishesRuleViolation,
} from "../../src/agentsmith/verification-provenance.js";

const rule: StructuredReviewRule = {
  id: "security.authorization-boundary",
  languages: ["typescript"],
  categories: ["security"],
  severity: "critical",
  triggers: [],
  short: "Verify authentication and authorization remain enforced at every changed boundary.",
  explanation: "Require an executable bypass path and exact evidence; naming alone is insufficient.",
};

const memberWitness: ControlFlowWitness = {
  version: "control-flow-witness/v1",
  witnessId: "witness-member",
  witnessKey: "deleteUser.guard-5.state-1",
  snapshotId: "snap",
  ownerSymbol: { file: "src/routes.ts", qualifiedName: "deleteUser", startLine: 3, endLine: 7 },
  file: "src/routes.ts",
  startLine: 5,
  endLine: 5,
  previousGuard: "!session || role !== \"admin\"",
  currentGuard: "!session && role !== \"admin\"",
  operatorTokens: ["&&"],
  state: 'session present, role = "member"',
  previousOutcome: "blocked",
  currentOutcome: "passes",
};

function candidate(partial: Partial<CandidateFinding> & Pick<CandidateFinding, "id" | "title" | "description">): CandidateFinding {
  return {
    sourceWorkItemIds: [],
    sourceReviewers: [],
    file: "src/routes.ts",
    line: 5,
    endLine: 5,
    severity: "critical",
    category: "security",
    evidenceRequests: [],
    candidateConfidence: 1,
    ...partial,
  };
}

describe("verification provenance", () => {
  it("detects generic claim polarity without fixture-specific policy wording", () => {
    expect(
      claimedGuardOutcome({
        title: "Member session bypasses the admin guard",
        description: "Trigger: session is present with role member; the blocking throw is skipped and deleteUser continues.",
      }),
    ).toBe("passes");
    expect(
      claimedGuardOutcome({
        title: "Member sessions are blocked by the admin guard",
        description: "Trigger: session is present with role member; the blocking throw executes. Impact: the member cannot reach deletion.",
      }),
    ).toBe("blocked");
  });

  it("resolves immutable rule text and binds a location/state-matched witness", () => {
    const provenance = resolveVerificationProvenance({
      candidate: candidate({
        id: "supported",
        title: "Member session bypasses the admin guard",
        description: "Trigger: session is present with role member; the blocking throw is skipped.",
        ruleId: "security.authorization-boundary",
      }),
      rules: [rule],
      witnesses: [memberWitness],
    });
    expect(provenance).toMatchObject({
      contract: WITNESS_RULE_PROVENANCE_CONTRACT,
      rule: {
        id: "security.authorization-boundary",
        short: rule.short,
        explanation: rule.explanation,
      },
      witness: {
        witnessId: "witness-member",
        currentOutcome: "passes",
        state: 'session present, role = "member"',
      },
    });
  });

  it("fail-closed rejects polarity that contradicts a bound witness and never verifies", () => {
    const provenance = resolveVerificationProvenance({
      candidate: candidate({
        id: "contradicted",
        title: "Member sessions are blocked by the admin guard",
        description: "Trigger: session is present with role member; the blocking throw executes. Impact: the member cannot reach deletion.",
        ruleId: "security.authorization-boundary",
      }),
      rules: [rule],
      witnesses: [memberWitness],
    });
    const closed = failClosedProvenancePreflight({
      candidate: candidate({
        id: "contradicted",
        title: "Member sessions are blocked by the admin guard",
        description: "Trigger: session is present with role member; the blocking throw executes. Impact: the member cannot reach deletion.",
        ruleId: "security.authorization-boundary",
      }),
      provenance,
    });
    expect(closed).toMatchObject({
      verdict: "rejected",
      confidence: 1,
    });
    expect(closed?.verdict).not.toBe("verified");
    expect(closed?.reasoningSummary).toContain("host provenance preflight");
  });

  it("fail-closed marks claims without rule or witness as insufficient_evidence", () => {
    const provenance = resolveVerificationProvenance({
      candidate: candidate({
        id: "unsupported",
        title: "External retention policy may be violated",
        description: "Trigger: an admin calls deleteUser. Invariant: an external retention policy requires a seven-day delay.",
      }),
      rules: [rule],
      witnesses: [memberWitness],
    });
    expect(provenance.rule).toBeUndefined();
    expect(provenance.witness).toBeUndefined();
    expect(
      failClosedProvenancePreflight({
        candidate: candidate({
          id: "unsupported",
          title: "External retention policy may be violated",
          description: "Trigger: an admin calls deleteUser. Invariant: an external retention policy requires a seven-day delay.",
        }),
        provenance,
      }),
    ).toMatchObject({ verdict: "insufficient_evidence" });
  });

  it("leaves matching polarity for the model and includes provenance in the prompt", () => {
    const finding = candidate({
      id: "supported",
      title: "Member session bypasses the admin guard",
      description: "Trigger: session is present with role member; the blocking throw is skipped and deleteUser continues.",
      ruleId: "security.authorization-boundary",
    });
    const provenance = resolveVerificationProvenance({
      candidate: finding,
      rules: [rule],
      witnesses: [memberWitness],
    });
    expect(failClosedProvenancePreflight({ candidate: finding, provenance })).toBeNull();
    expect(witnessEstablishesRuleViolation(provenance.witness!)).toBe(true);
    const prompt = buildProvenanceVerificationPrompt({
      candidate: finding,
      originatingCode: "if (!session && role !== \"admin\") throw new Error(\"forbidden\");",
      evidenceText: "[abc] anchor src/routes.ts:5-5\n...",
      provenance,
    });
    expect(prompt).toContain("Host provenance (immutable):");
    expect(prompt).toContain("security.authorization-boundary");
    expect(prompt).toContain("witness-member");
    expect(prompt).toContain("VERIFIED requires that the witnessed or evidenced behavior violates the supplied rule");
  });

  it("requires a bound witness for guard/authorization claims when CF witnesses exist", () => {
    const finding = candidate({
      id: "unbound-auth",
      title: "Member session bypasses the admin guard",
      description: "Trigger: session is present with role member; the blocking throw is skipped.",
      ruleId: "security.authorization-boundary",
      // Force location away from the available witness so binding fails.
      line: 99,
      endLine: 99,
    });
    expect(isGuardAuthorizationClaim(finding)).toBe(true);
    const provenance = resolveVerificationProvenance({
      candidate: finding,
      rules: [rule],
      witnesses: [memberWitness],
    });
    expect(provenance.rule).toBeDefined();
    expect(provenance.witness).toBeUndefined();
    expect(
      failClosedProvenancePreflight({
        candidate: finding,
        provenance,
        controlFlowWitnessesAvailable: true,
      }),
    ).toMatchObject({
      verdict: "insufficient_evidence",
      reasoningSummary: expect.stringContaining("requires a bound control-flow witness"),
    });
  });

  it("rejects a bound witness that does not establish an authorization-rule violation", () => {
    const stillBlocked: typeof memberWitness = {
      ...memberWitness,
      previousOutcome: "blocked",
      currentOutcome: "blocked",
    };
    const finding = candidate({
      id: "no-violation",
      title: "Member sessions are blocked by the admin guard",
      description: "Trigger: session is present with role member; the blocking throw executes.",
      ruleId: "security.authorization-boundary",
    });
    const provenance = resolveVerificationProvenance({
      candidate: finding,
      rules: [rule],
      witnesses: [stillBlocked],
    });
    expect(provenance.witness).toBeDefined();
    expect(witnessEstablishesRuleViolation(provenance.witness!)).toBe(false);
    expect(
      failClosedProvenancePreflight({ candidate: finding, provenance, controlFlowWitnessesAvailable: true }),
    ).toMatchObject({
      verdict: "rejected",
      reasoningSummary: expect.stringContaining("does not establish an authorization-rule violation"),
    });
  });

  it("fail-closed demotes auth claims that bind a witness without stating bypass/block polarity", () => {
    const finding = candidate({
      id: "vague",
      title: "Authorization boundary requires validating user role for all authenticated requests",
      description: "Trigger: authenticated caller reaches deleteUser. Invariant: roles must be checked. Impact: unauthorized access.",
      ruleId: "security.authorization-boundary",
    });
    const provenance = resolveVerificationProvenance({
      candidate: finding,
      rules: [rule],
      witnesses: [memberWitness],
    });
    expect(provenance.witness).toBeDefined();
    expect(claimedGuardOutcome(finding)).toBeUndefined();
    expect(
      failClosedProvenancePreflight({ candidate: finding, provenance, controlFlowWitnessesAvailable: true }),
    ).toMatchObject({
      verdict: "insufficient_evidence",
      reasoningSummary: expect.stringContaining("lacks concrete bypass/block polarity"),
    });
    expect(
      demoteUnpublishableVerified({
        candidate: finding,
        provenance,
        controlFlowWitnessesAvailable: true,
        outcome: {
          candidateId: finding.id,
          verdict: "verified",
          confidence: 1,
          reasoningSummary: "model said verified",
          supportingEvidenceIds: ["evidence-1"],
        },
      }),
    ).toMatchObject({
      verdict: "insufficient_evidence",
      reasoningSummary: expect.stringContaining("lacks concrete bypass/block polarity"),
    });
  });

  it("demotes model verified outcomes that lack citations or fail provenance publish checks", () => {
    const finding = candidate({
      id: "supported",
      title: "Member session bypasses the admin guard",
      description: "Trigger: session is present with role member; the blocking throw is skipped and deleteUser continues.",
      ruleId: "security.authorization-boundary",
    });
    const provenance = resolveVerificationProvenance({
      candidate: finding,
      rules: [rule],
      witnesses: [memberWitness],
    });
    expect(
      demoteUnpublishableVerified({
        candidate: finding,
        provenance,
        controlFlowWitnessesAvailable: true,
        outcome: {
          candidateId: finding.id,
          verdict: "verified",
          confidence: 1,
          reasoningSummary: "model said verified",
          supportingEvidenceIds: [],
        },
      }),
    ).toMatchObject({ verdict: "insufficient_evidence", reasoningSummary: expect.stringContaining("publish gate") });
    expect(
      demoteUnpublishableVerified({
        candidate: finding,
        provenance,
        controlFlowWitnessesAvailable: true,
        outcome: {
          candidateId: finding.id,
          verdict: "verified",
          confidence: 1,
          reasoningSummary: "model said verified",
          supportingEvidenceIds: ["evidence-1"],
        },
      }).verdict,
    ).toBe("verified");
  });
});
