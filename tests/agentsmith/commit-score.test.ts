import { describe, expect, it } from "vitest";
import {
  answerFromGuidedContinuation,
  parseCommitAllowList,
  scoreCommitAnswer,
} from "../../src/agentsmith/commit-score.js";

const witnesses = ["deleteUser.guard-5.state-1"];
const rules = ["security.authorization-boundary", "correctness.control-flow"];

function score(answer: string, thinking?: string) {
  return scoreCommitAnswer({ answer, allowedWitnessKeys: witnesses, allowedRuleIds: rules, thinking });
}

describe("scoreCommitAnswer", () => {
  it("accepts one finding line whose witness and rule were supplied", () => {
    const result = score("DECISION: finding WITNESS: deleteUser.guard-5.state-1 RULE: security.authorization-boundary");
    expect(result.score).toEqual({
      outcome: "finding",
      witnessKey: "deleteUser.guard-5.state-1",
      basisRuleId: "security.authorization-boundary",
      form: { witnessKey: "deleteUser.guard-5.state-1", basisRuleId: "security.authorization-boundary" },
    });
    expect(result.thinkingMentionsAllowedWitness).toBe(false);
  });

  it("stops a no_finding or insufficient_context line without a form", () => {
    expect(score("DECISION: no_finding WITNESS: none RULE: none").score).toEqual({ outcome: "no_finding" });
    expect(score("notes\nDECISION: insufficient_context WITNESS: none RULE: none").score).toEqual({
      outcome: "insufficient_context",
    });
  });

  it("keeps a scratchpad mention from turning a missing answer into a finding", () => {
    const result = score(
      '{"state":"no_finding","candidates":[]}',
      "the witness deleteUser.guard-5.state-1 violates the rule",
    );
    expect(result.score).toEqual({ outcome: "incomplete", reason: "missing-commit" });
    expect(result.thinkingMentionsAllowedWitness).toBe(true);
  });

  it("rejects a second commit line, a commit that is not last, and an unparsed decision line", () => {
    expect(
      score(
        "DECISION: finding WITNESS: deleteUser.guard-5.state-1 RULE: security.authorization-boundary\nDECISION: no_finding WITNESS: none RULE: none",
      ).score,
    ).toEqual({
      outcome: "incomplete",
      reason: "extra-commit",
    });
    expect(
      score("DECISION: finding WITNESS: deleteUser.guard-5.state-1 RULE: security.authorization-boundary\nextra").score,
    ).toEqual({
      outcome: "incomplete",
      reason: "malformed",
    });
    expect(score("DECISION: maybe").score).toEqual({ outcome: "incomplete", reason: "malformed" });
  });

  it("rejects a finding that names a witness or rule outside the supplied lists", () => {
    expect(score("DECISION: finding WITNESS: other.witness RULE: security.authorization-boundary").score).toEqual({
      outcome: "incomplete",
      reason: "unmatched-witness",
    });
    expect(score("DECISION: finding WITNESS: deleteUser.guard-5.state-1 RULE: other.rule").score).toEqual({
      outcome: "incomplete",
      reason: "unmatched-rule",
    });
  });
});

describe("parseCommitAllowList", () => {
  it("reads witness keys and rule ids from a work item body", () => {
    const body = [
      "Rules:",
      "- security.authorization-boundary [categories: security; severity: critical]: stay enforced",
      "- correctness.control-flow [categories: correctness; severity: medium]: check flow",
      "Control-flow witnesses (host-derived):",
      "- deleteUser.guard-5.state-1: src/routes.ts:5; state session present",
    ].join("\n");
    expect(parseCommitAllowList(body)).toEqual({
      witnessKeys: ["deleteUser.guard-5.state-1"],
      ruleIds: ["security.authorization-boundary", "correctness.control-flow"],
    });
  });
});

describe("answerFromGuidedContinuation", () => {
  it("keeps a continuation that already starts with the decision label", () => {
    expect(answerFromGuidedContinuation("DECISION: no_finding WITNESS: none RULE: none")).toBe(
      "DECISION: no_finding WITNESS: none RULE: none",
    );
  });

  it("prefixes the label the server already wrote", () => {
    expect(
      answerFromGuidedContinuation(
        " finding WITNESS: deleteUser.guard-5.state-1 RULE: security.authorization-boundary",
      ),
    ).toBe("DECISION: finding WITNESS: deleteUser.guard-5.state-1 RULE: security.authorization-boundary");
  });
});
