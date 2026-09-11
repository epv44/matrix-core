import { describe, expect, it } from "vitest";
import { generateWorkItemCandidate } from "../../src/agentsmith/candidate-generation.js";
import {
  buildTaskEvidenceLocatorTable,
  selectorPromptText,
} from "../../src/agentsmith/evidence-locators.js";
import {
  buildEvidenceLocatorTable,
  deterministicEvidenceLocatorId,
  validateEvidenceLocatorRequest,
} from "../../src/core/evidence-locators.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import type { ModelProfile } from "../../src/core/types.js";
import type { ReviewWorkItem } from "../../src/agentsmith/engine-types.js";

const profile: ModelProfile = {
  id: "small",
  provider: "ollama",
  model: "small",
  contextTokens: 8192,
  reviewCapability: "small",
  requestedOutputTokens: 512,
  safetyReserveTokens: 512,
  tokenizer: { kind: "conservative-ratio", codeCharsPerToken: 2, proseCharsPerToken: 3 },
  inference: { temperature: 0, thinking: false, timeoutMs: 1_000 },
};

const symbol = {
  file: "src/producer.ts",
  provider: "typescript-compiler",
  kind: "function" as const,
  name: "produce",
  qualifiedName: "produce",
  startLine: 1,
  endLine: 3,
  contentHash: "producer",
};

const workItem: ReviewWorkItem = {
  id: "interaction:producer-consumer",
  kind: "interaction",
  primarySymbols: [symbol],
  relatedSymbols: [],
  code: [
    {
      id: "producer-code",
      file: "src/producer.ts",
      startLine: 1,
      endLine: 3,
      symbol: "produce",
      content: "export function produce() { return null; }",
      changed: true,
      score: 100,
      reason: "changed producer",
      estimatedTokens: 20,
    },
  ],
  graphEdges: [],
  rules: [],
  estimatedTokens: 100,
};

describe("semantic evidence selector boundaries", () => {
  it("renders readable selector semantics for model-facing output", () => {
    const table = buildTaskEvidenceLocatorTable({ snapshotId: "snapshot-a", workItem });
    const prompt = selectorPromptText(table.selectors);

    expect(prompt).toContain("primary-1.definition: definition for produce (src/producer.ts)");
    expect(prompt).toContain("primary-1.implementation: implementation for produce (src/producer.ts)");
    expect(prompt).not.toMatch(/locator-[a-f0-9]{20}/);
  });

  it("compiles readable host selectors to deterministic internal hashes", () => {
    const table = buildEvidenceLocatorTable({
      taskId: "task-a",
      snapshotId: "snapshot-a",
      scopePaths: ["src/producer.ts"],
      locators: [
        {
          mode: "symbol",
          canonicalValue: "produce",
          pathBound: "src/producer.ts",
          allowedEvidenceKinds: ["type", "definition", "implementation"],
        },
      ],
    });
    const locator = table.locators[0];

    expect(locator.id).toMatch(/^locator-[a-f0-9]{20}$/);
    const { id, ...identity } = locator;
    expect(id).toBe(deterministicEvidenceLocatorId(identity));
    expect(locator.canonicalValue).toBe("produce");
    expect(locator.allowedEvidenceKinds).toEqual(["definition", "type", "implementation"]);
  });

  it("rejects an unknown selector before evidence-kind validation", () => {
    const table = buildEvidenceLocatorTable({
      taskId: "task-a",
      snapshotId: "snapshot-a",
      scopePaths: ["src/producer.ts"],
      locators: [
        {
          mode: "symbol",
          canonicalValue: "produce",
          pathBound: "src/producer.ts",
          allowedEvidenceKinds: ["definition"],
        },
      ],
    });

    expect(() =>
      validateEvidenceLocatorRequest(
        { locatorId: "selector-does-not-exist", evidenceKind: "definition" },
        table,
      ),
    ).toThrow(/unknown evidence locator ID/);
  });

  it("does not expose internal selector hashes in the prompt or provider schema", async () => {
    const table = buildTaskEvidenceLocatorTable({ snapshotId: "snapshot-a", workItem });
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["small"] }),
      invoke: async () => ({ raw: '{"c":[]}', usage: { inputTokens: 1, outputTokens: 1 } }),
    };

    const result = await generateWorkItemCandidate({
      item: workItem,
      profile,
      provider,
      allowedFiles: ["src/producer.ts"],
      maxCandidates: 1,
      allowedEvidenceSelectors: table.selectors,
    });

    expect(result.prompt).toContain("primary-1.definition: definition for produce (src/producer.ts)");
    expect(result.prompt).not.toMatch(/locator-[a-f0-9]{20}/);
  });

  it("attributes an invalid selector response to candidate quality instead of infrastructure", async () => {
    const table = buildTaskEvidenceLocatorTable({ snapshotId: "snapshot-a", workItem });
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["small"] }),
      invoke: async () => ({
        raw: JSON.stringify({
          c: [
            {
              f: "src/producer.ts",
              l: 1,
              s: "high",
              k: "contract",
              t: "Invalid selector",
              d: "The selector is not in the supplied task table.",
              q: 0.9,
              e: [{ selector: "selector-does-not-exist", r: "inspect producer" }],
            },
          ],
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const result = await generateWorkItemCandidate({
      item: workItem,
      profile,
      provider,
      allowedFiles: ["src/producer.ts"],
      maxCandidates: 1,
      allowedEvidenceSelectors: table.selectors,
    });

    expect(result.candidates).toEqual([]);
    expect(result.contractDrops).toEqual([
      { candidateIndex: 0, reason: "unknown-selector", selector: "selector-does-not-exist" },
    ]);
  });
});
