import { describe, expect, it } from "vitest";
import { classifyFindingEvidence } from "../../src/agentsmith/evidence.js";
import type { ReviewScope } from "../../src/agentsmith/scope.js";

const scope: ReviewScope = {
  id: "scope",
  version: "version",
  root: "/repo",
  base: "main",
  diff: "",
  changedFiles: ["src/a.ts"],
  fileContents: { "src/a.ts": "const safe = true;\nreturn null;\n" },
  suppliedContext: {},
};

describe("finding evidence classification", () => {
  it("locates a complete claim whose excerpt matches the claimed line", () => {
    expect(
      classifyFindingEvidence(
        {
          severity: "warn",
          message: "nullable result",
          file: "./src/a.ts",
          line: 2,
          evidence: "return null;",
          impact: "caller can fail",
          recommendation: "return a result object",
        },
        scope,
      ),
    ).toMatchObject({ evidenceStatus: "located", validationIssues: [], file: "src/a.ts" });
  });

  it.each([
    [{ line: 2, evidence: "return null;", impact: "x", recommendation: "y" }, "missing file"],
    [
      { file: "src/other.ts", line: 2, evidence: "return null;", impact: "x", recommendation: "y" },
      "outside the changed review scope",
    ],
    [{ file: "src/a.ts", line: 99, evidence: "return null;", impact: "x", recommendation: "y" }, "outside the file"],
    [{ file: "src/a.ts", line: 2, evidence: "not present", impact: "x", recommendation: "y" }, "does not match"],
    [{ file: "src/a.ts", line: 2 }, "missing evidence excerpt"],
  ])("preserves an unsupported claim as unverified", (partial, issue) => {
    const result = classifyFindingEvidence({ severity: "warn", message: "claim", ...partial }, scope);
    expect(result.evidenceStatus).toBe("unverified");
    expect(result.validationIssues?.join(" ")).toContain(issue);
  });

  it("rejects a finding outside the dispatched reviewer's domain", () => {
    const result = classifyFindingEvidence(
      {
        severity: "warn",
        message: "nullable result",
        file: "src/a.ts",
        line: 2,
        domain: "performance",
        evidence: "return null;",
        impact: "caller can fail",
        recommendation: "return a result object",
      },
      scope,
      "correctness",
    );
    expect(result.evidenceStatus).toBe("unverified");
    expect(result.validationIssues).toContain("reviewer domain performance does not match expected correctness");
  });

  it("validates deleted-file evidence against frozen pre-deletion content", () => {
    const deletedScope: ReviewScope = {
      ...scope,
      changedFiles: ["docs/architecture.md"],
      deletedFiles: ["docs/architecture.md"],
      fileContents: { "docs/architecture.md": "# Architecture\nLayering rules\n" },
    };
    expect(
      classifyFindingEvidence(
        {
          severity: "warn",
          message: "architecture contract removed",
          file: "docs/architecture.md",
          line: 2,
          evidence: "Layering rules",
          impact: "maintainers lose the contract",
          recommendation: "restore or migrate it",
        },
        deletedScope,
      ),
    ).toMatchObject({ evidenceStatus: "located", validationIssues: [] });
    expect(
      classifyFindingEvidence(
        {
          severity: "warn",
          message: "architecture contract removed",
          file: "docs/architecture.md",
          line: 1,
          evidence: "deleted file mode 100644",
          impact: "maintainers lose the contract",
          recommendation: "restore or migrate it",
        },
        deletedScope,
      ).validationIssues,
    ).toContain("evidence excerpt does not match the claimed location");
  });
});
