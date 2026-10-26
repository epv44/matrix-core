import { describe, expect, it } from "vitest";
import {
  SUBSTANTIVE_NORMALIZATION_HASH,
  SUBSTANTIVE_NORMALIZATION_VERSION,
  domainCompatible,
  evaluateConceptCoverage,
  normalizeConcept,
  normalizeTokens,
} from "../../tools/agentsmith-evals/src/substantive/index.js";

describe("substantive diagnostic normalization", () => {
  it("normalizes identifiers and generic operator aliases deterministically", () => {
    const expected = ["delete", "user", "logical_and", "short_circuit_guard", "cash", "snapshot"];
    expect(normalizeTokens("deleteUser && short-circuit cash_snapshot")).toEqual(expected);
    expect(normalizeTokens("deleteUser conjunction short circuit cash-snapshot")).toEqual(expected);
    expect(normalizeConcept("time.sleep")).toEqual(["time", "sleep"]);
  });

  it("uses all-of groups with any-of alternatives", () => {
    const contract = {
      domain: "security" as const,
      triggerGroups: [["member"], ["logical_and", "short_circuit_guard"]],
      invariantGroups: [["admin", "administrator"]],
      impactGroups: [["delete user", "deletion"]],
      forbidden: [],
    };
    expect(evaluateConceptCoverage("A member reaches deleteUser because the && admin guard short circuits.", contract))
      .toMatchObject({ trigger: true, invariant: true, impact: true, forbidden: false, impactContradiction: false });
    expect(evaluateConceptCoverage("A member reaches deleteUser past the admin guard.", contract).trigger).toBe(false);
  });

  it("distinguishes positive forbidden claims from explicit negation", () => {
    const contract = {
      domain: "contract" as const,
      triggerGroups: [["cash snapshot"]],
      invariantGroups: [["label"]],
      impactGroups: [["account balance"]],
      forbidden: ["runtime error"],
    };
    expect(evaluateConceptCoverage("cash_snapshot has the wrong label Account balance; this is a runtime error", contract).forbidden)
      .toBe(true);
    expect(evaluateConceptCoverage("cash_snapshot has the wrong label Account balance; this is not a runtime error", contract).forbidden)
      .toBe(false);
  });

  it("flags an explicitly negated harmful impact", () => {
    const contract = {
      domain: "security" as const,
      triggerGroups: [["member"]],
      invariantGroups: [["admin"]],
      impactGroups: [["delete user"]],
      forbidden: [],
    };
    expect(evaluateConceptCoverage("A member is not permitted to delete users; admin is required.", contract))
      .toMatchObject({ impact: true, impactContradiction: true });
  });

  it("keeps domain compatibility finite and exposes stable provenance", () => {
    expect(domainCompatible("security", "contract")).toBe(true);
    expect(domainCompatible("performance", "security")).toBe(false);
    expect(SUBSTANTIVE_NORMALIZATION_VERSION).toBe(1);
    expect(SUBSTANTIVE_NORMALIZATION_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});

