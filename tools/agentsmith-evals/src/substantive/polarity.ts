import { normalizeConcept, normalizeTokens } from "./tokenizer.js";

const NEGATORS = new Set(["cannot", "never", "no", "not", "without"]);

export interface PolarityIndex {
  mentioned: Set<string>;
  positive: Set<string>;
  negated: Set<string>;
}

/**
 * Index explicit lexical negation. The bounded three-token scope is
 * intentionally conservative; this is an evaluator diagnostic, not a parser.
 */
export function polarityIndex(value: string): PolarityIndex {
  const positive = new Set<string>();
  const negated = new Set<string>();
  let negationBudget = 0;
  for (const token of normalizeTokens(value)) {
    if (NEGATORS.has(token)) {
      negationBudget = 3;
      continue;
    }
    if (negationBudget > 0) {
      negated.add(token);
      negationBudget -= 1;
    } else positive.add(token);
  }
  return { mentioned: new Set([...positive, ...negated]), positive, negated };
}

export function conceptMentioned(index: PolarityIndex, concept: string): boolean {
  const atoms = normalizeConcept(concept);
  return atoms.length > 0 && atoms.every((atom) => index.mentioned.has(atom));
}

export function conceptAsserted(index: PolarityIndex, concept: string): boolean {
  const atoms = normalizeConcept(concept);
  return atoms.length > 0 && atoms.every((atom) => index.positive.has(atom));
}

export function conceptExplicitlyNegated(index: PolarityIndex, concept: string): boolean {
  const atoms = normalizeConcept(concept);
  return atoms.length > 0 && atoms.every((atom) => index.mentioned.has(atom)) && atoms.some((atom) => index.negated.has(atom));
}

