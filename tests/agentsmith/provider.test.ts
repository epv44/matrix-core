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
          JSON.stringify({ response: '{"summary":"ok","candidates":[]}', prompt_eval_count: 12, eval_count: 3 }),
        );
      }),
    );
    const response = await new OllamaProvider(config).invoke({
      profile,
      prompt: "review",
      outputKind: "candidates",
      allowedFiles: ["src/a.ts", "docs/deleted.md", "src/a.ts"],
    });
    const item = requestBody.format.properties.candidates.items;
    expect(item.required).toEqual(expect.arrayContaining(["file", "line", "category", "evidenceRequests"]));
    expect(item.properties.file).toEqual({ type: "string", enum: ["src/a.ts", "docs/deleted.md"] });
    expect(requestBody.model).toBe(profile.model);
    expect(requestBody.options).toMatchObject({
      num_ctx: profile.contextTokens,
      num_predict: profile.requestedOutputTokens,
    });
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
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
});
