import { describe, expect, it } from "vitest";
import { selectRules } from "../../src/agentsmith/rules.js";

const input = {
  id: "interaction:auth",
  kind: "interaction" as const,
  primarySymbols: [],
  relatedSymbols: [],
  code: [{
    id: "routes",
    file: "src/routes.ts",
    startLine: 1,
    endLine: 3,
    content: "if (!session && role !== 'admin') throw new Error('forbidden')",
    changed: true,
    score: 1,
    reason: "changed",
    estimatedTokens: 20,
  }],
  graphEdges: [{ kind: "reads-type", source: "src/routes.ts:deleteUser", target: "src/auth.ts:Session", targetText: "Session", confidence: "exact", provider: "typescript" }],
  rules: [],
  estimatedTokens: 20,
};

describe("structured rule selection", () => {
  it("retains declared critical policy rules under the existing cap", () => {
    const selected = selectRules([
      { id: "contract.interface", languages: ["typescript"], categories: ["contract"], triggers: [{ edgeKinds: ["reads-type"] }], short: "contract", explanation: "contract" },
      { id: "correctness.control", languages: ["typescript"], categories: ["correctness"], triggers: [{ keywords: ["if"] }], short: "control", explanation: "control" },
      { id: "correctness.null", languages: ["typescript"], categories: ["correctness"], triggers: [{ keywords: ["session"] }], short: "null", explanation: "null" },
      { id: "contract.value", languages: ["typescript"], categories: ["contract"], triggers: [{ keywords: ["role"] }], short: "value", explanation: "value" },
      { id: "security.authorization", languages: ["typescript"], categories: ["security"], severity: "critical", triggers: [{ keywords: ["role"] }], short: "security", explanation: "security" },
    ], input, 4);

    expect(selected.map((rule) => rule.id)).toEqual([
      "security.authorization",
      "contract.interface",
      "contract.value",
      "correctness.control",
    ]);
    expect(selected[0]).toMatchObject({ categories: ["security"], severity: "critical" });
  });

  it("remains stable for rules without declared severity", () => {
    const rules = [
      { id: "zeta", languages: ["typescript"], categories: ["correctness"], triggers: [], short: "z", explanation: "z" },
      { id: "alpha", languages: ["typescript"], categories: ["contract"], triggers: [], short: "a", explanation: "a" },
    ];
    expect(selectRules(rules, input, 2).map((rule) => rule.id)).toEqual(["alpha", "zeta"]);
  });
});
