import { describe, expect, it } from "vitest";
import { agentSmithConfigFromPolicy, resolvePolicy } from "../../src/core/resolved-policy.js";

describe("central AgentSmith policy", () => {
  it("publishes locked small and strong profiles with role bindings", () => {
    const policy = resolvePolicy();
    const config = agentSmithConfigFromPolicy(true, policy);
    expect(policy.agentSmith).toMatchObject({
      id: "agentsmith.unified.v2",
      outputSchemaVersion: 2,
      concurrency: 1,
      partitioned: { maxCandidateWorkItems: 4, maxVerificationCandidates: 4 },
    });
    expect(policy.agentSmith.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "qwen35-9b-local", reviewCapability: "small", contextTokens: 8192 }),
        expect.objectContaining({ id: "qwen35-122b-local", reviewCapability: "strong", contextTokens: 131072 }),
      ]),
    );
    expect(config.models).toEqual({ candidate: "qwen35-9b-local", verifier: "qwen35-9b-local" });
    expect(config.routing.inputContextFraction).toBe(0.7);
  });
});
