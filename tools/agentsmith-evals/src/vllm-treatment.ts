import type { AgentSmithConfig } from "../../../src/core/types.js";
import type { CandidateGenerationArm, CandidateInferenceMode, CandidatePromptVariant } from "../../../src/agentsmith/engine-types.js";

/**
 * Reproducible, explicitly named provider treatments used by diagnostic evals.
 * Treatments are deliberately narrow: they select a provider/model contract,
 * not a new review algorithm or a relaxed oracle.
 */
export const VLLM_METAL_THINKING_4B_TREATMENT = "vllm-metal-thinking-4b" as const;
export const VLLM_METAL_THINKING_4B_CONTROL_FLOW_DELTA_TREATMENT = "vllm-metal-thinking-4b-control-flow-delta" as const;
export const VLLM_METAL_THINKING_4B_RULE_BOUND_CLASSIFICATION_TREATMENT = "vllm-metal-thinking-4b-rule-bound-classification" as const;
/** Matched A/B/C state-scan budget experiment; diagnostic only, never a promotion default. */
export const VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_TREATMENT = "vllm-metal-thinking-4b-rule-bound-state-scan" as const;
export const VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_TREATMENT = "vllm-metal-thinking-4b-rule-bound-state-scan-output-2k" as const;
export const VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_THINKING_1K_TREATMENT = "vllm-metal-thinking-4b-rule-bound-state-scan-output-2k-thinking-1k" as const;
/** 1,895 is the largest partitioned-route-safe output budget at 4,096 context + 1,000 reserve. */
export const VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_TREATMENT = "vllm-metal-thinking-4b-rule-bound-state-scan-output-max-fit" as const;
export const VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT = "vllm-metal-thinking-4b-rule-bound-state-scan-output-max-fit-thinking-1k" as const;
/** Delta-first prompt experiment matched to the 4B 1,024-token state-scan control. */
export const VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT = "vllm-metal-thinking-4b-rule-bound-delta-first-output-max-fit-thinking-1k" as const;
/** Larger-context diagnostic isolating whether a 2K reasoning budget preserves the final decision. */
export const VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT = "vllm-metal-thinking-4b-rule-bound-delta-first-output-3k-thinking-2k-long-timeout" as const;
/** Ollama/llama.cpp hard-budget treatment matched to the final 4B control. */
export const OLLAMA_THINKING_9B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT = "ollama-thinking-9b-rule-bound-delta-first-output-3k-thinking-2k-long-timeout" as const;
export type EvalTreatmentId =
  | typeof VLLM_METAL_THINKING_4B_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_CONTROL_FLOW_DELTA_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_CLASSIFICATION_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_THINKING_1K_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT
  | typeof VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT
  | typeof OLLAMA_THINKING_9B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT;
/** @deprecated Use EvalTreatmentId; retained for existing diagnostic imports. */
export type VllmEvalTreatment = EvalTreatmentId;

export interface EvalTreatmentSettings {
  id: EvalTreatmentId;
  provider?: "ollama" | "vllm";
  baseUrl?: string;
  candidateModel: string;
  verifierModel: string;
  candidateContextTokens: number;
  candidateOutputTokens: number;
  candidateTemperature: number;
  candidateTopP: number;
  candidateTopK: number;
  candidateThinkingTokens: number;
  verifierContextTokens: number;
  verifierOutputTokens: number;
  timeoutMs: number;
  candidateArm: CandidateGenerationArm;
  inferenceMode: CandidateInferenceMode;
  candidatePromptVariant: CandidatePromptVariant;
  thinkingStream: boolean;
  controlFlowDelta: boolean;
}

const EVAL_TREATMENTS: Record<EvalTreatmentId, EvalTreatmentSettings> = {
  [VLLM_METAL_THINKING_4B_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 1024,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 512,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "simplified-contract",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-v1",
    thinkingStream: true,
    controlFlowDelta: false,
  },
  [VLLM_METAL_THINKING_4B_CONTROL_FLOW_DELTA_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_CONTROL_FLOW_DELTA_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 1024,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 512,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "simplified-contract",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-v1",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_CLASSIFICATION_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_CLASSIFICATION_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 1024,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 512,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-v1",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 1024,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 512,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-state-scan-v2",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 2048,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 512,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-state-scan-v2",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_THINKING_1K_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_2K_THINKING_1K_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 2048,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 1024,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-state-scan-v2",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 1895,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 512,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-state-scan-v2",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_STATE_SCAN_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 1895,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 1024,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-state-scan-v2",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_MAX_FIT_THINKING_1K_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 4096,
    candidateOutputTokens: 1895,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 1024,
    verifierContextTokens: 4096,
    verifierOutputTokens: 512,
    timeoutMs: 300_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-delta-first-v3",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT]: {
    id: VLLM_METAL_THINKING_4B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT,
    candidateModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    verifierModel: "mlx-community/Qwen3.5-4B-MLX-4bit",
    candidateContextTokens: 6144,
    candidateOutputTokens: 3072,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 2048,
    verifierContextTokens: 6144,
    verifierOutputTokens: 512,
    timeoutMs: 900_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-delta-first-v3",
    thinkingStream: true,
    controlFlowDelta: true,
  },
  [OLLAMA_THINKING_9B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT]: {
    id: OLLAMA_THINKING_9B_RULE_BOUND_DELTA_FIRST_OUTPUT_3K_THINKING_2K_LONG_TIMEOUT_TREATMENT,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11435",
    candidateModel: "qwen3.5:9b-q4_K_M",
    verifierModel: "qwen3.5:9b-q4_K_M",
    candidateContextTokens: 6144,
    candidateOutputTokens: 3072,
    candidateTemperature: 0.6,
    candidateTopP: 0.95,
    candidateTopK: 20,
    candidateThinkingTokens: 2048,
    verifierContextTokens: 6144,
    verifierOutputTokens: 512,
    timeoutMs: 900_000,
    candidateArm: "rule-bound-classification",
    inferenceMode: "thinking-structured",
    candidatePromptVariant: "branch-analysis-delta-first-v3",
    thinkingStream: true,
    controlFlowDelta: true,
  },
};

export function resolveEvalTreatment(value?: string): EvalTreatmentSettings | undefined {
  if (value === undefined) return undefined;
  const treatment = EVAL_TREATMENTS[value as EvalTreatmentId];
  if (!treatment) throw new Error(`Unknown eval treatment: ${value}. Available: ${Object.keys(EVAL_TREATMENTS).join(", ")}`);
  return treatment;
}

/** @deprecated Use resolveEvalTreatment. */
export const resolveVllmEvalTreatment = resolveEvalTreatment;

/** Apply provider and role-profile settings without changing the policy's limits. */
export function applyEvalTreatment(config: AgentSmithConfig, treatment?: string): AgentSmithConfig {
  const settings = resolveEvalTreatment(treatment);
  if (!settings) return config;
  const provider = settings.provider ?? "vllm";
  return {
    ...config,
    provider,
    base_url: settings.baseUrl ?? "http://127.0.0.1:8001/v1",
    model_profiles: config.model_profiles.map((profile) => {
      if (profile.id === config.models.candidate) {
        return {
          ...profile,
          provider,
          model: settings.candidateModel,
          contextTokens: settings.candidateContextTokens,
          requestedOutputTokens: settings.candidateOutputTokens,
          inference: {
            ...profile.inference,
            thinking: true,
            timeoutMs: settings.timeoutMs,
            temperature: settings.candidateTemperature,
            topP: settings.candidateTopP,
            topK: settings.candidateTopK,
          },
        };
      }
      if (profile.id === config.models.verifier) {
        return {
          ...profile,
          provider,
          model: settings.verifierModel,
          contextTokens: settings.verifierContextTokens,
          requestedOutputTokens: settings.verifierOutputTokens,
          inference: { ...profile.inference, thinking: false, timeoutMs: settings.timeoutMs },
        };
      }
      return profile;
    }),
  };
}

/** @deprecated Use applyEvalTreatment. */
export const applyVllmEvalTreatment = applyEvalTreatment;
