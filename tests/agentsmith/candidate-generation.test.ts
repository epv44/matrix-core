import { describe, expect, it } from "vitest";
import { generateWorkItemCandidate, verifyCandidateWithModel } from "../../src/agentsmith/candidate-generation.js";
import type { ReviewProvider } from "../../src/agentsmith/provider.js";
import type { ModelProfile } from "../../src/core/types.js";
import type { ReviewWorkItem } from "../../src/agentsmith/engine-types.js";

const profile: ModelProfile = {
  id: "candidate",
  provider: "ollama",
  model: "qwen",
  contextTokens: 8192,
  reviewCapability: "small",
  requestedOutputTokens: 1024,
  safetyReserveTokens: 1000,
  tokenizer: { kind: "conservative-ratio", codeCharsPerToken: 2, proseCharsPerToken: 3 },
  inference: { temperature: 0, thinking: false, timeoutMs: 300_000 },
};

const symbol = {
  file: "src/a.ts",
  provider: "typescript-compiler",
  kind: "function" as const,
  name: "value",
  qualifiedName: "value",
  startLine: 1,
  endLine: 1,
  contentHash: "a",
};

const item: ReviewWorkItem = {
  id: "local:value",
  kind: "local",
  primarySymbols: [symbol],
  relatedSymbols: [],
  graphEdges: [],
  rules: [],
  code: [
    {
      id: "code",
      file: "src/a.ts",
      startLine: 1,
      endLine: 1,
      symbol: "value",
      content: "export function value() { return 1; }",
      changed: true,
      score: 100,
      reason: "changed",
      estimatedTokens: 20,
    },
  ],
  estimatedTokens: 100,
};

describe("candidate structured output", () => {
  it("repairs one schema-invalid response and expands the required evidence locator", async () => {
    let calls = 0;
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => {
        calls += 1;
        return {
          raw:
            calls === 1
              ? '{"c":[{"f":"src/a.ts","l":1,"s":"high","k":"correctness","t":"Bad return","d":"The return is wrong.","q":109,"e":[]}]}'
              : '{"c":[{"f":"src/a.ts","l":1,"s":"high","k":"correctness","t":"Bad return","d":"The return is wrong.","q":0.9,"e":[{"k":"implementation","v":"value","p":"src/a.ts","r":"confirm return"}]}]}',
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      },
    };
    const result = await generateWorkItemCandidate({
      item,
      profile,
      provider,
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
    });
    expect(calls).toBe(2);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        failureKind: "schema-validation",
        attempt: 1,
        validationIssues: expect.arrayContaining([expect.objectContaining({ path: "c.0.q" })]),
      }),
    ]);
    expect(result.candidates[0].evidenceRequests).toEqual([
      {
        kind: "implementation",
        locatorMode: "symbol",
        symbol: "value",
        pathHint: "src/a.ts",
        query: undefined,
        reason: "confirm return",
      },
    ]);
  });

  it("repairs malformed verifier citations once", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async (input) => {
        prompts.push(input.prompt);
        return {
          raw: JSON.stringify({
            verdict: "rejected",
            confidence: 0.9,
            supportingEvidenceIds: [calls++ === 0 ? "[e-1]" : "e-1"],
          }),
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      },
    };
    const judged = await verifyCandidateWithModel({
      candidate: {
        id: "candidate",
        sourceWorkItemIds: ["local:1"],
        sourceReviewers: [],
        file: "src/a.ts",
        line: 1,
        severity: "medium",
        category: "correctness",
        title: "Candidate",
        description: "Candidate description",
        evidenceRequests: [],
        candidateConfidence: 0.8,
      },
      originatingCode: "return true;",
      evidenceText: "[e-1] src/a.ts:1-1\nreturn true;",
      evidenceIds: ["e-1"],
      requiredEvidenceIdsByRequest: { "request-1": ["e-1"] },
      profile,
      provider,
    });
    expect(calls).toBe(2);
    expect(judged.result).toMatchObject({
      verdict: "rejected",
      supportingEvidenceIds: ["e-1"],
      citationRepairAttempted: true,
      providerInvocations: 2,
    });
    expect(judged.result.diagnostics).toEqual([
      expect.objectContaining({ failureKind: "citation-validation", attempt: 1 }),
    ]);
    expect(judged).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(prompts[1]).toContain("request request-1: include at least one of e-1");
  });

  it("downgrades a verifier result when citation repair remains invalid", async () => {
    let calls = 0;
    const provider: ReviewProvider = {
      health: async () => ({ ok: true, models: ["qwen"] }),
      invoke: async () => {
        calls++;
        return {
          raw: '{"verdict":"verified","confidence":1,"supportingEvidenceIds":["invented"]}',
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      },
    };
    const judged = await verifyCandidateWithModel({
      candidate: {
        id: "candidate",
        sourceWorkItemIds: ["local:1"],
        sourceReviewers: [],
        file: "src/a.ts",
        line: 1,
        severity: "medium",
        category: "correctness",
        title: "Candidate",
        description: "Candidate description",
        evidenceRequests: [],
        candidateConfidence: 0.8,
      },
      originatingCode: "return true;",
      evidenceText: "[e-1] src/a.ts:1-1\nreturn true;",
      evidenceIds: ["e-1"],
      profile,
      provider,
    });
    expect(calls).toBe(2);
    expect(judged.result).toMatchObject({
      verdict: "insufficient_evidence",
      confidence: 0,
      supportingEvidenceIds: [],
      citationRepairAttempted: true,
    });
    expect(judged.result.diagnostics?.filter((item) => item.failureKind === "citation-validation")).toHaveLength(2);
  });
});
