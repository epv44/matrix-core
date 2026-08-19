import { resolveCanonicalKey } from "../packs/registry.js";
import type { ResolvedConfig } from "./types.js";

export const DEFAULT_FAST_CHECKS = [
  "python.ruff",
  "python.ruff-format",
  "python.mypy",
  "typescript.tsc",
  "typescript.eslint",
  "sql.sqlfluff",
  "typescript.prettier",
];

export function resolveFastChecks(resolved: ResolvedConfig): Set<string> {
  const list = resolved.config.stages?.fast?.checks;
  const src = list && list.length > 0 ? list : DEFAULT_FAST_CHECKS;
  return new Set(src.map((c) => resolveCanonicalKey(c)));
}
