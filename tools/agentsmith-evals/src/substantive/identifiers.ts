const CANONICAL_TOKENS = new Set(["logical_and", "logical_or", "short_circuit_guard"]);

/** Split source identifiers without teaching the evaluator fixture vocabulary. */
export function splitIdentifier(value: string): string[] {
  if (CANONICAL_TOKENS.has(value.toLowerCase())) return [value.toLowerCase()];
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[._\-/\\]+|\s+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

