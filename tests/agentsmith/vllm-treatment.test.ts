import { describe, expect, it } from "vitest";
import { agentSmithConfigFromPolicy } from "../../src/core/resolved-policy.js";
import {
  applyEvalTreatment,
  resolveEvalTreatment,
  OLLAMA_THINKING_9B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT,
  VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT,
  VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT,
  VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT,
} from "../../tools/agentsmith-evals/src/vllm-treatment.js";

describe("provider diagnostic treatments", () => {
  it("keeps the established 4B endpoint unchanged", () => {
    const config = applyEvalTreatment(
      agentSmithConfigFromPolicy(true),
      VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT,
    );
    expect(config.base_url).toBe("http://127.0.0.1:8001/v1");
  });

  it("changes only the prompt variant in the matched delta-first treatment", () => {
    const control = resolveEvalTreatment(VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT)!;
    const treatment = resolveEvalTreatment(VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT)!;
    const { candidatePromptVariant: controlPrompt, ...controlSettings } = control;
    const { candidatePromptVariant: treatmentPrompt, ...treatmentSettings } = treatment;
    expect(controlPrompt).toBe("branch-analysis-state-scan-v2");
    expect(treatmentPrompt).toBe("branch-analysis-delta-first-v3");
    expect(treatmentSettings).toEqual({
      ...controlSettings,
      id: VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT,
    });
    expect(treatment).toMatchObject({
      candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
      verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
      candidateContextTokens: 4096,
      candidateOutputTokens: 1895,
      candidateThinkingTokens: 1024,
      candidateTemperature: 0.6,
      candidateTopP: 0.95,
      candidateTopK: 20,
      candidateArm: "rule-bound-classification",
      inferenceMode: "thinking-structured",
      candidatePromptVariant: "branch-analysis-delta-first-v3",
      thinkingStream: true,
      controlFlowDelta: true,
    });
  });

  it("defines the larger-thinking diagnostic with explicit context, output, and timeout headroom", () => {
    expect(resolveEvalTreatment(VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT)).toMatchObject({
      candidateContextTokens: 6144,
      candidateOutputTokens: 3072,
      candidateThinkingTokens: 2048,
      verifierContextTokens: 6144,
      timeoutMs: 900_000,
      candidateTemperature: 0.6,
      candidateTopP: 0.95,
      candidateTopK: 20,
      candidateArm: "rule-bound-classification",
      inferenceMode: "thinking-structured",
      candidatePromptVariant: "branch-analysis-delta-first-v3",
      thinkingStream: true,
      controlFlowDelta: true,
    });
  });

  it("defines the matched Ollama 9B hard-budget treatment without changing eval limits", () => {
    const settings = resolveEvalTreatment(
      OLLAMA_THINKING_9B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT,
    );
    expect(settings).toMatchObject({
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11435",
      candidateModel: "qwen3.5:9b-q4_K_M",
      verifierModel: "qwen3.5:9b-q4_K_M",
      candidateContextTokens: 6144,
      candidateOutputTokens: 3072,
      candidateThinkingTokens: 2048,
      verifierOutputTokens: 512,
      timeoutMs: 900_000,
      candidateArm: "rule-bound-classification",
      inferenceMode: "thinking-structured",
      candidatePromptVariant: "branch-analysis-delta-first-v3",
    });
    const config = applyEvalTreatment(
      agentSmithConfigFromPolicy(true),
      OLLAMA_THINKING_9B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT,
    );
    expect(config.provider).toBe("ollama");
    expect(config.base_url).toBe("http://127.0.0.1:11435");
    expect(config.model_profiles.find((profile) => profile.id === config.models.candidate)).toMatchObject({
      provider: "ollama",
      model: "qwen3.5:9b-q4_K_M",
      contextTokens: 6144,
      requestedOutputTokens: 3072,
    });
  });
});
