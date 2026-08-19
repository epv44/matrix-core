import { describe, expect, it } from "vitest";
import { resolvePolicy } from "../src/core/resolved-policy.js";

describe("central deterministic stages", () => {
  it("contains only the centrally selected consumer checks", () => {
    expect(resolvePolicy().checks.map((check) => check.id)).toEqual([
      "python.ruff",
      "python.ruff-format",
      "python.mypy",
      "python.xenon",
      "python.deptry",
      "typescript.tsc",
      "typescript.eslint",
      "sql.sqlfluff",
    ]);
  });

  it("never includes application tests, coverage, or builds", () => {
    expect(
      resolvePolicy()
        .checks.map((check) => check.id)
        .join(" "),
    ).not.toMatch(/pytest|vitest|test|coverage|build/);
  });
});
