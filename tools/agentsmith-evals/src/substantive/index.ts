import crypto from "node:crypto";
import { DOMAIN_COMPATIBILITY, domainCompatible, type SubstantiveDomain } from "./domains.js";
import { OPERATOR_ALIASES } from "./operators.js";
import {
  conceptAsserted,
  conceptExplicitlyNegated,
  conceptMentioned,
  polarityIndex,
  type PolarityIndex,
} from "./polarity.js";
import { normalizeConcept, normalizeTokens } from "./tokenizer.js";

export { domainCompatible, normalizeConcept, normalizeTokens };
export type { SubstantiveDomain };

export const SUBSTANTIVE_NORMALIZATION_VERSION = 1;

export const SUBSTANTIVE_NORMALIZATION_HASH = crypto
  .createHash("sha256")
  .update(JSON.stringify({
    version: SUBSTANTIVE_NORMALIZATION_VERSION,
    domains: DOMAIN_COMPATIBILITY,
    operators: OPERATOR_ALIASES,
    polarityScope: 3,
  }))
  .digest("hex");

export interface SubstantiveConceptContract {
  domain: SubstantiveDomain;
  triggerGroups: string[][];
  invariantGroups: string[][];
  impactGroups: string[][];
  forbidden: string[];
}

export interface ConceptCoverage {
  trigger: boolean;
  invariant: boolean;
  impact: boolean;
  forbidden: boolean;
  impactContradiction: boolean;
}

function groupCovered(index: PolarityIndex, group: string[]): boolean {
  return group.some((concept) => conceptMentioned(index, concept));
}

function allGroupsCovered(index: PolarityIndex, groups: string[][]): boolean {
  return groups.every((group) => groupCovered(index, group));
}

export function evaluateConceptCoverage(narrative: string, contract: SubstantiveConceptContract): ConceptCoverage {
  const index = polarityIndex(narrative);
  const impactContradiction = contract.impactGroups.some((group) => {
    const mentioned = group.filter((concept) => conceptMentioned(index, concept));
    return mentioned.length > 0 && !mentioned.some((concept) => conceptAsserted(index, concept)) &&
      mentioned.some((concept) => conceptExplicitlyNegated(index, concept));
  });
  return {
    trigger: allGroupsCovered(index, contract.triggerGroups),
    invariant: allGroupsCovered(index, contract.invariantGroups),
    impact: allGroupsCovered(index, contract.impactGroups),
    forbidden: contract.forbidden.some((concept) => conceptAsserted(index, concept)),
    impactContradiction,
  };
}

