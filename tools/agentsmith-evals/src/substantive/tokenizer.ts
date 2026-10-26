import { splitIdentifier } from "./identifiers.js";
import { normalizeOperatorSyntax } from "./operators.js";

const STOP_WORDS = new Set([
  "a", "an", "are", "as", "at", "be", "been", "being", "by", "can", "could", "did", "do", "does",
  "for", "from", "has", "have", "in", "is", "it", "its", "may", "might", "of", "on", "should", "that",
  "the", "this", "to", "was", "were", "will", "with", "would",
]);

const NEGATION_TOKENS = new Set(["cannot", "never", "no", "not", "without"]);

function basicVariants(token: string): string[] {
  const variants = [token];
  if (token.length > 4 && token.endsWith("ies")) variants.push(`${token.slice(0, -3)}y`);
  else if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) variants.push(token.slice(0, -1));
  if (token.length > 5 && token.endsWith("ing")) variants.push(token.slice(0, -3));
  if (token.length > 4 && token.endsWith("ed")) variants.push(token.slice(0, -2));
  return [...new Set(variants)];
}

/** Deterministic lexical normalization shared by fixture concepts and candidate text. */
export function normalizeTokens(value: string): string[] {
  const source = normalizeOperatorSyntax(value);
  const lexical = source.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:[.\-/][A-Za-z_$][A-Za-z0-9_$]*)*|\d+(?:\.\d+)?/g) ?? [];
  return lexical.flatMap((item) =>
    splitIdentifier(item).flatMap((part) => {
      if (part === "logical_and" || part === "logical_or" || part === "short_circuit_guard") return [part];
      if (NEGATION_TOKENS.has(part)) return [part];
      if (STOP_WORDS.has(part)) return [];
      return basicVariants(part);
    }),
  );
}

export function normalizeConcept(value: string): string[] {
  return [...new Set(normalizeTokens(value).filter((token) => !NEGATION_TOKENS.has(token)))];
}

