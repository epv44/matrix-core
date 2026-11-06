import { describe, expect, it } from "vitest";
import {
  filterRulesForCallsWitnessFallback,
  filterRulesForReadsTypeWitnessFallback,
  prioritizeRulesForCallsInteraction,
  selectRules,
} from "../../src/agentsmith/rules.js";

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

  it("biases calls-interaction shortlists toward producer/lifecycle over configuration/nullability", () => {
    const callsInput = {
      ...input,
      graphEdges: [
        {
          kind: "calls" as const,
          source: "src/producer.ts:emit",
          target: "src/consumer.ts:handle",
          targetText: "handle",
          confidence: "exact" as const,
          provider: "typescript",
        },
      ],
      code: [
        {
          ...input.code[0],
          content: "async function emit(config) { await close(); return null; }",
        },
      ],
    };
    const selected = selectRules(
      [
        {
          id: "contract.configuration",
          languages: ["typescript"],
          categories: ["contract"],
          triggers: [{ keywords: ["config"] }],
          short: "config",
          explanation: "config",
        },
        {
          id: "correctness.nullability",
          languages: ["typescript"],
          categories: ["correctness"],
          triggers: [{ keywords: ["null"] }],
          short: "null",
          explanation: "null",
        },
        {
          id: "contract.producer-consumer",
          languages: ["typescript"],
          categories: ["contract"],
          triggers: [{ edgeKinds: ["calls"] }],
          short: "producer",
          explanation: "producer",
        },
        {
          id: "correctness.lifecycle-concurrency",
          languages: ["typescript"],
          categories: ["correctness"],
          triggers: [{ keywords: ["async", "close"] }],
          short: "lifecycle",
          explanation: "lifecycle",
        },
      ],
      callsInput,
      4,
    );
    expect(selected.map((rule) => rule.id)).toEqual([
      "contract.producer-consumer",
      "correctness.lifecycle-concurrency",
      "contract.configuration",
      "correctness.nullability",
    ]);
  });

  it("orders witness-fallback shortlists with the same edge bias", () => {
    expect(
      prioritizeRulesForCallsInteraction([
        { id: "contract.configuration" },
        { id: "correctness.nullability" },
        { id: "performance.changed-complexity" },
        { id: "contract.producer-consumer" },
        { id: "correctness.lifecycle-concurrency" },
      ]).map((rule) => rule.id),
    ).toEqual([
      "contract.producer-consumer",
      "performance.changed-complexity",
      "correctness.lifecycle-concurrency",
      "contract.configuration",
      "correctness.nullability",
    ]);
  });

  it("drops configuration/nullability on calls witness fallback", () => {
    expect(
      filterRulesForCallsWitnessFallback([
        { id: "contract.configuration" },
        { id: "correctness.nullability" },
        { id: "performance.changed-complexity" },
        { id: "contract.producer-consumer" },
        { id: "security.authorization-boundary" },
        { id: "correctness.lifecycle-concurrency" },
        { id: "correctness.control-flow" },
      ]).map((rule) => rule.id),
    ).toEqual([
      "contract.producer-consumer",
      "performance.changed-complexity",
      "correctness.control-flow",
    ]);
  });

  it("biases reads-type witness fallback toward value-provenance over configuration", () => {
    expect(
      filterRulesForReadsTypeWitnessFallback([
        { id: "contract.configuration" },
        { id: "correctness.nullability" },
        { id: "contract.producer-consumer" },
        { id: "contract.value-provenance" },
        { id: "contract.interface-implementation" },
      ]).map((rule) => rule.id),
    ).toEqual([
      "contract.value-provenance",
      "contract.interface-implementation",
      "contract.producer-consumer",
    ]);
  });
});
