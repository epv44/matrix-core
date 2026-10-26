import type { ReviewCategory } from "../../../../src/core/types.js";

export type SubstantiveDomain = ReviewCategory;

/** Coarse review domains that may describe the same executable defect. */
export const DOMAIN_COMPATIBILITY: Readonly<Record<SubstantiveDomain, readonly ReviewCategory[]>> = {
  correctness: ["correctness", "contract"],
  contract: ["contract", "correctness"],
  performance: ["performance", "correctness"],
  security: ["security", "contract", "correctness"],
};

export function domainCompatible(expected: SubstantiveDomain, actual: ReviewCategory): boolean {
  return DOMAIN_COMPATIBILITY[expected].includes(actual);
}

