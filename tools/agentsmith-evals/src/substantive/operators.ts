export const OPERATOR_ALIASES = {
  logical_and: ["&&", "and", "conjunction"],
  logical_or: ["||", "or", "disjunction"],
  short_circuit_guard: ["short circuit", "short-circuit", "short circuiting", "short-circuiting"],
} as const;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateAliases(): void {
  const owners = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(OPERATOR_ALIASES)) {
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      const owner = owners.get(key);
      if (owner && owner !== canonical) throw new Error(`Ambiguous substantive operator alias: ${alias}`);
      owners.set(key, canonical);
    }
  }
}

validateAliases();

/** Replace only generic language/operator forms with stable evaluator atoms. */
export function normalizeOperatorSyntax(value: string): string {
  let normalized = value;
  const entries = Object.entries(OPERATOR_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => ({ canonical, alias })),
  ).sort((left, right) => right.alias.length - left.alias.length || left.alias.localeCompare(right.alias));
  for (const { canonical, alias } of entries) {
    const symbolic = alias === "&&" || alias === "||";
    const pattern = symbolic
      ? new RegExp(escaped(alias), "g")
      : new RegExp(`\\b${escaped(alias).replaceAll("\\ ", "\\s+")}\\b`, "gi");
    normalized = normalized.replace(pattern, ` ${canonical} `);
  }
  return normalized;
}

