import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../../src/agentsmith/provider.js";
import { agentSmithConfigFromPolicy } from "../../src/core/resolved-policy.js";

afterEach(() => vi.unstubAllGlobals());

describe("OllamaProvider v2", () => {
  it("uses locked model inference settings and constrains candidate locations", async () => {
    const config = agentSmithConfigFromPolicy(true);
    const profile = config.model_profiles[0];
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: "qwen3.5:9b-q4_K_M",
            response: '{"c":[]}',
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 3,
            total_duration: 100,
            load_duration: 20,
            prompt_eval_duration: 30,
            eval_duration: 50,
          }),
        );
      }),
    );
    const response = await new OllamaProvider(config).invoke({
      profile,
      prompt: "review",
      outputKind: "candidates",
      allowedFiles: ["src/a.ts", "docs/deleted.md", "src/a.ts"],
      maxCandidates: 2,
    });
    const candidates = requestBody.format.properties.c;
    const item = candidates.items;
    expect(requestBody.format.required).toEqual(["c"]);
    expect(candidates.maxItems).toBe(2);
    expect(item.required).toEqual(expect.arrayContaining(["f", "l", "k", "e"]));
    expect(item.properties.f).toEqual({ type: "string", enum: ["src/a.ts", "docs/deleted.md"] });
    expect(item.properties.d.maxLength).toBe(280);
    expect(item.properties.e.maxItems).toBe(2);
    expect(item.properties.e.items.required).toEqual(["k", "v", "r"]);
    expect(item.properties.e.items.properties.v.minLength).toBe(1);
    expect(requestBody.model).toBe(profile.model);
    expect(requestBody.options).toMatchObject({
      num_ctx: profile.contextTokens,
      num_predict: profile.requestedOutputTokens,
    });
    expect(requestBody.keep_alive).toBe("35m");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(response.completion).toEqual({
      model: "qwen3.5:9b-q4_K_M",
      done: true,
      doneReason: "stop",
      totalDurationNs: 100,
      loadDurationNs: 20,
      promptEvalDurationNs: 30,
      evalDurationNs: 50,
    });
  });

  it("uses the focused verification schema", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ response: '{"verdict":"rejected","confidence":1,"supportingEvidenceIds":[]}' }),
        );
      }),
    );
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "verify",
      outputKind: "verification",
    });
    expect(requestBody.format.properties.verdict.enum).toEqual([
      "verified",
      "likely",
      "rejected",
      "insufficient_evidence",
    ]);
  });

  it("uses only supplied semantic selector keys for bounded candidate evidence", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"c":[]}' }));
      }),
    );
    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "review",
      outputKind: "candidates",
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
      evidenceSelectorKeys: ["primary-1.definition", "primary-1.implementation"],
    });
    const evidence = requestBody.format.properties.c.items.properties.e.items;
    expect(evidence.required).toEqual(["selector", "r"]);
    expect(evidence.properties.selector).toEqual({
      type: "string",
      enum: ["primary-1.definition", "primary-1.implementation"],
    });
    expect(evidence.properties.k).toBeUndefined();
    expect(evidence.properties.i).toBeUndefined();
    expect(evidence.properties.v).toBeUndefined();
    expect(evidence.properties.m).toBeUndefined();
    expect(evidence.properties.p).toBeUndefined();
  });

  it("preserves the strong specialist path without bounded selector IDs", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    const prompt = "strong specialist review prompt";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"summary":"reviewed","c":[]}' }));
      }),
    );

    await new OllamaProvider(config).invoke({
      profile: config.model_profiles.find((item) => item.reviewCapability === "strong")!,
      prompt,
      outputKind: "specialist",
      allowedFiles: ["src/a.ts"],
      maxCandidates: 2,
    });

    const evidence = requestBody.format.properties.c.items.properties.e.items;
    expect(requestBody.prompt).toBe(prompt);
    expect(evidence.required).toEqual(["k", "v", "r"]);
    expect(evidence.properties.i).toBeUndefined();
    expect(evidence.properties.v).toMatchObject({ type: "string", minLength: 1 });
    expect(evidence.properties.m.enum).toEqual(["symbol", "literal"]);
    expect(evidence.properties.p).toBeDefined();
  });

  it("keeps readable selector names in the bounded schema rather than exposing internal hashes", async () => {
    const config = agentSmithConfigFromPolicy(true);
    let requestBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ response: '{"c":[]}' }));
      }),
    );

    await new OllamaProvider(config).invoke({
      profile: config.model_profiles[0],
      prompt: "inspect the producer selector",
      outputKind: "candidates",
      allowedFiles: ["src/producer.ts"],
      maxCandidates: 1,
      evidenceSelectorKeys: ["primary-1.definition"],
    } as any);

    const evidence = requestBody.format.properties.c.items.properties.e.items;
    expect(evidence.required).toEqual(["selector", "r"]);
    expect(evidence.properties.selector).toEqual({ type: "string", enum: ["primary-1.definition"] });
    expect(evidence.properties.i).toBeUndefined();
    expect(evidence.properties.v).toBeUndefined();
    expect(JSON.stringify(requestBody.format)).not.toMatch(/locator-[a-f0-9]{20}/);
  });
});
