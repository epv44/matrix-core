import { describe, expect, it } from "vitest";
import { agentSmithConfigFromPolicy, resolvePolicy } from "../../src/core/resolved-policy.js";

describe("central AgentSmith policy", () => {
  it("publishes locked small and strong profiles with role bindings", () => {
    const policy = resolvePolicy();
    const config = agentSmithConfigFromPolicy(true, policy);
    expect(policy.agentSmith).toMatchObject({
      id: "agentsmith.unified.v4",
      outputSchemaVersion: 4,
      concurrency: 1,
      maxDurationMs: 1800000,
      partitioned: {
        maxCandidateWorkItems: 4,
        maxCandidatesPerWorkItem: 2,
        maxVerificationCandidates: 4,
        maxRulesPerUnit: 4,
      },
    });
    expect(policy.agentSmith.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qwen35-9b-local",
          reviewCapability: "small",
          contextTokens: 8192,
          requestedOutputTokens: 4096,
          inference: expect.objectContaining({ timeoutMs: 300000 }),
        }),
        expect.objectContaining({
          id: "qwen35-9b-verifier-local",
          requestedOutputTokens: 512,
          inference: expect.objectContaining({ timeoutMs: 300000 }),
        }),
        expect.objectContaining({ id: "qwen35-122b-local", reviewCapability: "strong", contextTokens: 131072 }),
        expect.objectContaining({
          id: "qwen35-122b-scout-local",
          requestedOutputTokens: 1024,
          inference: expect.objectContaining({ timeoutMs: 180000 }),
        }),
      ]),
    );
    expect(config.models).toEqual({ candidate: "qwen35-9b-local", verifier: "qwen35-9b-verifier-local" });
    expect(config.routing.inputContextFraction).toBe(0.7);
  });
});
