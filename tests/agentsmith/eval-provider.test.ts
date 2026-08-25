import { describe, expect, it } from "vitest";
import { PlannerReviewProvider, RecordedReviewProvider } from "../../tools/agentsmith-evals/src/eval-provider.js";

const profile = { id: "small", model: "qwen:test" } as any;

describe("AgentSmith eval replay providers", () => {
  it("replays exact recorded prompt/output pairs and reports strategy drift", async () => {
    const provider = new RecordedReviewProvider({
      execution: {
        modelProfiles: { candidate: profile, verifier: profile },
        candidateBatches: [
          {
            sourceId: "local:a",
            candidates: [],
            prompt: "frozen prompt",
            raw: '{"c":[]}',
            inputTokens: 11,
            outputTokens: 3,
          },
        ],
        verification: [],
      },
    } as any);

    await expect(
      provider.invoke({ outputKind: "candidates", profile, prompt: "frozen prompt" } as any),
    ).resolves.toMatchObject({ raw: '{"c":[]}', usage: { inputTokens: 11, outputTokens: 3 } });
    await expect(
      provider.invoke({ outputKind: "candidates", profile, prompt: "changed prompt" } as any),
    ).rejects.toThrow(/Recorded replay miss/);
  });

  it("supports deterministic planner-only evaluation without an LLM", async () => {
    const provider = new PlannerReviewProvider({ model_profiles: [profile] } as any);
    await expect(provider.health()).resolves.toEqual({ ok: true, models: ["qwen:test"] });
    await expect(provider.invoke({ outputKind: "candidates" } as any)).resolves.toMatchObject({ raw: '{"c":[]}' });
  });
});
